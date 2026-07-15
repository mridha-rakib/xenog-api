import { Schema, model } from "mongoose";
import type { EventWindowMediaItem, IEventWindow, IEventWindowPost } from "./event-window.interface.js";
import {
  eventWindowContentTypes,
  eventWindowMediaSources,
  eventWindowMediaTypes,
  eventWindowPostStatuses,
  eventWindowStatuses,
  MAX_EVENT_WINDOW_POSTS,
} from "./event-window.interface.js";

const eventWindowSchema = new Schema<IEventWindow>(
  {
    eventId: {
      type: Schema.Types.ObjectId,
      ref: "Event",
      required: true,
      index: true,
    },
    hostUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    title: {
      type: String,
      trim: true,
      maxlength: 120,
      default: null,
    },
    details: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },
    startsAt: {
      type: Date,
      required: true,
      index: true,
    },
    endsAt: {
      type: Date,
      required: true,
      index: true,
    },
    allowedContentTypes: {
      type: [{ type: String, enum: eventWindowContentTypes }],
      required: true,
      validate: {
        validator: (values: string[]) => values.length > 0 && new Set(values).size === values.length,
        message: "Allowed content types must be unique and non-empty",
      },
    },
    maxPosts: {
      type: Number,
      required: true,
      min: 1,
      max: MAX_EVENT_WINDOW_POSTS,
    },
    acceptedPostCount: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    status: {
      type: String,
      enum: eventWindowStatuses,
      required: true,
      default: "scheduled",
      index: true,
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

eventWindowSchema.index({ eventId: 1, startsAt: 1 });
eventWindowSchema.index({ eventId: 1, endsAt: 1 });
eventWindowSchema.index({ eventId: 1, status: 1, startsAt: 1 });

const eventWindowMediaItemSchema = new Schema<EventWindowMediaItem>(
  {
    type: {
      type: String,
      enum: eventWindowMediaTypes,
      required: true,
    },
    source: {
      type: String,
      enum: eventWindowMediaSources,
      required: true,
      default: "external",
    },
    url: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: null,
    },
    storageKey: {
      type: String,
      trim: true,
      maxlength: 300,
      default: null,
    },
    contentType: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null,
    },
    durationSeconds: {
      type: Number,
      min: 0,
      default: null,
    },
  },
  { _id: false },
);

const eventWindowPostSchema = new Schema<IEventWindowPost>(
  {
    eventId: {
      type: Schema.Types.ObjectId,
      ref: "Event",
      required: true,
      index: true,
    },
    windowId: {
      type: Schema.Types.ObjectId,
      ref: "EventWindow",
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    ticketUsageId: {
      type: Schema.Types.ObjectId,
      ref: "TicketUsage",
      required: true,
      index: true,
    },
    contentType: {
      type: String,
      enum: eventWindowContentTypes,
      required: true,
    },
    text: {
      type: String,
      trim: true,
      maxlength: 5000,
      default: null,
    },
    mediaItems: {
      type: [eventWindowMediaItemSchema],
      default: [],
    },
    status: {
      type: String,
      enum: eventWindowPostStatuses,
      required: true,
      default: "accepted",
      index: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

eventWindowPostSchema.index({ windowId: 1, userId: 1 }, { unique: true, partialFilterExpression: { status: "accepted" } });
eventWindowPostSchema.index({ windowId: 1, status: 1, createdAt: 1 });
eventWindowPostSchema.index({ eventId: 1, userId: 1, createdAt: -1 });

export const EventWindowModel = model<IEventWindow>("EventWindow", eventWindowSchema);
export const EventWindowPostModel = model<IEventWindowPost>("EventWindowPost", eventWindowPostSchema);
