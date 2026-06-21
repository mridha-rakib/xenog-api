import { Schema, model } from "mongoose";
import type { IGroup, IGroupMember } from "./group.interface.js";

const groupMemberSchema = new Schema<IGroupMember>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    role: { type: String, enum: ["admin", "member"], default: "member", required: true },
    joinedAt: { type: Date, default: Date.now, required: true },
  },
  { _id: false },
);

const groupSchema = new Schema<IGroup>(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    avatarKey: { type: String, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    members: { type: [groupMemberSchema], required: true },
    lastMessage: { type: String, default: null },
    lastMessageAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

groupSchema.index({ "members.userId": 1 });
groupSchema.index({ "members.userId": 1, lastMessageAt: -1, createdAt: -1 });

export const GroupModel = model<IGroup>("Group", groupSchema);
