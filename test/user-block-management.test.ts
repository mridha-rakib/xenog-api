import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import type { AuthUser } from "../src/modules/auth/auth.interface.js";
import { authenticate } from "../src/core/middlewares/auth.middleware.js";
import type { IUser } from "../src/modules/user/user.interface.js";
import { UserService } from "../src/modules/user/user.service.js";
import type { BlockedUserRecord } from "../src/modules/user/user-block.repository.js";

type BlockRecord = {
  blockerId: string;
  blockedId: string;
  createdAt: Date;
  recordId: string;
};

type FollowRecord = {
  followerId: string;
  followingId: string;
};

const createAuthUser = (id: string, name = "Viewer"): AuthUser => ({
  id,
  name,
  username: name.toLowerCase(),
  email: `${id}@example.test`,
  accountType: "personal",
  currentLocationSharingEnabled: false,
  notificationsEnabled: true,
  role: "user",
  isActive: true,
  emailVerified: true,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
});

const createUser = (
  id: string,
  name: string,
  overrides: Partial<IUser> = {},
): IUser => ({
  _id: new Types.ObjectId(id),
  name,
  username: name.toLowerCase().replace(/\s+/g, "_"),
  email: `${name.toLowerCase().replace(/\s+/g, ".")}@example.test`,
  accountType: "personal",
  role: "user",
  isActive: true,
  emailVerified: true,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...overrides,
});

const createService = (options: {
  users: IUser[];
  blocks?: BlockRecord[];
  follows?: FollowRecord[];
}) => {
  const usersById = new Map(options.users.map((user) => [user._id.toString(), user]));
  const blocks = [...(options.blocks ?? [])];
  const follows = [...(options.follows ?? [])];

  const blockRepository = {
    block: async (blockerId: string, blockedId: string) => {
      const exists = blocks.some((block) => block.blockerId === blockerId && block.blockedId === blockedId);

      if (!exists) {
        blocks.push({
          blockerId,
          blockedId,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, blocks.length)),
          recordId: new Types.ObjectId().toString(),
        });
      }
    },
    unblock: async (blockerId: string, blockedId: string) => {
      const index = blocks.findIndex((block) => block.blockerId === blockerId && block.blockedId === blockedId);

      if (index !== -1) {
        blocks.splice(index, 1);
      }
    },
    isBlocked: async (blockerId: string, blockedId: string) =>
      blocks.some((block) => block.blockerId === blockerId && block.blockedId === blockedId),
    findBlockedIds: async (blockerId: string) =>
      [...new Set(blocks.filter((block) => block.blockerId === blockerId).map((block) => block.blockedId))],
    findBlockerIds: async (blockedId: string) =>
      [...new Set(blocks.filter((block) => block.blockedId === blockedId).map((block) => block.blockerId))],
    findBlockedUsers: async (blockerId: string, skip: number, limit: number) => {
      const recordsByBlockedId = new Map<string, BlockRecord>();

      blocks
        .filter((block) => block.blockerId === blockerId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.recordId.localeCompare(a.recordId))
        .forEach((block) => {
          if (!recordsByBlockedId.has(block.blockedId)) {
            recordsByBlockedId.set(block.blockedId, block);
          }
        });

      const activeRecords = [...recordsByBlockedId.values()].filter((block) => {
        const user = usersById.get(block.blockedId);
        return Boolean(
          user
          && user.role === "user"
          && user.isActive
          && user.emailVerified
          && !user.deletedAt
          && !user.email.endsWith("@deleted.local"),
        );
      });
      const pageRecords = activeRecords.slice(skip, skip + limit);
      const responseUsers: BlockedUserRecord[] = pageRecords.map((block) => {
        const user = usersById.get(block.blockedId);
        if (!user) {
          throw new Error("Missing test user");
        }

        return {
          _id: user._id,
          name: user.name,
          username: user.username,
          avatarKey: user.avatarKey,
          blockedAt: block.createdAt,
        };
      });

      return {
        users: responseUsers,
        total: activeRecords.length,
      };
    },
  };

  const followRepository = {
    follow: async (followerId: string, followingId: string) => {
      if (!follows.some((follow) => follow.followerId === followerId && follow.followingId === followingId)) {
        follows.push({ followerId, followingId });
      }
    },
    unfollow: async (followerId: string, followingId: string) => {
      const index = follows.findIndex((follow) => follow.followerId === followerId && follow.followingId === followingId);
      if (index !== -1) {
        follows.splice(index, 1);
      }
    },
    removeBetween: async (userId: string, targetUserId: string) => {
      for (let index = follows.length - 1; index >= 0; index -= 1) {
        const follow = follows[index];
        if (
          (follow.followerId === userId && follow.followingId === targetUserId)
          || (follow.followerId === targetUserId && follow.followingId === userId)
        ) {
          follows.splice(index, 1);
        }
      }
    },
    isFollowing: async (followerId: string, followingId: string) =>
      follows.some((follow) => follow.followerId === followerId && follow.followingId === followingId),
    findFollowingIds: async (followerId: string) =>
      follows.filter((follow) => follow.followerId === followerId).map((follow) => follow.followingId),
    findFollowerIds: async (followingId: string, limit: number, skip = 0) =>
      follows
        .filter((follow) => follow.followingId === followingId)
        .slice(skip, skip + limit)
        .map((follow) => follow.followerId),
    findFollowingIdsForList: async (followerId: string, limit: number, skip = 0) =>
      follows
        .filter((follow) => follow.followerId === followerId)
        .slice(skip, skip + limit)
        .map((follow) => follow.followingId),
    countFollowers: async (userId: string) => follows.filter((follow) => follow.followingId === userId).length,
    countFollowing: async (userId: string) => follows.filter((follow) => follow.followerId === userId).length,
  };

  const service = new UserService(
    {
      findById: async (id: string) => usersById.get(id) ?? null,
      findActiveUsersByIds: async (userIds: string[]) =>
        userIds.map((id) => usersById.get(id)).filter((user): user is IUser => Boolean(user)),
      findSuggestedUsers: async (excludedIds: string[], limit: number) =>
        [...usersById.values()].filter((user) => !excludedIds.includes(user._id.toString())).slice(0, limit),
      findByIds: async (userIds: string[]) =>
        userIds.map((id) => usersById.get(id)).filter((user): user is IUser => Boolean(user)),
    } as never,
    followRepository as never,
    blockRepository as never,
    {
      createDownloadUrl: async (key: string) => ({ url: `https://cdn.example.test/${key}` }),
    } as never,
    {
      findManyByIds: async () => [],
    } as never,
    {} as never,
    {
      countByHostUserId: async () => 0,
      findByHostUserId: async () => [],
    } as never,
  );

  return { service, blocks, follows };
};

test("authenticated user can list only outbound blocked users with pagination and safe fields", async () => {
  const viewerId = new Types.ObjectId().toString();
  const blockedAId = new Types.ObjectId().toString();
  const blockedBId = new Types.ObjectId().toString();
  const inboundBlockerId = new Types.ObjectId().toString();
  const deletedUserId = new Types.ObjectId().toString();
  const { service } = createService({
    users: [
      createUser(blockedAId, "Blocked A", { avatarKey: "avatars/a.jpg" }),
      createUser(blockedBId, "Blocked B"),
      createUser(inboundBlockerId, "Inbound Blocker"),
      createUser(deletedUserId, "Deleted User", {
        isActive: false,
        emailVerified: false,
        deletedAt: new Date("2026-01-02T00:00:00.000Z"),
        email: `deleted-${deletedUserId}@deleted.local`,
      }),
    ],
    blocks: [
      { blockerId: viewerId, blockedId: blockedAId, createdAt: new Date("2026-01-04T00:00:00.000Z"), recordId: "3" },
      { blockerId: viewerId, blockedId: blockedAId, createdAt: new Date("2026-01-03T00:00:00.000Z"), recordId: "2" },
      { blockerId: viewerId, blockedId: deletedUserId, createdAt: new Date("2026-01-02T00:00:00.000Z"), recordId: "1" },
      { blockerId: inboundBlockerId, blockedId: viewerId, createdAt: new Date("2026-01-05T00:00:00.000Z"), recordId: "4" },
      { blockerId: viewerId, blockedId: blockedBId, createdAt: new Date("2026-01-01T00:00:00.000Z"), recordId: "0" },
    ],
  });

  const firstPage = await service.listBlockedUsers(createAuthUser(viewerId), { page: 1, limit: 1 });
  const secondPage = await service.listBlockedUsers(createAuthUser(viewerId), { page: 2, limit: 1 });

  assert.deepEqual(firstPage.meta, { page: 1, limit: 1, total: 2, totalPages: 2 });
  assert.equal(firstPage.data.length, 1);
  assert.equal(firstPage.data[0]?.id, blockedAId);
  assert.equal(firstPage.data[0]?.avatarUrl, "https://cdn.example.test/avatars/a.jpg");
  assert.equal("email" in firstPage.data[0]!, false);
  assert.equal("contact" in firstPage.data[0]!, false);
  assert.deepEqual(secondPage.data.map((user) => user.id), [blockedBId]);
});

test("blocked user appears after block creation and disappears after unblock", async () => {
  const viewerId = new Types.ObjectId().toString();
  const targetId = new Types.ObjectId().toString();
  const { service } = createService({
    users: [createUser(targetId, "Target User")],
  });
  const viewer = createAuthUser(viewerId);

  await service.blockUser(viewer, targetId);
  await service.blockUser(viewer, targetId);

  const blocked = await service.listBlockedUsers(viewer, { page: 1, limit: 30 });
  assert.deepEqual(blocked.data.map((user) => user.id), [targetId]);
  assert.deepEqual(await service.getBlockedIds(viewerId), [targetId]);

  await service.unblockUser(viewer, targetId);
  await service.unblockUser(viewer, targetId);

  const unblocked = await service.listBlockedUsers(viewer, { page: 1, limit: 30 });
  assert.deepEqual(unblocked.data, []);
});

test("blocking removes follow relationships in both directions and unblock does not restore them", async () => {
  const viewerId = new Types.ObjectId().toString();
  const targetId = new Types.ObjectId().toString();
  const { service, follows } = createService({
    users: [createUser(targetId, "Target User")],
    follows: [
      { followerId: viewerId, followingId: targetId },
      { followerId: targetId, followingId: viewerId },
    ],
  });
  const viewer = createAuthUser(viewerId);

  await service.blockUser(viewer, targetId);
  await service.blockUser(viewer, targetId);

  assert.deepEqual(follows, []);

  await service.unblockUser(viewer, targetId);

  assert.deepEqual(follows, []);
});

test("blocked profile response is minimal when viewer blocked target", async () => {
  const viewerId = new Types.ObjectId().toString();
  const targetId = new Types.ObjectId().toString();
  const { service } = createService({
    users: [createUser(targetId, "Target User", { bio: "Private bio", avatarKey: "avatars/target.jpg" })],
    blocks: [
      { blockerId: viewerId, blockedId: targetId, createdAt: new Date("2026-01-01T00:00:00.000Z"), recordId: "1" },
    ],
    follows: [{ followerId: viewerId, followingId: targetId }],
  });

  const response = await service.getById(targetId, createAuthUser(viewerId));

  assert.equal(response.profileAccess, "blocked");
  assert.equal(response.viewerHasBlockedTarget, true);
  assert.equal(response.targetHasBlockedViewer, false);
  assert.equal(response.blockedTitle, "You blocked this account");
  assert.equal(response.blockedDescription, "Unblock to view this profile, posts, and interact again.");
  assert.equal(response.avatarUrl, "https://cdn.example.test/avatars/target.jpg");
  assert.equal("accountType" in response, false);
  assert.equal("email" in response, false);
  assert.equal("bio" in response, false);
  assert.equal("isFollowing" in response, false);
});

test("blocked profile response is generic when target blocked viewer", async () => {
  const viewerId = new Types.ObjectId().toString();
  const targetId = new Types.ObjectId().toString();
  const { service } = createService({
    users: [createUser(targetId, "Target User", { bio: "Private bio" })],
    blocks: [
      { blockerId: targetId, blockedId: viewerId, createdAt: new Date("2026-01-01T00:00:00.000Z"), recordId: "1" },
    ],
  });

  const response = await service.getById(targetId, createAuthUser(viewerId));

  assert.equal(response.profileAccess, "blocked");
  assert.equal(response.viewerHasBlockedTarget, false);
  assert.equal(response.targetHasBlockedViewer, true);
  assert.equal(response.blockedTitle, "This account isn't available");
  assert.equal(response.blockedDescription, "You can't view this profile or interact with this account.");
  assert.equal("email" in response, false);
  assert.equal("bio" in response, false);
});

test("profile resources reject when either user has blocked the other", async () => {
  const viewerId = new Types.ObjectId().toString();
  const targetId = new Types.ObjectId().toString();
  const { service } = createService({
    users: [
      createUser(viewerId, "Viewer"),
      createUser(targetId, "Target User"),
    ],
    blocks: [
      { blockerId: viewerId, blockedId: targetId, createdAt: new Date("2026-01-01T00:00:00.000Z"), recordId: "1" },
    ],
  });
  const viewer = createAuthUser(viewerId);

  await assert.rejects(() => service.getProfileStats(targetId, viewer), /Profile unavailable/);
  await assert.rejects(() => service.listFollowers(targetId, viewer, {}), /Profile unavailable/);
  await assert.rejects(() => service.listFollowing(targetId, viewer, {}), /Profile unavailable/);
  await assert.rejects(() => service.listReviews(targetId, viewer, {}), /Profile unavailable/);
});

test("suggested users exclude outbound and inbound blocked relationships", async () => {
  const viewerId = new Types.ObjectId().toString();
  const outboundBlockedId = new Types.ObjectId().toString();
  const inboundBlockerId = new Types.ObjectId().toString();
  const visibleId = new Types.ObjectId().toString();
  const { service } = createService({
    users: [
      createUser(outboundBlockedId, "Outbound Blocked"),
      createUser(inboundBlockerId, "Inbound Blocker"),
      createUser(visibleId, "Visible User"),
    ],
    blocks: [
      { blockerId: viewerId, blockedId: outboundBlockedId, createdAt: new Date("2026-01-01T00:00:00.000Z"), recordId: "1" },
      { blockerId: inboundBlockerId, blockedId: viewerId, createdAt: new Date("2026-01-02T00:00:00.000Z"), recordId: "2" },
    ],
  });

  const suggestions = await service.listSuggestedUsers(createAuthUser(viewerId), 10);

  assert.deepEqual(suggestions.map((user) => user.id), [visibleId]);
});

test("self-block remains rejected", async () => {
  const viewerId = new Types.ObjectId().toString();
  const viewer = createAuthUser(viewerId);
  const { service } = createService({
    users: [createUser(viewerId, "Viewer")],
  });

  await assert.rejects(
    () => service.blockUser(viewer, viewerId),
    /cannot block yourself/i,
  );
});

test("listing is self scoped because no alternate blocker id is accepted", async () => {
  const viewerId = new Types.ObjectId().toString();
  const otherUserId = new Types.ObjectId().toString();
  const blockedByOtherId = new Types.ObjectId().toString();
  const { service } = createService({
    users: [createUser(blockedByOtherId, "Other Blocked")],
    blocks: [
      {
        blockerId: otherUserId,
        blockedId: blockedByOtherId,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        recordId: "1",
      },
    ],
  });

  const result = await service.listBlockedUsers(createAuthUser(viewerId), { page: 1, limit: 30 });

  assert.deepEqual(result.data, []);
});

test("unblock removes only the authenticated user's outbound block", async () => {
  const viewerId = new Types.ObjectId().toString();
  const otherUserId = new Types.ObjectId().toString();
  const targetId = new Types.ObjectId().toString();
  const { service } = createService({
    users: [createUser(targetId, "Target User")],
    blocks: [
      {
        blockerId: otherUserId,
        blockedId: targetId,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        recordId: "1",
      },
    ],
  });

  await service.unblockUser(createAuthUser(viewerId), targetId);

  const otherUserList = await service.listBlockedUsers(createAuthUser(otherUserId), { page: 1, limit: 30 });
  assert.deepEqual(otherUserList.data.map((user) => user.id), [targetId]);
});

test("blocked users route authentication rejects requests without a bearer token", async () => {
  let receivedError: unknown;

  await authenticate(
    { headers: {} } as never,
    {} as never,
    (error?: unknown) => {
      receivedError = error;
    },
  );

  assert.match(String((receivedError as { message?: string })?.message), /authentication required/i);
  assert.equal((receivedError as { statusCode?: number })?.statusCode, 401);
});
