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

  public async findFollowingIds(followerId: string): Promise<string[]> {
    const followingIds = await UserFollowModel.distinct("followingId", { followerId });

    return followingIds.map((id) => id.toString());
  }

  public async findMutualFriendIds(userId: string): Promise<string[]> {
    const [followingIds, followerIds] = await Promise.all([
      UserFollowModel.distinct("followingId", { followerId: userId }),
      UserFollowModel.distinct("followerId", { followingId: userId }),
    ]);
    const followerIdSet = new Set(followerIds.map((id) => id.toString()));

    return followingIds.map((id) => id.toString()).filter((id) => followerIdSet.has(id));
  }
}
