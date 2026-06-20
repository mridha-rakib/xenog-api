import { Schema, model } from "mongoose";
import type { CheckoutOrderLineItem, ICheckoutOrder } from "./checkout-payment.interface.js";
import {
  checkoutOrderKinds,
  checkoutPaymentMethods,
  checkoutPaymentStatuses,
  checkoutPayoutStatuses,
} from "./checkout-payment.interface.js";

const checkoutOrderLineItemSchema = new Schema<CheckoutOrderLineItem>(
  {
    itemType: {
      type: String,
      enum: checkoutOrderKinds,
      required: true,
    },
    itemId: {
      type: String,
      trim: true,
      default: null,
    },
    eventId: {
      type: String,
      trim: true,
      default: null,
    },
    sellerUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 180,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },
    unitAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    totalAmount: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { _id: false },
);

const checkoutOrderSchema = new Schema<ICheckoutOrder>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    kind: {
      type: String,
      enum: checkoutOrderKinds,
      required: true,
      index: true,
    },
    paymentMethod: {
      type: String,
      enum: checkoutPaymentMethods,
      required: true,
    },
    paymentStatus: {
      type: String,
      enum: checkoutPaymentStatuses,
      required: true,
      default: "requires_payment",
      index: true,
    },
    payoutStatus: {
      type: String,
      enum: checkoutPayoutStatuses,
      required: true,
      default: "not_ready",
      index: true,
    },
    currency: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      minlength: 3,
      maxlength: 3,
    },
    subtotalAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    platformFeeAmount: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    taxAmount: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    totalAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    amountMinor: {
      type: Number,
      required: true,
      min: 1,
    },
    lineItems: {
      type: [checkoutOrderLineItemSchema],
      required: true,
      validate: {
        validator: (value: CheckoutOrderLineItem[]) => value.length > 0,
        message: "Checkout order must include at least one line item",
      },
    },
    stripePaymentIntentId: {
      type: String,
      trim: true,
      default: null,
    },
    stripeClientSecret: {
      type: String,
      trim: true,
      default: null,
    },
    anonymous: {
      type: Boolean,
      required: true,
      default: false,
    },
    termsAcceptedAt: {
      type: Date,
      default: null,
    },
    paidAt: {
      type: Date,
      default: null,
    },
    failedAt: {
      type: Date,
      default: null,
    },
    failureMessage: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

checkoutOrderSchema.index({ userId: 1, createdAt: -1 });
checkoutOrderSchema.index({ stripePaymentIntentId: 1 }, { unique: true, sparse: true });

export const CheckoutOrderModel = model<ICheckoutOrder>("CheckoutOrder", checkoutOrderSchema);
