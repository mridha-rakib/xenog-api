import type { Request, Response } from "express";
import httpStatus from "http-status";
import { ApiResponse } from "../../core/http/api-response.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { MomentService } from "./moment.service.js";

export class MomentController {
  public constructor(private readonly momentService = new MomentService()) {}

  public createMoment = async (req: Request, res: Response): Promise<void> => {
    const moment = await this.momentService.createMoment(req.body, req.authUser as AuthUser);

    ApiResponse.success(res, {
      statusCode: httpStatus.CREATED,
      message: "Moment created",
      data: {
        moment,
      },
    });
  };

  public listMyMoments = async (req: Request, res: Response): Promise<void> => {
    const moments = await this.momentService.listMyMoments(req.authUser as AuthUser);

    ApiResponse.success(res, {
      message: "Moments retrieved",
      data: {
        moments,
      },
    });
  };

  public listFeedMoments = async (req: Request, res: Response): Promise<void> => {
    const moments = await this.momentService.listFeedMoments(
      req.authUser as AuthUser,
      req.query as { hashtags?: string[]; limit?: number; audience?: "discover" | "friends" },
    );

    ApiResponse.success(res, {
      message: "Feed moments retrieved",
      data: {
        moments,
      },
    });
  };

  public listHashtagMoments = async (req: Request, res: Response): Promise<void> => {
    const { hashtag } = req.params as { hashtag: string };
    const { limit } = req.query as { limit?: number };
    const moments = await this.momentService.listHashtagMoments(hashtag, req.authUser as AuthUser, limit);

    ApiResponse.success(res, {
      message: "Hashtag moments retrieved",
      data: { moments },
    });
  };

  public shareMoment = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string };
    const share = await this.momentService.shareMoment(id, req.authUser as AuthUser, req.body);

    ApiResponse.success(res, {
      statusCode: httpStatus.CREATED,
      message: "Moment shared",
      data: {
        share,
      },
    });
  };

  public listFeedShares = async (req: Request, res: Response): Promise<void> => {
    const shares = await this.momentService.listFeedShares(
      req.authUser as AuthUser,
      Number(req.query.limit ?? 50),
      req.query.audience as "discover" | "friends" | undefined,
    );
    ApiResponse.success(res, { message: "Feed reposts retrieved", data: { shares } });
  };

  public getMoment = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string };
    const moment = await this.momentService.getMoment(id, req.authUser as AuthUser);

    ApiResponse.success(res, { message: "Moment retrieved", data: { moment } });
  };

  public toggleMomentReaction = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string };
    const summary = await this.momentService.toggleMomentReaction(id, req.authUser as AuthUser);

    ApiResponse.success(res, {
      message: summary.isLiked ? "Moment liked" : "Moment unliked",
      data: {
        summary,
      },
    });
  };

  public deleteMoment = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string };

    await this.momentService.deleteMoment(id, req.authUser as AuthUser);

    ApiResponse.success(res, {
      message: "Moment deleted",
    });
  };

  public listMomentComments = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string };
    const comments = await this.momentService.listMomentComments(id, req.authUser as AuthUser);

    ApiResponse.success(res, {
      message: "Moment comments retrieved",
      data: {
        comments,
      },
    });
  };

  public toggleCommentReaction = async (req: Request, res: Response): Promise<void> => {
    const { id, commentId } = req.params as { id: string; commentId: string };
    const result = await this.momentService.toggleCommentReaction(id, commentId, req.authUser as AuthUser);

    ApiResponse.success(res, {
      message: result.isLiked ? "Comment liked" : "Comment unliked",
      data: result,
    });
  };

  public createMomentComment = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string };
    const { comment, summary } = await this.momentService.createMomentComment(
      id,
      req.body,
      req.authUser as AuthUser,
    );

    ApiResponse.success(res, {
      statusCode: httpStatus.CREATED,
      message: "Comment created",
      data: {
        comment,
        summary,
      },
    });
  };

  public getProfileTimeline = async (req: Request, res: Response): Promise<void> => {
    const { userId } = req.params as { userId: string };
    const timeline = await this.momentService.getProfileTimeline(
      userId,
      req.authUser as AuthUser | undefined,
      req.query as { page?: number; limit?: number },
    );

    ApiResponse.success(res, {
      message: "Profile timeline retrieved",
      data: timeline,
      meta: timeline.pagination ? { pagination: timeline.pagination } : undefined,
    });
  };

  public listEventMoments = async (req: Request, res: Response): Promise<void> => {
    const { eventId } = req.params as { eventId: string };
    const moments = await this.momentService.listEventMoments(eventId, req.authUser as AuthUser);

    ApiResponse.success(res, {
      message: "Event moments retrieved",
      data: { moments },
    });
  };

  public toggleMomentSave = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string };
    const summary = await this.momentService.toggleMomentSave(id, req.authUser as AuthUser);

    ApiResponse.success(res, {
      message: summary.isSaved ? "Moment saved" : "Moment unsaved",
      data: { summary },
    });
  };

  public listSavedMoments = async (req: Request, res: Response): Promise<void> => {
    const moments = await this.momentService.listSavedMoments(req.authUser as AuthUser);

    ApiResponse.success(res, {
      message: "Saved moments retrieved",
      data: { moments },
    });
  };
}
