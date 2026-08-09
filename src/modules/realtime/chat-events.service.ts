/**
 * Single shared "message created" side-effect path for direct and group
 * messages, used by every creation entry point: the raw-ws gateway, the
 * Socket.IO gateway, and the REST controllers.
 *
 * Before this module existed, only the WebSocket handlers broadcast the new
 * message in realtime and evaluated push — the REST create endpoints
 * (used by ShareModal to share a post/event/link into a DM) persisted the
 * message and returned, silently skipping both realtime delivery and push.
 * Routing every creation path through these two functions closes that gap
 * at the source instead of teaching each caller about broadcast/push.
 */
import type { AuthUser } from "../auth/auth.interface.js";
import type {
  ChatMessageAttachment,
  ChatMessageType,
  DirectMessageResponse,
} from "../chat/chat.interface.js";
import type { GroupMessageResponse } from "../chat/group.interface.js";
import { ChatService } from "../chat/chat.service.js";
import { GroupService } from "../chat/group.service.js";
import { GroupRepository } from "../chat/group.repository.js";
import { presenceService } from "./presence.service.js";
import { notifyUserBoth, notifyUsersBoth } from "./realtime-dual-emit.js";
import { sendPushNotifications } from "../notifications/fcm.service.js";

const chatService = new ChatService();
const groupService = new GroupService();
const groupRepository = new GroupRepository();

export type CreateDirectMessageInput = {
  text?: string;
  type?: ChatMessageType;
  attachment?: ChatMessageAttachment;
  clientMessageId?: string | null;
};
export type CreateGroupMessageInput = {
  text?: string;
  type?: ChatMessageType;
  attachment?: ChatMessageAttachment;
  clientMessageId?: string | null;
};

export const createDirectMessageWithSideEffects = async (
  sender: AuthUser,
  recipientId: string,
  payload: CreateDirectMessageInput,
): Promise<DirectMessageResponse> => {
  const savedMessage = await chatService.createDirectMessage(sender, recipientId, {
    text: payload.text,
    type: payload.type,
    attachment: payload.attachment,
    clientMessageId: payload.clientMessageId ?? undefined,
  });

  const eventMessage = {
    clientMessageId: payload.clientMessageId ?? null,
    conversationId: savedMessage.conversationId,
    createdAt: savedMessage.createdAt.toISOString(),
    id: savedMessage.id,
    recipientId,
    senderId: savedMessage.senderId,
    senderName: sender.name,
    text: savedMessage.text,
    type: savedMessage.type,
    attachment: savedMessage.attachment ?? null,
    editedAt: savedMessage.editedAt?.toISOString() ?? null,
  };
  const legacyEnvelope = { type: "dm:message", message: eventMessage };

  notifyUserBoth(sender.id, legacyEnvelope, "dm:message", eventMessage);
  notifyUserBoth(recipientId, legacyEnvelope, "dm:message", eventMessage);

  if (!presenceService.isOnline(recipientId)) {
    const notifBody = savedMessage.text?.trim() || "Sent an attachment";
    void sendPushNotifications([recipientId], {
      title: sender.name,
      body: notifBody,
      data: {
        type: "dm",
        conversationPartnerId: sender.id,
        senderName: sender.name,
        conversationId: savedMessage.conversationId,
      },
    });
  }

  return savedMessage;
};

export const notifyDirectMessageEdited = (updated: DirectMessageResponse, senderName: string): void => {
  const eventMessage = {
    conversationId: updated.conversationId,
    createdAt: updated.createdAt.toISOString(),
    editedAt: updated.editedAt?.toISOString() ?? null,
    id: updated.id,
    recipientId: updated.recipientId,
    senderId: updated.senderId,
    senderName,
    text: updated.text,
    type: updated.type,
    attachment: updated.attachment ?? null,
  };
  const legacyEnvelope = { type: "dm:message:updated", message: eventMessage };

  notifyUserBoth(updated.senderId, legacyEnvelope, "dm:message:updated", eventMessage);
  notifyUserBoth(updated.recipientId, legacyEnvelope, "dm:message:updated", eventMessage);
};

export const notifyDirectMessageDeleted = (deleted: DirectMessageResponse): void => {
  const eventPayload = { messageId: deleted.id, conversationId: deleted.conversationId };
  const legacyEnvelope = { type: "dm:message:deleted", ...eventPayload };

  notifyUserBoth(deleted.senderId, legacyEnvelope, "dm:message:deleted", eventPayload);
  notifyUserBoth(deleted.recipientId, legacyEnvelope, "dm:message:deleted", eventPayload);
};

export const notifyDirectTyping = (
  recipientId: string,
  typing: { isTyping: boolean; senderId: string; senderName: string },
): void => {
  const eventPayload = {
    isTyping: typing.isTyping,
    recipientId,
    senderId: typing.senderId,
    senderName: typing.senderName,
    updatedAt: new Date().toISOString(),
  };
  const legacyEnvelope = { type: "dm:typing", typing: eventPayload };

  notifyUserBoth(recipientId, legacyEnvelope, "dm:typing", eventPayload);
};

export const createGroupMessageWithSideEffects = async (
  sender: AuthUser,
  groupId: string,
  payload: CreateGroupMessageInput,
): Promise<GroupMessageResponse> => {
  const savedMessage = await groupService.createGroupMessage(sender, groupId, payload);

  const [memberIds, group] = await Promise.all([
    groupService.getGroupMemberIds(groupId),
    groupRepository.findById(groupId),
  ]);

  const eventMessage = {
    clientMessageId: payload.clientMessageId ?? null,
    groupId,
    id: savedMessage.id,
    senderId: savedMessage.senderId,
    senderName: sender.name,
    text: savedMessage.text,
    type: savedMessage.type,
    attachment: savedMessage.attachment ?? null,
    createdAt: savedMessage.createdAt.toISOString(),
    editedAt: savedMessage.editedAt?.toISOString() ?? null,
  };
  const legacyEnvelope = { type: "group:message", message: eventMessage };

  notifyUsersBoth(memberIds, legacyEnvelope, "group:message", eventMessage);

  const offlineMemberIds = memberIds.filter(
    (memberId) => memberId !== sender.id && !presenceService.isOnline(memberId),
  );

  if (offlineMemberIds.length > 0) {
    const groupName = group?.name ?? "Group";
    const notifBody = savedMessage.text?.trim() || "Sent an attachment";
    void sendPushNotifications(offlineMemberIds, {
      title: groupName,
      body: `${sender.name}: ${notifBody}`,
      data: {
        type: "group",
        groupId,
        groupName,
        senderName: sender.name,
      },
    });
  }

  return savedMessage;
};

export const notifyGroupMessageEdited = async (updated: GroupMessageResponse): Promise<void> => {
  const memberIds = await groupService.getGroupMemberIds(updated.groupId);
  const eventMessage = {
    groupId: updated.groupId,
    id: updated.id,
    senderId: updated.senderId,
    senderName: updated.senderName,
    text: updated.text,
    type: updated.type,
    attachment: updated.attachment ?? null,
    createdAt: updated.createdAt.toISOString(),
    editedAt: updated.editedAt?.toISOString() ?? null,
  };
  const legacyEnvelope = { type: "group:message:updated", message: eventMessage };

  notifyUsersBoth(memberIds, legacyEnvelope, "group:message:updated", eventMessage);
};

export const notifyGroupMessageDeleted = async (deleted: GroupMessageResponse): Promise<void> => {
  const memberIds = await groupService.getGroupMemberIds(deleted.groupId);
  const eventPayload = { messageId: deleted.id, groupId: deleted.groupId };
  const legacyEnvelope = { type: "group:message:deleted", ...eventPayload };

  notifyUsersBoth(memberIds, legacyEnvelope, "group:message:deleted", eventPayload);
};
