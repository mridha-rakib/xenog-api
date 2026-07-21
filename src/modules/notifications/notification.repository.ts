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
      orderId: data.orderId ?? null,
      refundId: data.refundId ?? null,
      refundStatus: data.refundStatus ?? null,
      cancellationReason: data.cancellationReason ?? null,
      title: data.title ?? null,
      deepLink: data.deepLink ?? null,
      sourceKey: data.sourceKey ?? null,
      eventName: data.eventName ?? null,
      ticketName: data.ticketName ?? null,
      message: data.message ?? null,
      isRead: false,
    });

    return notification.save();
  }

  public async createOnce(data: CreateNotificationDto): Promise<INotification | null> {
    try {
      return await this.create(data);
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        return null;
      }

      throw error;
    }
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

  public async markReadByIdForRecipient(notificationId: string, recipientUserId: string): Promise<INotification | null> {
    return NotificationModel.findOneAndUpdate(
      { _id: notificationId, recipientUserId },
      { $set: { isRead: true } },
      { new: true },
    ).lean<INotification | null>();
  }

  public async countUnreadByRecipientId(recipientUserId: string): Promise<number> {
    return NotificationModel.countDocuments({ recipientUserId, isRead: false });
  }
}
