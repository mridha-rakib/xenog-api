import type { Request, Response } from "express";
import { ApiResponse } from "../../core/http/api-response.js";
import { HealthService } from "./health.service.js";

export class HealthController {
  public constructor(private readonly healthService = new HealthService()) {}

  public check = async (_req: Request, res: Response): Promise<void> => {
    const health = await this.healthService.check();

    ApiResponse.success(res, {
      message: "Service is healthy",
      data: health,
    });
  };
}
