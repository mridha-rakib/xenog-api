import { Schema, model } from "mongoose";
import type { IMomentReaction } from "./moment.interface.js";

const momentReactionSchema = new Schema<IMomentReaction>(
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

momentReactionSchema.index({ userId: 1, momentId: 1, type: 1 }, { unique: true });
momentReactionSchema.index({ momentId: 1, createdAt: -1 });

export const MomentReactionModel = model<IMomentReaction>("MomentReaction", momentReactionSchema);
