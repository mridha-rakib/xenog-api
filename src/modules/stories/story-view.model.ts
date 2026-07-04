import { Schema, model } from "mongoose";
import type { IStoryView } from "./story.interface.js";

const schema = new Schema<IStoryView>({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  storyId: { type: Schema.Types.ObjectId, ref: "Story", required: true, index: true },
  expiresAt: { type: Date, required: true },
}, { timestamps: true, versionKey: false });
schema.index({ userId: 1, storyId: 1 }, { unique: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const StoryViewModel = model<IStoryView>("StoryView", schema);
