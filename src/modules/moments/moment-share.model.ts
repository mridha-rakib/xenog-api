import { Schema, model } from "mongoose";
import type { IMomentShare } from "./moment.interface.js";

const momentShareSchema = new Schema<IMomentShare>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    momentId: {
      type: Schema.Types.ObjectId,
      ref: "Moment",
      required: true,
      index: true,
    },
    caption: { type: String, trim: true, maxlength: 2000, default: null },
    taggedFriendIds: [{ type: Schema.Types.ObjectId, ref: "User" }],
    originalType: { type: String, enum: ["post", "event"], default: "post" },
    originalId: { type: Schema.Types.ObjectId, required: false },
    clientRequestId: { type: String, trim: true, maxlength: 100, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

momentShareSchema.index({ userId: 1, momentId: 1 }, { unique: true });
momentShareSchema.index({ userId: 1, createdAt: -1 });

export const MomentShareModel = model<IMomentShare>("MomentShare", momentShareSchema);
