import type { Types } from "mongoose";

export type NotificationType = "follow" | "ticket_buyer" | "ticket_creator" | "ticket_share";

export interface INotification {
  _id: Types.ObjectId;
  recipientUserId: Types.ObjectId;
  type: NotificationType;
  actorUserId?: Types.ObjectId | null;
  actorName?: string | null;
  actorUsername?: string | null;
  actorAvatarKey?: string | null;
  eventId?: string | null;
  eventName?: string | null;
  ticketName?: string | null;
  isRead: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateNotificationDto {
  recipientUserId: string;
  type: NotificationType;
  actorUserId?: string | null;
  actorName?: string | null;
  actorUsername?: string | null;
  actorAvatarKey?: string | null;
  eventId?: string | null;
  eventName?: string | null;
  ticketName?: string | null;
}

export interface NotificationResponse {
  id: string;
  type: NotificationType;
  actorId?: string | null;
  actorName?: string | null;
  actorUsername?: string | null;
  actorAvatarUrl?: string | null;
  eventId?: string | null;
  eventName?: string | null;
  ticketName?: string | null;
  isRead: boolean;
  createdAt: string;
}
