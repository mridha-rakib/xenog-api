import { MomentShareModel } from "./moment-share.model.js";
import type { IMomentShare } from "./moment.interface.js";
import { Types } from "mongoose";

const toObjectIds = (ids: string[]) => ids.map((id) => new Types.ObjectId(id));

export class MomentShareRepository {
  // rawResult surfaces the driver's lastErrorObject.upserted (only set when a
  // new document was inserted) so callers can distinguish a genuinely new
  // share/repost from an idempotent no-op on an already-existing share —
  // needed so notification side effects fire only for the former.
  public async share(userId: string, momentId: string, payload: {
    caption?: string | null;
    taggedFriendIds?: string[];
    originalType: "post" | "event";
    originalId: string;
    clientRequestId?: string | null;
  }): Promise<{ share: IMomentShare; isNew: boolean }> {
    const result = await MomentShareModel.findOneAndUpdate(
      { userId, momentId },
      { $setOnInsert: { userId, momentId, ...payload } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true, includeResultMetadata: true },
    );

    return {
      share: result.value as IMomentShare,
      isNew: Boolean(result.lastErrorObject?.upserted),
    };
  }

  public async findById(shareId: string): Promise<IMomentShare | null> {
    return MomentShareModel.findById(shareId);
  }

  // Targeted $set of only caption. Distinct from share() above (which is a
  // create-only upsert via $setOnInsert and is a no-op on an existing share) —
  // this is the sole write path for editing repost commentary. Scoped to
  // {_id, userId} so only the share's owner can ever update it, and never
  // touches taggedFriendIds/momentId/originalType/originalId/clientRequestId/
  // createdAt/userId. Mongoose's timestamps:true advances updatedAt naturally.
  public async updateCaptionForUser(
    shareId: string,
    userId: string,
    caption: string | null,
  ): Promise<IMomentShare | null> {
    return MomentShareModel.findOneAndUpdate(
      { _id: shareId, userId },
      { $set: { caption } },
      { new: true, runValidators: true },
    );
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

  // Mirrors MomentReactionRepository.findLikedUserIdsByMomentIds — one
  // batched query for Smart Feed's followed/mutual repost signal, scoped to
  // a caller-supplied relationship-relevant user set (never all reposters).
  public async findReposterUserIdsByMomentIds(
    momentIds: string[],
    userIds: string[],
  ): Promise<Map<string, string[]>> {
    const uniqueMomentIds = [...new Set(momentIds.filter(Boolean))];
    const uniqueUserIds = [...new Set(userIds.filter(Boolean))];

    if (uniqueMomentIds.length === 0 || uniqueUserIds.length === 0) {
      return new Map();
    }

    const shares = await MomentShareModel.find({
      momentId: { $in: toObjectIds(uniqueMomentIds) },
      userId: { $in: toObjectIds(uniqueUserIds) },
    }).select("momentId userId");

    const userIdsByMomentId = new Map<string, string[]>();
    const seenKeys = new Set<string>();

    for (const share of shares) {
      const momentId = share.momentId.toString();
      const userId = share.userId.toString();
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
