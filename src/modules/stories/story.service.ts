import httpStatus from "http-status";
import type { AuthUser } from "../auth/auth.interface.js";
import { StorageService } from "../storage/storage.service.js";
import { UserFollowRepository } from "../user/user-follow.repository.js";
import { AppError } from "../../core/errors/app-error.js";
import { StoryRepository } from "./story.repository.js";
import type { CreateStoryDto, IStory, StoryAuthorResponse, StoryResponse } from "./story.interface.js";

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
  ) {}

  public async createStory(payload: CreateStoryDto, user: AuthUser): Promise<StoryResponse> {
    if (payload.durationSeconds > MAX_STORY_DURATION_SECONDS) {
      throw new AppError("Stories can be up to 15 seconds long", httpStatus.BAD_REQUEST);
    }

    if (!payload.contentType.toLowerCase().startsWith("video/")) {
      throw new AppError("Stories must be video files", httpStatus.BAD_REQUEST);
    }

    const expiresAt = new Date(Date.now() + STORY_TTL_HOURS * 60 * 60 * 1000);
    const story = await this.storyRepository.create({
      userId: user.id,
      mediaSource: payload.mediaSource ?? "upload",
      storageKey: payload.storageKey,
      contentType: payload.contentType,
      durationSeconds: payload.durationSeconds,
      caption: payload.caption?.trim() || null,
      expiresAt,
    });

    return this.toResponse(story);
  }

  public async listFeedStories(user: AuthUser): Promise<StoryResponse[]> {
    const [followingIds, friendIds] = await Promise.all([
      this.userFollowRepository.findFollowingIds(user.id),
      this.userFollowRepository.findMutualFriendIds(user.id),
    ]);
    const visibleUserIds = [...new Set([user.id, ...followingIds, ...friendIds])];
    const stories = await this.storyRepository.findActiveByViewerNetwork(visibleUserIds);

    return Promise.all(stories.map((story) => this.toResponse(story)));
  }

  public async listMyStories(user: AuthUser): Promise<StoryResponse[]> {
    const stories = await this.storyRepository.findActiveByUserId(user.id);

    return Promise.all(stories.map((story) => this.toResponse(story)));
  }

  private async toResponse(story: IStory): Promise<StoryResponse> {
    const author = this.getAuthor(story);
    const [mediaUrl, avatarUrl] = await Promise.all([
      this.createOptionalDownloadUrl(story.storageKey),
      author?.avatarKey ? this.createOptionalDownloadUrl(author.avatarKey) : Promise.resolve(null),
    ]);

    return {
      id: story._id.toString(),
      userId: author?.id ?? story.userId.toString(),
      author: author ? { ...author, avatarUrl } : null,
      mediaType: story.mediaType,
      mediaSource: story.mediaSource,
      storageKey: story.storageKey,
      mediaUrl,
      contentType: story.contentType,
      durationSeconds: story.durationSeconds,
      caption: story.caption ?? null,
      audience: story.audience,
      expiresAt: story.expiresAt,
      createdAt: story.createdAt,
      updatedAt: story.updatedAt,
    };
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
