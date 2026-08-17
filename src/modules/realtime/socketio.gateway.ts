import type { Server as HttpServer } from "node:http";
import { Server as SocketIOServer, type Socket } from "socket.io";
import { z } from "zod";
import httpStatus from "http-status";
import { env } from "../../config/env.js";
import { AppError } from "../../core/errors/app-error.js";
import { logger } from "../../core/logger/logger.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { AuthService } from "../auth/auth.service.js";
import { chatMessageAttachmentSchema, chatMessageBodySchema } from "../chat/chat.validation.js";
import { ChatService } from "../chat/chat.service.js";
import { GroupService } from "../chat/group.service.js";
import { chatMessageTypes } from "../chat/chat.interface.js";
import { LiveRoomService } from "../live-rooms/live-room.service.js";
import {
  createDirectMessageWithSideEffects,
  createGroupMessageWithSideEffects,
  notifyDirectMessageDeleted,
  notifyDirectMessageEdited,
  notifyDirectTyping,
  notifyGroupMessageDeleted,
  notifyGroupMessageEdited,
} from "./chat-events.service.js";
import { createLiveRoomMessageWithSideEffects, registerLiveRoomBroadcastTarget } from "./live-room-events.service.js";
import { presenceService } from "./presence.service.js";
import { notifyUserBoth, registerBroadcastTarget } from "./realtime-dual-emit.js";
import { UserFollowRepository } from "../user/user-follow.repository.js";

type AckResponse<T> = { ok: true; message: T } | { ok: false; code?: string; message: string };
type AckCallback<T> = (response: AckResponse<T>) => void;

const objectId = z
  .string()
  .trim()
  .regex(/^[a-f\d]{24}$/i);

const chatMessageFields = {
  messageType: z.enum(chatMessageTypes).optional(),
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

const dmMessageSchema = z
  .object({
    clientMessageId: z.string().trim().min(1).max(120).optional(),
    recipientId: objectId,
    ...chatMessageFields,
  })
  .strict()
  .superRefine(validateRealtimeChatBody);

const dmTypingSchema = z.object({
  recipientId: objectId,
  isTyping: z.boolean(),
});

const dmEditSchema = z
  .object({
    messageId: objectId,
    text: z.string().trim().min(1).max(2000),
  })
  .strict();

const dmDeleteSchema = z
  .object({
    messageId: objectId,
  })
  .strict();

const groupMessageSchema = z
  .object({
    clientMessageId: z.string().trim().min(1).max(120).optional(),
    groupId: objectId,
    ...chatMessageFields,
  })
  .strict()
  .superRefine(validateRealtimeChatBody);

const liveRoomJoinSchema = z.object({ liveRoomId: objectId }).strict();
const liveRoomLeaveSchema = z.object({ liveRoomId: objectId }).strict();
const liveRoomMessageSchema = z
  .object({
    liveRoomId: objectId,
    text: z.string().trim().min(1).max(1000),
    clientMessageId: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

const userRoom = (userId: string) => `user:${userId}`;
const liveRoomRoom = (liveRoomId: string) => `live:${liveRoomId}`;

/**
 * Socket.IO gateway for DM/group chat + presence + notifications + Event
 * Chat (live rooms).
 *
 * Chat message creation is delegated to chat-events.service.ts /
 * live-room-events.service.ts, the same shared paths the REST controllers
 * use, so there is exactly one place that persists + broadcasts (+ decides
 * push, for DM/group) for a new message.
 *
 * Event Chat's `live:*` handlers here are a separate, additive realtime path
 * from the legacy raw-ws gateway's own `live:*` handling (realtime.gateway.ts)
 * — that one is NOT retired, because it also backs the unrelated standalone
 * Live Room (audio room) feature (see live-room-screen.tsx), which still
 * depends on it. Only the Event Chat client (ChatTab.tsx) has been cut over
 * to this gateway.
 */
export class SocketIOGateway {
  private io?: SocketIOServer;

  public constructor(
    private readonly authService = new AuthService(),
    private readonly chatService = new ChatService(),
    private readonly groupService = new GroupService(),
    private readonly liveRoomService = new LiveRoomService(),
    private readonly userFollowRepository = new UserFollowRepository(),
  ) {}

  public attach(server: HttpServer): void {
    const corsOrigin = env.CORS_ORIGIN ?? env.APP_ORIGIN;

    this.io = new SocketIOServer(server, {
      path: "/socket.io",
      cors: {
        origin: corsOrigin === "*" ? true : corsOrigin.split(",").map((origin) => origin.trim()),
        credentials: true,
      },
    });

    this.io.use((socket, next) => {
      void this.authenticateSocket(socket)
        .then((user) => {
          socket.data.user = user;
          next();
        })
        .catch((error) => {
          logger.warn({ error }, "Socket.IO authentication failed");
          const authError = new Error("Authentication required") as Error & {
            data?: { code: string };
          };
          authError.data = { code: "AUTHENTICATION_REQUIRED" };
          next(authError);
        });
    });

    this.io.on("connection", (socket) => {
      void this.handleConnection(socket);
    });

    registerBroadcastTarget({
      notifyUser: (userId, _legacyEnvelope, event, payload) => this.notifyUser(userId, event, payload),
    });

    registerLiveRoomBroadcastTarget({
      broadcast: (liveRoomId, event, payload) => {
        this.io?.to(liveRoomRoom(liveRoomId)).emit(event, payload);
      },
    });

    logger.info({ path: "/socket.io" }, "Socket.IO gateway attached");
  }

  public close(): void {
    this.io?.close();
    this.io = undefined;
  }

  public isUserOnline(userId: string): boolean {
    const room = this.io?.sockets.adapter.rooms.get(userRoom(userId));
    return Boolean(room && room.size > 0);
  }

  public notifyUser(userId: string, event: string, payload: unknown): void {
    this.io?.to(userRoom(userId)).emit(event, payload);
  }

  private async authenticateSocket(socket: Socket): Promise<AuthUser> {
    const token =
      (socket.handshake.auth?.token as string | undefined) ??
      (socket.handshake.query?.token as string | undefined);

    if (!token) {
      throw new Error("Missing realtime access token");
    }

    const payload = this.authService.verifyAccessToken(token);
    return this.authService.getCurrentUser(payload.sub);
  }

  private async handleConnection(socket: Socket): Promise<void> {
    const user = socket.data.user as AuthUser;

    logger.debug({ userId: user.id, socketId: socket.id }, "Socket.IO client connected");

    await socket.join(userRoom(user.id));

    const isFirstConnectionGlobally = presenceService.markConnected(user.id);
    if (isFirstConnectionGlobally) {
      void this.broadcastPresence(user.id, true);
    }

    socket.emit("ready", { type: "ready", user: { id: user.id, name: user.name } });

    socket.on("dm:message", (payload: unknown, ack?: AckCallback<unknown>) =>
      void this.handleDirectMessage(socket, user, payload, ack),
    );
    socket.on("dm:typing", (payload: unknown) => void this.handleDirectTyping(user, payload));
    socket.on("dm:message:edit", (payload: unknown, ack?: AckCallback<unknown>) =>
      void this.handleDirectMessageEdit(user, payload, ack),
    );
    socket.on("dm:message:delete", (payload: unknown, ack?: AckCallback<unknown>) =>
      void this.handleDirectMessageDelete(user, payload, ack),
    );
    socket.on("group:message", (payload: unknown, ack?: AckCallback<unknown>) =>
      void this.handleGroupMessage(socket, user, payload, ack),
    );
    socket.on("group:message:edit", (payload: unknown, ack?: AckCallback<unknown>) =>
      void this.handleGroupMessageEdit(user, payload, ack),
    );
    socket.on("group:message:delete", (payload: unknown, ack?: AckCallback<unknown>) =>
      void this.handleGroupMessageDelete(user, payload, ack),
    );
    socket.on("live:join", (payload: unknown, ack?: AckCallback<unknown>) =>
      void this.handleLiveRoomJoin(socket, user, payload, ack),
    );
    socket.on("live:leave", (payload: unknown, ack?: AckCallback<unknown>) =>
      this.handleLiveRoomLeave(socket, payload, ack),
    );
    socket.on("live:message", (payload: unknown, ack?: AckCallback<unknown>) =>
      void this.handleLiveRoomMessage(socket, user, payload, ack),
    );

    socket.on("disconnect", (reason) => {
      logger.debug({ userId: user.id, socketId: socket.id, reason }, "Socket.IO client disconnected");
      const wasLastConnectionGlobally = presenceService.markDisconnected(user.id);
      if (wasLastConnectionGlobally) {
        void this.broadcastPresence(user.id, false);
      }
    });
  }

  private async handleDirectMessage(
    socket: Socket,
    user: AuthUser,
    rawPayload: unknown,
    ack?: AckCallback<unknown>,
  ): Promise<void> {
    const result = dmMessageSchema.safeParse(rawPayload);
    if (!result.success) {
      this.sendError(socket, "INVALID_MESSAGE", "Invalid realtime message.");
      ack?.({ ok: false, code: "INVALID_MESSAGE", message: "Invalid realtime message." });
      return;
    }

    try {
      const savedMessage = await createDirectMessageWithSideEffects(user, result.data.recipientId, {
        type: result.data.messageType,
        text: result.data.text,
        attachment: result.data.attachment,
        clientMessageId: result.data.clientMessageId ?? null,
      });
      ack?.({ ok: true, message: savedMessage });
    } catch (error) {
      if (error instanceof AppError && error.statusCode === httpStatus.FORBIDDEN) {
        this.sendError(socket, "NOT_FRIENDS", error.message);
        ack?.({ ok: false, code: "NOT_FRIENDS", message: error.message });
        return;
      }
      logger.warn({ error, userId: user.id }, "Socket.IO dm:message failed");
      this.sendError(socket, "MESSAGE_FAILED", "Unable to process realtime message.");
      ack?.({ ok: false, code: "MESSAGE_FAILED", message: "Unable to process realtime message." });
    }
  }

  private async handleDirectTyping(user: AuthUser, rawPayload: unknown): Promise<void> {
    const result = dmTypingSchema.safeParse(rawPayload);
    if (!result.success) return;

    try {
      // Typing indicators reuse the send gate (not the read gate) — a
      // message-only-blocked pair must not expose active-typing state,
      // exactly as if messaging were fully unavailable.
      await this.chatService.assertCanSendDirectMessage(user.id, result.data.recipientId);
    } catch {
      return;
    }

    notifyDirectTyping(result.data.recipientId, {
      isTyping: result.data.isTyping,
      senderId: user.id,
      senderName: user.name,
    });
  }

  private async handleDirectMessageEdit(
    user: AuthUser,
    rawPayload: unknown,
    ack?: AckCallback<unknown>,
  ): Promise<void> {
    const result = dmEditSchema.safeParse(rawPayload);
    if (!result.success) {
      ack?.({ ok: false, code: "INVALID_MESSAGE", message: "Invalid realtime message." });
      return;
    }

    try {
      const updated = await this.chatService.editDirectMessage(user, result.data.messageId, result.data.text);
      notifyDirectMessageEdited(updated, user.name);
      ack?.({ ok: true, message: updated });
    } catch (error) {
      const message = error instanceof AppError ? error.message : "Unable to edit message.";
      ack?.({ ok: false, code: "MESSAGE_EDIT_FAILED", message });
    }
  }

  private async handleDirectMessageDelete(
    user: AuthUser,
    rawPayload: unknown,
    ack?: AckCallback<unknown>,
  ): Promise<void> {
    const result = dmDeleteSchema.safeParse(rawPayload);
    if (!result.success) {
      ack?.({ ok: false, code: "INVALID_MESSAGE", message: "Invalid realtime message." });
      return;
    }

    try {
      const deleted = await this.chatService.deleteDirectMessage(user, result.data.messageId);
      notifyDirectMessageDeleted(deleted);
      ack?.({ ok: true, message: deleted });
    } catch (error) {
      const message = error instanceof AppError ? error.message : "Unable to delete message.";
      ack?.({ ok: false, code: "MESSAGE_DELETE_FAILED", message });
    }
  }

  private async handleGroupMessage(
    socket: Socket,
    user: AuthUser,
    rawPayload: unknown,
    ack?: AckCallback<unknown>,
  ): Promise<void> {
    const result = groupMessageSchema.safeParse(rawPayload);
    if (!result.success) {
      this.sendError(socket, "INVALID_MESSAGE", "Invalid realtime message.");
      ack?.({ ok: false, code: "INVALID_MESSAGE", message: "Invalid realtime message." });
      return;
    }

    try {
      const savedMessage = await createGroupMessageWithSideEffects(user, result.data.groupId, {
        type: result.data.messageType,
        text: result.data.text,
        attachment: result.data.attachment,
        clientMessageId: result.data.clientMessageId ?? null,
      });
      ack?.({ ok: true, message: savedMessage });
    } catch (error) {
      if (error instanceof AppError) {
        const code = error.statusCode === httpStatus.FORBIDDEN ? "NOT_GROUP_MEMBER" : "GROUP_MESSAGE_FAILED";
        this.sendError(socket, code, error.message);
        ack?.({ ok: false, code, message: error.message });
        return;
      }
      logger.warn({ error, userId: user.id }, "Socket.IO group:message failed");
      this.sendError(socket, "GROUP_MESSAGE_FAILED", "Unable to process realtime message.");
      ack?.({ ok: false, code: "GROUP_MESSAGE_FAILED", message: "Unable to process realtime message." });
    }
  }

  private async handleGroupMessageEdit(
    user: AuthUser,
    rawPayload: unknown,
    ack?: AckCallback<unknown>,
  ): Promise<void> {
    const result = dmEditSchema.safeParse(rawPayload);
    if (!result.success) {
      ack?.({ ok: false, code: "INVALID_MESSAGE", message: "Invalid realtime message." });
      return;
    }

    try {
      const updated = await this.groupService.editGroupMessage(user, result.data.messageId, result.data.text);
      await notifyGroupMessageEdited(updated);
      ack?.({ ok: true, message: updated });
    } catch (error) {
      const message = error instanceof AppError ? error.message : "Unable to edit message.";
      ack?.({ ok: false, code: "MESSAGE_EDIT_FAILED", message });
    }
  }

  private async handleGroupMessageDelete(
    user: AuthUser,
    rawPayload: unknown,
    ack?: AckCallback<unknown>,
  ): Promise<void> {
    const result = dmDeleteSchema.safeParse(rawPayload);
    if (!result.success) {
      ack?.({ ok: false, code: "INVALID_MESSAGE", message: "Invalid realtime message." });
      return;
    }

    try {
      const deleted = await this.groupService.deleteGroupMessage(user, result.data.messageId);
      await notifyGroupMessageDeleted(deleted);
      ack?.({ ok: true, message: deleted });
    } catch (error) {
      const message = error instanceof AppError ? error.message : "Unable to delete message.";
      ack?.({ ok: false, code: "MESSAGE_DELETE_FAILED", message });
    }
  }

  private async handleLiveRoomJoin(
    socket: Socket,
    user: AuthUser,
    rawPayload: unknown,
    ack?: AckCallback<unknown>,
  ): Promise<void> {
    const result = liveRoomJoinSchema.safeParse(rawPayload);
    if (!result.success) {
      ack?.({ ok: false, code: "INVALID_MESSAGE", message: "Invalid realtime message." });
      return;
    }

    try {
      // Re-validates event-start/checked-in/host access on every join — a
      // prior successful join does not grant standing authorization (see
      // handleLiveRoomMessage, which re-checks again on every send).
      const liveRoom = await this.liveRoomService.getLiveRoom(user, result.data.liveRoomId);
      await socket.join(liveRoomRoom(result.data.liveRoomId));
      ack?.({ ok: true, message: liveRoom });
    } catch (error) {
      const message = error instanceof AppError ? error.message : "Unable to join event chat.";
      this.sendError(socket, "EVENT_CHAT_ACCESS_DENIED", message);
      ack?.({ ok: false, code: "EVENT_CHAT_ACCESS_DENIED", message });
    }
  }

  private handleLiveRoomLeave(socket: Socket, rawPayload: unknown, ack?: AckCallback<unknown>): void {
    const result = liveRoomLeaveSchema.safeParse(rawPayload);
    if (!result.success) {
      ack?.({ ok: false, code: "INVALID_MESSAGE", message: "Invalid realtime message." });
      return;
    }

    void socket.leave(liveRoomRoom(result.data.liveRoomId));
    ack?.({ ok: true, message: { liveRoomId: result.data.liveRoomId } });
  }

  private async handleLiveRoomMessage(
    socket: Socket,
    user: AuthUser,
    rawPayload: unknown,
    ack?: AckCallback<unknown>,
  ): Promise<void> {
    const result = liveRoomMessageSchema.safeParse(rawPayload);
    if (!result.success) {
      this.sendError(socket, "INVALID_MESSAGE", "Invalid realtime message.");
      ack?.({ ok: false, code: "INVALID_MESSAGE", message: "Invalid realtime message." });
      return;
    }

    try {
      const savedMessage = await createLiveRoomMessageWithSideEffects(user, result.data.liveRoomId, {
        text: result.data.text,
        clientMessageId: result.data.clientMessageId ?? null,
      });
      ack?.({ ok: true, message: savedMessage });
    } catch (error) {
      const message = error instanceof AppError ? error.message : "Unable to send event chat message.";
      this.sendError(socket, "EVENT_CHAT_ACCESS_DENIED", message);
      ack?.({ ok: false, code: "EVENT_CHAT_ACCESS_DENIED", message });
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
      logger.warn({ error, userId }, "Failed to broadcast user presence (Socket.IO)");
    }
  }

  private sendError(socket: Socket, code: string, message: string): void {
    socket.emit("error", { type: "error", code, message });
  }
}

export const socketIOGateway = new SocketIOGateway();
