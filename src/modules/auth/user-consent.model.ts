import { Schema, model } from "mongoose";
import type { IUserConsent } from "./user-consent.interface.js";
import { userConsentContexts } from "./user-consent.interface.js";

// Append-only legal-consent audit trail. Kept in its own collection so the
// `users` collection is never touched. One document is written per accepted
// "Create Account" submission. Policy versions are Option B snapshots — the
// admin-managed legal document `updatedAt` timestamps, stored as ISO strings.
const userConsentSchema = new Schema<IUserConsent>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    context: { type: String, enum: userConsentContexts, required: true, default: "signup" },
    termsVersion: { type: String, required: true, trim: true },
    privacyVersion: { type: String, required: true, trim: true },
    acceptedAt: { type: Date, required: true },
    locale: { type: String, required: true, trim: true, maxlength: 35 },
  },
  { timestamps: true, versionKey: false },
);

userConsentSchema.index({ userId: 1, createdAt: -1 });

export const UserConsentModel = model<IUserConsent>("UserConsent", userConsentSchema);

// Mirrors the ensureUserIndexes / ensureReportIndexes convention used elsewhere
// in this codebase (see src/server.ts) — there is no migration framework, so
// new indexes are rolled out via syncIndexes() at startup.
export const ensureUserConsentIndexes = async (): Promise<void> => {
  await UserConsentModel.syncIndexes();
};
