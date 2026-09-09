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

  public async removeBetween(userId: string, targetUserId: string): Promise<void> {
    await UserFollowModel.deleteMany({
      $or: [
        { followerId: userId, followingId: targetUserId },
        { followerId: targetUserId, followingId: userId },
      ],
    });
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

  public async findFollowerIds(followingId: string, limit: number, skip = 0): Promise<string[]> {
    const follows = await UserFollowModel.find({ followingId })
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .select("followerId");

    return follows.map((follow) => follow.followerId.toString());
  }

  public async findFollowingIdsForList(followerId: string, limit: number, skip = 0): Promise<string[]> {
    const follows = await UserFollowModel.find({ followerId })
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
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

  /** Every user id that follows `userId` (unbounded distinct, mirrors `findFollowingIds`). */
  public async findFollowerIdsForUser(userId: string): Promise<string[]> {
    const followerIds = await UserFollowModel.distinct("followerId", { followingId: userId });

    return followerIds.map((id) => id.toString());
  }

  /**
   * Batched shared-connection counts for People search.
   *
   * A "connection" is a mutual-follow. Given the viewer's mutual-follow set
   * (`viewerConnectionIds`) and a bounded list of `candidateIds`, returns a
   * Map<candidateId, count> where count = |{ x in viewerConnectionIds : x mutually follows candidate }|.
   *
   * Two batched edge queries only — never one query per candidate.
   */
  public async findSharedConnectionCounts(
    viewerConnectionIds: string[],
    candidateIds: string[],
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();

    if (viewerConnectionIds.length === 0 || candidateIds.length === 0) {
      return counts;
    }

    const [inboundEdges, outboundEdges] = await Promise.all([
      // viewerConnection -> candidate
      UserFollowModel.find({
        followerId: { $in: viewerConnectionIds },
        followingId: { $in: candidateIds },
      }).select("followerId followingId"),
      // candidate -> viewerConnection
      UserFollowModel.find({
        followerId: { $in: candidateIds },
        followingId: { $in: viewerConnectionIds },
      }).select("followerId followingId"),
    ]);

    const followsCandidate = new Map<string, Set<string>>();
    for (const edge of inboundEdges) {
      const candidateId = edge.followingId.toString();
      const connectionId = edge.followerId.toString();
      const set = followsCandidate.get(candidateId) ?? new Set<string>();
      set.add(connectionId);
      followsCandidate.set(candidateId, set);
    }

    for (const edge of outboundEdges) {
      const candidateId = edge.followerId.toString();
      const connectionId = edge.followingId.toString();
      if (followsCandidate.get(candidateId)?.has(connectionId)) {
        counts.set(candidateId, (counts.get(candidateId) ?? 0) + 1);
      }
    }

    return counts;
  }

  public async countFollowers(userId: string): Promise<number> {
    return UserFollowModel.countDocuments({ followingId: userId });
  }

  public async countFollowing(userId: string): Promise<number> {
    return UserFollowModel.countDocuments({ followerId: userId });
  }
}
