import { UserFollowModel } from "./user-follow.model.js";
import type { IUserFollow } from "./user.interface.js";

export class UserFollowRepository {
  public async follow(followerId: string, followingId: string): Promise<IUserFollow> {
    return UserFollowModel.findOneAndUpdate(
      { followerId, followingId },
      { $setOnInsert: { followerId, followingId } },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    );
  }

  public async unfollow(followerId: string, followingId: string): Promise<void> {
    await UserFollowModel.findOneAndDelete({ followerId, followingId });
  }

  public async isFollowing(followerId: string, followingId: string): Promise<boolean> {
    const relation = await UserFollowModel.exists({ followerId, followingId });

    return Boolean(relation);
  }

  public async hasAnyFollowRelation(userId: string, targetUserId: string): Promise<boolean> {
    const relation = await UserFollowModel.exists({
      $or: [
        { followerId: userId, followingId: targetUserId },
        { followerId: targetUserId, followingId: userId },
      ],
    });

    return Boolean(relation);
  }

  public async findFollowingIds(followerId: string): Promise<string[]> {
    const followingIds = await UserFollowModel.distinct("followingId", { followerId });

    return followingIds.map((id) => id.toString());
  }

  public async findFollowerIds(followingId: string, limit: number): Promise<string[]> {
    const follows = await UserFollowModel.find({ followingId })
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .select("followerId");

    return follows.map((follow) => follow.followerId.toString());
  }

  public async findFollowingIdsForList(followerId: string, limit: number): Promise<string[]> {
    const follows = await UserFollowModel.find({ followerId })
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .select("followingId");

    return follows.map((follow) => follow.followingId.toString());
  }

  public async findMutualFriendIds(userId: string): Promise<string[]> {
    const [followingIds, followerIds] = await Promise.all([
      UserFollowModel.distinct("followingId", { followerId: userId }),
      UserFollowModel.distinct("followerId", { followingId: userId }),
    ]);
    const followerIdSet = new Set(followerIds.map((id) => id.toString()));

    return followingIds.map((id) => id.toString()).filter((id) => followerIdSet.has(id));
  }

  public async countFollowers(userId: string): Promise<number> {
    return UserFollowModel.countDocuments({ followingId: userId });
  }

  public async countFollowing(userId: string): Promise<number> {
    return UserFollowModel.countDocuments({ followerId: userId });
  }
}
