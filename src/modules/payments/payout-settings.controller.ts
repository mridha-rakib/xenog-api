import type { Request, Response } from "express";
import { ApiResponse } from "../../core/http/api-response.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { PayoutSettingsService } from "./payout-settings.service.js";

export class PayoutSettingsController {
  public constructor(private readonly service = new PayoutSettingsService()) {}

  public getPayoutSettings = async (req: Request, res: Response): Promise<void> => {
    const settings = await this.service.getPayoutSettings(req.authUser as AuthUser);

    ApiResponse.success(res, {
      message: "Payout settings retrieved",
      data: { settings },
    });
  };

  public updatePayoutSettings = async (req: Request, res: Response): Promise<void> => {
    const settings = await this.service.updatePayoutSettings(req.authUser as AuthUser, req.body);

    ApiResponse.success(res, {
      message: "Payout settings updated",
      data: { settings },
    });
  };
}
