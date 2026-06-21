import type { AuthUser } from "../auth/auth.interface.js";
import { StorageService } from "../storage/storage.service.js";
import type { NotificationResponse } from "./notification.interface.js";
import { NotificationRepository } from "./notification.repository.js";

export class NotificationService {
  public constructor(
    private readonly repository = new NotificationRepository(),
    private readonly storageService = new StorageService(),
  ) {}

  public async listForUser(user: AuthUser): Promise<NotificationResponse[]> {
    const notifications = await this.repository.findByRecipientId(user.id, 100);

    return Promise.all(notifications.map((n) => this.toResponse(n)));
  }

  public async markAllRead(user: AuthUser): Promise<void> {
    await this.repository.markAllReadByRecipientId(user.id);
  }

  public async countUnread(user: AuthUser): Promise<number> {
    return this.repository.countUnreadByRecipientId(user.id);
  }

  private async toResponse(n: {
    _id: { toString(): string };
    type: string;
    actorUserId?: { toString(): string } | null;
    actorName?: string | null;
    actorUsername?: string | null;
    actorAvatarKey?: string | null;
    eventId?: string | null;
    eventName?: string | null;
    ticketName?: string | null;
    isRead: boolean;
    createdAt: Date;
  }): Promise<NotificationResponse> {
    const actorAvatarUrl = n.actorAvatarKey
      ? (await this.storageService.createDownloadUrl(n.actorAvatarKey)).url
      : null;

    return {
      id: n._id.toString(),
      type: n.type as NotificationResponse["type"],
      actorId: n.actorUserId?.toString() ?? null,
      actorName: n.actorName ?? null,
      actorUsername: n.actorUsername ?? null,
      actorAvatarUrl,
      eventId: n.eventId ?? null,
      eventName: n.eventName ?? null,
      ticketName: n.ticketName ?? null,
      isRead: n.isRead,
      createdAt: n.createdAt.toISOString(),
    };
  }
}
