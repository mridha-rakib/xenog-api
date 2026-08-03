import type { Request, Response } from "express";
import { ApiResponse } from "../../core/http/api-response.js";
import { AnalyticsService } from "./analytics.service.js";
import type { AnalyticsOverviewQuery } from "./analytics.interface.js";

export class AnalyticsController {
  public constructor(private readonly service = new AnalyticsService()) {}

  public getOverview = async (req: Request, res: Response): Promise<void> => {
    const overview = await this.service.getOverview(req.query as AnalyticsOverviewQuery);

    ApiResponse.success(res, {
      message: "Analytics overview retrieved",
      data: overview,
    });
  };
}
