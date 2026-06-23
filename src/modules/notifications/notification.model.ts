import { model, Schema } from "mongoose";
import type { INotification } from "./notification.interface.js";

const notificationSchema = new Schema<INotification>(
  {
    recipientUserId: { type: Schema.Types.ObjectId, required: true, index: true },
    type: { type: String, enum: ["follow", "ticket_buyer", "ticket_creator", "ticket_share", "join_request", "join_request_accepted"], required: true },
    actorUserId: { type: Schema.Types.ObjectId, default: null },
    actorName: { type: String, default: null },
    actorUsername: { type: String, default: null },
    actorAvatarKey: { type: String, default: null },
    eventId: { type: String, default: null },
    eventName: { type: String, default: null },
    ticketName: { type: String, default: null },
    isRead: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export const NotificationModel = model<INotification>("Notification", notificationSchema);
