import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import type { AuthUser } from "../src/modules/auth/auth.interface.js";
import type { IGroup, IGroupMember } from "../src/modules/chat/group.interface.js";
import { GroupService } from "../src/modules/chat/group.service.js";

const groupId = new Types.ObjectId().toString();

const createAuthUser = (id: string): AuthUser => ({
  id,
  name: "Test User",
  username: "test-user",
  email: `${id}@example.test`,
  accountType: "personal",
  currentLocationSharingEnabled: false,
  notificationsEnabled: true,
  role: "user",
  isActive: true,
  emailVerified: true,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const member = (id: string, role: "admin" | "member", joinedAt: Date): IGroupMember => ({
  userId: new Types.ObjectId(id),
  role,
  joinedAt,
});

// Fake GroupRepository: mimics the real repository's `runTransaction` by
// just invoking the callback directly (no real Mongo session needed), and
// tracks every write the service makes so assertions can inspect exactly
// what mutation the service decided to perform.
const createFakeGroupRepository = (group: IGroup) => {
  const calls: { method: string; args: unknown[] }[] = [];
  let deleted = false;

  const repo = {
    runTransaction: async <T>(fn: (session: unknown) => Promise<T>): Promise<T> => fn({}),
    findByIdInSession: async (id: string) => {
      calls.push({ method: "findByIdInSession", args: [id] });
      return deleted ? null : group;
    },
    pullNonOwnerMember: async (gId: string, userId: string) => {
      calls.push({ method: "pullNonOwnerMember", args: [gId, userId] });
      const before = group.members.length;
      group.members = group.members.filter((m) => m.userId.toString() !== userId);
      return group.members.length === before - 1;
    },
    transferOwnership: async (gId: string, currentOwnerId: string, newOwnerId: string) => {
      calls.push({ method: "transferOwnership", args: [gId, currentOwnerId, newOwnerId] });
      const successor = group.members.find((m) => m.userId.toString() === newOwnerId);
      if (!successor || group.createdBy.toString() !== currentOwnerId) return false;
      successor.role = "admin";
      group.createdBy = new Types.ObjectId(newOwnerId);
      return true;
    },
    pullFormerOwnerMember: async (gId: string, formerOwnerId: string) => {
      calls.push({ method: "pullFormerOwnerMember", args: [gId, formerOwnerId] });
      const before = group.members.length;
      group.members = group.members.filter((m) => m.userId.toString() !== formerOwnerId);
      return group.members.length === before - 1;
    },
    deleteGroupWithMessages: async (gId: string) => {
      calls.push({ method: "deleteGroupWithMessages", args: [gId] });
      deleted = true;
      return true;
    },
  };

  return { repo, calls };
};

const createService = (group: IGroup) => {
  const { repo, calls } = createFakeGroupRepository(group);
  const service = new GroupService(repo as never, {} as never, {} as never, {} as never);
  return { service, calls, group };
};

test("non-member cannot leave and nothing is mutated", async () => {
  const ownerId = new Types.ObjectId().toString();
  const strangerId = new Types.ObjectId().toString();
  const group: IGroup = {
    _id: new Types.ObjectId(groupId),
    name: "Test Group",
    avatarKey: null,
    createdBy: new Types.ObjectId(ownerId),
    members: [member(ownerId, "admin", new Date("2026-01-01"))],
    lastMessage: null,
    lastMessageAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const { service, calls } = createService(group);

  await assert.rejects(
    () => service.leaveGroup(createAuthUser(strangerId), groupId),
    /not a member/i,
  );

  assert.equal(calls.some((c) => c.method !== "findByIdInSession"), false);
  assert.equal(group.members.length, 1);
});

test("regular member leaves: only removed, owner and other members unchanged", async () => {
  const ownerId = new Types.ObjectId().toString();
  const memberId = new Types.ObjectId().toString();
  const group: IGroup = {
    _id: new Types.ObjectId(groupId),
    name: "Test Group",
    avatarKey: null,
    createdBy: new Types.ObjectId(ownerId),
    members: [
      member(ownerId, "admin", new Date("2026-01-01")),
      member(memberId, "member", new Date("2026-01-02")),
    ],
    lastMessage: null,
    lastMessageAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const { service, calls } = createService(group);
  const result = await service.leaveGroup(createAuthUser(memberId), groupId);

  assert.deepEqual(result, { groupId, status: "left" });
  assert.equal(group.members.length, 1);
  assert.equal(group.members[0]?.userId.toString(), ownerId);
  assert.equal(group.createdBy.toString(), ownerId);
  assert.equal(calls.some((c) => c.method === "transferOwnership"), false);
  assert.equal(calls.some((c) => c.method === "deleteGroupWithMessages"), false);
});

test("non-owner admin leaves like a regular member; owner untouched", async () => {
  const ownerId = new Types.ObjectId().toString();
  const adminId = new Types.ObjectId().toString();
  const group: IGroup = {
    _id: new Types.ObjectId(groupId),
    name: "Test Group",
    avatarKey: null,
    createdBy: new Types.ObjectId(ownerId),
    members: [
      member(ownerId, "admin", new Date("2026-01-01")),
      member(adminId, "admin", new Date("2026-01-02")),
    ],
    lastMessage: null,
    lastMessageAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const { service, calls } = createService(group);
  const result = await service.leaveGroup(createAuthUser(adminId), groupId);

  assert.deepEqual(result, { groupId, status: "left" });
  assert.equal(group.members.length, 1);
  assert.equal(group.createdBy.toString(), ownerId);
  assert.equal(calls.some((c) => c.method === "transferOwnership"), false);
});

test("owner leaves with regular members present: oldest regular member promoted (Priority 1)", async () => {
  const ownerId = new Types.ObjectId().toString();
  const memberAId = new Types.ObjectId().toString(); // joined 10:00
  const memberBId = new Types.ObjectId().toString(); // joined 11:00
  const adminOtherId = new Types.ObjectId().toString(); // joined 09:00, but is admin — must lose to a regular member
  const group: IGroup = {
    _id: new Types.ObjectId(groupId),
    name: "Test Group",
    avatarKey: null,
    createdBy: new Types.ObjectId(ownerId),
    members: [
      member(ownerId, "admin", new Date("2026-01-01T00:00:00Z")),
      member(adminOtherId, "admin", new Date("2026-01-01T09:00:00Z")),
      member(memberAId, "member", new Date("2026-01-01T10:00:00Z")),
      member(memberBId, "member", new Date("2026-01-01T11:00:00Z")),
    ],
    lastMessage: "hi",
    lastMessageAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const { service } = createService(group);
  const result = await service.leaveGroup(createAuthUser(ownerId), groupId);

  assert.deepEqual(result, { groupId, status: "left", newOwnerId: memberAId });
  assert.equal(group.createdBy.toString(), memberAId);
  assert.equal(group.members.find((m) => m.userId.toString() === memberAId)?.role, "admin");
  assert.equal(group.members.some((m) => m.userId.toString() === ownerId), false);
  assert.equal(group.members.length, 3);
  // messages/name/avatar untouched — repository never received a delete call
  assert.equal(group.name, "Test Group");
  assert.equal(group.lastMessage, "hi");
});

test("owner leaves with only admins remaining: oldest other admin promoted (Priority 2)", async () => {
  const ownerId = new Types.ObjectId().toString();
  const adminAId = new Types.ObjectId().toString(); // joined 10:00
  const adminBId = new Types.ObjectId().toString(); // joined 11:00
  const group: IGroup = {
    _id: new Types.ObjectId(groupId),
    name: "Test Group",
    avatarKey: null,
    createdBy: new Types.ObjectId(ownerId),
    members: [
      member(ownerId, "admin", new Date("2026-01-01T00:00:00Z")),
      member(adminAId, "admin", new Date("2026-01-01T10:00:00Z")),
      member(adminBId, "admin", new Date("2026-01-01T11:00:00Z")),
    ],
    lastMessage: null,
    lastMessageAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const { service } = createService(group);
  const result = await service.leaveGroup(createAuthUser(ownerId), groupId);

  assert.deepEqual(result, { groupId, status: "left", newOwnerId: adminAId });
  assert.equal(group.createdBy.toString(), adminAId);
  assert.equal(group.members.find((m) => m.userId.toString() === adminAId)?.role, "admin");
  assert.equal(group.members.length, 2);
});

test("owner leaves alone: group is deleted, no successor computed", async () => {
  const ownerId = new Types.ObjectId().toString();
  const group: IGroup = {
    _id: new Types.ObjectId(groupId),
    name: "Solo Group",
    avatarKey: null,
    createdBy: new Types.ObjectId(ownerId),
    members: [member(ownerId, "admin", new Date("2026-01-01"))],
    lastMessage: null,
    lastMessageAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const { service, calls } = createService(group);
  const result = await service.leaveGroup(createAuthUser(ownerId), groupId);

  assert.deepEqual(result, { groupId, status: "group_deleted" });
  assert.equal(calls.some((c) => c.method === "deleteGroupWithMessages"), true);
  assert.equal(calls.some((c) => c.method === "transferOwnership"), false);
  assert.equal(calls.some((c) => c.method === "pullNonOwnerMember"), false);
});

test("ownership tie-break: identical joinedAt resolved by ascending ObjectId string, not array order", async () => {
  const ownerId = new Types.ObjectId().toString();
  const sameJoinedAt = new Date("2026-01-01T10:00:00Z");

  // Deliberately create the two candidate ids and then decide, by string
  // comparison, which one *should* win — independent of which order they're
  // pushed into the members array — to prove the tiebreaker (not array
  // order) drives the result.
  const idA = new Types.ObjectId().toString();
  const idB = new Types.ObjectId().toString();
  const [expectedWinner, expectedLoser] = idA.localeCompare(idB) < 0 ? [idA, idB] : [idB, idA];

  const group: IGroup = {
    _id: new Types.ObjectId(groupId),
    name: "Tie Group",
    avatarKey: null,
    createdBy: new Types.ObjectId(ownerId),
    // Intentionally listed with the expected loser first, to prove array
    // order isn't what decides the winner.
    members: [
      member(ownerId, "admin", new Date("2026-01-01T00:00:00Z")),
      member(expectedLoser, "member", sameJoinedAt),
      member(expectedWinner, "member", sameJoinedAt),
    ],
    lastMessage: null,
    lastMessageAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const { service } = createService(group);
  const result = await service.leaveGroup(createAuthUser(ownerId), groupId);

  assert.deepEqual(result, { groupId, status: "left", newOwnerId: expectedWinner });
});
