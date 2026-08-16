import { Schema, model } from "mongoose";
import type { ILiveRoomMessage } from "./live-room.interface.js";

const liveRoomMessageSchema = new Schema<ILiveRoomMessage>(
  {
    liveRoomId: {
      type: Schema.Types.ObjectId,
      ref: "LiveRoom",
      required: true,
      index: true,
    },
    senderId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    text: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1000,
    },
    clientMessageId: {
      type: String,
      trim: true,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

liveRoomMessageSchema.index({ liveRoomId: 1, createdAt: -1, _id: -1 });
// Idempotent retry support: same shape as ChatMessageModel's clientMessageId
// index (chat-message.model.ts) — partial so existing rows and any row with
// clientMessageId left at its null default are excluded from the uniqueness
// constraint, only guaranteeing no two messages share a (sender, id) pair.
liveRoomMessageSchema.index(
  { senderId: 1, clientMessageId: 1 },
  { unique: true, partialFilterExpression: { clientMessageId: { $type: "string" } } },
);

export const LiveRoomMessageModel = model<ILiveRoomMessage>("LiveRoomMessage", liveRoomMessageSchema);
