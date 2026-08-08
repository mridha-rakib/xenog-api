import { Types } from "mongoose";
import { MomentReactionModel } from "./moment-reaction.model.js";
import type { IMomentReaction } from "./moment.interface.js";

const toObjectIds = (ids: string[]) => ids.map((id) => new Types.ObjectId(id));

export class MomentReactionRepository {
  public async toggleLike(userId: string, momentId: string): Promise<{ isLiked: boolean; reaction: IMomentReaction | null }> {
    const existingReaction = await MomentReactionModel.findOne({ userId, momentId, type: "like" });

    if (existingReaction) {
      await MomentReactionModel.deleteOne({ _id: existingReaction._id });

      return {
        isLiked: false,
        reaction: null,
      };
    }

    const reaction = await MomentReactionModel.create({
      userId,
      momentId,
      type: "like",
    });

    return {
      isLiked: true,
      reaction,
    };
  }

  public async countByMomentId(momentId: string): Promise<number> {
    return MomentReactionModel.countDocuments({ momentId, type: "like" });
  }

  public async deleteByMomentId(momentId: string): Promise<void> {
    await MomentReactionModel.deleteMany({ momentId });
  }

  public async countByMomentIds(momentIds: string[]): Promise<Map<string, number>> {
    if (momentIds.length === 0) {
      return new Map();
    }

    const counts = await MomentReactionModel.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { momentId: { $in: toObjectIds(momentIds) }, type: "like" } },
      { $group: { _id: "$momentId", count: { $sum: 1 } } },
    ]);

    return new Map(counts.map((item) => [item._id.toString(), item.count]));
  }

  public async findLikedMomentIds(userId: string, momentIds: string[]): Promise<Set<string>> {
    if (momentIds.length === 0) {
      return new Set();
    }

    const reactions = await MomentReactionModel.find({
      userId,
      momentId: { $in: momentIds },
      type: "like",
    }).select("momentId");

    return new Set(reactions.map((reaction) => reaction.momentId.toString()));
  }

  public async findLikedUserIdsByMomentIds(
    momentIds: string[],
    userIds: string[],
  ): Promise<Map<string, string[]>> {
    const uniqueMomentIds = [...new Set(momentIds.filter(Boolean))];
    const uniqueUserIds = [...new Set(userIds.filter(Boolean))];

    if (uniqueMomentIds.length === 0 || uniqueUserIds.length === 0) {
      return new Map();
    }

    const reactions = await MomentReactionModel.find({
      momentId: { $in: toObjectIds(uniqueMomentIds) },
      userId: { $in: toObjectIds(uniqueUserIds) },
      type: "like",
    })
      .select("momentId userId")
      .sort({ createdAt: -1, _id: -1 });

    const userIdsByMomentId = new Map<string, string[]>();
    const seenKeys = new Set<string>();

    for (const reaction of reactions) {
      const momentId = reaction.momentId.toString();
      const userId = reaction.userId.toString();
      const key = `${momentId}:${userId}`;

      if (seenKeys.has(key)) {
        continue;
      }

      const existing = userIdsByMomentId.get(momentId) ?? [];
      existing.push(userId);
      userIdsByMomentId.set(momentId, existing);
      seenKeys.add(key);
    }

    return userIdsByMomentId;
  }
}
