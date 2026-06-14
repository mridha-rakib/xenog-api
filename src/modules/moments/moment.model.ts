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
    eventCode: {
      type: String,
      trim: true,
      maxlength: 200,
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

export const MomentModel = model<IMoment>("Moment", momentSchema);
