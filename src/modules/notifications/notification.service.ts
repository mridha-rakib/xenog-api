import type { AuthUser } from "../auth/auth.interface.js";
import { StorageService } from "../storage/storage.service.js";
import type { NotificationResponse } from "./notification.interface.js";
import { NotificationRepository } from "./notification.repository.js";
import { UserFollowRepository } from "../user/user-follow.repository.js";

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

  public async markAllRead(user: AuthUser): Promise<void> {
    await this.repository.markAllReadByRecipientId(user.id);
  }

  public async countUnread(user: AuthUser): Promise<number> {
    return this.repository.countUnreadByRecipientId(user.id);
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
      isRead: n.isRead,
      createdAt: n.createdAt.toISOString(),
    };
  }
}
