import { StoryModel } from "./story.model.js";
import type { CreateStoryDto, IStory } from "./story.interface.js";

interface CreateStoryRecord extends CreateStoryDto {
  userId: string;
  expiresAt: Date;
}

export class StoryRepository {
  public async create(payload: CreateStoryRecord): Promise<IStory> {
    return StoryModel.create({
      userId: payload.userId,
      mediaType: payload.mediaType ?? "video",
      mediaSource: payload.mediaSource ?? "upload",
      storageKey: payload.storageKey ?? null,
      contentType: payload.contentType ?? null,
      durationSeconds: payload.durationSeconds,
      caption: payload.caption ?? null,
      textContent: payload.textContent ?? null,
      textBackground: payload.textBackground ?? null,
      textOverlay: payload.textOverlay ?? null,
      audience: "connections",
      expiresAt: payload.expiresAt,
    });
  }

  public async findActiveByViewerNetwork(userIds: string[], now = new Date()): Promise<IStory[]> {
    if (userIds.length === 0) {
      return [];
    }

    return StoryModel.find({
      userId: { $in: userIds },
      expiresAt: { $gt: now },
    })
      .populate("userId", "name username avatarKey")
      .sort({ createdAt: -1 });
  }

  public async findActiveByUserId(userId: string, now = new Date()): Promise<IStory[]> {
    return StoryModel.find({
      userId,
      expiresAt: { $gt: now },
    })
      .populate("userId", "name username avatarKey")
      .sort({ createdAt: -1 });
  }
}
