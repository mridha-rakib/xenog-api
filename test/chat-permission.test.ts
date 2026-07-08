import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import type { AuthUser } from "../src/modules/auth/auth.interface.js";
import { ChatService } from "../src/modules/chat/chat.service.js";

type PermissionOptions = {
  recipientExists?: boolean;
  senderFollowsRecipient?: boolean;
  recipientFollowsSender?: boolean;
  senderBlockedRecipient?: boolean;
  recipientBlockedSender?: boolean;
};

const userAId = new Types.ObjectId().toString();
const userBId = new Types.ObjectId().toString();

const createAuthUser = (
  id: string,
  accountType: "personal" | "business" = "personal",
): AuthUser => ({
  id,
  name: accountType === "business" ? "Business User" : "Personal User",
  username: accountType,
  email: `${id}@example.test`,
  accountType,
  currentLocationSharingEnabled: false,
  notificationsEnabled: true,
  role: "user",
  isActive: true,
  emailVerified: true,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const createService = (options: PermissionOptions = {}) => {
  const {
    recipientExists = true,
    senderFollowsRecipient = false,
    recipientFollowsSender = false,
    senderBlockedRecipient = false,
    recipientBlockedSender = false,
  } = options;
  const createdMessages: unknown[] = [];

  const service = new ChatService(
    {
      findById: async (id: string) =>
        recipientExists && id === userBId
          ? {
              _id: new Types.ObjectId(id),
              role: "user",
              isActive: true,
              emailVerified: true,
            }
          : null,
    } as never,
    {
      isFollowing: async (followerId: string, followingId: string) => {
        if (followerId === userAId && followingId === userBId) return senderFollowsRecipient;
        if (followerId === userBId && followingId === userAId) return recipientFollowsSender;
        return false;
      },
    } as never,
    {
      isBlocked: async (blockerId: string, blockedId: string) => {
        if (blockerId === userAId && blockedId === userBId) return senderBlockedRecipient;
        if (blockerId === userBId && blockedId === userAId) return recipientBlockedSender;
        return false;
      },
    } as never,
    {} as never,
    {
      create: async (payload: {
        conversationId: string;
        senderId: string;
        recipientId: string;
        text?: string;
        type?: string;
      }) => {
        createdMessages.push(payload);
        return {
          _id: new Types.ObjectId(),
          conversationId: payload.conversationId,
          senderId: new Types.ObjectId(payload.senderId),
          recipientId: new Types.ObjectId(payload.recipientId),
          type: payload.type ?? "text",
          text: payload.text ?? "",
          attachment: null,
          readAt: null,
          editedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      },
    } as never,
    {
      restore: async () => undefined,
    } as never,
    {} as never,
    {} as never,
  );

  return { service, createdMessages };
};

test("self-DM is rejected", async () => {
  const { service } = createService();

  await assert.rejects(
    () => service.assertCanDirectMessage(userAId, userAId),
    /cannot send a direct message to yourself/i,
  );
});

test("one-way follow is rejected", async () => {
  const { service } = createService({ senderFollowsRecipient: true });

  await assert.rejects(
    () => service.assertCanDirectMessage(userAId, userBId),
    /only message mutual friends/i,
  );
});

test("no follow relationship is rejected", async () => {
  const { service } = createService();

  await assert.rejects(
    () => service.assertCanDirectMessage(userAId, userBId),
    /only message mutual friends/i,
  );
});

test("mutual follow is allowed", async () => {
  const { service } = createService({
    senderFollowsRecipient: true,
    recipientFollowsSender: true,
  });

  await assert.doesNotReject(() => service.assertCanDirectMessage(userAId, userBId));
});

test("sender blocked recipient is rejected", async () => {
  const { service } = createService({
    senderFollowsRecipient: true,
    recipientFollowsSender: true,
    senderBlockedRecipient: true,
  });

  await assert.rejects(
    () => service.assertCanDirectMessage(userAId, userBId),
    /cannot message this user/i,
  );
});

test("recipient blocked sender is rejected", async () => {
  const { service } = createService({
    senderFollowsRecipient: true,
    recipientFollowsSender: true,
    recipientBlockedSender: true,
  });

  await assert.rejects(
    () => service.assertCanDirectMessage(userAId, userBId),
    /cannot message this user/i,
  );
});

test("blocked mutual followers cannot create a DM", async () => {
  const { service } = createService({
    senderFollowsRecipient: true,
    recipientFollowsSender: true,
    senderBlockedRecipient: true,
  });

  await assert.rejects(
    () => service.createDirectMessage(createAuthUser(userAId), userBId, { text: "Hello" }),
    /cannot message this user/i,
  );
});

test("business accountType still uses base user IDs for DMs", async () => {
  const { service, createdMessages } = createService({
    senderFollowsRecipient: true,
    recipientFollowsSender: true,
  });

  const message = await service.createDirectMessage(
    createAuthUser(userAId, "business"),
    userBId,
    { text: "Hello from business mode" },
  );

  assert.equal(message.senderId, userAId);
  assert.equal(message.recipientId, userBId);
  assert.deepEqual(createdMessages, [
    {
      conversationId: [userAId.toLowerCase(), userBId.toLowerCase()].sort().join(":"),
      recipientId: userBId,
      senderId: userAId,
      text: "Hello from business mode",
      type: "text",
      attachment: null,
      clientMessageId: null,
    },
  ]);
});
