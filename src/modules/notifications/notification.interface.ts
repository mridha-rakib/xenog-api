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
  | "ticket_cancelled"
  | "refund_processing"
  | "refund_completed"
  | "refund_needs_attention"
  | "moment_reaction"
  | "moment_comment"
  | "moment_share";

// Only meaningful for the moment_* interaction types above. Distinguishes
// whether the interacted-with Moment is a standalone Post or an Event's
// Interaction Moment — deliberately explicit rather than inferred from the
// notification type name, since both Posts and Events share the same
// moment_reaction/moment_comment/moment_share types.
export type NotificationContentType = "post" | "event";

export interface INotification {
  _id: Types.ObjectId;
  recipientUserId: Types.ObjectId;
  type: NotificationType;
  actorUserId?: Types.ObjectId | null;
  actorName?: string | null;
  actorUsername?: string | null;
  actorAvatarKey?: string | null;
  eventId?: string | null;
  momentId?: string | null;
  contentType?: NotificationContentType | null;
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
  momentId?: string | null;
  contentType?: NotificationContentType | null;
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
  momentId?: string | null;
  contentType?: NotificationContentType | null;
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
