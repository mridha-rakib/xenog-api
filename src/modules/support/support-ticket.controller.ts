import type { Request, Response } from "express";
import httpStatus from "http-status";
import { ApiResponse } from "../../core/http/api-response.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { SupportTicketService } from "./support-ticket.service.js";
import type { ListSupportTicketsQuery } from "./support-ticket.interface.js";

export class SupportTicketController {
  public constructor(private readonly supportTicketService = new SupportTicketService()) {}

  public createTicket = async (req: Request, res: Response): Promise<void> => {
    const ticket = await this.supportTicketService.createTicket(req.body, req.authUser as AuthUser);

    ApiResponse.success(res, {
      statusCode: httpStatus.CREATED,
      message: "Support ticket created",
      data: {
        ticket,
      },
    });
  };

  public listTickets = async (req: Request, res: Response): Promise<void> => {
    const result = await this.supportTicketService.listTickets(req.query as unknown as ListSupportTicketsQuery);

    ApiResponse.success(res, {
      message: "Support tickets retrieved",
      data: {
        tickets: result.tickets,
      },
      meta: {
        pagination: result.pagination,
      },
    });
  };

  public getTicket = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string };
    const ticket = await this.supportTicketService.getTicket(id);

    ApiResponse.success(res, {
      message: "Support ticket retrieved",
      data: {
        ticket,
      },
    });
  };

  public updateStatus = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string };
    const ticket = await this.supportTicketService.updateTicketStatus(
      id,
      req.body,
      req.authUser as AuthUser,
    );

    ApiResponse.success(res, {
      message: "Support ticket status updated",
      data: {
        ticket,
      },
    });
  };

  public createMessage = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string };
    const ticket = await this.supportTicketService.createAdminMessage(
      id,
      req.body,
      req.authUser as AuthUser,
    );

    ApiResponse.success(res, {
      statusCode: httpStatus.CREATED,
      message: "Support message sent",
      data: {
        ticket,
      },
    });
  };
}
