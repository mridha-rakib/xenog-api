import { Schema, model } from "mongoose";
import type { IStory } from "./story.interface.js";
import { storyAudienceTypes, storyMediaSources, storyMediaTypes } from "./story.interface.js";

const storySchema = new Schema<IStory>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    mediaType: {
      type: String,
      enum: storyMediaTypes,
      required: true,
      default: "video",
    },
    mediaSource: {
      type: String,
      enum: storyMediaSources,
      required: true,
      default: "upload",
    },
    storageKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 300,
    },
    contentType: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    durationSeconds: {
      type: Number,
      required: true,
      min: 0.1,
      max: 15,
    },
    caption: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },
    audience: {
      type: String,
      enum: storyAudienceTypes,
      required: true,
      default: "connections",
      index: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

storySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
storySchema.index({ userId: 1, createdAt: -1 });

export const StoryModel = model<IStory>("Story", storySchema);
