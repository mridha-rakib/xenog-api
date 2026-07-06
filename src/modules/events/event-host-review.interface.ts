import type { Types } from "mongoose";

export type EventHostReviewRating = "like" | "dislike";

export interface IEventHostReview {
  _id: Types.ObjectId;
  eventId: Types.ObjectId;
  hostUserId: Types.ObjectId;
  reviewerUserId: Types.ObjectId;
  ticketUsageId: Types.ObjectId;
  rating: EventHostReviewRating;
  text?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EventHostReviewEligibilityResponse {
  canReview: boolean;
  hasReviewed: boolean;
}

export interface SubmitEventHostReviewDto {
  liked: boolean;
  text?: string | null;
}

export interface EventHostReviewResponse {
  id: string;
  author: {
    id: string;
    name: string;
    username?: string;
    avatarKey?: string | null;
    avatarUrl?: string | null;
  } | null;
  text: string;
  liked: boolean;
  event?: {
    id: string;
    name?: string | null;
  } | null;
  createdAt: Date;
}
