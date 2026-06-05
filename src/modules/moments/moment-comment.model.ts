import { Schema, model } from "mongoose";
import type { IMomentComment } from "./moment.interface.js";

const momentCommentSchema = new Schema<IMomentComment>(
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
    parentCommentId: {
      type: Schema.Types.ObjectId,
      ref: "MomentComment",
      default: null,
      index: true,
    },
    text: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

momentCommentSchema.index({ momentId: 1, createdAt: 1 });

export const MomentCommentModel = model<IMomentComment>("MomentComment", momentCommentSchema);
