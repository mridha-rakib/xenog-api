import { StoryModel } from "./story.model.js";
import type { CreateStoryDto, IStory } from "./story.interface.js";
import { StoryCommentModel } from "./story-comment.model.js";
import { StoryReactionModel } from "./story-reaction.model.js";
import { StoryViewModel } from "./story-view.model.js";

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

  public async findAllActive(now = new Date()): Promise<IStory[]> {
    return StoryModel.find({ expiresAt: { $gt: now } })
      .populate("userId", "name username avatarKey")
      .sort({ createdAt: -1 });
  }

  public async findActiveById(id: string, now = new Date()): Promise<IStory | null> {
    return StoryModel.findOne({ _id: id, expiresAt: { $gt: now } }).populate("userId", "name username avatarKey");
  }

  public async deleteByIdForUser(id: string, userId: string): Promise<IStory | null> {
    return StoryModel.findOneAndDelete({ _id: id, userId });
  }

  public async toggleReaction(userId: string, storyId: string, expiresAt: Date): Promise<boolean> {
    const existing = await StoryReactionModel.findOne({ userId, storyId, type: "like" });
    if (existing) {
      await existing.deleteOne();
      return false;
    }
    await StoryReactionModel.create({ userId, storyId, type: "like", expiresAt });
    return true;
  }

  public async recordView(userId: string, storyId: string, expiresAt: Date): Promise<void> {
    await StoryViewModel.updateOne({ userId, storyId }, { $setOnInsert: { userId, storyId, expiresAt } }, { upsert: true });
  }

  public async getInteraction(storyId: string, userId: string) {
    const [viewsCount, reactionsCount, commentsCount, reaction] = await Promise.all([
      StoryViewModel.countDocuments({ storyId }),
      StoryReactionModel.countDocuments({ storyId, type: "like" }),
      StoryCommentModel.countDocuments({ storyId }),
      StoryReactionModel.exists({ storyId, userId, type: "like" }),
    ]);
    return { viewsCount, reactionsCount, commentsCount, isReacted: Boolean(reaction) };
  }

  public async createComment(storyId: string, userId: string, text: string, expiresAt: Date, parentCommentId?: string | null) {
    return StoryCommentModel.create({ storyId, userId, text, expiresAt, parentCommentId: parentCommentId ?? null });
  }

  public async findComments(storyId: string) {
    return StoryCommentModel.find({ storyId }).populate("userId", "name username avatarKey").sort({ createdAt: 1 });
  }

  public async deleteInteractions(storyId: string): Promise<void> {
    await Promise.all([
      StoryViewModel.deleteMany({ storyId }),
      StoryReactionModel.deleteMany({ storyId }),
      StoryCommentModel.deleteMany({ storyId }),
    ]);
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
