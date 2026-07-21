import { model, Schema } from "mongoose";
import type { INotification } from "./notification.interface.js";

const notificationSchema = new Schema<INotification>(
  {
    recipientUserId: { type: Schema.Types.ObjectId, required: true, index: true },
    type: { type: String, enum: ["follow", "ticket_buyer", "ticket_creator", "ticket_share", "join_request", "join_request_accepted", "event_member_added", "moderation_warning", "payout_requested", "payout_processing", "payout_completed", "payout_failed", "event_cancelled", "refund_processing", "refund_completed", "refund_needs_attention"], required: true },
    actorUserId: { type: Schema.Types.ObjectId, default: null },
    actorName: { type: String, default: null },
    actorUsername: { type: String, default: null },
    actorAvatarKey: { type: String, default: null },
    eventId: { type: String, default: null },
    orderId: { type: String, default: null },
    refundId: { type: String, default: null },
    refundStatus: { type: String, default: null },
    cancellationReason: { type: String, default: null },
    title: { type: String, default: null, maxlength: 160 },
    deepLink: { type: String, default: null, maxlength: 500 },
    sourceKey: { type: String, default: null, index: true },
    eventName: { type: String, default: null },
    ticketName: { type: String, default: null },
    message: { type: String, default: null, maxlength: 500 },
    isRead: { type: Boolean, default: false },
  },
  { timestamps: true },
);

notificationSchema.index(
  { recipientUserId: 1, sourceKey: 1 },
  { unique: true, partialFilterExpression: { sourceKey: { $type: "string" } } },
);

export const NotificationModel = model<INotification>("Notification", notificationSchema);
