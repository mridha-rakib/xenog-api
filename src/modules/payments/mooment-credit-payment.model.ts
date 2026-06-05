import { Schema, model } from "mongoose";
import type { IMoomentCreditPurchase, IMoomentCreditWallet } from "./mooment-credit-payment.interface.js";
import { moomentCreditPaymentMethods, moomentCreditPurchaseStatuses } from "./mooment-credit-payment.interface.js";

const moomentCreditWalletSchema = new Schema<IMoomentCreditWallet>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    balance: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

const moomentCreditPurchaseSchema = new Schema<IMoomentCreditPurchase>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    packageId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    packageName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    credits: {
      type: Number,
      required: true,
      min: 1,
    },
    subtotalUsd: {
      type: Number,
      required: true,
      min: 0,
    },
    platformFeeUsd: {
      type: Number,
      required: true,
      min: 0,
    },
    taxPercent: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },
    taxUsd: {
      type: Number,
      required: true,
      min: 0,
    },
    totalUsd: {
      type: Number,
      required: true,
      min: 0.01,
    },
    paymentMethod: {
      type: String,
      enum: moomentCreditPaymentMethods,
      required: true,
    },
    status: {
      type: String,
      enum: moomentCreditPurchaseStatuses,
      required: true,
      default: "completed",
      index: true,
    },
    paymentReference: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

moomentCreditPurchaseSchema.index({ userId: 1, createdAt: -1 });

export const MoomentCreditWalletModel = model<IMoomentCreditWallet>(
  "MoomentCreditWallet",
  moomentCreditWalletSchema,
);

export const MoomentCreditPurchaseModel = model<IMoomentCreditPurchase>(
  "MoomentCreditPurchase",
  moomentCreditPurchaseSchema,
);
