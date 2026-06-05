import { Schema, model } from "mongoose";
import type { ISupportTicket, ISupportTicketMessage } from "./support-ticket.interface.js";
import { supportMessageSenderTypes, supportTicketStatuses } from "./support-ticket.interface.js";

const supportTicketMessageSchema = new Schema<ISupportTicketMessage>(
  {
    senderType: {
      type: String,
      enum: supportMessageSenderTypes,
      required: true,
    },
    senderId: {
      type: String,
      required: true,
      trim: true,
    },
    senderName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
    },
    body: {
      type: String,
      required: true,
      trim: true,
      maxlength: 5000,
    },
    createdAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  {
    timestamps: false,
  },
);

const supportTicketSchema = new Schema<ISupportTicket>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    requesterName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    requesterEmail: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    requesterAvatarKey: {
      type: String,
      trim: true,
      default: null,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
      index: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: 5000,
    },
    status: {
      type: String,
      enum: supportTicketStatuses,
      required: true,
      default: "pending",
      index: true,
    },
    messages: {
      type: [supportTicketMessageSchema],
      default: [],
    },
    lastMessageAt: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },
    closedAt: {
      type: Date,
      default: null,
    },
    lastModifiedBy: {
      id: {
        type: String,
        trim: true,
      },
      name: {
        type: String,
        trim: true,
      },
      email: {
        type: String,
        lowercase: true,
        trim: true,
      },
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

supportTicketSchema.index({ requesterName: "text", requesterEmail: "text", title: "text" });

export const SupportTicketModel = model<ISupportTicket>("SupportTicket", supportTicketSchema);
