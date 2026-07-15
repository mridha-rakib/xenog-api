import { Schema, model } from "mongoose";
import type { IMoment, MomentMediaItem } from "./moment.interface.js";
import { momentAudiences, momentMediaSources, momentMediaTypes, momentModes } from "./moment.interface.js";

const momentMediaItemSchema = new Schema<MomentMediaItem>(
  {
    type: {
      type: String,
      enum: momentMediaTypes,
      required: true,
    },
    source: {
      type: String,
      enum: momentMediaSources,
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
  {
    _id: false,
  },
);

const momentSchema = new Schema<IMoment>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    mode: {
      type: String,
      enum: momentModes,
      required: true,
      index: true,
    },
    caption: {
      type: String,
      trim: true,
      maxlength: 5000,
      default: null,
    },
    hashtags: {
      type: [{ type: String, trim: true, lowercase: true, maxlength: 64 }],
      default: [],
      validate: {
        validator: (values: string[]) => values.length <= 20 && new Set(values).size === values.length,
        message: "A moment can have up to 20 unique hashtags",
      },
    },
    audience: {
      type: String,
      enum: momentAudiences,
      required: true,
      default: "public",
      index: true,
    },
    taggedPeople: {
      type: [
        {
          type: String,
          trim: true,
          maxlength: 120,
        },
      ],
      default: [],
    },
    taggedFriendIds: {
      type: [{ type: Schema.Types.ObjectId, ref: "User" }],
      default: [],
    },
    eventTitle: {
      type: String,
      trim: true,
      maxlength: 200,
      default: null,
    },
    eventId: {
      type: Schema.Types.ObjectId,
      ref: "Event",
      default: null,
      index: true,
      sparse: true,
    },
    isEventAnnouncement: {
      type: Boolean,
      default: false,
      index: true,
    },
    eventCode: {
      type: String,
      trim: true,
      maxlength: 200,
      default: null,
    },
    sourceStoryId: {
      type: Schema.Types.ObjectId,
      ref: "Story",
      default: null,
      index: true,
      sparse: true,
    },
    sourceClientRequestId: {
      type: String,
      trim: true,
      maxlength: 120,
      default: null,
    },
    mediaItems: {
      type: [momentMediaItemSchema],
      default: [],
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

momentSchema.index({ caption: "text", eventTitle: "text", taggedPeople: "text" });
momentSchema.index({ mode: 1, audience: 1, hashtags: 1, createdAt: -1 });
momentSchema.index({ audience: 1, hashtags: 1, createdAt: -1 });
momentSchema.index(
  { eventId: 1, isEventAnnouncement: 1 },
  { unique: true, partialFilterExpression: { isEventAnnouncement: true } },
);
// Supports isEventAnnouncement filter on profile and post-count queries
momentSchema.index({ userId: 1, isEventAnnouncement: 1, createdAt: -1 });
momentSchema.index(
  { userId: 1, sourceStoryId: 1 },
  { unique: true, partialFilterExpression: { sourceStoryId: { $type: "objectId" } } },
);

export const MomentModel = model<IMoment>("Moment", momentSchema);
