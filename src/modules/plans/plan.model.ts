import { Schema, model } from "mongoose";
import type { IPlan, PlanLocation } from "./plan.interface.js";

const planLocationSchema = new Schema<PlanLocation>(
  {
    address: {
      type: String,
      required: true,
      trim: true,
      maxlength: 240,
    },
    latitude: {
      type: Number,
      min: -90,
      max: 90,
      default: null,
    },
    longitude: {
      type: Number,
      min: -180,
      max: 180,
      default: null,
    },
  },
  {
    _id: false,
  },
);

const planSchema = new Schema<IPlan>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    scheduledAt: {
      type: Date,
      required: true,
      index: true,
    },
    timeLabel: {
      type: String,
      trim: true,
      maxlength: 40,
      default: null,
    },
    eventId: {
      type: Schema.Types.ObjectId,
      ref: "Event",
      default: null,
      index: true,
    },
    eventTitle: {
      type: String,
      trim: true,
      maxlength: 200,
      default: null,
    },
    location: {
      type: planLocationSchema,
      required: true,
    },
    friendIds: {
      type: [
        {
          type: Schema.Types.ObjectId,
          ref: "User",
        },
      ],
      default: [],
    },
    friendNames: {
      type: [
        {
          type: String,
          trim: true,
          maxlength: 120,
        },
      ],
      default: [],
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

planSchema.index({ userId: 1, scheduledAt: 1, _id: 1 });

export const PlanModel = model<IPlan>("Plan", planSchema);
