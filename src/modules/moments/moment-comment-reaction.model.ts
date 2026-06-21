import { Schema, model } from "mongoose";
import type { IMomentCommentReaction } from "./moment.interface.js";

const momentCommentReactionSchema = new Schema<IMomentCommentReaction>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    commentId: {
      type: Schema.Types.ObjectId,
      ref: "MomentComment",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ["like"],
      required: true,
      default: "like",
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

momentCommentReactionSchema.index({ userId: 1, commentId: 1, type: 1 }, { unique: true });
momentCommentReactionSchema.index({ commentId: 1, createdAt: -1 });

export const MomentCommentReactionModel = model<IMomentCommentReaction>(
  "MomentCommentReaction",
  momentCommentReactionSchema,
);
