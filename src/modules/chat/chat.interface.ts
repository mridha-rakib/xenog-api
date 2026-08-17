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

// Chat-only messaging restriction, entirely separate from the user module's
// UserBlockModel (full/profile block). See direct-message-block.model.ts —
// same directional shape as UserBlock, but this is a distinct collection so
// existing UserBlock consumers (Feed/Moment/Event exclusion, profile
// visibility, follow removal) are never affected by a message-only block.
export interface IDirectMessageBlock {
  _id: Types.ObjectId;
  blockerId: Types.ObjectId;
  blockedId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageBlockStatusResponse {
  userId: string;
  isMessageBlocked: boolean;
}

export interface MessageBlockedUserResponse {
  id: string;
  name: string;
  username?: string;
  avatarKey?: string | null;
  avatarUrl?: string | null;
  blockedAt: Date;
}

// Combined directional state for a single DM pair — lets Chat Detail derive
// its blocked-state UI from one request instead of one per block type.
// Deliberately computed and served from the chat module (not merged into
// the user module's GET /users/:id) to avoid a user->chat module dependency
// cycle: chat already depends on user (UserBlockRepository), so the reverse
// direction is avoided by keeping this endpoint chat-owned.
export interface DirectMessageRelationshipResponse {
  fullBlockedByMe: boolean;
  fullBlockedMe: boolean;
  messageBlockedByMe: boolean;
  messageBlockedMe: boolean;
  canMessage: boolean;
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
