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
      default: null,
      trim: true,
      maxlength: 300,
    },
    contentType: {
      type: String,
      default: null,
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
    textContent: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },
    textBackground: {
      type: {
        type: String,
        enum: ["color", "gradient"],
      },
      colors: {
        type: [String],
        default: undefined,
      },
    },
    textOverlay: {
      text: {
        type: String,
        trim: true,
        maxlength: 160,
      },
      x: {
        type: Number,
        min: 0,
        max: 1,
      },
      y: {
        type: Number,
        min: 0,
        max: 1,
      },
      scale: {
        type: Number,
        min: 0.5,
        max: 2,
      },
      color: {
        type: String,
        trim: true,
        maxlength: 24,
      },
      fontWeight: {
        type: String,
        enum: ["normal", "600", "700", "bold"],
      },
      textAlign: {
        type: String,
        enum: ["left", "center", "right"],
      },
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
