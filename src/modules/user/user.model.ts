import { Schema, model } from "mongoose";
import type { IUser } from "./user.interface.js";

const userSchema = new Schema<IUser>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
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

        return record;
      },
    },
  },
);

export const UserModel = model<IUser>("User", userSchema);
