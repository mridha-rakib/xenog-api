import type { CreateNotificationDto, INotification } from "./notification.interface.js";
import { NotificationModel } from "./notification.model.js";

export class NotificationRepository {
  public async create(data: CreateNotificationDto): Promise<INotification> {
    const notification = new NotificationModel({
      recipientUserId: data.recipientUserId,
      type: data.type,
      actorUserId: data.actorUserId ?? null,
      actorName: data.actorName ?? null,
      actorUsername: data.actorUsername ?? null,
      actorAvatarKey: data.actorAvatarKey ?? null,
      eventId: data.eventId ?? null,
      eventName: data.eventName ?? null,
      ticketName: data.ticketName ?? null,
      isRead: false,
    });

    return notification.save();
  }

  public async findByRecipientId(recipientUserId: string, limit = 50): Promise<INotification[]> {
    return NotificationModel.find({ recipientUserId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean<INotification[]>();
  }

  public async markAllReadByRecipientId(recipientUserId: string): Promise<void> {
    await NotificationModel.updateMany({ recipientUserId, isRead: false }, { $set: { isRead: true } });
  }

  public async countUnreadByRecipientId(recipientUserId: string): Promise<number> {
    return NotificationModel.countDocuments({ recipientUserId, isRead: false });
  }
}
