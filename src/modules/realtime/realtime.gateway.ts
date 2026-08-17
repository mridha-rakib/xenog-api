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
import { chatMessageAttachmentSchema, chatMessageBodySchema } from "../chat/chat.validation.js";
import { ChatService } from "../chat/chat.service.js";
import { GroupService } from "../chat/group.service.js";
import type { LiveRoomMessageResponse } from "../live-rooms/live-room.interface.js";
import { LiveRoomService } from "../live-rooms/live-room.service.js";
import { UserFollowRepository } from "../user/user-follow.repository.js";
import { presenceService } from "./presence.service.js";
import { notifyUserBoth, registerBroadcastTarget } from "./realtime-dual-emit.js";
import {
  createDirectMessageWithSideEffects,
  createGroupMessageWithSideEffects,
  notifyDirectMessageDeleted,
  notifyDirectMessageEdited,
  notifyDirectTyping,
  notifyGroupMessageDeleted,
  notifyGroupMessageEdited,
} from "./chat-events.service.js";

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

  // Message creation, edit, delete, and typing all delegate to
  // chat-events.service.ts — the single shared path also used by the
  // Socket.IO gateway and the REST controllers, so persistence, realtime
  // broadcast (to both transports), and push evaluation happen exactly once
  // regardless of which entry point a client used.
  private async handleDirectMessage(
    client: RealtimeClient,
    message: Extract<ClientMessage, { type: "dm:message" }>,
  ): Promise<void> {
    try {
      await createDirectMessageWithSideEffects(client.user, message.recipientId, {
        type: message.messageType,
        text: message.text,
        attachment: message.attachment,
        clientMessageId: message.clientMessageId ?? null,
      });
    } catch (error) {
      if (error instanceof AppError && error.statusCode === httpStatus.FORBIDDEN) {
        this.sendError(client.socket, "NOT_FRIENDS", error.message);
        return;
      }

      throw error;
    }
  }

  private async handleDirectMessageEdit(
    client: RealtimeClient,
    message: Extract<ClientMessage, { type: "dm:message:edit" }>,
  ): Promise<void> {
    try {
      const updated = await this.chatService.editDirectMessage(
        client.user,
        message.messageId,
        message.text,
      );
      notifyDirectMessageEdited(updated, client.user.name);
    } catch (error) {
      if (error instanceof AppError) {
        this.sendError(client.socket, "MESSAGE_EDIT_FAILED", error.message);
        return;
      }
      throw error;
    }
  }

  private async handleDirectMessageDelete(
    client: RealtimeClient,
    message: Extract<ClientMessage, { type: "dm:message:delete" }>,
  ): Promise<void> {
    try {
      const deleted = await this.chatService.deleteDirectMessage(client.user, message.messageId);
      notifyDirectMessageDeleted(deleted);
    } catch (error) {
      if (error instanceof AppError) {
        this.sendError(client.socket, "MESSAGE_DELETE_FAILED", error.message);
        return;
      }
      throw error;
    }
  }

  private async handleDirectTyping(
    client: RealtimeClient,
    message: Extract<ClientMessage, { type: "dm:typing" }>,
  ): Promise<void> {
    try {
      // Typing indicators reuse the send gate (not the read gate) — a
      // message-only-blocked pair must not expose active-typing state,
      // exactly as if messaging were fully unavailable.
      await this.chatService.assertCanSendDirectMessage(client.user.id, message.recipientId);
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

    notifyDirectTyping(message.recipientId, {
      isTyping: message.isTyping,
      senderId: client.user.id,
      senderName: client.user.name,
    });
  }

  private async handleGroupMessage(
    client: RealtimeClient,
    message: Extract<ClientMessage, { type: "group:message" }>,
  ): Promise<void> {
    try {
      await createGroupMessageWithSideEffects(client.user, message.groupId, {
        type: message.messageType,
        text: message.text,
        attachment: message.attachment,
        clientMessageId: message.clientMessageId ?? null,
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
  }

  private async handleGroupMessageEdit(
    client: RealtimeClient,
    message: Extract<ClientMessage, { type: "group:message:edit" }>,
  ): Promise<void> {
    try {
      const updated = await this.groupService.editGroupMessage(
        client.user,
        message.messageId,
        message.text,
      );
      await notifyGroupMessageEdited(updated);
    } catch (error) {
      if (error instanceof AppError) {
        this.sendError(client.socket, "MESSAGE_EDIT_FAILED", error.message);
        return;
      }
      throw error;
    }
  }

  private async handleGroupMessageDelete(
    client: RealtimeClient,
    message: Extract<ClientMessage, { type: "group:message:delete" }>,
  ): Promise<void> {
    try {
      const deleted = await this.groupService.deleteGroupMessage(client.user, message.messageId);
      await notifyGroupMessageDeleted(deleted);
    } catch (error) {
      if (error instanceof AppError) {
        this.sendError(client.socket, "MESSAGE_DELETE_FAILED", error.message);
        return;
      }
      throw error;
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

    userClients.add(client);
    this.clientsByUserId.set(client.user.id, userClients);

    // presenceService is shared with the Socket.IO gateway, so this reflects
    // whether the user had ANY live connection on either transport — not
    // just whether this transport had one — before this connection opened.
    const isFirstConnectionGlobally = presenceService.markConnected(client.user.id);

    if (isFirstConnectionGlobally) {
      void this.broadcastPresence(client.user.id, true);
    }
  }

  private removeClient(client: RealtimeClient): void {
    const userClients = this.clientsByUserId.get(client.user.id);

    userClients?.delete(client);

    if (userClients?.size === 0) {
      this.clientsByUserId.delete(client.user.id);
    }

    const wasLastConnectionGlobally = presenceService.markDisconnected(client.user.id);

    if (wasLastConnectionGlobally) {
      void this.broadcastPresence(client.user.id, false);
    }

    for (const roomId of Array.from(client.liveRooms)) {
      this.leaveLiveRoom(client, roomId);
    }
  }

  private async broadcastPresence(userId: string, isOnline: boolean): Promise<void> {
    try {
      const friendIds = await this.userFollowRepository.findMutualFriendIds(userId);
      const event = isOnline ? "user:online" : "user:offline";
      const payload = { userId };
      const legacyEnvelope = { type: event, userId };

      for (const friendId of friendIds) {
        notifyUserBoth(friendId, legacyEnvelope, event, payload);
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

// Register the legacy transport as a dual-emit target: it only understands
// the pre-existing `{ type, ... }` envelope shape, so it ignores the
// Socket.IO-specific (event, payload) arguments.
registerBroadcastTarget({
  notifyUser: (userId, legacyEnvelope) => realtimeGateway.notifyUser(userId, legacyEnvelope),
});
