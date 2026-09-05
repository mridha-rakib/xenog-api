import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import type { AuthUser } from "../src/modules/auth/auth.interface.js";
import type { IUser } from "../src/modules/user/user.interface.js";
import { UserService } from "../src/modules/user/user.service.js";
import {
  getBlockRelationship,
  isUserPubliclyViewable,
} from "../src/modules/user/user-access.js";

// ── Part 1 + Part 2: shared access helpers + profile privacy for
// suspended / banned / deleted accounts. Pure stubs, no DB. ────────────────

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

const createUser = (id: string, name: string, overrides: Partial<IUser> = {}): IUser => ({
  _id: new Types.ObjectId(id),
  name,
  username: name.toLowerCase().replace(/\s+/g, "_"),
  email: `${name.toLowerCase().replace(/\s+/g, ".")}@example.test`,
  accountType: "personal",
  role: "user",
  isActive: true,
  emailVerified: true,
  bio: "Private bio",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...overrides,
});

const createService = (users: IUser[], blocks: Array<{ blockerId: string; blockedId: string }> = []) => {
  const usersById = new Map(users.map((user) => [user._id.toString(), user]));

  const blockRepository = {
    isBlocked: async (blockerId: string, blockedId: string) =>
      blocks.some((block) => block.blockerId === blockerId && block.blockedId === blockedId),
    findBlockedIds: async (blockerId: string) =>
      blocks.filter((b) => b.blockerId === blockerId).map((b) => b.blockedId),
    findBlockerIds: async (blockedId: string) =>
      blocks.filter((b) => b.blockedId === blockedId).map((b) => b.blockerId),
  };

  const followRepository = {
    isFollowing: async () => false,
    findFollowingIds: async () => [],
  };

  return new UserService(
    { findById: async (id: string) => usersById.get(id) ?? null } as never,
    followRepository as never,
    blockRepository as never,
    { createDownloadUrl: async (key: string) => ({ url: `https://cdn.example.test/${key}` }) } as never,
    {} as never,
    {} as never,
    { countByHostUserId: async () => 0, findByHostUserId: async () => [] } as never,
    { countDistinctAcceptedWindowsByUser: async () => 0 } as never,
  );
};

// ---------------------------------------------------------------------------
// isUserPubliclyViewable
// ---------------------------------------------------------------------------

test("isUserPubliclyViewable: only active, non-deleted regular users", () => {
  assert.equal(isUserPubliclyViewable(createUser(new Types.ObjectId().toString(), "Active")), true);
  assert.equal(isUserPubliclyViewable(createUser(new Types.ObjectId().toString(), "Suspended", { isActive: false })), false);
  assert.equal(isUserPubliclyViewable(createUser(new Types.ObjectId().toString(), "Deleted", { deletedAt: new Date() })), false);
  assert.equal(isUserPubliclyViewable(createUser(new Types.ObjectId().toString(), "Admin", { role: "admin" })), false);
  assert.equal(isUserPubliclyViewable(null), false);
  assert.equal(isUserPubliclyViewable(undefined), false);
});

// ---------------------------------------------------------------------------
// getBlockRelationship
// ---------------------------------------------------------------------------

test("getBlockRelationship: reports both directions and is all-false for self", async () => {
  const a = new Types.ObjectId().toString();
  const b = new Types.ObjectId().toString();
  const repo = {
    isBlocked: async (blockerId: string, blockedId: string) => blockerId === a && blockedId === b,
  };

  assert.deepEqual(await getBlockRelationship(repo, a, b), {
    viewerHasBlockedTarget: true,
    targetHasBlockedViewer: false,
  });
  assert.deepEqual(await getBlockRelationship(repo, b, a), {
    viewerHasBlockedTarget: false,
    targetHasBlockedViewer: true,
  });
  assert.deepEqual(await getBlockRelationship(repo, a, a), {
    viewerHasBlockedTarget: false,
    targetHasBlockedViewer: false,
  });
});

// ---------------------------------------------------------------------------
// UserService.getById — suspended / deleted → safe "unavailable"
// ---------------------------------------------------------------------------

test("getById returns a safe 'unavailable' shape for a suspended account", async () => {
  const viewerId = new Types.ObjectId().toString();
  const targetId = new Types.ObjectId().toString();
  const service = createService([
    createUser(viewerId, "Viewer"),
    createUser(targetId, "Suspended User", { isActive: false, avatarKey: "avatars/target.jpg" }),
  ]);

  const response = await service.getById(targetId, createAuthUser(viewerId));

  assert.equal(response.profileAccess, "unavailable");
  assert.equal(response.name, "Unavailable");
  assert.equal(response.username, null);
  assert.equal(response.avatarUrl, null);
  assert.equal("email" in response, false);
  assert.equal("bio" in response, false);
  assert.equal("accountType" in response, false);
  assert.equal("isFollowing" in response, false);
});

test("getById returns 'unavailable' for a deleted / anonymised account", async () => {
  const viewerId = new Types.ObjectId().toString();
  const targetId = new Types.ObjectId().toString();
  const service = createService([
    createUser(viewerId, "Viewer"),
    createUser(targetId, "Deleted User", {
      isActive: false,
      deletedAt: new Date("2026-02-01T00:00:00.000Z"),
      email: `deleted-${targetId}@deleted.local`,
    }),
  ]);

  const response = await service.getById(targetId, createAuthUser(viewerId));

  assert.equal(response.profileAccess, "unavailable");
  assert.equal("email" in response, false);
});

test("getById still returns the full open profile for an active user (regression)", async () => {
  const viewerId = new Types.ObjectId().toString();
  const targetId = new Types.ObjectId().toString();
  const service = createService([
    createUser(viewerId, "Viewer"),
    createUser(targetId, "Active User"),
  ]);

  const response = await service.getById(targetId, createAuthUser(viewerId));

  assert.equal(response.profileAccess, "open");
  assert.equal(response.email, "active.user@example.test");
  assert.equal(response.bio, "Private bio");
});

test("getById still returns the 'blocked' shape when a block exists (regression)", async () => {
  const viewerId = new Types.ObjectId().toString();
  const targetId = new Types.ObjectId().toString();
  const service = createService(
    [createUser(viewerId, "Viewer"), createUser(targetId, "Blocked Target")],
    [{ blockerId: viewerId, blockedId: targetId }],
  );

  const response = await service.getById(targetId, createAuthUser(viewerId));

  assert.equal(response.profileAccess, "blocked");
  assert.equal(response.viewerHasBlockedTarget, true);
  assert.equal("email" in response, false);
  assert.equal("bio" in response, false);
});

test("getById on a suspended account that also blocked the viewer never leaks private fields", async () => {
  const viewerId = new Types.ObjectId().toString();
  const targetId = new Types.ObjectId().toString();
  const service = createService(
    [createUser(viewerId, "Viewer"), createUser(targetId, "Suspended Blocker", { isActive: false })],
    [{ blockerId: targetId, blockedId: viewerId }],
  );

  const response = await service.getById(targetId, createAuthUser(viewerId));

  assert.ok(response.profileAccess === "unavailable" || response.profileAccess === "blocked");
  assert.equal("email" in response, false);
  assert.equal("bio" in response, false);
});
