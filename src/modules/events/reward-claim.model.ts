import { Schema, model } from "mongoose";
import type { Types } from "mongoose";

export interface IRewardClaim {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  eventId: Types.ObjectId;
  rewardId: string;
  ticketId?: string | null;
  checkoutOrderId?: Types.ObjectId | null;
  stripePaymentIntentId?: string | null;
  status: "pending" | "redeemed" | "released" | "legacy_claim";
  source: "checkout" | "manual_claim" | "legacy";
  claimedAt: Date;
  redeemedAt?: Date | null;
  releasedAt?: Date | null;
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
    ticketId: {
      type: String,
      trim: true,
      maxlength: 80,
      default: null,
    },
    checkoutOrderId: {
      type: Schema.Types.ObjectId,
      ref: "CheckoutOrder",
      default: null,
    },
    stripePaymentIntentId: {
      type: String,
      trim: true,
      default: null,
    },
    status: {
      type: String,
      enum: ["pending", "redeemed", "released", "legacy_claim"],
      required: true,
      default: "legacy_claim",
      index: true,
    },
    source: {
      type: String,
      enum: ["checkout", "manual_claim", "legacy"],
      required: true,
      default: "legacy",
      index: true,
    },
    claimedAt: {
      type: Date,
      required: true,
      default: () => new Date(),
    },
    redeemedAt: {
      type: Date,
      default: null,
    },
    releasedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

rewardClaimSchema.index({ userId: 1, eventId: 1, rewardId: 1 }, { unique: true });
rewardClaimSchema.index({ eventId: 1, rewardId: 1 });
rewardClaimSchema.index({ checkoutOrderId: 1 });

export const RewardClaimModel = model<IRewardClaim>("RewardClaim", rewardClaimSchema);
