import { Schema, model } from "mongoose";
import type { IRefundReceipt, RefundReceiptSnapshot } from "./refund-receipt.interface.js";
import { refundReceiptSourceTypes } from "./refund-receipt.interface.js";

const refundReceiptSnapshotSchema = new Schema<RefundReceiptSnapshot>(
  {
    context: {
      type: String,
      enum: ["Ticket cancelled by buyer", "Event cancelled by organizer"],
      required: true,
    },
    buyerName: { type: String, required: true, trim: true },
    buyerEmail: { type: String, required: true, trim: true, lowercase: true },
    eventName: { type: String, trim: true, default: null },
    eventScheduledAt: { type: Date, default: null },
    eventEndAt: { type: Date, default: null },
    venue: { type: Schema.Types.Mixed, default: null },
    hostName: { type: String, trim: true, default: null },
    supportEmail: { type: String, trim: true, default: null },
    orderReference: { type: String, required: true, trim: true },
    receiptReference: { type: String, required: true, trim: true },
    purchasedAt: { type: Date, default: null },
    refundCompletedAt: { type: Date, required: true },
    statusLabel: { type: String, enum: ["Refund completed"], required: true },
    paymentMethod: { type: String, trim: true, default: null },
    items: {
      type: [{
        name: { type: String, required: true, trim: true },
        type: { type: String, trim: true, default: null },
        passLabel: { type: String, trim: true, default: null },
        quantity: { type: Number, required: true, min: 1 },
      }],
      required: true,
      default: [],
    },
    financial: {
      subtotalAmountMinor: { type: Number, min: 0, default: null },
      platformFeeAmountMinor: { type: Number, min: 0, default: null },
      taxAmountMinor: { type: Number, min: 0, default: null },
      discountAmountMinor: { type: Number, min: 0, default: null },
      completedAmountMinor: { type: Number, required: true, min: 0 },
      requestedAmountMinor: { type: Number, required: true, min: 0 },
      currency: { type: String, required: true, lowercase: true, trim: true, minlength: 3, maxlength: 3 },
    },
  },
  { _id: false },
);

const refundReceiptSchema = new Schema<IRefundReceipt>(
  {
    idempotencyKey: { type: String, required: true, trim: true, unique: true, index: true },
    sourceType: { type: String, enum: refundReceiptSourceTypes, required: true, index: true },
    sourceRefundId: { type: Schema.Types.ObjectId, required: true, index: true },
    payerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    toEmail: { type: String, required: true, trim: true, lowercase: true },
    receiptReference: { type: String, required: true, trim: true, unique: true, index: true },
    orderReference: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ["pending", "sending", "sent", "failed_retryable", "failed_terminal"],
      required: true,
      default: "pending",
      index: true,
    },
    attemptCount: { type: Number, required: true, min: 0, default: 0 },
    nextRetryAt: { type: Date, default: Date.now, index: true },
    lockedAt: { type: Date, default: null, index: true },
    sentAt: { type: Date, default: null },
    lastError: { type: String, trim: true, maxlength: 500, default: null },
    snapshot: { type: refundReceiptSnapshotSchema, required: true },
  },
  { timestamps: true, versionKey: false },
);

refundReceiptSchema.index({ sourceType: 1, sourceRefundId: 1 }, { unique: true });
refundReceiptSchema.index({ status: 1, nextRetryAt: 1, lockedAt: 1 });

export const RefundReceiptModel = model<IRefundReceipt>("RefundReceipt", refundReceiptSchema);

export const ensureRefundReceiptIndexes = async (): Promise<void> => {
  await RefundReceiptModel.syncIndexes();
};
