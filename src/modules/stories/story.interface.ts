import type { Types } from "mongoose";

export const storyMediaTypes = ["video"] as const;
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
  storageKey: string;
  contentType: string;
  durationSeconds: number;
  caption?: string | null;
  audience: StoryAudienceType;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateStoryDto {
  mediaSource?: StoryMediaSource;
  storageKey: string;
  contentType: string;
  durationSeconds: number;
  caption?: string | null;
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
  storageKey: string;
  mediaUrl?: string | null;
  contentType: string;
  durationSeconds: number;
  caption?: string | null;
  audience: StoryAudienceType;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}
