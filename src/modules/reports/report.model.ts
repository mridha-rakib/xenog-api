import { model, Schema } from "mongoose";
import type { IReport } from "./report.interface.js";
import { reportActions, reportContentMediaTypes, reportStatuses, reportTargetTypes } from "./report.interface.js";

const reportSchema = new Schema<IReport>(
  {
    reporterUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    reportedUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    targetType: { type: String, enum: reportTargetTypes, required: true, index: true },
    targetId: { type: Schema.Types.ObjectId, required: true, index: true },
    reason: { type: String, required: true, trim: true, maxlength: 160 },
    details: { type: String, trim: true, maxlength: 2000, default: null },
    status: { type: String, enum: reportStatuses, required: true, default: "pending", index: true },
    resolutionAction: { type: String, enum: reportActions, default: null },
    reporterName: { type: String, required: true, trim: true, maxlength: 120 },
    reporterEmail: { type: String, required: true, lowercase: true, trim: true },
    reporterAvatarKey: { type: String, trim: true, default: null },
    reportedUserName: { type: String, required: true, trim: true, maxlength: 120 },
    reportedUserEmail: { type: String, required: true, lowercase: true, trim: true },
    reportedUserAvatarKey: { type: String, trim: true, default: null },
    contentTitle: { type: String, trim: true, maxlength: 300, default: null },
    contentDescription: { type: String, trim: true, maxlength: 5000, default: null },
    contentImageKey: { type: String, trim: true, default: null },
    contentImageUrl: { type: String, trim: true, default: null },
    contentMediaType: { type: String, enum: reportContentMediaTypes, default: null },
    resolvedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

reportSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
reportSchema.index({ reporterName: "text", reporterEmail: "text", reportedUserName: "text", reportedUserEmail: "text" });

// One report per (reporter, target) for Post/Event only — approved product
// requirement. Scoped with a partial filter rather than a blanket unique
// index so existing User/Room report semantics (multiple reports allowed)
// are left untouched. Enforced at the DB layer so concurrent duplicate
// submissions cannot both succeed (see ReportRepository.createUnique).
reportSchema.index(
  { reporterUserId: 1, targetType: 1, targetId: 1 },
  {
    unique: true,
    partialFilterExpression: { targetType: { $in: ["post", "event"] } },
    name: "reporter_target_unique_post_event",
  },
);

export const ReportModel = model<IReport>("Report", reportSchema);

// Mirrors the ensureUserIndexes / ensureTicketUsageIndexes convention used
// elsewhere in this codebase (see src/server.ts) — there is no migration
// framework, so new indexes are rolled out via syncIndexes() at startup.
export const ensureReportIndexes = async (): Promise<void> => {
  await ReportModel.syncIndexes();
};
