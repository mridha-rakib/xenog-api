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
}
