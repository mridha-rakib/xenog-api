import type { Request, Response } from "express";
import httpStatus from "http-status";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AppError } from "../../core/errors/app-error.js";
import { ApiResponse } from "../../core/http/api-response.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { StorageService } from "../storage/storage.service.js";
import type {
  AddEventMediaDto,
  CreateEventTicketDto,
  CreateEventRewardDto,
  EventFeedQuery,
  EventMapQuery,
  NowModeQuery,
  PublishEventDto,
  SaveEventDraftDto,
  UpdateEventRewardDto,
  UpdateEventTicketDto,
} from "./event.interface.js";
import type { SubmitEventHostReviewDto as SubmitHostReviewDto } from "./event-host-review.interface.js";
import { EventService } from "./event.service.js";

const getSupportedRangeHeader = (rangeHeader: Request["headers"]["range"]): string | undefined => {
  if (typeof rangeHeader !== "string") {
    return undefined;
  }

  if (!/^bytes=(\d+-\d*|\d*-\d+)$/.test(rangeHeader)) {
    throw new AppError("Invalid Range header", 416);
  }

  return rangeHeader;
};

const escapeHeaderFilename = (filename: string): string => filename.replace(/["\\]/g, "_");

export class EventController {
  public constructor(
    private readonly eventService = new EventService(),
    private readonly storageService = new StorageService(),
  ) {}

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

  public listFeedEvents = async (req: Request, res: Response): Promise<void> => {
    const events = await this.eventService.listFeedEvents(
      req.authUser as AuthUser | undefined,
      req.query as unknown as EventFeedQuery,
    );

    ApiResponse.success(res, {
      message: "Feed events retrieved",
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

  public listUserEventsForAdmin = async (req: Request, res: Response): Promise<void> => {
    const events = await this.eventService.listUserEventsForAdmin(req.params.userId as string);

    ApiResponse.success(res, {
      message: "User events retrieved",
      data: { events },
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
      req.query as { filter?: "active" | "past" | "all"; page?: number; limit?: number },
    );

    ApiResponse.success(res, {
      message: "Profile events retrieved",
      data: {
        events,
      },
    });
  };

  public listMapEvents = async (req: Request, res: Response): Promise<void> => {
    const result = await this.eventService.listMapEvents(
      req.authUser as AuthUser,
      req.query as unknown as EventMapQuery,
    );

    ApiResponse.success(res, {
      message: "Map events retrieved",
      data: {
        events: result.events,
        nextCursor: result.nextCursor ?? null,
      },
    });
  };

  public addEventMedia = async (req: Request, res: Response): Promise<void> => {
    const result = await this.eventService.addEventMedia(
      req.authUser as AuthUser,
      req.params.id as string,
      req.body as AddEventMediaDto,
    );

    ApiResponse.success(res, {
      statusCode: httpStatus.CREATED,
      message: "Event media uploaded",
      data: result,
    });
  };

  public streamEventMedia = async (req: Request, res: Response): Promise<void> => {
    const media = await this.eventService.getAuthorizedEventMedia(
      req.authUser as AuthUser,
      req.params.id as string,
      req.params.mediaId as string,
    );
    const range = getSupportedRangeHeader(req.headers.range);
    const abortController = new AbortController();
    const bodyRef: { current?: Readable } = {};
    let streamFinished = false;

    const cleanupBody = (reason?: Error): void => {
      const body = bodyRef.current;

      if (body && !body.destroyed) {
        body.destroy(reason);
      }
    };

    const abortStreaming = (): void => {
      if (streamFinished || abortController.signal.aborted) {
        return;
      }

      abortController.abort();
      cleanupBody(new Error("Client disconnected during event media stream"));
    };

    const abortOnEarlyClose = (): void => {
      if (!res.writableEnded) {
        abortStreaming();
      }
    };

    req.on("aborted", abortStreaming);
    res.on("close", abortOnEarlyClose);
    res.on("error", abortStreaming);

    const file = await this.storageService.getObject(media.key, range, abortController.signal);
    const body = file.body;
    bodyRef.current = body;

    if (abortController.signal.aborted || req.aborted || res.destroyed) {
      cleanupBody(new Error("Client disconnected before event media stream started"));
      return;
    }

    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", media.contentType || file.contentType || "application/octet-stream");

    if (file.contentRange) {
      res.status(httpStatus.PARTIAL_CONTENT);
      res.setHeader("Content-Range", file.contentRange);
    }

    if (file.contentLength !== undefined) {
      res.setHeader("Content-Length", file.contentLength);
    }

    res.setHeader("Content-Disposition", `inline; filename="${escapeHeaderFilename(media.filename)}"`);
    res.setHeader("Cache-Control", "private, max-age=300");

    await pipeline(body, res);
    streamFinished = true;
  };

  public deleteEventMedia = async (req: Request, res: Response): Promise<void> => {
    const result = await this.eventService.deleteEventMedia(
      req.authUser as AuthUser,
      req.params.id as string,
      req.params.mediaId as string,
    );

    ApiResponse.success(res, {
      message: "Event media deleted",
      data: result,
    });
  };

  public listAdminMapEvents = async (_req: Request, res: Response): Promise<void> => {
    const events = await this.eventService.listAdminMapEvents();

    ApiResponse.success(res, {
      message: "Admin map events retrieved",
      data: { events },
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

  public submitHostReview = async (req: Request, res: Response): Promise<void> => {
    const review = await this.eventService.submitHostReview(
      req.authUser as AuthUser,
      req.params.id as string,
      req.body as SubmitHostReviewDto,
    );

    ApiResponse.success(res, {
      statusCode: httpStatus.CREATED,
      message: "Review submitted",
      data: {
        review,
      },
    });
  };

  public startEvent = async (req: Request, res: Response): Promise<void> => {
    const event = await this.eventService.startEvent(req.authUser as AuthUser, req.params.id as string);

    ApiResponse.success(res, {
      message: "Event started",
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

  public saveEvent = async (req: Request, res: Response): Promise<void> => {
    const result = await this.eventService.toggleSaveEvent(req.authUser as AuthUser, req.params.id as string);

    ApiResponse.success(res, {
      message: result.isSaved ? "Event saved" : "Event unsaved",
      data: { summary: result },
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

  public submitJoinRequest = async (req: Request, res: Response): Promise<void> => {
    const result = await this.eventService.submitJoinRequest(
      req.authUser as AuthUser,
      req.params.id as string,
    );

    ApiResponse.success(res, {
      statusCode: httpStatus.CREATED,
      message: "Join request submitted",
      data: result,
    });
  };

  public listJoinRequests = async (req: Request, res: Response): Promise<void> => {
    const requests = await this.eventService.listJoinRequests(
      req.authUser as AuthUser,
      req.params.id as string,
    );

    ApiResponse.success(res, {
      message: "Join requests retrieved",
      data: { requests },
    });
  };

  public acceptJoinRequest = async (req: Request, res: Response): Promise<void> => {
    await this.eventService.acceptJoinRequest(
      req.authUser as AuthUser,
      req.params.id as string,
      req.params.requestUserId as string,
    );

    ApiResponse.success(res, {
      message: "Join request accepted",
      data: {},
    });
  };

  public declineJoinRequest = async (req: Request, res: Response): Promise<void> => {
    await this.eventService.declineJoinRequest(
      req.authUser as AuthUser,
      req.params.id as string,
      req.params.requestUserId as string,
    );

    ApiResponse.success(res, {
      message: "Join request declined",
      data: {},
    });
  };
}
