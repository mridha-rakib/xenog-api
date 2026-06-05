import type { Types } from "mongoose";

export const supportTicketStatuses = ["pending", "solved", "dismissed"] as const;
export type SupportTicketStatus = (typeof supportTicketStatuses)[number];

export const supportMessageSenderTypes = ["user", "admin"] as const;
export type SupportMessageSenderType = (typeof supportMessageSenderTypes)[number];

export interface SupportTicketModifier {
  id: string;
  name: string;
  email: string;
}

export interface ISupportTicketMessage {
  _id: Types.ObjectId;
  senderType: SupportMessageSenderType;
  senderId: string;
  senderName: string;
  title: string;
  body: string;
  createdAt: Date;
}

export interface ISupportTicket {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  requesterName: string;
  requesterEmail: string;
  requesterAvatarKey?: string | null;
  title: string;
  description: string;
  status: SupportTicketStatus;
  messages: ISupportTicketMessage[];
  lastMessageAt: Date;
  closedAt?: Date | null;
  lastModifiedBy?: SupportTicketModifier;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateSupportTicketDto {
  title: string;
  description: string;
}

export interface ListSupportTicketsQuery {
  page: number;
  limit: number;
  search?: string;
  status?: SupportTicketStatus;
}

export interface UpdateSupportTicketStatusDto {
  status: SupportTicketStatus;
}

export interface CreateSupportTicketMessageDto {
  body: string;
}

export interface SupportTicketRequesterResponse {
  id: string;
  name: string;
  email: string;
  avatarKey?: string | null;
  avatarUrl?: string | null;
}

export interface SupportTicketMessageResponse {
  id: string;
  senderType: SupportMessageSenderType;
  senderId: string;
  senderName: string;
  title: string;
  body: string;
  createdAt: Date;
}

export interface SupportTicketResponse {
  id: string;
  requester: SupportTicketRequesterResponse;
  title: string;
  description: string;
  status: SupportTicketStatus;
  messages: SupportTicketMessageResponse[];
  lastMessageAt: Date;
  closedAt?: Date | null;
  lastModifiedBy?: SupportTicketModifier;
  createdAt: Date;
  updatedAt: Date;
}

export interface SupportTicketsPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  from: number;
  to: number;
}

export interface SupportTicketListResponse {
  tickets: SupportTicketResponse[];
  pagination: SupportTicketsPagination;
}
