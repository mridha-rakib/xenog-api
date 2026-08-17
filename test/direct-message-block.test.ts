import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Types } from "mongoose";
import type { AuthUser } from "../src/modules/auth/auth.interface.js";
import { ChatService } from "../src/modules/chat/chat.service.js";

// Covers the new message-only block domain (DirectMessageBlock), kept
// entirely separate from UserBlockModel (the existing Full/Profile Block).
// Full Block behavior itself (items 11-15 of the requested test matrix —
// send/read denial, unchanged history-read gating) is already exhaustively
// covered by chat-permission.test.ts's regression-locked suite; this file
// covers only what's new: message-block CRUD, the combined authorization
// gate, coexistence with Full Block, security/IDOR, and structural
// isolation from Feed/Moment/Event/Profile/Follow code.

const userAId = new Types.ObjectId().toString();
const userBId = new Types.ObjectId().toString();

const createAuthUser = (id: string): AuthUser => ({
  id,
  name: "Test User",
  username: "testuser",
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

type ServiceOptions = {
  recipientExists?: boolean;
  senderFollowsRecipient?: boolean;
  recipientFollowsSender?: boolean;
  senderBlockedRecipient?: boolean; // Full Block A -> B
  recipientBlockedSender?: boolean; // Full Block B -> A
  senderMessageBlockedRecipient?: boolean; // Message Block A -> B
  recipientMessageBlockedSender?: boolean; // Message Block B -> A
};

const createService = (options: ServiceOptions = {}) => {
  const {
    recipientExists = true,
    senderFollowsRecipient = true,
    recipientFollowsSender = true,
    senderBlockedRecipient = false,
    recipientBlockedSender = false,
    senderMessageBlockedRecipient = false,
    recipientMessageBlockedSender = false,
  } = options;

  const calls = {
    followRepositoryCalls: 0,
    userBlockRepositoryBlockCalls: 0,
    userBlockRepositoryUnblockCalls: 0,
    directMessageBlockCalls: [] as Array<{ op: string; blockerId: string; blockedId: string }>,
    findBlockedUsersCalledWith: null as string | null,
  };

  const userRepository = {
    findById: async (id: string) =>
      recipientExists && (id === userBId || id === userAId)
        ? { _id: new Types.ObjectId(id), role: "user", isActive: true, emailVerified: true }
        : null,
  };

  const userFollowRepository = {
    isFollowing: async (followerId: string, followingId: string) => {
      calls.followRepositoryCalls += 1;
      if (followerId === userAId && followingId === userBId) return senderFollowsRecipient;
      if (followerId === userBId && followingId === userAId) return recipientFollowsSender;
      return false;
    },
    removeBetween: async () => {
      throw new Error("removeBetween must NEVER be called by message-block code paths");
    },
  };

  const userBlockRepository = {
    isBlocked: async (blockerId: string, blockedId: string) => {
      if (blockerId === userAId && blockedId === userBId) return senderBlockedRecipient;
      if (blockerId === userBId && blockedId === userAId) return recipientBlockedSender;
      return false;
    },
    block: async () => {
      calls.userBlockRepositoryBlockCalls += 1;
    },
    unblock: async () => {
      calls.userBlockRepositoryUnblockCalls += 1;
    },
  };

  const directMessageBlockRepository = {
    isBlocked: async (blockerId: string, blockedId: string) => {
      if (blockerId === userAId && blockedId === userBId) return senderMessageBlockedRecipient;
      if (blockerId === userBId && blockedId === userAId) return recipientMessageBlockedSender;
      return false;
    },
    block: async (blockerId: string, blockedId: string) => {
      calls.directMessageBlockCalls.push({ op: "block", blockerId, blockedId });
    },
    unblock: async (blockerId: string, blockedId: string) => {
      calls.directMessageBlockCalls.push({ op: "unblock", blockerId, blockedId });
    },
    findBlockedUsers: async (blockerId: string, _skip: number, _limit: number) => {
      calls.findBlockedUsersCalledWith = blockerId;
      return { users: [], total: 0 };
    },
  };

  const service = new ChatService(
    userRepository as never,
    userFollowRepository as never,
    userBlockRepository as never,
    {} as never, // storageService
    {} as never, // chatMessageRepository
    {} as never, // chatDeletionRepository
    {} as never, // eventRepository
    {} as never, // momentRepository
    directMessageBlockRepository as never,
  );

  return { service, calls };
};

// ── MESSAGE BLOCK ONLY ──────────────────────────────────────────────────

test("1. blockMessages creates a DirectMessageBlock A->B", async () => {
  const { service, calls } = createService();

  await service.blockMessages(createAuthUser(userAId), userBId);

  assert.deepEqual(calls.directMessageBlockCalls, [{ op: "block", blockerId: userAId, blockedId: userBId }]);
});

test("2. blockMessages never creates a UserBlock (Full Block) row", async () => {
  const { service, calls } = createService();

  await service.blockMessages(createAuthUser(userAId), userBId);

  assert.equal(calls.userBlockRepositoryBlockCalls, 0);
});

test("3. blockMessages never touches the follow relationship", async () => {
  const { service } = createService();

  // userFollowRepository.removeBetween throws if called at all (see mock
  // above) — blockMessages completing without throwing proves it's never
  // invoked.
  await assert.doesNotReject(() => service.blockMessages(createAuthUser(userAId), userBId));
});

test("4. A -> B send denied after A message-blocks B", async () => {
  const { service } = createService({ senderMessageBlockedRecipient: true });

  await assert.rejects(
    () => service.assertCanSendDirectMessage(userAId, userBId),
    /cannot message this user/i,
  );
});

test("5. B -> A send denied after A message-blocks B (symmetric send eligibility)", async () => {
  const { service } = createService({ senderMessageBlockedRecipient: true });

  await assert.rejects(
    () => service.assertCanSendDirectMessage(userBId, userAId),
    /cannot message this user/i,
  );
});

test("6/7. history read remains allowed for both A and B under a message-only block", async () => {
  const { service } = createService({ senderMessageBlockedRecipient: true });

  await assert.doesNotReject(() => service.assertCanReadDirectMessages(userAId, userBId));
  await assert.doesNotReject(() => service.assertCanReadDirectMessages(userBId, userAId));
});

test("10. unblockMessages removes only the DirectMessageBlock, never UserBlock", async () => {
  const { service, calls } = createService();

  await service.unblockMessages(createAuthUser(userAId), userBId);

  assert.deepEqual(calls.directMessageBlockCalls, [{ op: "unblock", blockerId: userAId, blockedId: userBId }]);
  assert.equal(calls.userBlockRepositoryUnblockCalls, 0);
});

// ── COEXISTENCE ──────────────────────────────────────────────────────────

test("16. Full Block and Message Block can coexist — both checks are independent", async () => {
  const { service } = createService({
    senderBlockedRecipient: true,
    senderMessageBlockedRecipient: true,
  });

  await assert.rejects(
    () => service.assertCanSendDirectMessage(userAId, userBId),
    /cannot message this user/i,
  );
});

test("17. Message Unblock does not remove Full Block (unblockMessages never calls userBlockRepository.unblock)", async () => {
  const { service, calls } = createService({ senderBlockedRecipient: true });

  await service.unblockMessages(createAuthUser(userAId), userBId);

  assert.equal(calls.userBlockRepositoryUnblockCalls, 0);
});

test("18. Full Unblock does not remove Message Block — structurally guaranteed (see isolation tests below); unblockMessages itself never touches UserBlock", async () => {
  const { service, calls } = createService();

  await service.unblockMessages(createAuthUser(userAId), userBId);

  assert.equal(calls.userBlockRepositoryUnblockCalls, 0);
});

test("19. Full Block removed but Message Block remains -> send still denied", async () => {
  const { service } = createService({
    senderBlockedRecipient: false,
    recipientBlockedSender: false,
    senderMessageBlockedRecipient: true,
  });

  await assert.rejects(
    () => service.assertCanSendDirectMessage(userAId, userBId),
    /cannot message this user/i,
  );
});

test("20. Message Block removed but Full Block remains -> send still denied", async () => {
  const { service } = createService({
    senderBlockedRecipient: true,
    senderMessageBlockedRecipient: false,
  });

  await assert.rejects(
    () => service.assertCanSendDirectMessage(userAId, userBId),
    /cannot message this user/i,
  );
});

test("21. neither restriction exists -> sending allowed", async () => {
  const { service } = createService();

  await assert.doesNotReject(() => service.assertCanSendDirectMessage(userAId, userBId));
});

// ── SECURITY / IDOR ──────────────────────────────────────────────────────

test("22. self message-block is rejected", async () => {
  const { service } = createService();

  await assert.rejects(
    () => service.blockMessages(createAuthUser(userAId), userAId),
    /cannot message-block yourself/i,
  );
});

test("22b. self message-unblock is rejected", async () => {
  const { service } = createService();

  await assert.rejects(
    () => service.unblockMessages(createAuthUser(userAId), userAId),
    /cannot message-unblock yourself/i,
  );
});

test("24. blockerId always derives from the authenticated user, never a client param — blockMessages(A, B) always blocks A->B regardless of call order", async () => {
  const { service, calls } = createService();

  await service.blockMessages(createAuthUser(userAId), userBId);

  assert.equal(calls.directMessageBlockCalls[0]?.blockerId, userAId);
  assert.equal(calls.directMessageBlockCalls[0]?.blockedId, userBId);
});

test("27. listMessageBlockedUsers only ever queries the authenticated user's own block edges", async () => {
  const { service, calls } = createService();

  await service.listMessageBlockedUsers(createAuthUser(userAId), {});

  assert.equal(calls.findBlockedUsersCalledWith, userAId);
});

// ── COMBINED RELATIONSHIP RESPONSE ────────────────────────────────────────

test("getDirectMessageRelationship reports all four directional booleans plus a combined canMessage flag", async () => {
  const { service } = createService({
    senderBlockedRecipient: false,
    recipientBlockedSender: false,
    senderMessageBlockedRecipient: true,
    recipientMessageBlockedSender: false,
  });

  const relationship = await service.getDirectMessageRelationship(createAuthUser(userAId), userBId);

  assert.deepEqual(relationship, {
    fullBlockedByMe: false,
    fullBlockedMe: false,
    messageBlockedByMe: true,
    messageBlockedMe: false,
    canMessage: false,
  });
});

test("getDirectMessageRelationship: no blocks -> canMessage is true", async () => {
  const { service } = createService();

  const relationship = await service.getDirectMessageRelationship(createAuthUser(userAId), userBId);

  assert.equal(relationship.canMessage, true);
});

// ── STRUCTURAL ISOLATION — proves the new domain cannot leak into Feed/
// Profile/Follow code, since those modules are never given a
// DirectMessageBlockRepository reference to begin with. ───────────────────

const readSource = (relativePath: string) => readFileSync(join(process.cwd(), relativePath), "utf8");

test("isolation: user.service.ts (Full Block + Follow + Profile domain) never imports DirectMessageBlockRepository", () => {
  const source = readSource("src/modules/user/user.service.ts");
  assert.doesNotMatch(source, /DirectMessageBlock/);
});

test("isolation: event.service.ts (Feed/Event content) never imports DirectMessageBlockRepository", () => {
  const source = readSource("src/modules/events/event.service.ts");
  assert.doesNotMatch(source, /DirectMessageBlock/);
});

test("isolation: moment.service.ts (Feed/Moment content) never imports DirectMessageBlockRepository", () => {
  const source = readSource("src/modules/moments/moment.service.ts");
  assert.doesNotMatch(source, /DirectMessageBlock/);
});

test("isolation: DirectMessageBlockModel schema carries no feed/profile fields — directional edge only, mirroring UserBlockModel's shape", () => {
  const source = readSource("src/modules/chat/direct-message-block.model.ts");
  assert.match(source, /blockerId/);
  assert.match(source, /blockedId/);
  assert.doesNotMatch(source, /feed|profile|follow/i);
});

test("23. every new message-block route sits after the router-wide authenticate middleware", () => {
  const source = readSource("src/modules/chat/chat.route.ts");
  const authIndex = source.indexOf("router.use(authenticate)");
  const messageBlockedIndex = source.indexOf('"/dms/message-blocked"');
  const messageBlockPostIndex = source.indexOf('"/dms/:friendId/message-block"');
  const relationshipIndex = source.indexOf('"/dms/:friendId/relationship"');

  assert.notEqual(authIndex, -1);
  assert.ok(messageBlockedIndex > authIndex);
  assert.ok(messageBlockPostIndex > authIndex);
  assert.ok(relationshipIndex > authIndex);
});

test("route ordering: the static /dms/message-blocked list route is registered before any dynamic /dms/:friendId/... route", () => {
  const source = readSource("src/modules/chat/chat.route.ts");
  const staticIndex = source.indexOf('"/dms/message-blocked"');
  const firstDynamicIndex = source.indexOf('"/dms/:friendId');

  assert.notEqual(staticIndex, -1);
  assert.notEqual(firstDynamicIndex, -1);
  assert.ok(staticIndex < firstDynamicIndex);
});
