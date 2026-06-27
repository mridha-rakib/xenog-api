import httpStatus from "http-status";
import { AppError } from "../../core/errors/app-error.js";
import { createPaginationMeta } from "../../core/utils/pagination.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { EventModel } from "../events/event.model.js";
import { LiveRoomModel } from "../live-rooms/live-room.model.js";
import { MomentModel } from "../moments/moment.model.js";
import { NotificationRepository } from "../notifications/notification.repository.js";
import { StorageService } from "../storage/storage.service.js";
import { UserRepository } from "../user/user.repository.js";
import type {
  AdminReportResponse,
  CreateReportDto,
  IReport,
  ListReportsQuery,
  ReportAction,
  ReportTargetType,
} from "./report.interface.js";
import { ReportRepository } from "./report.repository.js";

type TargetSnapshot = {
  ownerId: string;
  title?: string | null;
  description?: string | null;
  imageKey?: string | null;
  imageUrl?: string | null;
};

export class ReportService {
  public constructor(
    private readonly reportRepository = new ReportRepository(),
    private readonly userRepository = new UserRepository(),
    private readonly storageService = new StorageService(),
    private readonly notificationRepository = new NotificationRepository(),
  ) {}

  public async create(payload: CreateReportDto, reporter: AuthUser): Promise<AdminReportResponse> {
    if (reporter.id === payload.reportedUserId) {
      throw new AppError("You cannot report yourself", httpStatus.BAD_REQUEST);
    }

    const [reportedUser, target] = await Promise.all([
      this.userRepository.findById(payload.reportedUserId),
      this.getTargetSnapshot(payload.targetType, payload.targetId),
    ]);
    if (!reportedUser || reportedUser.role !== "user" || target.ownerId !== payload.reportedUserId) {
      throw new AppError("Reported content or user not found", httpStatus.NOT_FOUND);
    }

    const report = await this.reportRepository.create({
      reporterUserId: reporter.id,
      reportedUserId: reportedUser._id,
      targetType: payload.targetType,
      targetId: payload.targetId,
      reason: payload.reason,
      details: payload.details ?? null,
      status: "pending",
      resolutionAction: null,
      reporterName: reporter.name,
      reporterEmail: reporter.email,
      reporterAvatarKey: reporter.avatarKey ?? null,
      reportedUserName: reportedUser.name,
      reportedUserEmail: reportedUser.email,
      reportedUserAvatarKey: reportedUser.avatarKey ?? null,
      contentTitle: target.title ?? null,
      contentDescription: target.description ?? null,
      contentImageKey: target.imageKey ?? null,
      contentImageUrl: target.imageUrl ?? null,
      resolvedBy: null,
      resolvedAt: null,
    });

    return this.toResponse(report);
  }

  public async list(query: ListReportsQuery): Promise<{
    reports: AdminReportResponse[];
    pagination: ReturnType<typeof createPaginationMeta>;
  }> {
    const result = await this.reportRepository.findMany(query);
    return {
      reports: await Promise.all(result.reports.map((report) => this.toResponse(report))),
      pagination: createPaginationMeta(query.page, query.limit, result.total),
    };
  }

  public async getDetail(id: string): Promise<{
    report: AdminReportResponse;
    relatedReports: AdminReportResponse[];
  }> {
    const report = await this.getReport(id);
    const related = await this.reportRepository.findByTarget(report.targetType, report.targetId.toString());
    return {
      report: await this.toResponse(report),
      relatedReports: await Promise.all(related.map((item) => this.toResponse(item))),
    };
  }

  public async takeAction(id: string, action: ReportAction, admin: AuthUser): Promise<AdminReportResponse> {
    const report = await this.getReport(id);

    if (action === "remove_content") await this.removeContent(report);
    if (action === "warn") {
      await this.notificationRepository.create({
        recipientUserId: report.reportedUserId.toString(),
        type: "moderation_warning",
        actorUserId: admin.id,
        actorName: "Xenog Moderation",
        message: `Your ${report.targetType} was reported for: ${report.reason}`,
      });
    }
    if (action === "suspend_user") {
      const user = await this.userRepository.updateById(report.reportedUserId.toString(), { isActive: false });
      if (!user) throw new AppError("Reported user not found", httpStatus.NOT_FOUND);
    }

    const updated = await this.reportRepository.resolve(id, action, admin.id);
    if (!updated) throw new AppError("Report not found", httpStatus.NOT_FOUND);
    return this.toResponse(updated);
  }

  public async delete(id: string): Promise<void> {
    const report = await this.reportRepository.delete(id);
    if (!report) throw new AppError("Report not found", httpStatus.NOT_FOUND);
  }

  private async getReport(id: string): Promise<IReport> {
    const report = await this.reportRepository.findById(id);
    if (!report) throw new AppError("Report not found", httpStatus.NOT_FOUND);
    return report;
  }

  private async getTargetSnapshot(type: ReportTargetType, id: string): Promise<TargetSnapshot> {
    if (type === "post") {
      const post = await MomentModel.findById(id);
      if (!post) throw new AppError("Reported post not found", httpStatus.NOT_FOUND);
      const media = post.mediaItems[0];
      return { ownerId: post.userId.toString(), title: "Post", description: post.caption, imageKey: media?.storageKey, imageUrl: media?.url };
    }
    if (type === "event") {
      const event = await EventModel.findById(id);
      if (!event) throw new AppError("Reported event not found", httpStatus.NOT_FOUND);
      return { ownerId: event.userId.toString(), title: event.name, description: event.description, imageKey: event.bannerImageKey };
    }
    if (type === "room") {
      const room = await LiveRoomModel.findById(id);
      if (!room) throw new AppError("Reported room not found", httpStatus.NOT_FOUND);
      return { ownerId: room.hostUserId.toString(), title: room.title, description: "Live room" };
    }
    const user = await this.userRepository.findById(id);
    if (!user) throw new AppError("Reported user not found", httpStatus.NOT_FOUND);
    return { ownerId: user._id.toString(), title: user.name, description: user.bio, imageKey: user.avatarKey };
  }

  private async removeContent(report: IReport): Promise<void> {
    if (report.targetType === "post") {
      await MomentModel.findByIdAndDelete(report.targetId);
      return;
    }
    if (report.targetType === "event") {
      await EventModel.findByIdAndUpdate(report.targetId, {
        $set: { status: "cancelled", privacy: "private", cancelledAt: new Date() },
      });
      return;
    }
    if (report.targetType === "room") {
      await LiveRoomModel.findByIdAndUpdate(report.targetId, { $set: { status: "ended" } });
      return;
    }
    throw new AppError("This report does not reference removable content", httpStatus.BAD_REQUEST);
  }

  private async toResponse(report: IReport): Promise<AdminReportResponse> {
    const downloadUrl = async (key?: string | null): Promise<string | null> => key
      ? this.storageService.createDownloadUrl(key).then((value) => value.url).catch(() => null)
      : null;
    const [reporterAvatar, reportedAvatar, contentImage] = await Promise.all([
      downloadUrl(report.reporterAvatarKey),
      downloadUrl(report.reportedUserAvatarKey),
      downloadUrl(report.contentImageKey),
    ]);
    return {
      id: report._id.toString(),
      reporter: { id: report.reporterUserId.toString(), name: report.reporterName || "Deleted User", email: report.reporterEmail || "Unavailable", avatarUrl: reporterAvatar },
      reportedUser: { id: report.reportedUserId.toString(), name: report.reportedUserName || "Deleted User", email: report.reportedUserEmail || "Unavailable", avatarUrl: reportedAvatar },
      targetType: report.targetType,
      targetId: report.targetId.toString(),
      reason: report.reason,
      details: report.details ?? null,
      status: report.status,
      resolutionAction: report.resolutionAction ?? null,
      content: { title: report.contentTitle ?? null, description: report.contentDescription ?? null, imageUrl: contentImage ?? report.contentImageUrl ?? null },
      createdAt: report.createdAt.toISOString(),
      updatedAt: report.updatedAt.toISOString(),
    };
  }
}
