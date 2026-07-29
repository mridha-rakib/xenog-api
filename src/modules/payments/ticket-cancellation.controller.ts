import type { Request, Response } from "express";
import httpStatus from "http-status";
import { ApiResponse } from "../../core/http/api-response.js";
import type { AuthUser } from "../auth/auth.interface.js";
import type { ListAdminTicketCancellationsQuery } from "./ticket-cancellation.interface.js";
import { TicketCancellationService } from "./ticket-cancellation.service.js";

export class TicketCancellationController {
  public constructor(private readonly service = new TicketCancellationService()) {}

  public cancelTicketPass = async (req: Request, res: Response): Promise<void> => {
    const cancellation = await this.service.cancelTicketPass(req.authUser as AuthUser, req.body);

    ApiResponse.success(res, {
      statusCode: httpStatus.ACCEPTED,
      message: "Ticket cancellation accepted",
      data: { cancellation },
    });
  };

  public listCancellations = async (req: Request, res: Response): Promise<void> => {
    const result = await this.service.listAdminCancellations(req.query as ListAdminTicketCancellationsQuery);

    ApiResponse.success(res, {
      message: "Ticket cancellations retrieved",
      data: { cancellations: result.cancellations },
      meta: { pagination: result.pagination },
    });
  };

  public getCancellation = async (req: Request, res: Response): Promise<void> => {
    const cancellation = await this.service.getAdminCancellation(req.params.cancellationId as string);

    ApiResponse.success(res, {
      message: "Ticket cancellation retrieved",
      data: { cancellation },
    });
  };

  public retryCancellation = async (req: Request, res: Response): Promise<void> => {
    const cancellation = await this.service.retryCancellation(
      req.params.cancellationId as string,
      (req.authUser as AuthUser).id,
    );

    ApiResponse.success(res, {
      message: "Ticket cancellation refund retry queued",
      data: { cancellation },
    });
  };

  public reconcileCancellation = async (req: Request, res: Response): Promise<void> => {
    const cancellation = await this.service.reconcileCancellation(
      req.params.cancellationId as string,
      (req.authUser as AuthUser).id,
    );

    ApiResponse.success(res, {
      message: "Ticket cancellation refund reconciled",
      data: { cancellation },
    });
  };
}
