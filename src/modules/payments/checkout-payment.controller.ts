import type { Request, Response } from "express";
import httpStatus from "http-status";
import { ApiResponse } from "../../core/http/api-response.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { CheckoutPaymentService } from "./checkout-payment.service.js";

export class CheckoutPaymentController {
  public constructor(private readonly service = new CheckoutPaymentService()) {}

  public createIntent = async (req: Request, res: Response): Promise<void> => {
    const checkout = await this.service.createIntent(req.authUser as AuthUser, req.body);

    ApiResponse.success(res, {
      statusCode: httpStatus.CREATED,
      message: "Checkout payment intent created",
      data: {
        checkout,
      },
    });
  };

  public confirmOrder = async (req: Request, res: Response): Promise<void> => {
    const { orderId } = req.params as { orderId: string };
    const order = await this.service.confirmOrder(req.authUser as AuthUser, orderId);

    ApiResponse.success(res, {
      message: "Checkout payment confirmed",
      data: {
        order,
      },
    });
  };

  public refundOrder = async (req: Request, res: Response): Promise<void> => {
    const { orderId } = req.params as { orderId: string };
    const order = await this.service.refundUserOrder(req.authUser as AuthUser, orderId);

    ApiResponse.success(res, {
      message: "Order refunded successfully",
      data: {
        order,
      },
    });
  };

  public cancelOrder = async (req: Request, res: Response): Promise<void> => {
    const { orderId } = req.params as { orderId: string };
    const order = await this.service.cancelOrder(req.authUser as AuthUser, orderId);

    ApiResponse.success(res, {
      message: "Order cancelled successfully",
      data: {
        order,
      },
    });
  };

  public getMyTicketPurchaseCounts = async (req: Request, res: Response): Promise<void> => {
    const { eventId } = req.params as { eventId: string };
    const counts = await this.service.getMyTicketPurchaseCounts(req.authUser as AuthUser, eventId);

    ApiResponse.success(res, {
      message: "Ticket purchase counts retrieved",
      data: { counts },
    });
  };

  public getEventTicketStats = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string };
    const result = await this.service.getEventTicketStats(req.authUser as AuthUser, id);

    ApiResponse.success(res, {
      message: "Event ticket stats retrieved",
      data: result,
    });
  };

  public getEventTicketStatItems = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string };
    const result = await this.service.getEventTicketStatItems(req.authUser as AuthUser, id, req.query);

    ApiResponse.success(res, {
      message: "Event ticket stat items retrieved",
      data: { tickets: result.tickets },
      meta: result.pagination ? { pagination: result.pagination } : undefined,
    });
  };

  public getEventAttendanceSummary = async (req: Request, res: Response): Promise<void> => {
    const { eventId } = req.params as { eventId: string };
    const summary = await this.service.getEventAttendanceSummary(req.authUser as AuthUser, eventId);

    ApiResponse.success(res, {
      message: "Event attendance summary retrieved",
      data: {
        summary,
      },
    });
  };

  public getMyTicketWallet = async (req: Request, res: Response): Promise<void> => {
    const tickets = await this.service.getMyTicketWallet(req.authUser as AuthUser);

    ApiResponse.success(res, {
      message: "Ticket wallet retrieved",
      data: { tickets },
    });
  };

  public shareTicket = async (req: Request, res: Response): Promise<void> => {
    const share = await this.service.shareTicket(req.authUser as AuthUser, req.body);

    ApiResponse.success(res, {
      statusCode: httpStatus.CREATED,
      message: "Ticket shared",
      data: { share },
    });
  };

  public cancelTicketShare = async (req: Request, res: Response): Promise<void> => {
    const { shareId } = req.params as { shareId: string };
    const share = await this.service.cancelTicketShare(req.authUser as AuthUser, shareId);

    ApiResponse.success(res, {
      message: "Ticket share cancelled",
      data: { share },
    });
  };

  public scanTicket = async (req: Request, res: Response): Promise<void> => {
    const ticket = await this.service.scanTicket(req.authUser as AuthUser, req.body);

    ApiResponse.success(res, {
      message: "Ticket scanned successfully",
      data: { ticket },
    });
  };

  public stripeWebhook = async (req: Request, res: Response): Promise<void> => {
    await this.service.handleStripeWebhook(req.header("stripe-signature"), req.rawBody);

    res.status(httpStatus.OK).json({ received: true });
  };
}
