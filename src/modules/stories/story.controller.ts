import type { Request, Response } from "express";
import httpStatus from "http-status";
import { ApiResponse } from "../../core/http/api-response.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { StoryService } from "./story.service.js";

export class StoryController {
  public constructor(private readonly storyService = new StoryService()) {}

  public createStory = async (req: Request, res: Response): Promise<void> => {
    const story = await this.storyService.createStory(req.body, req.authUser as AuthUser);

    ApiResponse.success(res, {
      statusCode: httpStatus.CREATED,
      message: "Story created",
      data: {
        story,
      },
    });
  };

  public listFeedStories = async (req: Request, res: Response): Promise<void> => {
    const stories = await this.storyService.listFeedStories(req.authUser as AuthUser);

    ApiResponse.success(res, {
      message: "Stories retrieved",
      data: {
        stories,
      },
    });
  };

  public listMyStories = async (req: Request, res: Response): Promise<void> => {
    const stories = await this.storyService.listMyStories(req.authUser as AuthUser);

    ApiResponse.success(res, {
      message: "Stories retrieved",
      data: {
        stories,
      },
    });
  };
}
