import { Schema, model } from "mongoose";
import type { IChatMessage } from "./chat.interface.js";
import { chatMessageTypes } from "./chat.interface.js";

const chatMessageSchema = new Schema<IChatMessage>(
  {
    conversationId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    senderId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    recipientId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: chatMessageTypes,
      required: true,
      default: "text",
    },
    text: {
      type: String,
      default: "",
      trim: true,
      maxlength: 2000,
    },
    attachment: {
      type: Schema.Types.Mixed,
      default: null,
    },
    readAt: {
      type: Date,
      default: null,
      index: true,
    },
    editedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

chatMessageSchema.index({ conversationId: 1, createdAt: -1, _id: -1 });
chatMessageSchema.index({ recipientId: 1, readAt: 1, createdAt: -1 });

export const ChatMessageModel = model<IChatMessage>("ChatMessage", chatMessageSchema);
