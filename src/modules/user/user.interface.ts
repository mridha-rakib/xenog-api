import type { Types } from "mongoose";

export const payoutPreferences = ["manual", "weekly", "monthly"] as const;
export type PayoutPreference = (typeof payoutPreferences)[number];

export const withdrawalMethods = ["bank_transfer", "instant_debit_card"] as const;
export type WithdrawalMethod = (typeof withdrawalMethods)[number];

export interface IBusinessProfileSettings {
  payoutPreference: PayoutPreference;
  withdrawalMethod: WithdrawalMethod;
}

export interface IUser {
  _id: Types.ObjectId;
  name: string;
  username?: string;
  email: string;
  contact?: string | null;
  passwordHash?: string;
  passwordChangedAt?: Date | null;
  accountType: "personal" | "business";
  avatarKey?: string | null;
  gender?: string | null;
  age?: number | null;
  bio?: string | null;
  address?: string | null;
  businessDocumentKey?: string | null;
  businessProfile?: IBusinessProfileSettings | null;
  currentLocationSharingEnabled?: boolean;
  currentLocation?: UserCurrentLocation | null;
  notificationsEnabled?: boolean;
  role: "user" | "admin";
  isActive: boolean;
  emailVerified: boolean;
  deletedAt?: Date | null;
  emailVerificationCodeHash?: string;
  emailVerificationExpiresAt?: Date;
  passwordResetCodeHash?: string;
  passwordResetExpiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface IUserFollow {
  _id: Types.ObjectId;
  followerId: Types.ObjectId;
  followingId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserCurrentLocation {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  updatedAt?: Date;
}

export interface CreateUserDto {
  name: string;
  username?: string;
  email: string;
  contact?: string | null;
  password?: string;
  accountType?: "personal" | "business";
  avatarKey?: string | null;
  gender?: string | null;
  age?: number | null;
  bio?: string | null;
  address?: string | null;
  businessDocumentKey?: string | null;
  currentLocationSharingEnabled?: boolean;
  currentLocation?: UserCurrentLocation | null;
  notificationsEnabled?: boolean;
  role?: "user" | "admin";
}

export interface UpdateUserDto {
  name?: string;
  username?: string;
  email?: string;
  contact?: string | null;
  accountType?: "personal" | "business";
  avatarKey?: string | null;
  gender?: string | null;
  age?: number | null;
  bio?: string | null;
  address?: string | null;
  businessDocumentKey?: string | null;
  businessProfile?: IBusinessProfileSettings | null;
  currentLocationSharingEnabled?: boolean;
  currentLocation?: UserCurrentLocation | null;
  notificationsEnabled?: boolean;
  role?: "user" | "admin";
  isActive?: boolean;
  emailVerified?: boolean;
}

export interface AdminManagedUserResponse {
  id: string;
  name: string;
  username?: string;
  email: string;
  contact?: string | null;
  accountType: "personal" | "business";
  avatarKey?: string | null;
  avatarUrl?: string | null;
  gender?: string | null;
  age?: number | null;
  bio?: string | null;
  address?: string | null;
  businessDocumentKey?: string | null;
  role: "user" | "admin";
  isActive: boolean;
  emailVerified: boolean;
  isDeleted: boolean;
  totalEvents: number;
  completedEvents: number;
  cancelledEvents: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminUserStatsResponse {
  total: number;
  active: number;
  suspended: number;
  business: number;
}

export interface SuggestedUserResponse {
  id: string;
  name: string;
  username?: string;
  avatarKey?: string | null;
  avatarUrl?: string | null;
  isFollowing: boolean;
}

export interface FriendUserResponse {
  id: string;
  name: string;
  username?: string;
  avatarKey?: string | null;
  avatarUrl?: string | null;
}

export interface IUserBlock {
  _id: Types.ObjectId;
  blockerId: Types.ObjectId;
  blockedId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface FollowStatusResponse {
  userId: string;
  isFollowing: boolean;
}

export interface BlockStatusResponse {
  userId: string;
  isBlocked: boolean;
}

export interface UserProfileStatsResponse {
  reviews: number;
  followers: number;
  following: number;
}

export interface ProfileFollowUserResponse {
  id: string;
  name: string;
  username?: string;
  avatarKey?: string | null;
  avatarUrl?: string | null;
  isFollowing: boolean;
}

export interface UserReviewResponse {
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
  createdAt: Date;
}

export interface UserResponse {
  id: string;
  name: string;
  username?: string;
  email?: string;
  accountType: "personal" | "business";
  avatarKey?: string | null;
  avatarUrl?: string | null;
  bio?: string | null;
  isFollowing?: boolean;
}
