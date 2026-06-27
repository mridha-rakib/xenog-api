import type { Request, Response } from "express";
import httpStatus from "http-status";
import { ApiResponse } from "../../core/http/api-response.js";
import type { AuthUser } from "../auth/auth.interface.js";
import type { CreateReportDto, ListReportsQuery, ReportAction } from "./report.interface.js";
import { ReportService } from "./report.service.js";

export class ReportController {
  public constructor(private readonly reportService = new ReportService()) {}

  public create = async (req: Request, res: Response): Promise<void> => {
    const report = await this.reportService.create(req.body as CreateReportDto, req.authUser as AuthUser);
    ApiResponse.success(res, { statusCode: httpStatus.CREATED, message: "Report submitted", data: { report } });
  };

  public list = async (req: Request, res: Response): Promise<void> => {
    const result = await this.reportService.list(req.query as unknown as ListReportsQuery);
    ApiResponse.success(res, { message: "Reports retrieved", data: { reports: result.reports }, meta: { pagination: result.pagination } });
  };

  public get = async (req: Request, res: Response): Promise<void> => {
    const result = await this.reportService.getDetail((req.params as { id: string }).id);
    ApiResponse.success(res, { message: "Report retrieved", data: result });
  };

  public action = async (req: Request, res: Response): Promise<void> => {
    const report = await this.reportService.takeAction(
      (req.params as { id: string }).id,
      (req.body as { action: ReportAction }).action,
      req.authUser as AuthUser,
    );
    ApiResponse.success(res, { message: "Report action completed", data: { report } });
  };

  public delete = async (req: Request, res: Response): Promise<void> => {
    await this.reportService.delete((req.params as { id: string }).id);
    ApiResponse.success(res, { message: "Report deleted" });
  };
}
