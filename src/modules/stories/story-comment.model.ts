import { Schema, model } from "mongoose";
import type { IStoryComment } from "./story.interface.js";

const schema = new Schema<IStoryComment>({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  storyId: { type: Schema.Types.ObjectId, ref: "Story", required: true, index: true },
  parentCommentId: { type: Schema.Types.ObjectId, ref: "StoryComment", default: null, index: true },
  text: { type: String, required: true, trim: true, maxlength: 2000 },
  expiresAt: { type: Date, required: true },
}, { timestamps: true, versionKey: false });
schema.index({ storyId: 1, createdAt: 1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const StoryCommentModel = model<IStoryComment>("StoryComment", schema);
