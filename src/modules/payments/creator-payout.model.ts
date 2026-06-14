import { Schema, model } from "mongoose";
import type { ICreatorPayout } from "./creator-payout.interface.js";
import { creatorPayoutStatuses, creatorPayoutTypes } from "./creator-payout.interface.js";

const creatorPayoutSchema = new Schema<ICreatorPayout>(
  {
    creatorUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    earningIds: {
      type: [Schema.Types.ObjectId],
      ref: "CreatorEarning",
      required: true,
      default: [],
    },
    totalAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    payoutType: {
      type: String,
      enum: creatorPayoutTypes,
      required: true,
    },
    status: {
      type: String,
      enum: creatorPayoutStatuses,
      required: true,
      default: "pending",
      index: true,
    },
    scheduledDate: {
      type: Date,
      required: true,
      index: true,
    },
    moomentCreditsAwarded: {
      type: Number,
      default: null,
    },
    stripeTransferId: {
      type: String,
      trim: true,
      default: null,
    },
    failureReason: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },
    processedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

creatorPayoutSchema.index({ creatorUserId: 1, createdAt: -1 });
creatorPayoutSchema.index({ status: 1, scheduledDate: 1 });

export const CreatorPayoutModel = model<ICreatorPayout>("CreatorPayout", creatorPayoutSchema);
