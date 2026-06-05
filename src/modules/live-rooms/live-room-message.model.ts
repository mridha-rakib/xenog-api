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
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

liveRoomMessageSchema.index({ liveRoomId: 1, createdAt: -1, _id: -1 });

export const LiveRoomMessageModel = model<ILiveRoomMessage>("LiveRoomMessage", liveRoomMessageSchema);
