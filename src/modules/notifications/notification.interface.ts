import type { Types } from "mongoose";

export type NotificationType =
  | "follow"
  | "ticket_buyer"
  | "ticket_creator"
  | "ticket_share"
  | "join_request"
  | "join_request_accepted"
  | "event_member_added"
  | "moderation_warning"
  | "payout_requested"
  | "payout_processing"
  | "payout_completed"
  | "payout_failed"
  | "event_cancelled"
  | "refund_processing"
  | "refund_completed"
  | "refund_needs_attention";

export interface INotification {
  _id: Types.ObjectId;
  recipientUserId: Types.ObjectId;
  type: NotificationType;
  actorUserId?: Types.ObjectId | null;
  actorName?: string | null;
  actorUsername?: string | null;
  actorAvatarKey?: string | null;
  eventId?: string | null;
  orderId?: string | null;
  refundId?: string | null;
  refundStatus?: string | null;
  cancellationReason?: string | null;
  title?: string | null;
  deepLink?: string | null;
  sourceKey?: string | null;
  eventName?: string | null;
  ticketName?: string | null;
  message?: string | null;
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
  orderId?: string | null;
  refundId?: string | null;
  refundStatus?: string | null;
  cancellationReason?: string | null;
  title?: string | null;
  deepLink?: string | null;
  sourceKey?: string | null;
  eventName?: string | null;
  ticketName?: string | null;
  message?: string | null;
}

export interface NotificationResponse {
  id: string;
  type: NotificationType;
  actorId?: string | null;
  actorName?: string | null;
  actorUsername?: string | null;
  actorAvatarUrl?: string | null;
  isFollowing?: boolean | null;
  eventId?: string | null;
  orderId?: string | null;
  refundId?: string | null;
  refundStatus?: string | null;
  cancellationReason?: string | null;
  title?: string | null;
  deepLink?: string | null;
  eventName?: string | null;
  ticketName?: string | null;
  message?: string | null;
  isRead: boolean;
  createdAt: string;
}
