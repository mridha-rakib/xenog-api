import httpStatus from "http-status";
import type { AuthUser } from "../auth/auth.interface.js";
import { StorageService } from "../storage/storage.service.js";
import { UserFollowRepository } from "../user/user-follow.repository.js";
import { AppError } from "../../core/errors/app-error.js";
import { StoryRepository } from "./story.repository.js";
import type { CreateStoryDto, IStory, StoryAuthorResponse, StoryResponse } from "./story.interface.js";
import { MomentRepository } from "../moments/moment.repository.js";

const STORY_TTL_HOURS = 24;
const MAX_STORY_DURATION_SECONDS = 15;

type PopulatedStoryUser = {
  _id: { toString: () => string };
  name?: string;
  username?: string;
  avatarKey?: string | null;
};

export class StoryService {
  public constructor(
    private readonly storyRepository = new StoryRepository(),
    private readonly userFollowRepository = new UserFollowRepository(),
    private readonly storageService = new StorageService(),
    private readonly momentRepository = new MomentRepository(),
  ) {}

  public async createStory(payload: CreateStoryDto, user: AuthUser): Promise<StoryResponse> {
    const mediaType = payload.mediaType ?? "video";

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
      expiresAt,
    });

    return this.toResponse(story, user);
  }

  public async listFeedStories(user: AuthUser): Promise<StoryResponse[]> {
    const [followingIds, friendIds] = await Promise.all([
      this.userFollowRepository.findFollowingIds(user.id),
      this.userFollowRepository.findMutualFriendIds(user.id),
    ]);
    const visibleUserIds = [...new Set([user.id, ...followingIds, ...friendIds])];
    const stories = await this.storyRepository.findActiveByViewerNetwork(visibleUserIds);

    return Promise.all(stories.map((story) => this.toResponse(story, user)));
  }

  public async listMyStories(user: AuthUser): Promise<StoryResponse[]> {
    const stories = await this.storyRepository.findActiveByUserId(user.id);

    return Promise.all(stories.map((story) => this.toResponse(story, user)));
  }

  public async listUserStories(userId: string, viewer: AuthUser): Promise<StoryResponse[]> {
    const stories = await this.storyRepository.findActiveByUserId(userId);
    return Promise.all(stories.map((story) => this.toResponse(story, viewer)));
  }

  public async listDiscoverStories(user: AuthUser): Promise<StoryResponse[]> {
    const stories = await this.storyRepository.findAllActive();
    return Promise.all(stories.map((story) => this.toResponse(story, user)));
  }

  public async listFriendStories(user: AuthUser): Promise<StoryResponse[]> {
    const friendIds = await this.userFollowRepository.findMutualFriendIds(user.id);
    const stories = await this.storyRepository.findActiveByViewerNetwork(friendIds);
    return Promise.all(stories.map((story) => this.toResponse(story, user)));
  }

  public async getStoryDetails(id: string, user: AuthUser): Promise<StoryResponse> {
    const story = await this.getActiveStory(id);
    return this.toResponse(story, user);
  }

  public async recordView(id: string, user: AuthUser) {
    const story = await this.getActiveStory(id);
    await this.storyRepository.recordView(user.id, id, story.expiresAt);
    return this.storyRepository.getInteraction(id, user.id);
  }

  public async toggleReaction(id: string, user: AuthUser) {
    const story = await this.getActiveStory(id);
    await this.storyRepository.toggleReaction(user.id, id, story.expiresAt);
    return this.storyRepository.getInteraction(id, user.id);
  }

  public async deleteStory(id: string, user: AuthUser): Promise<void> {
    const deleted = await this.storyRepository.deleteByIdForUser(id, user.id);
    if (!deleted) throw new AppError("Story not found", httpStatus.NOT_FOUND);
    await this.storyRepository.deleteInteractions(id);
  }

  public async listComments(id: string, _user: AuthUser) {
    await this.getActiveStory(id);
    const comments = await this.storyRepository.findComments(id);
    const responses = await Promise.all(comments.map(async (comment) => {
      const author = this.getCommentAuthor(comment.userId);
      return {
        id: comment._id.toString(), storyId: id,
        parentCommentId: comment.parentCommentId?.toString() ?? null,
        author: author ? { ...author, avatarUrl: author.avatarKey ? await this.createOptionalDownloadUrl(author.avatarKey) : null } : null,
        text: comment.text, likesCount: 0, isLiked: false, replies: [],
        createdAt: comment.createdAt, updatedAt: comment.updatedAt,
      };
    }));
    const byParent = new Map<string, typeof responses>();
    responses.forEach((comment) => {
      if (!comment.parentCommentId) return;
      byParent.set(comment.parentCommentId, [...(byParent.get(comment.parentCommentId) ?? []), comment]);
    });
    return responses.filter((comment) => !comment.parentCommentId).map((comment) => ({ ...comment, replies: byParent.get(comment.id) ?? [] }));
  }

  public async createComment(id: string, user: AuthUser, payload: { text: string; parentCommentId?: string | null }) {
    const story = await this.getActiveStory(id);
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
    const story = await this.getActiveStory(id);
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

  private async getActiveStory(id: string): Promise<IStory> {
    const story = await this.storyRepository.findActiveById(id);
    if (!story) throw new AppError("Story not found or expired", httpStatus.NOT_FOUND);
    return story;
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
