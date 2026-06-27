import type { Request, Response } from "express";
import httpStatus from "http-status";
import { ApiResponse } from "../../core/http/api-response.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { CreatorEarningService } from "./creator-earning.service.js";

export class CreatorEarningController {
  public constructor(private readonly service = new CreatorEarningService()) {}

  public getMyEarnings = async (req: Request, res: Response): Promise<void> => {
    const summary = await this.service.getMyEarnings(req.authUser as AuthUser);

    ApiResponse.success(res, {
      message: "Creator earnings retrieved",
      data: { summary },
    });
  };

  public requestWithdrawal = async (req: Request, res: Response): Promise<void> => {
    const payout = await this.service.requestWithdrawal(req.authUser as AuthUser, req.body);

    ApiResponse.success(res, {
      statusCode: httpStatus.CREATED,
      message: "Withdrawal request submitted",
      data: { payout },
    });
  };

  public getEarningsByEvent = async (req: Request, res: Response): Promise<void> => {
    const summary = await this.service.getEarningsByEvent(req.authUser as AuthUser, req.params.eventId as string);

    ApiResponse.success(res, {
      message: "Event earnings retrieved",
      data: { summary },
    });
  };

  public getMyPayouts = async (req: Request, res: Response): Promise<void> => {
    const payouts = await this.service.getMyPayouts(req.authUser as AuthUser);

    ApiResponse.success(res, {
      message: "Creator payouts retrieved",
      data: { payouts },
    });
  };
}
