import { Schema, model } from "mongoose";
import type { CheckoutInvoiceSnapshot, ICheckoutInvoice } from "./checkout-invoice.interface.js";

const checkoutInvoiceSnapshotSchema = new Schema<CheckoutInvoiceSnapshot>(
  {
    orderId: { type: String, required: true },
    eventName: { type: String, trim: true, default: null },
    eventPrivacy: { type: String, enum: ["public", "locked", "private"], default: null },
    eventScheduledAt: { type: Date, default: null },
    eventEndAt: { type: Date, default: null },
    venue: { type: Schema.Types.Mixed, default: null },
    purchasedAt: { type: Date, required: true },
    buyerName: { type: String, required: true, trim: true },
    buyerEmail: { type: String, required: true, trim: true, lowercase: true },
    paymentMethod: { type: String, required: true, trim: true },
    termsVersion: { type: String, trim: true, default: null },
    refundEscrowVersion: { type: String, trim: true, default: null },
    currency: { type: String, required: true, lowercase: true, trim: true, minlength: 3, maxlength: 3 },
    subtotalAmount: { type: Number, required: true, min: 0 },
    platformFeeAmount: { type: Number, required: true, min: 0 },
    taxAmount: { type: Number, required: true, min: 0 },
    discountAmount: { type: Number, required: true, min: 0, default: 0 },
    totalAmount: { type: Number, required: true, min: 0 },
    lineItems: {
      type: [{
        itemType: { type: String, required: true, trim: true },
        itemId: { type: String, trim: true, default: null },
        name: { type: String, required: true, trim: true },
        description: { type: String, trim: true, default: null },
        ticketType: { type: String, trim: true, default: null },
        quantity: { type: Number, required: true, min: 1 },
        paidQuantity: { type: Number, required: true, min: 0 },
        freeQuantity: { type: Number, required: true, min: 0 },
        unitAmount: { type: Number, required: true, min: 0 },
        originalUnitAmount: { type: Number, min: 0, default: null },
        discountAmount: { type: Number, required: true, min: 0, default: 0 },
        totalAmount: { type: Number, required: true, min: 0 },
      }],
      required: true,
      default: [],
    },
  },
  { _id: false },
);

const checkoutInvoiceSchema = new Schema<ICheckoutInvoice>(
  {
    orderId: { type: Schema.Types.ObjectId, ref: "CheckoutOrder", required: true, unique: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    invoiceNumber: { type: String, required: true, trim: true, unique: true, index: true },
    toEmail: { type: String, required: true, trim: true, lowercase: true },
    status: {
      type: String,
      enum: ["pending", "sending", "sent", "failed_retryable", "failed_terminal"],
      required: true,
      default: "pending",
      index: true,
    },
    attemptCount: { type: Number, required: true, min: 0, default: 0 },
    nextRetryAt: { type: Date, default: Date.now, index: true },
    lockedAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    lastError: { type: String, trim: true, maxlength: 500, default: null },
    snapshot: { type: checkoutInvoiceSnapshotSchema, required: true },
  },
  { timestamps: true, versionKey: false },
);

checkoutInvoiceSchema.index({ status: 1, nextRetryAt: 1 });

export const CheckoutInvoiceModel = model<ICheckoutInvoice>("CheckoutInvoice", checkoutInvoiceSchema);

export const ensureCheckoutInvoiceIndexes = async (): Promise<void> => {
  await CheckoutInvoiceModel.syncIndexes();
};
