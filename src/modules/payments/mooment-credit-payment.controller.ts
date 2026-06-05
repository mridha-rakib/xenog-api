import type { Request, Response } from "express";
import httpStatus from "http-status";
import { ApiResponse } from "../../core/http/api-response.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { MoomentCreditPaymentService } from "./mooment-credit-payment.service.js";

export class MoomentCreditPaymentController {
  public constructor(private readonly service = new MoomentCreditPaymentService()) {}

  public getCheckoutQuote = async (req: Request, res: Response): Promise<void> => {
    const { packageId } = req.params as { packageId: string };
    const checkout = await this.service.getCheckoutQuote(packageId);

    ApiResponse.success(res, {
      message: "Mooment credit checkout retrieved",
      data: {
        checkout,
      },
    });
  };

  public purchaseCredits = async (req: Request, res: Response): Promise<void> => {
    const result = await this.service.purchaseCredits(req.authUser as AuthUser, req.body);

    ApiResponse.success(res, {
      statusCode: httpStatus.CREATED,
      message: "Mooment credits purchased",
      data: result,
    });
  };

  public getWallet = async (req: Request, res: Response): Promise<void> => {
    const wallet = await this.service.getWallet(req.authUser as AuthUser);

    ApiResponse.success(res, {
      message: "Mooment credit wallet retrieved",
      data: {
        wallet,
      },
    });
  };
}
