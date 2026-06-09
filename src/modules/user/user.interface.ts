import type { Types } from "mongoose";

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
  currentLocationSharingEnabled?: boolean;
  currentLocation?: UserCurrentLocation | null;
  notificationsEnabled?: boolean;
  role: "user" | "admin";
  isActive: boolean;
  emailVerified: boolean;
  emailVerificationCodeHash?: string;
  emailVerificationExpiresAt?: Date;
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
  currentLocationSharingEnabled?: boolean;
  currentLocation?: UserCurrentLocation | null;
  notificationsEnabled?: boolean;
  role?: "user" | "admin";
  isActive?: boolean;
  emailVerified?: boolean;
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

export interface FollowStatusResponse {
  userId: string;
  isFollowing: boolean;
}
