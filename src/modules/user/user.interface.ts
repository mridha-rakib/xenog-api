import type { Types } from "mongoose";

export interface IUser {
  _id: Types.ObjectId;
  name: string;
  email: string;
  role: "user" | "admin";
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateUserDto {
  name: string;
  email: string;
  role?: "user" | "admin";
}

export interface UpdateUserDto {
  name?: string;
  role?: "user" | "admin";
  isActive?: boolean;
}
