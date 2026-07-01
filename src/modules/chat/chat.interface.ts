import type { Types } from "mongoose";

export const chatMessageTypes = ["text", "image", "video", "audio", "location", "event", "post"] as const;

export type ChatMessageType = (typeof chatMessageTypes)[number];

export const fileAttachmentTypes = ["image", "video", "audio"] as const;
export type FileAttachmentType = (typeof fileAttachmentTypes)[number];

export interface ChatFileAttachment {
  type: FileAttachmentType;
  key: string;
  url?: string | null;
  mimeType: string;
  size: number;
  fileName?: string | null;
  width?: number | null;
  height?: number | null;
  durationSeconds?: number | null;
}

export interface ChatLocationAttachment {
  type: "location";
  latitude: number;
  longitude: number;
  label?: string | null;
  address?: string | null;
}

export interface ChatEventAttachment {
  type: "event";
  eventId: string;
  title?: string | null;
  scheduledAt?: Date | null;
  endAt?: Date | null;
  coverImageKey?: string | null;
  coverImageUrl?: string | null;
  locationName?: string | null;
  address?: string | null;
}

export interface ChatPostAttachment {
  type: "post";
  postId: string;
  preview?: string | null;
  imageKey?: string | null;
  imageUrl?: string | null;
  authorName?: string | null;
}

export type ChatMessageAttachment = ChatFileAttachment | ChatLocationAttachment | ChatEventAttachment | ChatPostAttachment;

export interface ListDirectMessagesQuery {
  limit?: number;
  search?: string;
  includeHidden?: boolean;
}

export interface ListDirectMessageHistoryQuery {
  before?: Date;
  limit?: number;
}

export interface CreateDirectMessageDto {
  text?: string;
  type?: ChatMessageType;
  attachment?: ChatMessageAttachment;
  clientMessageId?: string;
}

export interface IChatMessage {
  _id: Types.ObjectId;
  conversationId: string;
  senderId: Types.ObjectId;
  recipientId: Types.ObjectId;
  type: ChatMessageType;
  text: string;
  attachment?: ChatMessageAttachment | null;
  clientMessageId?: string | null;
  readAt?: Date | null;
  editedAt?: Date | null;
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
  attachment?: ChatMessageAttachment | null;
  readAt: Date | null;
  editedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
