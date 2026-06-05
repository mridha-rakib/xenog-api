import { Schema, model } from "mongoose";
import type { IPricingSettings } from "./pricing-settings.interface.js";

const pricingSettingsSchema = new Schema<IPricingSettings>(
  {
    key: {
      type: String,
      enum: ["pricing"],
      default: "pricing",
      unique: true,
      index: true,
    },
    tax: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },
    creditCardFee: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },
    applePayoutFee: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },
    platformFee: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },
    productPercentage: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },
    ticketPercentage: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },
    lastModifiedBy: {
      id: {
        type: String,
        trim: true,
      },
      name: {
        type: String,
        trim: true,
      },
      email: {
        type: String,
        trim: true,
        lowercase: true,
      },
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

export const PricingSettingsModel = model<IPricingSettings>("PricingSettings", pricingSettingsSchema);
