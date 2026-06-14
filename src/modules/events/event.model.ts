import { randomUUID } from "node:crypto";
import { Schema, model } from "mongoose";
import type { EventLocation, EventReward, EventTicket, IEvent } from "./event.interface.js";
import {
  eventAgeRestrictions,
  eventCategories,
  eventPrivacyOptions,
  eventRewardTypes,
  eventStatuses,
  eventTicketTypes,
} from "./event.interface.js";

const eventLocationSchema = new Schema<EventLocation>(
  {
    searchLabel: {
      type: String,
      trim: true,
      maxlength: 240,
      default: null,
    },
    venue: {
      type: String,
      trim: true,
      maxlength: 160,
      default: null,
    },
    address: {
      type: String,
      trim: true,
      maxlength: 240,
      default: null,
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
  { _id: false },
);

const eventTicketSchema = new Schema<EventTicket>(
  {
    id: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
      default: randomUUID,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: null,
    },
    salesEndAt: {
      type: Date,
      default: null,
    },
    type: {
      type: String,
      enum: eventTicketTypes,
      required: true,
      default: "free",
    },
    price: {
      type: Number,
      min: 0,
      max: 1_000_000,
      default: 0,
    },
    capacity: {
      type: Number,
      min: 0,
      max: 1_000_000,
      required: true,
    },
  },
  { _id: false },
);

const eventRewardSchema = new Schema<EventReward>(
  {
    id: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
      default: randomUUID,
    },
    rewardType: {
      type: String,
      enum: eventRewardTypes,
      required: true,
    },
    ticketId: {
      type: String,
      trim: true,
      maxlength: 80,
      default: null,
    },
    productId: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      default: null,
    },
    targetName: {
      type: String,
      trim: true,
      maxlength: 160,
      default: null,
    },
    imageKeys: {
      type: [String],
      default: [],
      validate: {
        validator: (value: string[]) => value.length <= 10,
        message: "Reward cannot include more than 10 images",
      },
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: null,
    },
    expiresAt: {
      type: Date,
      default: null,
    },
    discountPercent: {
      type: Number,
      min: 0,
      max: 100,
      default: 0,
    },
    buyQuantity: {
      type: Number,
      min: 1,
      max: 1_000_000,
      required: true,
    },
    freeQuantity: {
      type: Number,
      min: 1,
      max: 1_000_000,
      required: true,
    },
    capacity: {
      type: Number,
      min: 0,
      max: 1_000_000,
      required: true,
    },
  },
  { _id: false },
);

const eventImageDisplaySchema = new Schema(
  {
    crop: {
      x: {
        type: Number,
        min: 0,
        max: 1,
        default: 0,
      },
      y: {
        type: Number,
        min: 0,
        max: 1,
        default: 0,
      },
      width: {
        type: Number,
        min: 0,
        max: 1,
        default: 1,
      },
      height: {
        type: Number,
        min: 0,
        max: 1,
        default: 1,
      },
    },
    imageWidth: {
      type: Number,
      min: 1,
      default: null,
    },
    imageHeight: {
      type: Number,
      min: 1,
      default: null,
    },
  },
  { _id: false },
);

const eventSchema = new Schema<IEvent>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: eventStatuses,
      required: true,
      default: "draft",
      index: true,
    },
    name: {
      type: String,
      trim: true,
      maxlength: 160,
      default: null,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 5000,
      default: null,
    },
    bannerImageKey: {
      type: String,
      trim: true,
      maxlength: 300,
      default: null,
    },
    bannerOriginalImageKey: {
      type: String,
      trim: true,
      maxlength: 300,
      default: null,
    },
    bannerImageDisplay: {
      type: eventImageDisplaySchema,
      default: null,
    },
    ageRestriction: {
      type: String,
      enum: eventAgeRestrictions,
      default: null,
    },
    category: {
      type: String,
      enum: eventCategories,
      trim: true,
      maxlength: 120,
      default: null,
    },
    scheduledAt: {
      type: Date,
      default: null,
      index: true,
    },
    location: {
      type: eventLocationSchema,
      default: null,
    },
    tickets: {
      type: [eventTicketSchema],
      default: [],
    },
    rewards: {
      type: [eventRewardSchema],
      default: [],
    },
    privacy: {
      type: String,
      enum: eventPrivacyOptions,
      required: true,
      default: "public",
    },
    publishedAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
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

eventSchema.index({ userId: 1, status: 1, createdAt: -1 });
eventSchema.index({ name: "text", description: "text", category: "text", "location.venue": "text", "location.address": "text" });

export const EventModel = model<IEvent>("Event", eventSchema);
