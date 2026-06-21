import { Types } from "mongoose";
import { MomentCommentReactionModel } from "./moment-comment-reaction.model.js";

export class MomentCommentReactionRepository {
  public async toggleLike(userId: string, commentId: string): Promise<{ isLiked: boolean }> {
    const existing = await MomentCommentReactionModel.findOne({ userId, commentId, type: "like" });

    if (existing) {
      await MomentCommentReactionModel.deleteOne({ _id: existing._id });
      return { isLiked: false };
    }

    await MomentCommentReactionModel.create({ userId, commentId, type: "like" });
    return { isLiked: true };
  }

  public async countByCommentId(commentId: string): Promise<number> {
    return MomentCommentReactionModel.countDocuments({ commentId, type: "like" });
  }

  public async countByCommentIds(commentIds: string[]): Promise<Map<string, number>> {
    if (commentIds.length === 0) {
      return new Map();
    }

    const counts = await MomentCommentReactionModel.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { commentId: { $in: commentIds.map((id) => new Types.ObjectId(id)) }, type: "like" } },
      { $group: { _id: "$commentId", count: { $sum: 1 } } },
    ]);

    return new Map(counts.map((item) => [item._id.toString(), item.count]));
  }

  public async findLikedCommentIds(userId: string, commentIds: string[]): Promise<Set<string>> {
    if (commentIds.length === 0) {
      return new Set();
    }

    const reactions = await MomentCommentReactionModel.find({
      userId,
      commentId: { $in: commentIds.map((id) => new Types.ObjectId(id)) },
      type: "like",
    }).select("commentId");

    return new Set(reactions.map((r) => r.commentId.toString()));
  }

  public async deleteByCommentIds(commentIds: string[]): Promise<void> {
    if (commentIds.length === 0) {
      return;
    }

    await MomentCommentReactionModel.deleteMany({
      commentId: { $in: commentIds.map((id) => new Types.ObjectId(id)) },
    });
  }
}
