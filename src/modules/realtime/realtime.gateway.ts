import type { IncomingMessage, Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import httpStatus from "http-status";
import { z } from "zod";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { AppError } from "../../core/errors/app-error.js";
import { logger } from "../../core/logger/logger.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { AuthService } from "../auth/auth.service.js";
import type { DirectMessageResponse } from "../chat/chat.interface.js";
import { chatMessageAttachmentSchema, chatMessageBodySchema } from "../chat/chat.validation.js";
import { ChatService } from "../chat/chat.service.js";
import type { GroupMessageResponse } from "../chat/group.interface.js";
import { GroupService } from "../chat/group.service.js";
import { GroupRepository } from "../chat/group.repository.js";
import type { LiveRoomMessageResponse } from "../live-rooms/live-room.interface.js";
import { LiveRoomService } from "../live-rooms/live-room.service.js";
import { UserFollowRepository } from "../user/user-follow.repository.js";
import { presenceService } from "./presence.service.js";
import { sendPushNotifications } from "../notifications/fcm.service.js";

type RealtimeClient = {
  isAlive: boolean;
  socket: WebSocket;
  user: AuthUser;
  liveRooms: Set<string>;
};

const objectId = z
  .string()
  .trim()
  .regex(/^[a-f\d]{24}$/i);
const chatMessageFields = {
  messageType: z.enum(["text", "image", "video", "audio", "location", "event"]).optional(),
  text: z.string().trim().max(2000).optional(),
  attachment: chatMessageAttachmentSchema.optional(),
};
const validateRealtimeChatBody = (
  value: { messageType?: string; text?: string; attachment?: unknown },
  ctx: z.RefinementCtx,
) => {
  const result = chatMessageBodySchema.safeParse({
    type: value.messageType,
    text: value.text,
    attachment: value.attachment,
  });

  if (!result.success) {
    for (const issue of result.error.issues) {
      ctx.addIssue(issue);
    }
  }
};

const clientMessageSchema = z.union([
  z
    .object({
      type: z.literal("dm:message"),
      clientMessageId: z.string().trim().min(1).max(120).optional(),
      recipientId: objectId,
      ...chatMessageFields,
    })
    .strict()
    .superRefine(validateRealtimeChatBody),
  z.object({
    type: z.literal("dm:typing"),
    recipientId: objectId,
    isTyping: z.boolean(),
  }),
  z
    .object({
      type: z.literal("dm:message:edit"),
      messageId: objectId,
      text: z.string().trim().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      type: z.literal("dm:message:delete"),
      messageId: objectId,
    })
    .strict(),
  z.object({
    type: z.literal("live:join"),
    roomId: z.string().trim().min(1).max(160),
  }),
  z.object({
    type: z.literal("live:leave"),
    roomId: z.string().trim().min(1).max(160),
  }),
  z.object({
    type: z.literal("live:message"),
    clientMessageId: z.string().trim().min(1).max(120).optional(),
    roomId: z.string().trim().min(1).max(160),
    text: z.string().trim().min(1).max(1000),
  }),
  z
    .object({
      type: z.literal("group:message"),
      clientMessageId: z.string().trim().min(1).max(120).optional(),
      groupId: objectId,
      ...chatMessageFields,
    })
    .strict()
    .superRefine(validateRealtimeChatBody),
  z
    .object({
      type: z.literal("group:message:edit"),
      messageId: objectId,
      text: z.string().trim().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      type: z.literal("group:message:delete"),
      messageId: objectId,
    })
    .strict(),
  z.object({
    type: z.literal("ping"),
  }),
]);

type ClientMessage = z.infer<typeof clientMessageSchema>;

export class RealtimeGateway {
  private readonly clientsByUserId = new Map<string, Set<RealtimeClient>>();
  private readonly liveRooms = new Map<string, Set<RealtimeClient>>();
  private heartbeatInterval?: ReturnType<typeof setInterval>;
  private wss?: WebSocketServer;

  public constructor(
    private readonly authService = new AuthService(),
    private readonly chatService = new ChatService(),
    private readonly groupService = new GroupService(),
    private readonly groupRepository = new GroupRepository(),
    private readonly liveRoomService = new LiveRoomService(),
    private readonly userFollowRepository = new UserFollowRepository(),
  ) {}

  public isUserOnline(userId: string): boolean {
    const clients = this.clientsByUserId.get(userId);
    return Boolean(clients && clients.size > 0);
  }

  public notifyUser(userId: string, payload: unknown): void {
    this.broadcastToUser(userId, payload);
  }

  public attach(server: HttpServer): void {
    this.wss = new WebSocketServer({
      path: "/ws",
      server,
    });

    this.wss.on("connection", (socket, request) => {
      void this.handleConnection(socket, request);
    });
    this.heartbeatInterval = setInterval(() => this.terminateDeadClients(), 30_000);

    logger.info({ path: "/ws" }, "Realtime WebSocket gateway attached");
  }

  public close(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }

    const clients = Array.from(this.clientsByUserId.values()).flatMap((userClients) =>
      Array.from(userClients),
    );
    for (const client of clients) {
      this.removeClient(client);
      client.socket.terminate();
    }

    this.wss?.close();
    this.wss = undefined;
  }

  private async handleConnection(socket: WebSocket, request: IncomingMessage): Promise<void> {
    try {
      const user = await this.authenticateRequest(request);
      const client: RealtimeClient = {
        isAlive: true,
        liveRooms: new Set(),
        socket,
        user,
      };

      this.addUserClient(client);
      this.send(socket, {
        type: "ready",
        user: {
          id: user.id,
          name: user.name,
        },
      });

      socket.on("message", (data) => {
        void this.handleMessage(client, data);
      });
      socket.on("pong", () => {
        client.isAlive = true;
      });
      socket.on("close", () => this.removeClient(client));
      socket.on("error", (error) => {
        logger.warn({ error, userId: user.id }, "Realtime socket error");
      });
    } catch (error) {
      logger.warn({ error }, "Realtime socket authentication failed");
      socket.close(1008, "Authentication required");
    }
  }

  private async authenticateRequest(request: IncomingMessage): Promise<AuthUser> {
    const baseUrl = `http://${request.headers.host ?? "localhost"}`;
    const requestUrl = new URL(request.url ?? "/ws", baseUrl);
    const token = requestUrl.searchParams.get("token");

    if (!token) {
      throw new Error("Missing realtime access token");
    }

    const payload = this.authService.verifyAccessToken(token);

    return this.authService.getCurrentUser(payload.sub);
  }

  private async handleMessage(client: RealtimeClient, data: RawData): Promise<void> {
    let parsed: unknown;

    try {
      parsed = JSON.parse(data.toString());
    } catch {
      this.sendError(client.socket, "INVALID_JSON", "Invalid realtime payload.");
      return;
    }

    const result = clientMessageSchema.safeParse(parsed);

    if (!result.success) {
      this.sendError(client.socket, "INVALID_MESSAGE", "Invalid realtime message.");
      return;
    }

    try {
      await this.routeMessage(client, result.data);
    } catch (error) {
      logger.warn({ error, userId: client.user.id }, "Realtime message handling failed");
      this.sendError(client.socket, "MESSAGE_FAILED", "Unable to process realtime message.");
    }
  }

  private async routeMessage(client: RealtimeClient, message: ClientMessage): Promise<void> {
    switch (message.type) {
      case "dm:message":
        await this.handleDirectMessage(client, message);
        return;
      case "dm:typing":
        await this.handleDirectTyping(client, message);
        return;
      case "dm:message:edit":
        await this.handleDirectMessageEdit(client, message);
        return;
      case "dm:message:delete":
        await this.handleDirectMessageDelete(client, message);
        return;
      case "group:message":
        await this.handleGroupMessage(client, message);
        return;
      case "group:message:edit":
        await this.handleGroupMessageEdit(client, message);
        return;
      case "group:message:delete":
        await this.handleGroupMessageDelete(client, message);
        return;
      case "live:join":
        await this.handleLiveJoin(client, message);
        return;
      case "live:leave":
        this.leaveLiveRoom(client, message.roomId);
        return;
      case "live:message":
        await this.handleLiveMessage(client, message);
        return;
      case "ping":
        this.send(client.socket, { type: "pong" });
        return;
      default:
        return;
    }
  }

  private async handleDirectMessage(
    client: RealtimeClient,
    message: Extract<ClientMessage, { type: "dm:message" }>,
  ): Promise<void> {
    const recipientId = message.recipientId;
    let savedMessage: DirectMessageResponse;

    try {
      savedMessage = await this.chatService.createDirectMessage(client.user, recipientId, {
        type: message.messageType,
        text: message.text,
        attachment: message.attachment,
      });
    } catch (error) {
      if (error instanceof AppError && error.statusCode === httpStatus.FORBIDDEN) {
        this.sendError(client.socket, "NOT_FRIENDS", error.message);
        return;
      }

      throw error;
    }

    const payload = {
      type: "dm:message",
      message: {
        clientMessageId: message.clientMessageId ?? null,
        conversationId: savedMessage.conversationId,
        createdAt: savedMessage.createdAt.toISOString(),
        id: savedMessage.id,
        recipientId,
        senderId: savedMessage.senderId,
        senderName: client.user.name,
        text: savedMessage.text,
        type: savedMessage.type,
        attachment: savedMessage.attachment ?? null,
        editedAt: savedMessage.editedAt?.toISOString() ?? null,
      },
    };

    this.broadcastToUser(client.user.id, payload);
    this.broadcastToUser(recipientId, payload);

    if (!this.isUserOnline(recipientId)) {
      const notifBody = savedMessage.text?.trim() || "Sent an attachment";
      void sendPushNotifications([recipientId], {
        title: client.user.name,
        body: notifBody,
        data: {
          type: "dm",
          conversationPartnerId: client.user.id,
          senderName: client.user.name,
          conversationId: savedMessage.conversationId,
        },
      });
    }
  }

  private async handleDirectMessageEdit(
    client: RealtimeClient,
    message: Extract<ClientMessage, { type: "dm:message:edit" }>,
  ): Promise<void> {
    let updated: DirectMessageResponse;

    try {
      updated = await this.chatService.editDirectMessage(
        client.user,
        message.messageId,
        message.text,
      );
    } catch (error) {
      if (error instanceof AppError) {
        this.sendError(client.socket, "MESSAGE_EDIT_FAILED", error.message);
        return;
      }
      throw error;
    }

    const payload = {
      type: "dm:message:updated",
      message: {
        conversationId: updated.conversationId,
        createdAt: updated.createdAt.toISOString(),
        editedAt: updated.editedAt?.toISOString() ?? null,
        id: updated.id,
        recipientId: updated.recipientId,
        senderId: updated.senderId,
        senderName: client.user.name,
        text: updated.text,
        type: updated.type,
        attachment: updated.attachment ?? null,
      },
    };

    this.broadcastToUser(updated.senderId, payload);
    this.broadcastToUser(updated.recipientId, payload);
  }

  private async handleDirectMessageDelete(
    client: RealtimeClient,
    message: Extract<ClientMessage, { type: "dm:message:delete" }>,
  ): Promise<void> {
    let deleted: DirectMessageResponse;

    try {
      deleted = await this.chatService.deleteDirectMessage(client.user, message.messageId);
    } catch (error) {
      if (error instanceof AppError) {
        this.sendError(client.socket, "MESSAGE_DELETE_FAILED", error.message);
        return;
      }
      throw error;
    }

    const payload = {
      type: "dm:message:deleted",
      messageId: deleted.id,
      conversationId: deleted.conversationId,
    };

    this.broadcastToUser(deleted.senderId, payload);
    this.broadcastToUser(deleted.recipientId, payload);
  }

  private async handleDirectTyping(
    client: RealtimeClient,
    message: Extract<ClientMessage, { type: "dm:typing" }>,
  ): Promise<void> {
    try {
      await this.chatService.assertCanDirectMessage(client.user.id, message.recipientId);
    } catch (error) {
      if (error instanceof AppError) {
        this.sendError(
          client.socket,
          error.statusCode === httpStatus.FORBIDDEN ? "NOT_FRIENDS" : "DM_UNAVAILABLE",
          error.message,
        );
        return;
      }

      throw error;
    }

    this.broadcastToUser(message.recipientId, {
      type: "dm:typing",
      typing: {
        isTyping: message.isTyping,
        recipientId: message.recipientId,
        senderId: client.user.id,
        senderName: client.user.name,
        updatedAt: new Date().toISOString(),
      },
    });
  }

  private async handleGroupMessage(
    client: RealtimeClient,
    message: Extract<ClientMessage, { type: "group:message" }>,
  ): Promise<void> {
    let savedMessage: GroupMessageResponse;

    try {
      savedMessage = await this.groupService.createGroupMessage(client.user, message.groupId, {
        type: message.messageType,
        text: message.text,
        attachment: message.attachment,
      });
    } catch (error) {
      if (error instanceof AppError) {
        this.sendError(
          client.socket,
          error.statusCode === httpStatus.FORBIDDEN ? "NOT_GROUP_MEMBER" : "GROUP_MESSAGE_FAILED",
          error.message,
        );
        return;
      }

      throw error;
    }

    const [memberIds, group] = await Promise.all([
      this.groupService.getGroupMemberIds(message.groupId),
      this.groupRepository.findById(message.groupId),
    ]);

    const payload = {
      type: "group:message",
      message: {
        clientMessageId: message.clientMessageId ?? null,
        groupId: message.groupId,
        id: savedMessage.id,
        senderId: savedMessage.senderId,
        senderName: client.user.name,
        text: savedMessage.text,
        type: savedMessage.type,
        attachment: savedMessage.attachment ?? null,
        createdAt: savedMessage.createdAt.toISOString(),
        editedAt: savedMessage.editedAt?.toISOString() ?? null,
      },
    };

    for (const memberId of memberIds) {
      this.broadcastToUser(memberId, payload);
    }

    const offlineMemberIds = memberIds.filter(
      (memberId) => memberId !== client.user.id && !this.isUserOnline(memberId),
    );

    if (offlineMemberIds.length > 0) {
      const groupName = group?.name ?? "Group";
      const notifBody = savedMessage.text?.trim() || "Sent an attachment";
      void sendPushNotifications(offlineMemberIds, {
        title: groupName,
        body: `${client.user.name}: ${notifBody}`,
        data: {
          type: "group",
          groupId: message.groupId,
          groupName: groupName,
          senderName: client.user.name,
        },
      });
    }
  }

  private async handleGroupMessageEdit(
    client: RealtimeClient,
    message: Extract<ClientMessage, { type: "group:message:edit" }>,
  ): Promise<void> {
    let updated: GroupMessageResponse;

    try {
      updated = await this.groupService.editGroupMessage(
        client.user,
        message.messageId,
        message.text,
      );
    } catch (error) {
      if (error instanceof AppError) {
        this.sendError(client.socket, "MESSAGE_EDIT_FAILED", error.message);
        return;
      }
      throw error;
    }

    const memberIds = await this.groupService.getGroupMemberIds(updated.groupId);
    const payload = {
      type: "group:message:updated",
      message: {
        groupId: updated.groupId,
        id: updated.id,
        senderId: updated.senderId,
        senderName: client.user.name,
        text: updated.text,
        type: updated.type,
        attachment: updated.attachment ?? null,
        createdAt: updated.createdAt.toISOString(),
        editedAt: updated.editedAt?.toISOString() ?? null,
      },
    };

    for (const memberId of memberIds) {
      this.broadcastToUser(memberId, payload);
    }
  }

  private async handleGroupMessageDelete(
    client: RealtimeClient,
    message: Extract<ClientMessage, { type: "group:message:delete" }>,
  ): Promise<void> {
    let deleted: GroupMessageResponse;

    try {
      deleted = await this.groupService.deleteGroupMessage(client.user, message.messageId);
    } catch (error) {
      if (error instanceof AppError) {
        this.sendError(client.socket, "MESSAGE_DELETE_FAILED", error.message);
        return;
      }
      throw error;
    }

    const memberIds = await this.groupService.getGroupMemberIds(deleted.groupId);
    const payload = {
      type: "group:message:deleted",
      messageId: deleted.id,
      groupId: deleted.groupId,
    };

    for (const memberId of memberIds) {
      this.broadcastToUser(memberId, payload);
    }
  }

  private handleLiveMessage(
    client: RealtimeClient,
    message: Extract<ClientMessage, { type: "live:message" }>,
  ): Promise<void> | void {
    if (objectId.safeParse(message.roomId).success) {
      return this.handlePersistedLiveMessage(client, message);
    }

    this.broadcastToLiveRoom(message.roomId, {
      type: "live:message",
      roomId: message.roomId,
      message: {
        clientMessageId: message.clientMessageId ?? null,
        createdAt: new Date().toISOString(),
        id: randomUUID(),
        senderId: client.user.id,
        senderName: client.user.name,
        text: message.text,
      },
    });
  }

  private async handleLiveJoin(
    client: RealtimeClient,
    message: Extract<ClientMessage, { type: "live:join" }>,
  ): Promise<void> {
    if (objectId.safeParse(message.roomId).success) {
      try {
        await this.liveRoomService.assertEventChatAccess(client.user, message.roomId);
      } catch (error) {
        if (error instanceof AppError) {
          this.sendError(client.socket, "EVENT_CHAT_ACCESS_DENIED", error.message);
          return;
        }

        throw error;
      }
    }

    this.joinLiveRoom(client, message.roomId);
  }

  private async handlePersistedLiveMessage(
    client: RealtimeClient,
    message: Extract<ClientMessage, { type: "live:message" }>,
  ): Promise<void> {
    let savedMessage: LiveRoomMessageResponse;

    try {
      savedMessage = await this.liveRoomService.createMessage(client.user, message.roomId, {
        text: message.text,
      });
    } catch (error) {
      if (error instanceof AppError) {
        this.sendError(client.socket, "EVENT_CHAT_ACCESS_DENIED", error.message);
        return;
      }

      throw error;
    }

    this.broadcastToLiveRoom(message.roomId, {
      type: "live:message",
      roomId: message.roomId,
      message: {
        clientMessageId: message.clientMessageId ?? null,
        createdAt: savedMessage.createdAt.toISOString(),
        id: savedMessage.id,
        senderAvatarUrl: savedMessage.senderAvatarUrl ?? null,
        senderId: savedMessage.senderId,
        senderName: savedMessage.senderName,
        text: savedMessage.text,
      },
    });
  }

  private joinLiveRoom(client: RealtimeClient, roomId: string): void {
    client.liveRooms.add(roomId);

    const roomClients = this.liveRooms.get(roomId) ?? new Set<RealtimeClient>();
    roomClients.add(client);
    this.liveRooms.set(roomId, roomClients);
  }

  private leaveLiveRoom(client: RealtimeClient, roomId: string): void {
    client.liveRooms.delete(roomId);

    const roomClients = this.liveRooms.get(roomId);
    roomClients?.delete(client);

    if (roomClients?.size === 0) {
      this.liveRooms.delete(roomId);
    }
  }

  private addUserClient(client: RealtimeClient): void {
    const userClients = this.clientsByUserId.get(client.user.id) ?? new Set<RealtimeClient>();
    const wasOffline = userClients.size === 0;

    userClients.add(client);
    this.clientsByUserId.set(client.user.id, userClients);
    presenceService.markConnected(client.user.id);

    if (wasOffline) {
      void this.broadcastPresence(client.user.id, true);
    }
  }

  private removeClient(client: RealtimeClient): void {
    const userClients = this.clientsByUserId.get(client.user.id);

    userClients?.delete(client);

    if (userClients?.size === 0) {
      this.clientsByUserId.delete(client.user.id);
      presenceService.markDisconnected(client.user.id);
      void this.broadcastPresence(client.user.id, false);
    }

    for (const roomId of Array.from(client.liveRooms)) {
      this.leaveLiveRoom(client, roomId);
    }
  }

  private async broadcastPresence(userId: string, isOnline: boolean): Promise<void> {
    try {
      const friendIds = await this.userFollowRepository.findMutualFriendIds(userId);
      const payload = { type: isOnline ? "user:online" : "user:offline", userId };

      for (const friendId of friendIds) {
        this.broadcastToUser(friendId, payload);
      }
    } catch (error) {
      logger.warn({ error, userId }, "Failed to broadcast user presence");
    }
  }

  private broadcastToUser(userId: string, payload: unknown): void {
    const userClients = this.clientsByUserId.get(userId);

    userClients?.forEach((client) => this.send(client.socket, payload));
  }

  private broadcastToLiveRoom(roomId: string, payload: unknown): void {
    const roomClients = this.liveRooms.get(roomId);

    roomClients?.forEach((client) => this.send(client.socket, payload));
  }

  private send(socket: WebSocket, payload: unknown): void {
    if (socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify(payload));
      } catch (error) {
        logger.warn({ error }, "Realtime socket send failed");
      }
    }
  }

  private sendError(socket: WebSocket, code: string, message: string): void {
    this.send(socket, {
      code,
      message,
      type: "error",
    });
  }

  private terminateDeadClients(): void {
    const clients = Array.from(this.clientsByUserId.values()).flatMap((userClients) =>
      Array.from(userClients),
    );

    for (const client of clients) {
      if (client.socket.readyState !== WebSocket.OPEN) {
        continue;
      }

      if (!client.isAlive) {
        logger.warn({ userId: client.user.id }, "Terminating stale realtime socket");
        client.socket.terminate();
        continue;
      }

      client.isAlive = false;
      try {
        client.socket.ping();
      } catch (error) {
        logger.warn({ error, userId: client.user.id }, "Realtime ping failed");
        client.socket.terminate();
      }
    }
  }
}

export const realtimeGateway = new RealtimeGateway();
