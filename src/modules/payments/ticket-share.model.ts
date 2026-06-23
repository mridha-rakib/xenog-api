import { Schema, model } from "mongoose";
import type { ITicketShare } from "./checkout-payment.interface.js";

const ticketShareSchema = new Schema<ITicketShare>(
  {
    ownerUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    recipientUserId: {
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
    status: {
      type: String,
      enum: ["active", "cancelled"],
      required: true,
      default: "active",
      index: true,
    },
    sharedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    cancelledAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

ticketShareSchema.index(
  { ownerUserId: 1, eventId: 1, ticketId: 1, orderId: 1, ticketIndex: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "active" } },
);
ticketShareSchema.index({ recipientUserId: 1, status: 1, sharedAt: -1 });

export const TicketShareModel = model<ITicketShare>("TicketShare", ticketShareSchema);

export const ensureTicketShareIndexes = async (): Promise<void> => {
  try {
    await TicketShareModel.collection.dropIndex("ownerUserId_1_eventId_1_ticketId_1_status_1");
  } catch (error) {
    const indexError = error as { codeName?: string; code?: number };

    if (indexError.codeName !== "IndexNotFound" && indexError.code !== 27) {
      throw error;
    }
  }

  await TicketShareModel.syncIndexes();
};
