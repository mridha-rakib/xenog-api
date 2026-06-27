import { Schema, model } from "mongoose";
import type { IGroupMessage } from "./group.interface.js";
import { chatMessageTypes } from "./chat.interface.js";

const groupMessageSchema = new Schema<IGroupMessage>(
  {
    groupId: { type: Schema.Types.ObjectId, ref: "Group", required: true, index: true },
    senderId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, enum: chatMessageTypes, required: true, default: "text" },
    text: { type: String, default: "", trim: true, maxlength: 2000 },
    attachment: { type: Schema.Types.Mixed, default: null },
    editedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

groupMessageSchema.index({ groupId: 1, createdAt: -1, _id: -1 });

export const GroupMessageModel = model<IGroupMessage>("GroupMessage", groupMessageSchema);
