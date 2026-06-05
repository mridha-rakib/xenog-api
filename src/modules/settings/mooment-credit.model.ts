import { Schema, model } from "mongoose";
import type { IMoomentCreditPackage, IMoomentCreditSettings } from "./mooment-credit.interface.js";

const moomentCreditPackageSchema = new Schema<IMoomentCreditPackage>(
  {
    name: {
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
    priceUsd: {
      type: Number,
      required: true,
      min: 0.01,
    },
    commissionPercent: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },
    sortOrder: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
  },
  {
    timestamps: false,
  },
);

const moomentCreditSettingsSchema = new Schema<IMoomentCreditSettings>(
  {
    key: {
      type: String,
      enum: ["mooment-credit"],
      default: "mooment-credit",
      unique: true,
      index: true,
    },
    packages: {
      type: [moomentCreditPackageSchema],
      default: [],
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

export const MoomentCreditSettingsModel = model<IMoomentCreditSettings>(
  "MoomentCreditSettings",
  moomentCreditSettingsSchema,
);
