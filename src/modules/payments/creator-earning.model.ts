import { Schema, model } from "mongoose";
import type { ICreatorEarning } from "./creator-earning.interface.js";
import { creatorEarningStatuses } from "./creator-earning.interface.js";

const creatorEarningSchema = new Schema<ICreatorEarning>(
  {
    creatorUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    orderId: {
      type: Schema.Types.ObjectId,
      ref: "CheckoutOrder",
      required: true,
      index: true,
    },
    eventId: {
      type: Schema.Types.ObjectId,
      ref: "Event",
      default: null,
      index: true,
    },
    itemType: {
      type: String,
      enum: ["ticket", "product"],
      required: true,
    },
    grossAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    platformFeePercent: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },
    platformFeeAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    netAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    status: {
      type: String,
      enum: creatorEarningStatuses,
      required: true,
      default: "held",
      index: true,
    },
    eligibleAt: {
      type: Date,
      default: null,
    },
    payoutId: {
      type: Schema.Types.ObjectId,
      ref: "CreatorPayout",
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

creatorEarningSchema.index({ creatorUserId: 1, status: 1, createdAt: -1 });
creatorEarningSchema.index({ eventId: 1, status: 1 });

export const CreatorEarningModel = model<ICreatorEarning>("CreatorEarning", creatorEarningSchema);
