import type { Types } from "mongoose";

export const eventWindowContentTypes = ["text", "image", "video", "audio"] as const;
export type EventWindowContentType = (typeof eventWindowContentTypes)[number];

export const eventWindowStatuses = ["scheduled", "cancelled"] as const;
export type EventWindowStatus = (typeof eventWindowStatuses)[number];

export const eventWindowPostStatuses = ["accepted", "removed"] as const;
export type EventWindowPostStatus = (typeof eventWindowPostStatuses)[number];

export const eventWindowMediaTypes = ["image", "video", "audio"] as const;
export type EventWindowMediaType = (typeof eventWindowMediaTypes)[number];

export const eventWindowMediaSources = ["gallery", "camera", "upload", "external"] as const;
export type EventWindowMediaSource = (typeof eventWindowMediaSources)[number];

export const MAX_EVENT_WINDOW_POSTS = 10_000;
export const DEFAULT_EVENT_WINDOW_POST_PAGE_SIZE = 20;
export const MAX_EVENT_WINDOW_POST_PAGE_SIZE = 50;
export const EVENT_WINDOW_MEDIA_LIMITS_BYTES = {
  image: 15 * 1024 * 1024,
  video: 300 * 1024 * 1024,
  audio: 50 * 1024 * 1024,
} as const satisfies Record<EventWindowMediaType, number>;

export interface EventWindowMediaItem {
  type: EventWindowMediaType;
  source: EventWindowMediaSource;
  url?: string | null;
  storageKey?: string | null;
  contentType?: string | null;
  durationSeconds?: number | null;
}

export interface IEventWindow {
  _id: Types.ObjectId;
  eventId: Types.ObjectId;
  hostUserId: Types.ObjectId;
  title?: string | null;
  details?: string | null;
  startsAt: Date;
  endsAt: Date;
  allowedContentTypes: EventWindowContentType[];
  maxPosts: number;
  acceptedPostCount: number;
  status: EventWindowStatus;
  cancelledAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IEventWindowPost {
  _id: Types.ObjectId;
  eventId: Types.ObjectId;
  windowId: Types.ObjectId;
  userId: Types.ObjectId;
  ticketUsageId: Types.ObjectId;
  contentType: EventWindowContentType;
  text?: string | null;
  mediaItems: EventWindowMediaItem[];
  status: EventWindowPostStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateEventWindowDto {
  title?: string | null;
  details?: string | null;
  startsAt: Date;
  endsAt: Date;
  allowedContentTypes: EventWindowContentType[];
  maxPosts: number;
}

export type UpdateEventWindowDto = Partial<CreateEventWindowDto>;

export interface CreateEventWindowPostDto {
  contentType: EventWindowContentType;
  text?: string | null;
  mediaItems?: EventWindowMediaItem[];
}

export type EventWindowComputedStatus = "scheduled" | "open" | "closed" | "cancelled";

export interface EventWindowResponse {
  id: string;
  eventId: string;
  hostUserId: string;
  title?: string | null;
  details?: string | null;
  startsAt: Date;
  endsAt: Date;
  allowedContentTypes: EventWindowContentType[];
  maxPosts: number;
  acceptedPostCount: number;
  status: EventWindowStatus;
  computedStatus: EventWindowComputedStatus;
  cancelledAt?: Date | null;
  hasAttended: boolean;
  hasPosted: boolean;
  canPost: boolean;
  canViewPosts: boolean;
  remainingSlots: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface EventWindowPostMediaResponse {
  type: EventWindowMediaType;
  source: EventWindowMediaSource;
  url?: string | null;
  contentType?: string | null;
  durationSeconds?: number | null;
}

export interface EventWindowPostResponse {
  id: string;
  eventId: string;
  windowId: string;
  userId: string;
  contentType: EventWindowContentType;
  text?: string | null;
  mediaItems: EventWindowPostMediaResponse[];
  status: EventWindowPostStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListEventWindowPostsOptions {
  limit: number;
  cursor?: string;
}

export interface EventWindowPostListResponse {
  posts: EventWindowPostResponse[];
  nextCursor: string | null;
}
