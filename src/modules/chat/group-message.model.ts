import { Schema, model } from "mongoose";
import type { IGroupMessage } from "./group.interface.js";

const groupMessageSchema = new Schema<IGroupMessage>(
  {
    groupId: { type: Schema.Types.ObjectId, ref: "Group", required: true, index: true },
    senderId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    text: { type: String, required: true, trim: true, maxlength: 2000 },
  },
  { timestamps: true, versionKey: false },
);

groupMessageSchema.index({ groupId: 1, createdAt: -1, _id: -1 });

export const GroupMessageModel = model<IGroupMessage>("GroupMessage", groupMessageSchema);
