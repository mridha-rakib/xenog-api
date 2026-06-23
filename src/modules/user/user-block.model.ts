import { Schema, model } from "mongoose";
import type { IUserBlock } from "./user.interface.js";

const userBlockSchema = new Schema<IUserBlock>(
  {
    blockerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    blockedId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

userBlockSchema.index({ blockerId: 1, blockedId: 1 }, { unique: true });

export const UserBlockModel = model<IUserBlock>("UserBlock", userBlockSchema);
