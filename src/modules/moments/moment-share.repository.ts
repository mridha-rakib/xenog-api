import { MomentShareModel } from "./moment-share.model.js";
import type { IMomentShare } from "./moment.interface.js";
import { Types } from "mongoose";

const toObjectIds = (ids: string[]) => ids.map((id) => new Types.ObjectId(id));

export class MomentShareRepository {
  public async share(userId: string, momentId: string): Promise<IMomentShare> {
    const share = await MomentShareModel.findOneAndUpdate(
      { userId, momentId },
      { $setOnInsert: { userId, momentId } },
      { new: true, upsert: true, runValidators: true },
    );

    return share;
  }

  public async findByUserId(userId: string): Promise<IMomentShare[]> {
    return MomentShareModel.find({ userId }).sort({ createdAt: -1 });
  }

  public async countByUserId(userId: string): Promise<number> {
    return MomentShareModel.countDocuments({ userId });
  }

  public async countByMomentId(momentId: string): Promise<number> {
    return MomentShareModel.countDocuments({ momentId });
  }

  public async deleteByMomentId(momentId: string): Promise<void> {
    await MomentShareModel.deleteMany({ momentId });
  }

  public async countByMomentIds(momentIds: string[]): Promise<Map<string, number>> {
    if (momentIds.length === 0) {
      return new Map();
    }

    const counts = await MomentShareModel.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { momentId: { $in: toObjectIds(momentIds) } } },
      { $group: { _id: "$momentId", count: { $sum: 1 } } },
    ]);

    return new Map(counts.map((item) => [item._id.toString(), item.count]));
  }
}
