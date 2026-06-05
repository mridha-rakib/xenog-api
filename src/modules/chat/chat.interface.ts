import type { Types } from "mongoose";

export const chatMessageTypes = ["text"] as const;

export type ChatMessageType = (typeof chatMessageTypes)[number];

export interface ListDirectMessagesQuery {
  limit?: number;
  search?: string;
}

export interface ListDirectMessageHistoryQuery {
  before?: Date;
  limit?: number;
}

export interface CreateDirectMessageDto {
  text: string;
}

export interface IChatMessage {
  _id: Types.ObjectId;
  conversationId: string;
  senderId: Types.ObjectId;
  recipientId: Types.ObjectId;
  type: ChatMessageType;
  text: string;
  readAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DirectMessageConversationResponse {
  id: string;
  type: "direct";
  friendId: string;
  name: string;
  username?: string;
  avatarKey?: string | null;
  avatarUrl?: string | null;
  lastMessage: string | null;
  lastMessageAt: Date | null;
  unreadCount: number;
  isOnline: boolean;
  isBlocked: boolean;
}

export interface DirectMessageResponse {
  id: string;
  conversationId: string;
  senderId: string;
  recipientId: string;
  type: ChatMessageType;
  text: string;
  readAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
