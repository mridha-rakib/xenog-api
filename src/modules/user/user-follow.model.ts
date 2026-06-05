import { Schema, model } from "mongoose";
import type { IUserFollow } from "./user.interface.js";

const userFollowSchema = new Schema<IUserFollow>(
  {
    followerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    followingId: {
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

userFollowSchema.index({ followerId: 1, followingId: 1 }, { unique: true });

export const UserFollowModel = model<IUserFollow>("UserFollow", userFollowSchema);
