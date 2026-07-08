import { MomentShareModel } from "./moment-share.model.js";
import type { IMomentShare } from "./moment.interface.js";
import { Types } from "mongoose";

const toObjectIds = (ids: string[]) => ids.map((id) => new Types.ObjectId(id));

export class MomentShareRepository {
  public async share(userId: string, momentId: string, payload: {
    caption?: string | null;
    taggedFriendIds?: string[];
    originalType: "post" | "event";
    originalId: string;
    clientRequestId?: string | null;
  }): Promise<IMomentShare> {
    const share = await MomentShareModel.findOneAndUpdate(
      { userId, momentId },
      { $setOnInsert: { userId, momentId, ...payload } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    );

    return share;
  }

  public async findRecent(limit = 50): Promise<IMomentShare[]> {
    return MomentShareModel.find().sort({ createdAt: -1 }).limit(limit);
  }

  public async findByUserId(userId: string, options: { limit?: number; skip?: number } = {}): Promise<IMomentShare[]> {
    return MomentShareModel.find({ userId })
      .sort({ createdAt: -1, _id: -1 })
      .skip(options.skip ?? 0)
      .limit(options.limit ?? 0);
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
