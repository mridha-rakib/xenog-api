import { Schema, model } from "mongoose";

const fcmTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    token: { type: String, required: true, trim: true },
    platform: { type: String, enum: ["android", "ios"], default: "android" },
    deviceId: { type: String, trim: true, default: null },
  },
  { timestamps: true, versionKey: false },
);

fcmTokenSchema.index({ userId: 1, token: 1 }, { unique: true });
fcmTokenSchema.index({ token: 1 });

export const FcmTokenModel = model("FcmToken", fcmTokenSchema);
