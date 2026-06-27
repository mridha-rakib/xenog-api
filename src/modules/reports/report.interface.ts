import type { Types } from "mongoose";

export const reportTargetTypes = ["post", "event", "user", "room"] as const;
export type ReportTargetType = (typeof reportTargetTypes)[number];
export const reportStatuses = ["pending", "resolved", "dismissed"] as const;
export type ReportStatus = (typeof reportStatuses)[number];
export const reportActions = ["warn", "remove_content", "suspend_user", "dismiss"] as const;
export type ReportAction = (typeof reportActions)[number];

export interface IReport {
  _id: Types.ObjectId;
  reporterUserId: Types.ObjectId;
  reportedUserId: Types.ObjectId;
  targetType: ReportTargetType;
  targetId: Types.ObjectId;
  reason: string;
  details?: string | null;
  status: ReportStatus;
  resolutionAction?: ReportAction | null;
  reporterName: string;
  reporterEmail: string;
  reporterAvatarKey?: string | null;
  reportedUserName: string;
  reportedUserEmail: string;
  reportedUserAvatarKey?: string | null;
  contentTitle?: string | null;
  contentDescription?: string | null;
  contentImageKey?: string | null;
  contentImageUrl?: string | null;
  resolvedBy?: Types.ObjectId | null;
  resolvedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateReportDto {
  reportedUserId: string;
  targetType: ReportTargetType;
  targetId: string;
  reason: string;
  details?: string | null;
}

export interface ListReportsQuery {
  page: number;
  limit: number;
  search?: string;
  status?: ReportStatus;
  type?: ReportTargetType;
}

export interface ReportUserResponse {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string | null;
}

export interface AdminReportResponse {
  id: string;
  reporter: ReportUserResponse;
  reportedUser: ReportUserResponse;
  targetType: ReportTargetType;
  targetId: string;
  reason: string;
  details?: string | null;
  status: ReportStatus;
  resolutionAction?: ReportAction | null;
  content: {
    title?: string | null;
    description?: string | null;
    imageUrl?: string | null;
  };
  createdAt: string;
  updatedAt: string;
}
