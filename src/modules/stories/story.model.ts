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
      // -0.6..1.6 (not 0..1): text is now a freeform-draggable canvas
      // object and may be positioned partially off-canvas, matching the
      // image transform's POSITION_BOUND_MIN/MAX (see lib/storyTransform.ts).
      x: {
        type: Number,
        min: -0.6,
        max: 1.6,
      },
      y: {
        type: Number,
        min: -0.6,
        max: 1.6,
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
      rotation: {
        type: Number,
        min: -180,
        max: 180,
      },
    },
    // Optional — absent/null on every Story created before this feature and
    // on any Story whose image was never touched by the editor, in which
    // case the client falls back to the pre-existing full-bleed cover
    // rendering unchanged.
    imageTransform: {
      x: {
        type: Number,
        min: -0.6,
        max: 1.6,
      },
      y: {
        type: Number,
        min: -0.6,
        max: 1.6,
      },
      scale: {
        type: Number,
        min: 0.5,
        max: 4,
      },
      rotation: {
        type: Number,
        min: -180,
        max: 180,
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
