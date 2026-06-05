import { Schema, model } from "mongoose";
import type { ILiveRoomParticipant } from "./live-room.interface.js";

const liveRoomParticipantSchema = new Schema<ILiveRoomParticipant>(
  {
    liveRoomId: {
      type: Schema.Types.ObjectId,
      ref: "LiveRoom",
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    isActive: {
      type: Boolean,
      required: true,
      default: true,
      index: true,
    },
    joinedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    leftAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

liveRoomParticipantSchema.index({ liveRoomId: 1, userId: 1 }, { unique: true });
liveRoomParticipantSchema.index({ liveRoomId: 1, isActive: 1, joinedAt: -1 });

export const LiveRoomParticipantModel = model<ILiveRoomParticipant>(
  "LiveRoomParticipant",
  liveRoomParticipantSchema,
);
