import { Schema, model } from "mongoose";
import type { IStripeConnectAccount } from "./stripe-connect.interface.js";
import { stripeConnectOnboardingStatuses } from "./stripe-connect.interface.js";

const requirementsSchema = new Schema(
  {
    currentlyDue: {
      type: [String],
      default: [],
    },
    eventuallyDue: {
      type: [String],
      default: [],
    },
    pastDue: {
      type: [String],
      default: [],
    },
    disabledReason: {
      type: String,
      default: null,
    },
  },
  { _id: false },
);

const stripeConnectAccountSchema = new Schema<IStripeConnectAccount>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    stripeAccountId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
    },
    country: {
      type: String,
      trim: true,
      uppercase: true,
      default: null,
    },
    livemode: {
      type: Boolean,
      default: false,
    },
    detailsSubmitted: {
      type: Boolean,
      default: false,
    },
    chargesEnabled: {
      type: Boolean,
      default: false,
    },
    payoutsEnabled: {
      type: Boolean,
      default: false,
    },
    onboardingStatus: {
      type: String,
      enum: stripeConnectOnboardingStatuses,
      default: "not_started",
      index: true,
    },
    requirements: {
      type: requirementsSchema,
      default: () => ({}),
    },
    lastSyncedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        const record = ret as Record<string, unknown> & {
          _id?: { toString: () => string };
          id?: string;
        };

        record.id = record._id?.toString();
        delete record._id;

        return record;
      },
    },
  },
);

export const StripeConnectAccountModel = model<IStripeConnectAccount>(
  "StripeConnectAccount",
  stripeConnectAccountSchema,
);
