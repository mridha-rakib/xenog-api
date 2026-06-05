import { Schema, model } from "mongoose";
import type { ILiveRoom } from "./live-room.interface.js";
import { liveRoomStatuses } from "./live-room.interface.js";

const liveRoomSchema = new Schema<ILiveRoom>(
  {
    hostUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    allowAllParticipantsToSpeak: {
      type: Boolean,
      required: true,
      default: true,
    },
    speakerIds: {
      type: [
        {
          type: Schema.Types.ObjectId,
          ref: "User",
        },
      ],
      default: [],
    },
    status: {
      type: String,
      enum: liveRoomStatuses,
      required: true,
      default: "live",
      index: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

liveRoomSchema.index({ hostUserId: 1, createdAt: -1 });

export const LiveRoomModel = model<ILiveRoom>("LiveRoom", liveRoomSchema);
