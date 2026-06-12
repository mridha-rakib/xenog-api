import { Schema, model } from "mongoose";
import type { Types } from "mongoose";

export interface IRewardClaim {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  eventId: Types.ObjectId;
  rewardId: string;
  claimedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const rewardClaimSchema = new Schema<IRewardClaim>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    eventId: {
      type: Schema.Types.ObjectId,
      ref: "Event",
      required: true,
      index: true,
    },
    rewardId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    claimedAt: {
      type: Date,
      required: true,
      default: () => new Date(),
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

rewardClaimSchema.index({ userId: 1, eventId: 1, rewardId: 1 }, { unique: true });
rewardClaimSchema.index({ eventId: 1, rewardId: 1 });

export const RewardClaimModel = model<IRewardClaim>("RewardClaim", rewardClaimSchema);
