import { Schema, model } from "mongoose";
import type { IStoryReaction } from "./story.interface.js";

const schema = new Schema<IStoryReaction>({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  storyId: { type: Schema.Types.ObjectId, ref: "Story", required: true, index: true },
  type: { type: String, enum: ["like"], default: "like", required: true },
  expiresAt: { type: Date, required: true },
}, { timestamps: true, versionKey: false });
schema.index({ userId: 1, storyId: 1, type: 1 }, { unique: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const StoryReactionModel = model<IStoryReaction>("StoryReaction", schema);
