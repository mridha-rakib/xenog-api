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
    const moments = await this.momentService.listFeedMoments(req.authUser as AuthUser);

    ApiResponse.success(res, {
      message: "Feed moments retrieved",
      data: {
        moments,
      },
    });
  };

  public shareMoment = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string };
    const share = await this.momentService.shareMoment(id, req.authUser as AuthUser);

    ApiResponse.success(res, {
      statusCode: httpStatus.CREATED,
      message: "Moment shared",
      data: {
        share,
      },
    });
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
    const timeline = await this.momentService.getProfileTimeline(userId, req.authUser as AuthUser | undefined);

    ApiResponse.success(res, {
      message: "Profile timeline retrieved",
      data: timeline,
    });
  };
}
