import { Schema, model } from "mongoose";
import type { IUser } from "./user.interface.js";
import { payoutPreferences, withdrawalMethods } from "./user.interface.js";

const currentLocationSchema = new Schema(
  {
    latitude: {
      type: Number,
      min: -90,
      max: 90,
      required: true,
    },
    longitude: {
      type: Number,
      min: -180,
      max: 180,
      required: true,
    },
    accuracy: {
      type: Number,
      min: 0,
      default: null,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false },
);

const userSchema = new Schema<IUser>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    username: {
      type: String,
      unique: true,
      sparse: true,
      lowercase: true,
      trim: true,
      maxlength: 40,
      index: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    contact: {
      type: String,
      trim: true,
      maxlength: 40,
      default: null,
    },
    passwordHash: {
      type: String,
      select: false,
    },
    passwordChangedAt: {
      type: Date,
      default: null,
    },
    accountType: {
      type: String,
      enum: ["personal", "business"],
      default: "personal",
    },
    avatarKey: {
      type: String,
      trim: true,
      default: null,
    },
    gender: {
      type: String,
      trim: true,
      maxlength: 40,
      default: null,
    },
    age: {
      type: Number,
      min: 0,
      max: 130,
      default: null,
    },
    bio: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },
    address: {
      type: String,
      trim: true,
      maxlength: 240,
      default: null,
    },
    businessDocumentKey: {
      type: String,
      trim: true,
      default: null,
    },
    businessProfile: {
      type: new Schema(
        {
          payoutPreference: { type: String, enum: payoutPreferences, default: "manual" },
          withdrawalMethod: { type: String, enum: withdrawalMethods, default: "bank_transfer" },
        },
        { _id: false },
      ),
      default: null,
    },
    currentLocationSharingEnabled: {
      type: Boolean,
      default: false,
    },
    currentLocation: {
      type: currentLocationSchema,
      default: null,
    },
    notificationsEnabled: {
      type: Boolean,
      default: true,
    },
    role: {
      type: String,
      enum: ["user", "admin"],
      default: "user",
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    emailVerified: {
      type: Boolean,
      default: false,
      index: true,
    },
    deletedAt: {
      type: Date,
      default: null,
      index: true,
    },
    emailVerificationCodeHash: {
      type: String,
      select: false,
    },
    emailVerificationExpiresAt: {
      type: Date,
      select: false,
    },
    passwordResetCodeHash: {
      type: String,
      select: false,
    },
    passwordResetExpiresAt: {
      type: Date,
      select: false,
    },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        const record = ret as Record<string, unknown> & {
          _id?: { toString: () => string };
          id?: string;
        };

        record.id = record._id?.toString();
        delete record._id;
        delete record.passwordHash;
        delete record.emailVerificationCodeHash;
        delete record.emailVerificationExpiresAt;
        delete record.passwordResetCodeHash;
        delete record.passwordResetExpiresAt;

        return record;
      },
    },
  },
);

export const UserModel = model<IUser>("User", userSchema);
