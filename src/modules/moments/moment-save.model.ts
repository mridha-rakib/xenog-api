import { Schema, model } from "mongoose";
import type { IMomentSave } from "./moment.interface.js";

const momentSaveSchema = new Schema<IMomentSave>(
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

momentSaveSchema.index({ userId: 1, momentId: 1 }, { unique: true });
momentSaveSchema.index({ userId: 1, createdAt: -1 });

export const MomentSaveModel = model<IMomentSave>("MomentSave", momentSaveSchema);
