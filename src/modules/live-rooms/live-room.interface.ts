import type { Types } from "mongoose";

export const liveRoomStatuses = ["live", "ended"] as const;
export type LiveRoomStatus = (typeof liveRoomStatuses)[number];

export interface ILiveRoom {
  _id: Types.ObjectId;
  hostUserId: Types.ObjectId;
  title: string;
  allowAllParticipantsToSpeak: boolean;
  speakerIds: Types.ObjectId[];
  status: LiveRoomStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface ILiveRoomParticipant {
  _id: Types.ObjectId;
  liveRoomId: Types.ObjectId;
  userId: Types.ObjectId;
  isActive: boolean;
  joinedAt: Date;
  leftAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ILiveRoomMessage {
  _id: Types.ObjectId;
  liveRoomId: Types.ObjectId;
  senderId: Types.ObjectId;
  text: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateLiveRoomDto {
  title: string;
  allowAllParticipantsToSpeak: boolean;
  speakerIds?: string[];
}

export interface UpdateLiveRoomPermissionsDto {
  allowAllParticipantsToSpeak?: boolean;
  speakerIds?: string[];
}

export interface ListLiveRoomMessagesQuery {
  before?: Date;
  limit?: number;
}

export interface CreateLiveRoomMessageDto {
  text: string;
}

export interface LiveRoomViewerPermissions {
  isHost: boolean;
  canSpeak: boolean;
  canManagePermissions: boolean;
}

export interface LiveRoomUserResponse {
  id: string;
  name: string;
  username?: string;
  avatarKey?: string | null;
  avatarUrl?: string | null;
}

export interface LiveRoomParticipantResponse {
  id: string;
  user: LiveRoomUserResponse | null;
  isActive: boolean;
  canSpeak: boolean;
  isHost: boolean;
  joinedAt: Date;
  leftAt?: Date | null;
}

export interface LiveRoomMessageResponse {
  id: string;
  liveRoomId: string;
  senderId: string;
  senderName: string;
  senderAvatarUrl?: string | null;
  text: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface LiveRoomResponse {
  id: string;
  hostUserId: string;
  host: LiveRoomUserResponse | null;
  title: string;
  allowAllParticipantsToSpeak: boolean;
  speakerIds: string[];
  listenerCount: number;
  participants: LiveRoomParticipantResponse[];
  status: LiveRoomStatus;
  viewerPermissions: LiveRoomViewerPermissions;
  createdAt: Date;
  updatedAt: Date;
}
