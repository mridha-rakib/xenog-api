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
import { ChatService } from "../chat/chat.service.js";
import { LiveRoomService } from "../live-rooms/live-room.service.js";

type RealtimeClient = {
  socket: WebSocket;
  user: AuthUser;
  liveRooms: Set<string>;
};

const objectId = z.string().trim().regex(/^[a-f\d]{24}$/i);

const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("dm:message"),
    clientMessageId: z.string().trim().min(1).max(120).optional(),
    recipientId: objectId,
    text: z.string().trim().min(1).max(2000),
  }),
  z.object({
    type: z.literal("dm:typing"),
    recipientId: objectId,
    isTyping: z.boolean(),
  }),
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
  z.object({
    type: z.literal("ping"),
  }),
]);

type ClientMessage = z.infer<typeof clientMessageSchema>;

export class RealtimeGateway {
  private readonly clientsByUserId = new Map<string, Set<RealtimeClient>>();
  private readonly liveRooms = new Map<string, Set<RealtimeClient>>();
  private wss?: WebSocketServer;

  public constructor(
    private readonly authService = new AuthService(),
    private readonly chatService = new ChatService(),
    private readonly liveRoomService = new LiveRoomService(),
  ) {}

  public attach(server: HttpServer): void {
    this.wss = new WebSocketServer({
      path: "/ws",
      server,
    });

    this.wss.on("connection", (socket, request) => {
      void this.handleConnection(socket, request);
    });

    logger.info({ path: "/ws" }, "Realtime WebSocket gateway attached");
  }

  public close(): void {
    this.wss?.close();
  }

  private async handleConnection(socket: WebSocket, request: IncomingMessage): Promise<void> {
    try {
      const user = await this.authenticateRequest(request);
      const client: RealtimeClient = {
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
      case "live:join":
        this.joinLiveRoom(client, message.roomId);
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
        text: message.text,
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
      },
    };

    this.broadcastToUser(client.user.id, payload);
    this.broadcastToUser(recipientId, payload);
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

  private handleLiveMessage(
    client: RealtimeClient,
    message: Extract<ClientMessage, { type: "live:message" }>,
  ): Promise<void> | void {
    this.joinLiveRoom(client, message.roomId);

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

  private async handlePersistedLiveMessage(
    client: RealtimeClient,
    message: Extract<ClientMessage, { type: "live:message" }>,
  ): Promise<void> {
    const savedMessage = await this.liveRoomService.createMessage(client.user, message.roomId, {
      text: message.text,
    });

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
  }

  private removeClient(client: RealtimeClient): void {
    const userClients = this.clientsByUserId.get(client.user.id);

    userClients?.delete(client);

    if (userClients?.size === 0) {
      this.clientsByUserId.delete(client.user.id);
    }

    for (const roomId of Array.from(client.liveRooms)) {
      this.leaveLiveRoom(client, roomId);
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
      socket.send(JSON.stringify(payload));
    }
  }

  private sendError(socket: WebSocket, code: string, message: string): void {
    this.send(socket, {
      code,
      message,
      type: "error",
    });
  }
}
