import type { Request, Response } from "express";
import { ApiResponse } from "../../core/http/api-response.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { EventCancellationRefundService } from "./event-cancellation-refund.service.js";

export class EventCancellationRefundController {
  public constructor(private readonly service = new EventCancellationRefundService()) {}

  public listBatches = async (_req: Request, res: Response): Promise<void> => {
    const batches = await this.service.listBatches();

    ApiResponse.success(res, {
      message: "Refund batches retrieved",
      data: { batches },
    });
  };

  public getBatchDetails = async (req: Request, res: Response): Promise<void> => {
    const result = await this.service.getBatchDetails(req.params.batchId as string);

    ApiResponse.success(res, {
      message: "Refund batch retrieved",
      data: result,
    });
  };

  public retryBatch = async (req: Request, res: Response): Promise<void> => {
    const batch = await this.service.retryBatch(req.params.batchId as string, (req.authUser as AuthUser).id);

    ApiResponse.success(res, {
      message: "Refund batch retry queued",
      data: { batch },
    });
  };

  public reconcileBatch = async (req: Request, res: Response): Promise<void> => {
    const batch = await this.service.reconcileBatch(req.params.batchId as string, (req.authUser as AuthUser).id);

    ApiResponse.success(res, {
      message: "Refund batch reconciled",
      data: { batch },
    });
  };

  public resumeBatch = async (req: Request, res: Response): Promise<void> => {
    const batch = await this.service.resumeBatch(req.params.batchId as string, (req.authUser as AuthUser).id);

    ApiResponse.success(res, {
      message: "Refund batch resumed",
      data: { batch },
    });
  };

  public retryRefund = async (req: Request, res: Response): Promise<void> => {
    const refund = await this.service.retryRefundItem(req.params.refundId as string, (req.authUser as AuthUser).id);

    ApiResponse.success(res, {
      message: "Refund retry queued",
      data: { refund },
    });
  };

  public reconcileRefund = async (req: Request, res: Response): Promise<void> => {
    const refund = await this.service.reconcileRefundItem(req.params.refundId as string, (req.authUser as AuthUser).id);

    ApiResponse.success(res, {
      message: "Refund reconciled",
      data: { refund },
    });
  };
}
