import type { Types } from "mongoose";
import type { ChatMessageAttachment, ChatMessageType } from "./chat.interface.js";

export type GroupMemberRole = "admin" | "member";

export interface IGroupMember {
  userId: Types.ObjectId;
  role: GroupMemberRole;
  joinedAt: Date;
}

export interface IGroup {
  _id: Types.ObjectId;
  name: string;
  avatarKey?: string | null;
  createdBy: Types.ObjectId;
  members: IGroupMember[];
  lastMessage: string | null;
  lastMessageAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IGroupMessage {
  _id: Types.ObjectId;
  groupId: Types.ObjectId;
  senderId: Types.ObjectId;
  type: ChatMessageType;
  text: string;
  attachment?: ChatMessageAttachment | null;
  editedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateGroupDto {
  name: string;
  memberIds: string[];
  avatarKey?: string | null;
}

export interface ListGroupsQuery {
  limit?: number;
}

export interface ListGroupMessageHistoryQuery {
  before?: Date;
  limit?: number;
}

export interface CreateGroupMessageDto {
  text?: string;
  type?: ChatMessageType;
  attachment?: ChatMessageAttachment;
}

export interface GroupConversationResponse {
  id: string;
  type: "group";
  name: string;
  avatarKey?: string | null;
  avatarUrl?: string | null;
  memberCount: number;
  lastMessage: string | null;
  lastMessageAt: Date | null;
  unreadCount: number;
  createdBy: string;
}

export interface GroupMessageResponse {
  id: string;
  groupId: string;
  senderId: string;
  senderName: string;
  type: ChatMessageType;
  text: string;
  attachment?: ChatMessageAttachment | null;
  editedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
