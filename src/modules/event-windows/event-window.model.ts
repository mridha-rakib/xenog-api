import { Schema, model } from "mongoose";
import type { EventWindowMediaItem, EventWindowPostTicketEntitlement, IEventWindow, IEventWindowPost } from "./event-window.interface.js";
import {
  DEFAULT_EVENT_WINDOW_PARTICIPANT_POST_VISIBILITY,
  DEFAULT_EVENT_WINDOW_POSTING_ELIGIBILITY,
  eventWindowContentTypes,
  eventWindowMediaSources,
  eventWindowMediaTypes,
  eventWindowParticipantPostVisibilities,
  eventWindowPostingEligibilities,
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
    postingEligibility: {
      type: String,
      enum: eventWindowPostingEligibilities,
      required: true,
      default: DEFAULT_EVENT_WINDOW_POSTING_ELIGIBILITY,
    },
    participantPostVisibility: {
      type: String,
      enum: eventWindowParticipantPostVisibilities,
      required: true,
      default: DEFAULT_EVENT_WINDOW_PARTICIPANT_POST_VISIBILITY,
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

const eventWindowPostTicketEntitlementSchema = new Schema<EventWindowPostTicketEntitlement>(
  {
    orderId: {
      type: Schema.Types.ObjectId,
      ref: "CheckoutOrder",
      required: true,
    },
    ticketId: {
      type: String,
      required: true,
    },
    ticketIndex: {
      type: Number,
      required: true,
      min: 0,
    },
    source: {
      type: String,
      enum: ["owned", "shared"],
      required: true,
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
    // Only one of ticketUsageId / ticketEntitlement is populated on a given
    // post, depending on the window's postingEligibility at the time the
    // post was created (see event-window.service.ts#resolvePostingAuthorization).
    ticketUsageId: {
      type: Schema.Types.ObjectId,
      ref: "TicketUsage",
      default: null,
      index: true,
    },
    ticketEntitlement: {
      type: eventWindowPostTicketEntitlementSchema,
      default: null,
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
// Supports the "my participated events/windows" query (EventWindowRepository
// #findAcceptedPostsByUser) — a cross-event, user-scoped lookup that none of
// the indexes above serve, since each has eventId or windowId leading rather
// than userId.
eventWindowPostSchema.index({ userId: 1, status: 1, createdAt: -1 });

export const EventWindowModel = model<IEventWindow>("EventWindow", eventWindowSchema);
export const EventWindowPostModel = model<IEventWindowPost>("EventWindowPost", eventWindowPostSchema);
