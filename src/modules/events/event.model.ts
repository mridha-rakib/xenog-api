import { Schema, model } from "mongoose";
import type { EventLocation, EventTicket, IEvent } from "./event.interface.js";
import {
  eventAgeRestrictions,
  eventCategories,
  eventPrivacyOptions,
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
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

eventSchema.index({ userId: 1, status: 1, createdAt: -1 });
eventSchema.index({ name: "text", description: "text", category: "text", "location.venue": "text", "location.address": "text" });

export const EventModel = model<IEvent>("Event", eventSchema);
