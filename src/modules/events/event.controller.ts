import type { Request, Response } from "express";
import httpStatus from "http-status";
import { ApiResponse } from "../../core/http/api-response.js";
import type { AuthUser } from "../auth/auth.interface.js";
import type {
  CreateEventTicketDto,
  EventMapQuery,
  PublishEventDto,
  SaveEventDraftDto,
  UpdateEventTicketDto,
} from "./event.interface.js";
import { EventService } from "./event.service.js";

export class EventController {
  public constructor(private readonly eventService = new EventService()) {}

  public saveDraft = async (req: Request, res: Response): Promise<void> => {
    const event = await this.eventService.saveDraft(req.authUser as AuthUser, req.body as SaveEventDraftDto);

    ApiResponse.success(res, {
      statusCode: httpStatus.CREATED,
      message: "Event draft saved",
      data: {
        event,
      },
    });
  };

  public updateDraft = async (req: Request, res: Response): Promise<void> => {
    const event = await this.eventService.saveDraft(
      req.authUser as AuthUser,
      req.body as SaveEventDraftDto,
      req.params.id as string,
    );

    ApiResponse.success(res, {
      message: "Event draft saved",
      data: {
        event,
      },
    });
  };

  public publish = async (req: Request, res: Response): Promise<void> => {
    const event = await this.eventService.publish(req.authUser as AuthUser, req.body as PublishEventDto);

    ApiResponse.success(res, {
      statusCode: httpStatus.CREATED,
      message: "Event published",
      data: {
        event,
      },
    });
  };

  public publishDraft = async (req: Request, res: Response): Promise<void> => {
    const event = await this.eventService.publish(
      req.authUser as AuthUser,
      req.body as PublishEventDto,
      req.params.id as string,
    );

    ApiResponse.success(res, {
      message: "Event published",
      data: {
        event,
      },
    });
  };

  public createDraftTicket = async (req: Request, res: Response): Promise<void> => {
    const event = await this.eventService.createDraftTicket(
      req.authUser as AuthUser,
      req.params.id as string,
      req.body as CreateEventTicketDto,
    );

    ApiResponse.success(res, {
      statusCode: httpStatus.CREATED,
      message: "Event draft ticket created",
      data: {
        event,
      },
    });
  };

  public updateDraftTicket = async (req: Request, res: Response): Promise<void> => {
    const event = await this.eventService.updateDraftTicket(
      req.authUser as AuthUser,
      req.params.id as string,
      req.params.ticketId as string,
      req.body as UpdateEventTicketDto,
    );

    ApiResponse.success(res, {
      message: "Event draft ticket updated",
      data: {
        event,
      },
    });
  };

  public deleteDraftTicket = async (req: Request, res: Response): Promise<void> => {
    const event = await this.eventService.deleteDraftTicket(
      req.authUser as AuthUser,
      req.params.id as string,
      req.params.ticketId as string,
    );

    ApiResponse.success(res, {
      message: "Event draft ticket deleted",
      data: {
        event,
      },
    });
  };

  public listMyEvents = async (req: Request, res: Response): Promise<void> => {
    const events = await this.eventService.listMyEvents(req.authUser as AuthUser);

    ApiResponse.success(res, {
      message: "Events retrieved",
      data: {
        events,
      },
    });
  };

  public listMyProfileEvents = async (req: Request, res: Response): Promise<void> => {
    const events = await this.eventService.listMyProfileEvents(req.authUser as AuthUser);

    ApiResponse.success(res, {
      message: "Profile events retrieved",
      data: {
        events,
      },
    });
  };

  public listMapEvents = async (req: Request, res: Response): Promise<void> => {
    const events = await this.eventService.listMapEvents(req.query as unknown as EventMapQuery);

    ApiResponse.success(res, {
      message: "Map events retrieved",
      data: {
        events,
      },
    });
  };
}
