import { Schema, model } from "mongoose";
import type { ITicketUsage } from "./checkout-payment.interface.js";

const ticketUsageSchema = new Schema<ITicketUsage>(
  {
    ownerUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    holderUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    usedByUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    shareId: {
      type: Schema.Types.ObjectId,
      ref: "TicketShare",
      default: null,
      index: true,
    },
    orderId: {
      type: Schema.Types.ObjectId,
      ref: "CheckoutOrder",
      required: true,
      index: true,
    },
    eventId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    ticketId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
      index: true,
    },
    ticketIndex: {
      type: Number,
      required: true,
      min: 1,
    },
    source: {
      type: String,
      enum: ["owned", "shared"],
      required: true,
    },
    usedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

ticketUsageSchema.index({ eventId: 1, ticketId: 1, orderId: 1, ticketIndex: 1 }, { unique: true });
ticketUsageSchema.index({ eventId: 1, holderUserId: 1, usedAt: -1 });
ticketUsageSchema.index({ holderUserId: 1, usedAt: -1 });

export const TicketUsageModel = model<ITicketUsage>("TicketUsage", ticketUsageSchema);

export const ensureTicketUsageIndexes = async (): Promise<void> => {
  await TicketUsageModel.syncIndexes();
};
