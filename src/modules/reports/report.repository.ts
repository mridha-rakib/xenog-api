import type { FilterQuery } from "mongoose";
import { ReportModel } from "./report.model.js";
import type { IReport, ListReportsQuery, ReportAction, ReportTargetType } from "./report.interface.js";

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Mirrors the isDuplicateKeyError helper used elsewhere in this codebase
// (e.g. event-window.repository.ts, notification.repository.ts) for the
// Mongo E11000 unique-index violation code.
const isDuplicateKeyError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") {
    return false;
  }

  return (error as { code?: number }).code === 11000;
};

export type CreateReportResult =
  | { status: "created"; report: IReport }
  | { status: "duplicate" };

export class ReportRepository {
  public async create(payload: Record<string, unknown>): Promise<IReport> {
    return ReportModel.create(payload);
  }

  // Race-safe: relies on the partial unique index on
  // (reporterUserId, targetType, targetId) for post/event targets (see
  // report.model.ts) rather than a check-then-insert, so two simultaneous
  // duplicate submissions cannot both succeed. Never throws the raw Mongo
  // E11000 error to callers.
  public async createUnique(payload: Record<string, unknown>): Promise<CreateReportResult> {
    try {
      const report = await ReportModel.create(payload);
      return { status: "created", report };
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        return { status: "duplicate" };
      }

      throw error;
    }
  }

  // Batched viewer-report-state lookup — one query for an entire page of
  // Feed/list targets, never one query per item. Mirrors the
  // findLikedMomentIds/findSavedMomentIds batching pattern used by
  // MomentService/EventService.
  public async findReportedTargetIds(
    reporterUserId: string,
    targetType: ReportTargetType,
    targetIds: string[],
  ): Promise<Set<string>> {
    if (targetIds.length === 0) {
      return new Set();
    }

    const ids = await ReportModel.distinct("targetId", {
      reporterUserId,
      targetType,
      targetId: { $in: targetIds },
    });

    return new Set(ids.map((id) => id.toString()));
  }

  public async hasReported(
    reporterUserId: string,
    targetType: ReportTargetType,
    targetId: string,
  ): Promise<boolean> {
    return Boolean(await ReportModel.exists({ reporterUserId, targetType, targetId }));
  }

  public async findById(id: string): Promise<IReport | null> {
    return ReportModel.findById(id);
  }

  public async findMany(query: ListReportsQuery): Promise<{ reports: IReport[]; total: number }> {
    const filter: FilterQuery<IReport> = {};
    if (query.status) filter.status = query.status;
    if (query.type) filter.targetType = query.type;
    if (query.search) {
      const regex = new RegExp(escapeRegExp(query.search), "i");
      filter.$or = [
        { reporterName: regex }, { reporterEmail: regex },
        { reportedUserName: regex }, { reportedUserEmail: regex },
      ];
    }
    const skip = (query.page - 1) * query.limit;
    const [reports, total] = await Promise.all([
      ReportModel.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(query.limit),
      ReportModel.countDocuments(filter),
    ]);
    return { reports, total };
  }

  public async findByTarget(type: string, targetId: string): Promise<IReport[]> {
    return ReportModel.find({ targetType: type, targetId }).sort({ createdAt: -1 });
  }

  public async resolve(id: string, action: ReportAction, adminId: string): Promise<IReport | null> {
    return ReportModel.findByIdAndUpdate(id, {
      $set: {
        status: action === "dismiss" ? "dismissed" : "resolved",
        resolutionAction: action,
        resolvedBy: adminId,
        resolvedAt: new Date(),
      },
    }, { new: true, runValidators: true });
  }

  public async delete(id: string): Promise<IReport | null> {
    return ReportModel.findByIdAndDelete(id);
  }
}
