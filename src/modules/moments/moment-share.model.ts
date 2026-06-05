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
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

momentShareSchema.index({ userId: 1, momentId: 1 }, { unique: true });
momentShareSchema.index({ userId: 1, createdAt: -1 });

export const MomentShareModel = model<IMomentShare>("MomentShare", momentShareSchema);
