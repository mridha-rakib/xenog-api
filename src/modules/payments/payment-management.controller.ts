import type { Request, Response } from "express";
import { ApiResponse } from "../../core/http/api-response.js";
import { PaymentManagementService } from "./payment-management.service.js";
import type { PaymentManagementQuery } from "./payment-management.interface.js";

export class PaymentManagementController {
  public constructor(private readonly service = new PaymentManagementService()) {}

  public list = async (req: Request, res: Response): Promise<void> => {
    const result = await this.service.list(req.query as PaymentManagementQuery);

    ApiResponse.success(res, {
      message: "Payments retrieved",
      data: result,
    });
  };
}
