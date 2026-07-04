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

  public listDiscoverStories = async (req: Request, res: Response) => {
    const stories = await this.storyService.listDiscoverStories(req.authUser as AuthUser);
    ApiResponse.success(res, { message: "Stories retrieved", data: { stories } });
  };
  public listFriendStories = async (req: Request, res: Response) => {
    const stories = await this.storyService.listFriendStories(req.authUser as AuthUser);
    ApiResponse.success(res, { message: "Stories retrieved", data: { stories } });
  };
  public recordView = async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const interaction = await this.storyService.recordView(id, req.authUser as AuthUser);
    ApiResponse.success(res, { message: "Story view recorded", data: { interaction } });
  };
  public toggleReaction = async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const interaction = await this.storyService.toggleReaction(id, req.authUser as AuthUser);
    ApiResponse.success(res, { message: "Story reaction updated", data: { interaction } });
  };
  public deleteStory = async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    await this.storyService.deleteStory(id, req.authUser as AuthUser);
    ApiResponse.success(res, { message: "Story deleted" });
  };
  public listComments = async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const comments = await this.storyService.listComments(id, req.authUser as AuthUser);
    ApiResponse.success(res, { message: "Comments retrieved", data: { comments } });
  };
  public createComment = async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const result = await this.storyService.createComment(id, req.authUser as AuthUser, req.body);
    ApiResponse.success(res, { statusCode: httpStatus.CREATED, message: "Comment created", data: result });
  };
  public shareToFeed = async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const share = await this.storyService.shareToFeed(id, req.authUser as AuthUser, req.body);
    ApiResponse.success(res, { statusCode: httpStatus.CREATED, message: "Story shared to feed", data: { share } });
  };
}
