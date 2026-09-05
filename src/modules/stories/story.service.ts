import httpStatus from "http-status";
import type { AuthUser } from "../auth/auth.interface.js";
import { env } from "../../config/env.js";
import { StorageService } from "../storage/storage.service.js";
import { UserFollowRepository } from "../user/user-follow.repository.js";
import { UserBlockRepository } from "../user/user-block.repository.js";
import { UserRepository } from "../user/user.repository.js";
import { isBlockedBetween, isUserPubliclyViewable } from "../user/user-access.js";
import { AppError } from "../../core/errors/app-error.js";
import { StoryRepository } from "./story.repository.js";
import type { CreateStoryDto, IStory, StoryAuthorResponse, StoryCommentResponse, StoryResponse } from "./story.interface.js";
import { MomentRepository } from "../moments/moment.repository.js";

const STORY_TTL_HOURS = 24;
const MAX_STORY_DURATION_SECONDS = 15;

type PopulatedStoryUser = {
  _id: { toString: () => string };
  name?: string;
  username?: string;
  avatarKey?: string | null;
  isActive?: boolean;
  role?: string;
  deletedAt?: Date | null;
};

export class StoryService {
  public constructor(
    private readonly storyRepository = new StoryRepository(),
    private readonly userFollowRepository = new UserFollowRepository(),
    private readonly storageService = new StorageService(),
    private readonly momentRepository = new MomentRepository(),
    private readonly userBlockRepository = new UserBlockRepository(),
    private readonly userRepository = new UserRepository(),
  ) {}

  public async createStory(payload: CreateStoryDto, user: AuthUser): Promise<StoryResponse> {
    const mediaType = payload.mediaType ?? "video";

    // Video Story creation is temporarily disabled while the deployment host
    // runs without the transcoding worker. Image and text Stories are
    // untouched. Set ENABLE_VIDEO_UPLOADS=true (env.ts) to re-enable.
    if (mediaType === "video" && !env.ENABLE_VIDEO_UPLOADS) {
      throw new AppError("Video stories are temporarily unavailable", httpStatus.BAD_REQUEST);
    }

    if (payload.durationSeconds > MAX_STORY_DURATION_SECONDS) {
      throw new AppError("Stories can be up to 15 seconds long", httpStatus.BAD_REQUEST);
    }

    if (mediaType === "video" && !payload.contentType?.toLowerCase().startsWith("video/")) {
      throw new AppError("Video stories must be video files", httpStatus.BAD_REQUEST);
    }

    if (mediaType === "image" && !payload.contentType?.toLowerCase().startsWith("image/")) {
      throw new AppError("Image stories must be image files", httpStatus.BAD_REQUEST);
    }

    if (mediaType !== "text" && !payload.storageKey) {
      throw new AppError("Story storage key is required", httpStatus.BAD_REQUEST);
    }

    if (mediaType === "text" && !payload.textContent?.trim()) {
      throw new AppError("Story text is required", httpStatus.BAD_REQUEST);
    }

    const expiresAt = new Date(Date.now() + STORY_TTL_HOURS * 60 * 60 * 1000);
    const story = await this.storyRepository.create({
      userId: user.id,
      mediaType,
      mediaSource: payload.mediaSource ?? "upload",
      storageKey: payload.storageKey?.trim() || null,
      contentType: payload.contentType?.trim() || null,
      durationSeconds: payload.durationSeconds,
      caption: payload.caption?.trim() || null,
      textContent: payload.textContent?.trim() || null,
      textBackground: payload.textBackground ?? null,
      textOverlay: payload.textOverlay?.text.trim() ? payload.textOverlay : null,
      imageTransform: payload.imageTransform ?? null,
      expiresAt,
    });

    return this.toResponse(story, user);
  }

  // Video is temporarily disabled — video Stories are excluded from every
  // list/feed response (existing video Stories included) so no playable
  // video reaches a normal product surface. Image/text Stories are
  // untouched, and the underlying records are never modified. Set
  // ENABLE_VIDEO_UPLOADS=true (env.ts) to re-enable.
  private filterVisibleStories(stories: IStory[]): IStory[] {
    return env.ENABLE_VIDEO_UPLOADS ? stories : stories.filter((story) => story.mediaType !== "video");
  }

  public async listFeedStories(user: AuthUser): Promise<StoryResponse[]> {
    const [followingIds, friendIds] = await Promise.all([
      this.userFollowRepository.findFollowingIds(user.id),
      this.userFollowRepository.findMutualFriendIds(user.id),
    ]);
    const visibleUserIds = [...new Set([user.id, ...followingIds, ...friendIds])];
    const stories = await this.filterAccessibleStories(
      this.filterVisibleStories(await this.storyRepository.findActiveByViewerNetwork(visibleUserIds)),
      user.id,
    );

    return Promise.all(stories.map((story) => this.toResponse(story, user)));
  }

  public async listMyStories(user: AuthUser): Promise<StoryResponse[]> {
    const stories = this.filterVisibleStories(await this.storyRepository.findActiveByUserId(user.id));

    return Promise.all(stories.map((story) => this.toResponse(story, user)));
  }

  public async listUserStories(userId: string, viewer: AuthUser): Promise<StoryResponse[]> {
    const stories = await this.filterAccessibleStories(
      this.filterVisibleStories(await this.storyRepository.findActiveByUserId(userId)),
      viewer.id,
    );
    return Promise.all(stories.map((story) => this.toResponse(story, viewer)));
  }

  public async listDiscoverStories(user: AuthUser): Promise<StoryResponse[]> {
    const stories = await this.filterAccessibleStories(
      this.filterVisibleStories(await this.storyRepository.findAllActive()),
      user.id,
    );
    return Promise.all(stories.map((story) => this.toResponse(story, user)));
  }

  public async listFriendStories(user: AuthUser): Promise<StoryResponse[]> {
    const friendIds = await this.userFollowRepository.findMutualFriendIds(user.id);
    const stories = await this.filterAccessibleStories(
      this.filterVisibleStories(await this.storyRepository.findActiveByViewerNetwork(friendIds)),
      user.id,
    );
    return Promise.all(stories.map((story) => this.toResponse(story, user)));
  }

  public async getStoryDetails(id: string, user: AuthUser): Promise<StoryResponse> {
    const story = await this.getViewableStory(id, user);
    return this.toResponse(story, user);
  }

  public async recordView(id: string, user: AuthUser) {
    const story = await this.getViewableStory(id, user);
    await this.storyRepository.recordView(user.id, id, story.expiresAt);
    return this.storyRepository.getInteraction(id, user.id);
  }

  public async toggleReaction(id: string, user: AuthUser) {
    const story = await this.getViewableStory(id, user);
    await this.storyRepository.toggleReaction(user.id, id, story.expiresAt);
    return this.storyRepository.getInteraction(id, user.id);
  }

  public async deleteStory(id: string, user: AuthUser): Promise<void> {
    const deleted = await this.storyRepository.deleteByIdForUser(id, user.id);
    if (!deleted) throw new AppError("Story not found", httpStatus.NOT_FOUND);
    await this.storyRepository.deleteInteractions(id);
  }

  public async listComments(id: string, user: AuthUser) {
    await this.getViewableStory(id, user);
    const comments = await this.storyRepository.findComments(id);
    const responses: StoryCommentResponse[] = await Promise.all(comments.map(async (comment) => {
      const author = this.getCommentAuthor(comment.userId);
      return {
        id: comment._id.toString(), storyId: id,
        parentCommentId: comment.parentCommentId?.toString() ?? null,
        author: author ? { ...author, avatarUrl: author.avatarKey ? await this.createOptionalDownloadUrl(author.avatarKey) : null } : null,
        text: comment.text, likesCount: 0, isLiked: false, replies: [],
        createdAt: comment.createdAt, updatedAt: comment.updatedAt,
      };
    }));
    const byParent = new Map<string, StoryCommentResponse[]>();
    responses.forEach((comment) => {
      const parentId = comment.parentCommentId ?? "root";
      byParent.set(parentId, [...(byParent.get(parentId) ?? []), comment]);
    });

    const buildTree = (comment: StoryCommentResponse): StoryCommentResponse => ({
      ...comment,
      replies: (byParent.get(comment.id) ?? []).map(buildTree),
    });

    return (byParent.get("root") ?? []).map(buildTree);
  }

  public async createComment(id: string, user: AuthUser, payload: { text: string; parentCommentId?: string | null }) {
    const story = await this.getViewableStory(id, user);
    if (payload.parentCommentId) {
      const comments = await this.storyRepository.findComments(id);
      if (!comments.some((comment) => comment._id.toString() === payload.parentCommentId)) {
        throw new AppError("Parent comment not found", httpStatus.NOT_FOUND);
      }
    }
    const created = await this.storyRepository.createComment(id, user.id, payload.text.trim(), story.expiresAt, payload.parentCommentId);
    const avatarUrl = user.avatarKey ? await this.createOptionalDownloadUrl(user.avatarKey) : null;
    return {
      comment: {
        id: created._id.toString(), storyId: id,
        parentCommentId: created.parentCommentId?.toString() ?? null,
        author: { id: user.id, name: user.name, username: user.username, avatarKey: user.avatarKey ?? null, avatarUrl },
        text: created.text, likesCount: 0, isLiked: false, replies: [],
        createdAt: created.createdAt, updatedAt: created.updatedAt,
      },
      interaction: await this.storyRepository.getInteraction(id, user.id),
    };
  }

  public async shareToFeed(id: string, user: AuthUser, payload: { caption?: string | null; taggedFriendIds?: string[]; clientRequestId?: string | null }) {
    const story = await this.getViewableStory(id, user);
    const mediaType = story.mediaType === "text" ? null : story.mediaType;
    const taggedPeople = [...new Set(payload.taggedFriendIds ?? [])];
    const moment = await this.momentRepository.createStoryShare({
      userId: user.id,
      mode: "feed",
      audience: "public",
      caption: payload.caption?.trim() || story.caption || story.textContent || null,
      taggedPeople, hashtags: [],
      sourceStoryId: story._id.toString(),
      sourceClientRequestId: payload.clientRequestId?.trim() || null,
      mediaItems: mediaType ? [{
        type: mediaType,
        source: story.mediaSource,
        storageKey: story.storageKey ?? null,
        contentType: story.contentType ?? null,
        durationSeconds: story.durationSeconds,
      }] : [],
    });
    return { momentId: moment._id.toString() };
  }

  // Single choke point for every by-ID Story read (detail, view, reaction,
  // comments, share-to-feed). While video is disabled, a video Story is
  // treated as not-found here too — same semantics as an expired Story —
  // so no read/detail path can reach a video Story's storageKey/mediaUrl
  // even if the caller already knows its id. Set ENABLE_VIDEO_UPLOADS=true
  // (env.ts) to re-enable. deleteStory intentionally does not go through
  // this method: owners may still delete their own video Stories.
  private async getActiveStory(id: string): Promise<IStory> {
    const story = await this.storyRepository.findActiveById(id);
    if (!story || (story.mediaType === "video" && !env.ENABLE_VIDEO_UPLOADS)) {
      throw new AppError("Story not found or expired", httpStatus.NOT_FOUND);
    }
    return story;
  }

  // Per-id read / interact privacy gate. getActiveStory already enforces
  // expiry + the video kill-switch; this additionally hides a Story — as a
  // plain 404, leaking nothing — when the viewer and the author have blocked
  // each other in either direction, or the author is suspended / banned /
  // deleted / not a regular user. The author viewing their own Story is
  // always allowed.
  private async getViewableStory(id: string, viewer: AuthUser): Promise<IStory> {
    const story = await this.getActiveStory(id);
    const authorId = this.resolveStoryAuthorId(story);

    if (authorId !== viewer.id) {
      const [blocked, authorViewable] = await Promise.all([
        isBlockedBetween(this.userBlockRepository, viewer.id, authorId),
        this.resolveAuthorPubliclyViewable(story, authorId),
      ]);

      if (blocked || !authorViewable) {
        throw new AppError("Story not found or expired", httpStatus.NOT_FOUND);
      }
    }

    return story;
  }

  // List filter counterpart of getViewableStory: drops Stories authored by a
  // user the viewer has blocked or been blocked by, or by an account that is
  // not publicly viewable. The viewer's own Stories are always kept.
  private async filterAccessibleStories(stories: IStory[], viewerId: string): Promise<IStory[]> {
    if (stories.length === 0) {
      return [];
    }

    const [blockedIds, blockerIds] = await Promise.all([
      this.userBlockRepository.findBlockedIds(viewerId),
      this.userBlockRepository.findBlockerIds(viewerId),
    ]);
    const excluded = new Set([...blockedIds, ...blockerIds]);

    return stories.filter((story) => {
      const authorId = this.resolveStoryAuthorId(story);
      if (authorId === viewerId) {
        return true;
      }
      return !excluded.has(authorId) && this.isPopulatedAuthorPubliclyViewable(story);
    });
  }

  private resolveStoryAuthorId(story: IStory): string {
    const maybeUser = story.userId as unknown as PopulatedStoryUser;
    if (maybeUser && typeof maybeUser === "object" && "_id" in maybeUser) {
      return maybeUser._id.toString();
    }
    return String(story.userId);
  }

  // Uses the populated author fields when present (list + findActiveById both
  // populate isActive/role/deletedAt). Returns true when the author is not
  // populated so a list never silently drops everything; the per-id path
  // (resolveAuthorPubliclyViewable) does an authoritative lookup instead.
  private isPopulatedAuthorPubliclyViewable(story: IStory): boolean {
    const maybeUser = story.userId as unknown as PopulatedStoryUser;
    if (
      !maybeUser
      || typeof maybeUser !== "object"
      || !("_id" in maybeUser)
      || typeof maybeUser.isActive !== "boolean"
    ) {
      return true;
    }
    return maybeUser.isActive === true && maybeUser.role === "user" && !maybeUser.deletedAt;
  }

  private async resolveAuthorPubliclyViewable(story: IStory, authorId: string): Promise<boolean> {
    const maybeUser = story.userId as unknown as PopulatedStoryUser;
    if (
      maybeUser
      && typeof maybeUser === "object"
      && "_id" in maybeUser
      && typeof maybeUser.isActive === "boolean"
    ) {
      return maybeUser.isActive === true && maybeUser.role === "user" && !maybeUser.deletedAt;
    }

    // Author not populated on this record — do an authoritative lookup. A
    // missing user document is treated as "cannot determine" (allowed), the
    // same conservative choice the Moment path makes.
    const author = await this.userRepository.findById(authorId);
    return author === null ? true : isUserPubliclyViewable(author);
  }

  private async toResponse(story: IStory, viewer: AuthUser): Promise<StoryResponse> {
    const author = this.getAuthor(story);
    const [mediaUrl, avatarUrl, interaction] = await Promise.all([
      story.storageKey ? this.createOptionalDownloadUrl(story.storageKey) : Promise.resolve(null),
      author?.avatarKey ? this.createOptionalDownloadUrl(author.avatarKey) : Promise.resolve(null),
      this.storyRepository.getInteraction(story._id.toString(), viewer.id),
    ]);

    return {
      id: story._id.toString(),
      userId: author?.id ?? story.userId.toString(),
      author: author ? { ...author, avatarUrl } : null,
      mediaType: story.mediaType,
      mediaSource: story.mediaSource,
      storageKey: story.storageKey ?? null,
      mediaUrl,
      contentType: story.contentType ?? null,
      durationSeconds: story.durationSeconds,
      caption: story.caption ?? null,
      textContent: story.textContent ?? null,
      textBackground: story.textBackground ?? null,
      textOverlay: story.textOverlay ?? null,
      imageTransform: story.imageTransform ?? null,
      audience: story.audience,
      ...interaction,
      isOwner: (author?.id ?? story.userId.toString()) === viewer.id,
      expiresInSeconds: Math.max(0, Math.ceil((story.expiresAt.getTime() - Date.now()) / 1000)),
      expiresAt: story.expiresAt,
      createdAt: story.createdAt,
      updatedAt: story.updatedAt,
    };
  }

  private getCommentAuthor(value: unknown): StoryAuthorResponse | null {
    const user = value as PopulatedStoryUser;
    if (!user || typeof user !== "object" || !("_id" in user)) return null;
    return { id: user._id.toString(), name: user.name ?? "Mooment User", username: user.username, avatarKey: user.avatarKey ?? null };
  }

  private getAuthor(story: IStory): StoryAuthorResponse | null {
    const maybeUser = story.userId as unknown as PopulatedStoryUser;

    if (!maybeUser || typeof maybeUser !== "object" || !("_id" in maybeUser)) {
      return null;
    }

    return {
      id: maybeUser._id.toString(),
      name: maybeUser.name ?? "Mooment User",
      username: maybeUser.username,
      avatarKey: maybeUser.avatarKey ?? null,
      avatarUrl: null,
    };
  }

  private async createOptionalDownloadUrl(key: string): Promise<string | null> {
    try {
      const download = await this.storageService.createDownloadUrl(key);

      return download.url;
    } catch {
      return null;
    }
  }
}
