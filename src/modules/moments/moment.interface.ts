import type { Types } from "mongoose";

export const momentModes = ["feed", "event"] as const;
export type MomentMode = (typeof momentModes)[number];

export const momentAudiences = ["public", "friends", "only_me"] as const;
export type MomentAudience = (typeof momentAudiences)[number];

export const momentMediaTypes = ["image", "video", "audio"] as const;
export type MomentMediaType = (typeof momentMediaTypes)[number];

export const momentMediaSources = ["gallery", "camera", "upload", "external"] as const;
export type MomentMediaSource = (typeof momentMediaSources)[number];

export interface MomentMediaItem {
  type: MomentMediaType;
  source: MomentMediaSource;
  url?: string | null;
  storageKey?: string | null;
  contentType?: string | null;
  durationSeconds?: number | null;
}

export interface IMoment {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  mode: MomentMode;
  caption?: string | null;
  hashtags: string[];
  audience: MomentAudience;
  taggedPeople: string[];
  taggedFriendIds?: Types.ObjectId[];
  eventTitle?: string | null;
  eventId?: Types.ObjectId | null;
  isEventAnnouncement?: boolean;
  eventCode?: string | null;
  sourceStoryId?: Types.ObjectId | null;
  sourceClientRequestId?: string | null;
  mediaItems: MomentMediaItem[];
  createdAt: Date;
  updatedAt: Date;
}

export interface IMomentShare {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  momentId: Types.ObjectId;
  caption?: string | null;
  taggedFriendIds?: Types.ObjectId[];
  originalType?: "post" | "event";
  originalId?: Types.ObjectId;
  clientRequestId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type MomentReactionType = "like";

export interface IMomentReaction {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  momentId: Types.ObjectId;
  type: MomentReactionType;
  createdAt: Date;
  updatedAt: Date;
}

export interface IMomentComment {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  momentId: Types.ObjectId;
  parentCommentId?: Types.ObjectId | null;
  text: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IMomentCommentReaction {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  commentId: Types.ObjectId;
  type: MomentReactionType;
  createdAt: Date;
  updatedAt: Date;
}

export interface IMomentSave {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  momentId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface MomentSaveSummaryResponse {
  momentId: string;
  isSaved: boolean;
}

export interface CreateMomentDto {
  mode: MomentMode;
  caption?: string | null;
  audience: MomentAudience;
  taggedPeople?: string[];
  taggedFriendIds?: string[];
  eventTitle?: string | null;
  eventId?: string | null;
  eventCode?: string | null;
  mediaItems?: MomentMediaItem[];
}

export interface MomentAuthorResponse {
  id: string;
  name: string;
  username?: string;
  avatarKey?: string | null;
  avatarUrl?: string | null;
  isFollowing: boolean;
}

export interface MomentResponse {
  id: string;
  userId: string;
  author?: MomentAuthorResponse | null;
  mode: MomentMode;
  caption?: string | null;
  hashtags: string[];
  audience: MomentAudience;
  taggedPeople: string[];
  taggedFriends?: MomentAuthorResponse[];
  eventTitle?: string | null;
  eventId?: string | null;
  eventCode?: string | null;
  mediaItems: MomentMediaItem[];
  likesCount: number;
  commentsCount: number;
  sharesCount: number;
  isLiked: boolean;
  isSaved: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface MomentFeedQuery {
  hashtags?: string[];
  limit?: number;
  excludeUserIds?: string[];
  visibleEventIds?: string[];
}

export interface MomentTimelineItemResponse {
  id: string;
  type: "post" | "share";
  createdAt: Date;
  sharedAt?: Date | null;
  moment: MomentResponse;
  repostCaption?: string | null;
  taggedFriends?: MomentAuthorResponse[];
  sharedBy?: MomentAuthorResponse | null;
  originalItem?: { type: "post" | "event"; id: string };
}

export interface ProfileTimelineQuery {
  page?: number;
  limit?: number;
}

export interface CreateMomentShareDto {
  caption?: string | null;
  taggedFriendIds?: string[];
  clientRequestId?: string | null;
}

export interface MomentInteractionSummaryResponse {
  momentId: string;
  likesCount: number;
  commentsCount: number;
  sharesCount: number;
  isLiked: boolean;
}

export interface CreateMomentCommentDto {
  text: string;
  parentCommentId?: string | null;
}

export interface MomentCommentAuthorResponse {
  id: string;
  name: string;
  username?: string;
  avatarKey?: string | null;
  avatarUrl?: string | null;
}

export interface MomentCommentResponse {
  id: string;
  momentId: string;
  parentCommentId?: string | null;
  author?: MomentCommentAuthorResponse | null;
  text: string;
  likesCount: number;
  isLiked: boolean;
  createdAt: Date;
  updatedAt: Date;
  replies: MomentCommentResponse[];
}
