import { Schema, model } from "mongoose";
import type { IDirectMessageBlock } from "./chat.interface.js";

const directMessageBlockSchema = new Schema<IDirectMessageBlock>(
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

directMessageBlockSchema.index({ blockerId: 1, blockedId: 1 }, { unique: true });

export const DirectMessageBlockModel = model<IDirectMessageBlock>("DirectMessageBlock", directMessageBlockSchema);
