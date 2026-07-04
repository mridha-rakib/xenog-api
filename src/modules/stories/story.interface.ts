import type { Types } from "mongoose";

export const storyMediaTypes = ["image", "video", "text"] as const;
export type StoryMediaType = (typeof storyMediaTypes)[number];

export const storyMediaSources = ["camera", "gallery", "upload"] as const;
export type StoryMediaSource = (typeof storyMediaSources)[number];

export const storyAudienceTypes = ["connections"] as const;
export type StoryAudienceType = (typeof storyAudienceTypes)[number];

export interface IStory {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  mediaType: StoryMediaType;
  mediaSource: StoryMediaSource;
  storageKey?: string | null;
  contentType?: string | null;
  durationSeconds: number;
  caption?: string | null;
  textContent?: string | null;
  textBackground?: StoryTextBackground | null;
  textOverlay?: StoryTextOverlay | null;
  audience: StoryAudienceType;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface IStoryReaction {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  storyId: Types.ObjectId;
  type: "like";
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface IStoryView {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  storyId: Types.ObjectId;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface IStoryComment {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  storyId: Types.ObjectId;
  parentCommentId?: Types.ObjectId | null;
  text: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateStoryDto {
  mediaType?: StoryMediaType;
  mediaSource?: StoryMediaSource;
  storageKey?: string | null;
  contentType?: string | null;
  durationSeconds: number;
  caption?: string | null;
  textContent?: string | null;
  textBackground?: StoryTextBackground | null;
  textOverlay?: StoryTextOverlay | null;
}

export interface StoryTextBackground {
  type: "color" | "gradient";
  colors: string[];
}

export interface StoryTextOverlay {
  text: string;
  x: number;
  y: number;
  scale: number;
  color: string;
  fontWeight?: "normal" | "600" | "700" | "bold";
  textAlign?: "left" | "center" | "right";
}

export interface StoryAuthorResponse {
  id: string;
  name: string;
  username?: string;
  avatarKey?: string | null;
  avatarUrl?: string | null;
}

export interface StoryResponse {
  id: string;
  userId: string;
  author?: StoryAuthorResponse | null;
  mediaType: StoryMediaType;
  mediaSource: StoryMediaSource;
  storageKey?: string | null;
  mediaUrl?: string | null;
  contentType?: string | null;
  durationSeconds: number;
  caption?: string | null;
  textContent?: string | null;
  textBackground?: StoryTextBackground | null;
  textOverlay?: StoryTextOverlay | null;
  audience: StoryAudienceType;
  viewsCount: number;
  reactionsCount: number;
  commentsCount: number;
  isReacted: boolean;
  isOwner: boolean;
  expiresInSeconds: number;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoryCommentResponse {
  id: string;
  storyId: string;
  parentCommentId?: string | null;
  author?: StoryAuthorResponse | null;
  text: string;
  likesCount: number;
  isLiked: boolean;
  replies: StoryCommentResponse[];
  createdAt: Date;
  updatedAt: Date;
}
