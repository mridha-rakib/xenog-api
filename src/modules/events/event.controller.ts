import type { Request, Response } from "express";
import httpStatus from "http-status";
import { ApiResponse } from "../../core/http/api-response.js";
import type { AuthUser } from "../auth/auth.interface.js";
import type {
  CreateEventTicketDto,
  CreateEventRewardDto,
  EventMapQuery,
  NowModeQuery,
  PublishEventDto,
  SaveEventDraftDto,
  UpdateEventRewardDto,
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

  public updateEvent = async (req: Request, res: Response): Promise<void> => {
    const event = await this.eventService.updateEvent(
      req.authUser as AuthUser,
      req.params.id as string,
      req.body as SaveEventDraftDto,
    );

    ApiResponse.success(res, {
      message: "Event updated",
      data: {
        event,
      },
    });
  };

  public deleteEvent = async (req: Request, res: Response): Promise<void> => {
    const event = await this.eventService.deleteEvent(req.authUser as AuthUser, req.params.id as string);

    ApiResponse.success(res, {
      message: "Event deleted",
      data: {
        event,
      },
    });
  };

  public getEventTicket = async (req: Request, res: Response): Promise<void> => {
    const event = await this.eventService.getEventTicket(
      req.authUser as AuthUser,
      req.params.id as string,
      req.params.ticketId as string,
    );

    ApiResponse.success(res, {
      message: "Event ticket retrieved",
      data: {
        event,
      },
    });
  };

  public createEventTicket = async (req: Request, res: Response): Promise<void> => {
    const event = await this.eventService.createEventTicket(
      req.authUser as AuthUser,
      req.params.id as string,
      req.body as CreateEventTicketDto,
    );

    ApiResponse.success(res, {
      statusCode: httpStatus.CREATED,
      message: "Event ticket created",
      data: {
        event,
      },
    });
  };

  public updateEventTicket = async (req: Request, res: Response): Promise<void> => {
    const event = await this.eventService.updateEventTicket(
      req.authUser as AuthUser,
      req.params.id as string,
      req.params.ticketId as string,
      req.body as UpdateEventTicketDto,
    );

    ApiResponse.success(res, {
      message: "Event ticket updated",
      data: {
        event,
      },
    });
  };

  public deleteEventTicket = async (req: Request, res: Response): Promise<void> => {
    const event = await this.eventService.deleteEventTicket(
      req.authUser as AuthUser,
      req.params.id as string,
      req.params.ticketId as string,
    );

    ApiResponse.success(res, {
      message: "Event ticket deleted",
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

  public createEventReward = async (req: Request, res: Response): Promise<void> => {
    const event = await this.eventService.createEventReward(
      req.authUser as AuthUser,
      req.params.id as string,
      req.body as CreateEventRewardDto,
    );

    ApiResponse.success(res, {
      statusCode: httpStatus.CREATED,
      message: "Event reward created",
      data: {
        event,
      },
    });
  };

  public updateEventReward = async (req: Request, res: Response): Promise<void> => {
    const event = await this.eventService.updateEventReward(
      req.authUser as AuthUser,
      req.params.id as string,
      req.params.rewardId as string,
      req.body as UpdateEventRewardDto,
    );

    ApiResponse.success(res, {
      message: "Event reward updated",
      data: {
        event,
      },
    });
  };

  public deleteEventReward = async (req: Request, res: Response): Promise<void> => {
    const event = await this.eventService.deleteEventReward(
      req.authUser as AuthUser,
      req.params.id as string,
      req.params.rewardId as string,
    );

    ApiResponse.success(res, {
      message: "Event reward deleted",
      data: {
        event,
      },
    });
  };

  public createDraftReward = async (req: Request, res: Response): Promise<void> => {
    const event = await this.eventService.createDraftReward(
      req.authUser as AuthUser,
      req.params.id as string,
      req.body as CreateEventRewardDto,
    );

    ApiResponse.success(res, {
      statusCode: httpStatus.CREATED,
      message: "Event draft reward created",
      data: {
        event,
      },
    });
  };

  public updateDraftReward = async (req: Request, res: Response): Promise<void> => {
    const event = await this.eventService.updateDraftReward(
      req.authUser as AuthUser,
      req.params.id as string,
      req.params.rewardId as string,
      req.body as UpdateEventRewardDto,
    );

    ApiResponse.success(res, {
      message: "Event draft reward updated",
      data: {
        event,
      },
    });
  };

  public deleteDraftReward = async (req: Request, res: Response): Promise<void> => {
    const event = await this.eventService.deleteDraftReward(
      req.authUser as AuthUser,
      req.params.id as string,
      req.params.rewardId as string,
    );

    ApiResponse.success(res, {
      message: "Event draft reward deleted",
      data: {
        event,
      },
    });
  };

  public claimReward = async (req: Request, res: Response): Promise<void> => {
    const claim = await this.eventService.claimReward(
      req.authUser as AuthUser,
      req.params.id as string,
      req.params.rewardId as string,
    );

    ApiResponse.success(res, {
      statusCode: httpStatus.CREATED,
      message: "Reward claimed",
      data: {
        claim,
      },
    });
  };

  public getMyEventRewardClaims = async (req: Request, res: Response): Promise<void> => {
    const claims = await this.eventService.getMyEventRewardClaims(
      req.authUser as AuthUser,
      req.params.id as string,
    );

    ApiResponse.success(res, {
      message: "Reward claims retrieved",
      data: {
        claims,
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

  public listMyDraftEvents = async (req: Request, res: Response): Promise<void> => {
    const events = await this.eventService.listMyDraftEvents(req.authUser as AuthUser);

    ApiResponse.success(res, {
      message: "Draft events retrieved",
      data: {
        events,
      },
    });
  };

  public listMyPostTagEvents = async (req: Request, res: Response): Promise<void> => {
    const events = await this.eventService.listMyPostTagEvents(req.authUser as AuthUser);

    ApiResponse.success(res, {
      message: "Post tag events retrieved",
      data: {
        events,
      },
    });
  };

  public getTicketAccess = async (req: Request, res: Response): Promise<void> => {
    const access = await this.eventService.getTicketAccess(
      req.authUser as AuthUser,
      req.params.id as string,
    );

    ApiResponse.success(res, {
      message: "Ticket access retrieved",
      data: {
        access,
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

  public listProfileEvents = async (req: Request, res: Response): Promise<void> => {
    const events = await this.eventService.listProfileEventsForUser(
      req.authUser as AuthUser,
      req.params.userId as string,
    );

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

  public listNowModeEvents = async (req: Request, res: Response): Promise<void> => {
    const events = await this.eventService.listNowModeEvents(req.query as unknown as NowModeQuery);

    ApiResponse.success(res, {
      message: "Now mode events retrieved",
      data: {
        events,
      },
    });
  };

  public getEventById = async (req: Request, res: Response): Promise<void> => {
    const event = await this.eventService.getEventById(req.authUser as AuthUser, req.params.id as string);

    ApiResponse.success(res, {
      message: "Event retrieved",
      data: {
        event,
      },
    });
  };

  public completeEvent = async (req: Request, res: Response): Promise<void> => {
    const event = await this.eventService.completeEvent(req.authUser as AuthUser, req.params.id as string);

    ApiResponse.success(res, {
      message: "Event marked as completed",
      data: {
        event,
      },
    });
  };

  public cancelEvent = async (req: Request, res: Response): Promise<void> => {
    const event = await this.eventService.cancelEvent(req.authUser as AuthUser, req.params.id as string);

    ApiResponse.success(res, {
      message: "Event cancelled and refunds issued",
      data: {
        event,
      },
    });
  };

  public listEventMembers = async (req: Request, res: Response): Promise<void> => {
    const members = await this.eventService.listEventMembers(req.authUser as AuthUser, req.params.id as string);

    ApiResponse.success(res, {
      message: "Event members retrieved",
      data: { members },
    });
  };

  public addEventMember = async (req: Request, res: Response): Promise<void> => {
    const members = await this.eventService.addEventMember(
      req.authUser as AuthUser,
      req.params.id as string,
      (req.body as { userId: string }).userId,
    );

    ApiResponse.success(res, {
      statusCode: httpStatus.CREATED,
      message: "Member added",
      data: { members },
    });
  };

  public removeEventMember = async (req: Request, res: Response): Promise<void> => {
    const members = await this.eventService.removeEventMember(
      req.authUser as AuthUser,
      req.params.id as string,
      req.params.userId as string,
    );

    ApiResponse.success(res, {
      message: "Member removed",
      data: { members },
    });
  };
}
