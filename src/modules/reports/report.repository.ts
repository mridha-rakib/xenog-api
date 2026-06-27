import type { FilterQuery } from "mongoose";
import { ReportModel } from "./report.model.js";
import type { IReport, ListReportsQuery, ReportAction } from "./report.interface.js";

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class ReportRepository {
  public async create(payload: Record<string, unknown>): Promise<IReport> {
    return ReportModel.create(payload);
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
