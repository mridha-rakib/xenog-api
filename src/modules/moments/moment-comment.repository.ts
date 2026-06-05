import { Types } from "mongoose";
import { MomentCommentModel } from "./moment-comment.model.js";
import type { CreateMomentCommentDto, IMomentComment } from "./moment.interface.js";

const toObjectIds = (ids: string[]) => ids.map((id) => new Types.ObjectId(id));

interface CreateMomentCommentRecord extends CreateMomentCommentDto {
  userId: string;
  momentId: string;
}

export class MomentCommentRepository {
  public async create(payload: CreateMomentCommentRecord): Promise<IMomentComment> {
    return MomentCommentModel.create({
      userId: payload.userId,
      momentId: payload.momentId,
      parentCommentId: payload.parentCommentId ?? null,
      text: payload.text,
    });
  }

  public async findById(id: string): Promise<IMomentComment | null> {
    return MomentCommentModel.findById(id);
  }

  public async findByMomentId(momentId: string): Promise<IMomentComment[]> {
    return MomentCommentModel.find({ momentId }).sort({ createdAt: 1 });
  }

  public async countByMomentId(momentId: string): Promise<number> {
    return MomentCommentModel.countDocuments({ momentId });
  }

  public async deleteByMomentId(momentId: string): Promise<void> {
    await MomentCommentModel.deleteMany({ momentId });
  }

  public async countByMomentIds(momentIds: string[]): Promise<Map<string, number>> {
    if (momentIds.length === 0) {
      return new Map();
    }

    const counts = await MomentCommentModel.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { momentId: { $in: toObjectIds(momentIds) } } },
      { $group: { _id: "$momentId", count: { $sum: 1 } } },
    ]);

    return new Map(counts.map((item) => [item._id.toString(), item.count]));
  }
}
