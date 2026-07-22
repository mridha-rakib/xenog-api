import { UserBlockModel } from "./user-block.model.js";
import { UserModel } from "./user.model.js";
import type { IUser } from "./user.interface.js";
import { Types } from "mongoose";

export type BlockedUserRecord = Pick<IUser, "_id" | "name" | "username" | "avatarKey"> & {
  blockedAt: Date;
};

export class UserBlockRepository {
  public async block(blockerId: string, blockedId: string): Promise<void> {
    await UserBlockModel.findOneAndUpdate(
      { blockerId, blockedId },
      { $setOnInsert: { blockerId, blockedId } },
      { upsert: true, runValidators: true, setDefaultsOnInsert: true },
    );
  }

  public async unblock(blockerId: string, blockedId: string): Promise<void> {
    await UserBlockModel.deleteOne({ blockerId, blockedId });
  }

  public async isBlocked(blockerId: string, blockedId: string): Promise<boolean> {
    return Boolean(await UserBlockModel.exists({ blockerId, blockedId }));
  }

  public async findBlockedIds(blockerId: string): Promise<string[]> {
    const ids = await UserBlockModel.distinct("blockedId", { blockerId });
    return ids.map((id) => id.toString());
  }

  public async findBlockerIds(blockedId: string): Promise<string[]> {
    const ids = await UserBlockModel.distinct("blockerId", { blockedId });
    return ids.map((id) => id.toString());
  }

  public async findBlockedUsers(
    blockerId: string,
    skip: number,
    limit: number,
  ): Promise<{ users: BlockedUserRecord[]; total: number }> {
    const [result] = await UserBlockModel.aggregate<{
      users: BlockedUserRecord[];
      total: Array<{ count: number }>;
    }>([
      { $match: { blockerId: new Types.ObjectId(blockerId) } },
      { $sort: { createdAt: -1, _id: -1 } },
      {
        $group: {
          _id: "$blockedId",
          blockRecordId: { $first: "$_id" },
          blockedAt: { $first: "$createdAt" },
        },
      },
      {
        $lookup: {
          from: UserModel.collection.name,
          localField: "_id",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: "$user" },
      {
        $match: {
          "user.role": "user",
          "user.isActive": true,
          "user.emailVerified": true,
          "user.deletedAt": null,
          "user.email": { $not: /@deleted\.local$/i },
        },
      },
      { $sort: { blockedAt: -1, blockRecordId: -1 } },
      {
        $facet: {
          users: [
            { $skip: skip },
            { $limit: limit },
            {
              $project: {
                _id: "$user._id",
                name: "$user.name",
                username: "$user.username",
                avatarKey: "$user.avatarKey",
                blockedAt: "$blockedAt",
              },
            },
          ],
          total: [{ $count: "count" }],
        },
      },
    ]);

    return {
      users: result?.users ?? [],
      total: result?.total?.[0]?.count ?? 0,
    };
  }
}
