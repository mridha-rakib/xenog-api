import type { Request, Response } from "express";
import { ApiResponse } from "../../core/http/api-response.js";
import { DashboardService } from "./dashboard.service.js";
import type { DashboardOverviewQuery } from "./dashboard.interface.js";

export class DashboardController {
  public constructor(private readonly service = new DashboardService()) {}

  public getOverview = async (req: Request, res: Response): Promise<void> => {
    const overview = await this.service.getOverview(req.query as DashboardOverviewQuery);

    ApiResponse.success(res, {
      message: "Dashboard overview retrieved",
      data: overview,
    });
  };
}
