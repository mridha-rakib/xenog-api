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
  textStyle?: StoryTextStyle | null;
  imageTransform?: StoryImageTransform | null;
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
  textStyle?: StoryTextStyle | null;
  imageTransform?: StoryImageTransform | null;
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
  // "800" is the new "Heavy" value; "bold" is kept only so already-stored
  // overlays and legacy clients keep validating/rendering unchanged.
  fontWeight?: "normal" | "600" | "700" | "800" | "bold";
  textAlign?: "left" | "center" | "right";
  rotation?: number;
  /** User's shadow intent. Absent/null on legacy overlays === shadow on. */
  shadow?: boolean;
}

// Minimal persisted style for the text-only Story body. Deliberately NOT
// StoryTextOverlay — the text-only body is a full-bleed centered block, not
// a positioned/draggable sticker, so it has no x/y/scale/rotation.
export interface StoryTextStyle {
  fontWeight?: "normal" | "600" | "700" | "800";
  color?: string;
  textAlign?: "left" | "center" | "right";
  shadow?: boolean;
}

// Normalized Story image placement — x/y are the image's visual center as a
// fraction of the Story canvas (0.5/0.5 = today's legacy centered
// full-bleed cover), matching StoryTextOverlay's coordinate convention.
export interface StoryImageTransform {
  x: number;
  y: number;
  scale: number;
  rotation?: number;
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
  textStyle?: StoryTextStyle | null;
  imageTransform?: StoryImageTransform | null;
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
