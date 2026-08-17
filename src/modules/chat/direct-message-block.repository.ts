import { Types } from "mongoose";
import { DirectMessageBlockModel } from "./direct-message-block.model.js";
import { UserModel } from "../user/user.model.js";
import type { IUser } from "../user/user.interface.js";

export type MessageBlockedUserRecord = Pick<IUser, "_id" | "name" | "username" | "avatarKey"> & {
  blockedAt: Date;
};

export class DirectMessageBlockRepository {
  public async block(blockerId: string, blockedId: string): Promise<void> {
    await DirectMessageBlockModel.findOneAndUpdate(
      { blockerId, blockedId },
      { $setOnInsert: { blockerId, blockedId } },
      { upsert: true, runValidators: true, setDefaultsOnInsert: true },
    );
  }

  public async unblock(blockerId: string, blockedId: string): Promise<void> {
    await DirectMessageBlockModel.deleteOne({ blockerId, blockedId });
  }

  public async isBlocked(blockerId: string, blockedId: string): Promise<boolean> {
    return Boolean(await DirectMessageBlockModel.exists({ blockerId, blockedId }));
  }

  public async findBlockedUsers(
    blockerId: string,
    skip: number,
    limit: number,
  ): Promise<{ users: MessageBlockedUserRecord[]; total: number }> {
    const [result] = await DirectMessageBlockModel.aggregate<{
      users: MessageBlockedUserRecord[];
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
