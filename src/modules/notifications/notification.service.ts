import type { AuthUser } from "../auth/auth.interface.js";
import httpStatus from "http-status";
import { Types } from "mongoose";
import { AppError } from "../../core/errors/app-error.js";
import { StorageService } from "../storage/storage.service.js";
import type { NotificationResponse, NotificationType } from "./notification.interface.js";
import { NotificationRepository } from "./notification.repository.js";
import { UserFollowRepository } from "../user/user-follow.repository.js";
import { realtimeGateway } from "../realtime/realtime.gateway.js";

export class NotificationService {
  public constructor(
    private readonly repository = new NotificationRepository(),
    private readonly storageService = new StorageService(),
    private readonly userFollowRepository = new UserFollowRepository(),
  ) {}

  public async listForUser(user: AuthUser): Promise<NotificationResponse[]> {
    const [notifications, followingIds] = await Promise.all([
      this.repository.findByRecipientId(user.id, 100),
      this.userFollowRepository.findFollowingIds(user.id),
    ]);

    const followingSet = new Set(followingIds);

    return Promise.all(notifications.map((n) => this.toResponse(n, followingSet)));
  }

  public async markAllRead(user: AuthUser): Promise<number> {
    await this.repository.markAllReadByRecipientId(user.id);
    const unreadCount = await this.repository.countUnreadByRecipientId(user.id);
    realtimeGateway.notifyUser(user.id, {
      type: "notification:read-all",
      unreadCount,
    });
    return unreadCount;
  }

  public async markRead(user: AuthUser, notificationId: string): Promise<number> {
    if (!Types.ObjectId.isValid(notificationId)) {
      throw new AppError("Invalid notification id.", httpStatus.BAD_REQUEST);
    }

    const notification = await this.repository.markReadByIdForRecipient(notificationId, user.id);

    if (!notification) {
      throw new AppError("Notification not found.", httpStatus.NOT_FOUND);
    }

    const unreadCount = await this.repository.countUnreadByRecipientId(user.id);
    realtimeGateway.notifyUser(user.id, {
      type: "notification:read",
      notificationId,
      unreadCount,
    });

    return unreadCount;
  }

  public async countUnread(user: AuthUser): Promise<number> {
    return this.repository.countUnreadByRecipientId(user.id);
  }

  public async sendSystemNotification(
    recipientUserId: string,
    type: NotificationType,
    message: string,
  ): Promise<void> {
    const notification = await this.repository.create({ recipientUserId, type, message });
    const unreadCount = await this.repository.countUnreadByRecipientId(recipientUserId);

    realtimeGateway.notifyUser(recipientUserId, {
      type: "notification:new",
      notification: {
        id: notification._id.toString(),
        type: notification.type,
        message: notification.message ?? null,
        isRead: false,
        createdAt: notification.createdAt.toISOString(),
      },
      unreadCount,
    });
  }

  private async toResponse(
    n: {
      _id: { toString(): string };
      type: string;
      actorUserId?: { toString(): string } | null;
      actorName?: string | null;
      actorUsername?: string | null;
      actorAvatarKey?: string | null;
      eventId?: string | null;
      eventName?: string | null;
      ticketName?: string | null;
      message?: string | null;
      isRead: boolean;
      createdAt: Date;
    },
    viewerFollowingSet: Set<string>,
  ): Promise<NotificationResponse> {
    const actorAvatarUrl = n.actorAvatarKey
      ? (await this.storageService.createDownloadUrl(n.actorAvatarKey)).url
      : null;

    const actorId = n.actorUserId?.toString() ?? null;

    return {
      id: n._id.toString(),
      type: n.type as NotificationResponse["type"],
      actorId,
      actorName: n.actorName ?? null,
      actorUsername: n.actorUsername ?? null,
      actorAvatarUrl,
      isFollowing: actorId ? viewerFollowingSet.has(actorId) : null,
      eventId: n.eventId ?? null,
      eventName: n.eventName ?? null,
      ticketName: n.ticketName ?? null,
      message: n.message ?? null,
      isRead: n.isRead,
      createdAt: n.createdAt.toISOString(),
    };
  }
}
