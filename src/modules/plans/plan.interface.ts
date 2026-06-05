import type { Types } from "mongoose";

export interface PlanLocation {
  address: string;
  latitude?: number | null;
  longitude?: number | null;
}

export interface IPlan {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  title: string;
  scheduledAt: Date;
  timeLabel?: string | null;
  eventTitle?: string | null;
  location: PlanLocation;
  friendIds: Types.ObjectId[];
  friendNames: string[];
  notes?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePlanDto {
  title: string;
  scheduledAt: Date;
  timeLabel?: string | null;
  eventTitle?: string | null;
  location: PlanLocation;
  friendIds?: string[];
  friendNames?: string[];
  notes?: string | null;
}

export interface UpdatePlanDto {
  title?: string;
  scheduledAt?: Date;
  timeLabel?: string | null;
  eventTitle?: string | null;
  location?: PlanLocation;
  friendIds?: string[];
  friendNames?: string[];
  notes?: string | null;
}

export interface ListPlansQuery {
  from?: Date;
  to?: Date;
  limit?: number;
}

export interface PlanResponse {
  id: string;
  userId: string;
  title: string;
  scheduledAt: Date;
  timeLabel?: string | null;
  eventTitle?: string | null;
  location: PlanLocation;
  friendIds: string[];
  friendNames: string[];
  notes?: string | null;
  createdAt: Date;
  updatedAt: Date;
}
