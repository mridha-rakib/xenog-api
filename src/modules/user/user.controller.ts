import type { Request, Response } from "express";
import httpStatus from "http-status";
import { ApiResponse } from "../../core/http/api-response.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { UserService } from "./user.service.js";

export class UserController {
  public constructor(private readonly userService = new UserService()) {}

  public create = async (req: Request, res: Response): Promise<void> => {
    const user = await this.userService.create(req.body);

    ApiResponse.success(res, {
      statusCode: httpStatus.CREATED,
      message: "User created",
      data: user,
    });
  };

  public list = async (req: Request, res: Response): Promise<void> => {
    const result = await this.userService.list(req.query);

    ApiResponse.success(res, {
      message: "Users retrieved",
      data: result.data,
      meta: result.meta,
    });
  };

  public getById = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string };
    const user = await this.userService.getById(id);

    ApiResponse.success(res, {
      message: "User retrieved",
      data: user,
    });
  };

  public listSuggestions = async (req: Request, res: Response): Promise<void> => {
    const { limit } = req.query as { limit?: number };
    const users = await this.userService.listSuggestedUsers(req.authUser as AuthUser, limit);

    ApiResponse.success(res, {
      message: "Suggested users retrieved",
      data: {
        users,
      },
    });
  };

  public listFriends = async (req: Request, res: Response): Promise<void> => {
    const query = req.query as { search?: string; limit?: number };
    const friends = await this.userService.listFriends(req.authUser as AuthUser, query);

    ApiResponse.success(res, {
      message: "Friends retrieved",
      data: {
        friends,
      },
    });
  };

  public getProfileStats = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string };
    const stats = await this.userService.getProfileStats(id);

    ApiResponse.success(res, {
      message: "Profile stats retrieved",
      data: {
        stats,
      },
    });
  };

  public listFollowers = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string };
    const users = await this.userService.listFollowers(
      id,
      req.authUser as AuthUser,
      req.query as { search?: string; limit?: number },
    );

    ApiResponse.success(res, {
      message: "Followers retrieved",
      data: {
        users,
      },
    });
  };

  public listFollowing = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string };
    const users = await this.userService.listFollowing(
      id,
      req.authUser as AuthUser,
      req.query as { search?: string; limit?: number },
    );

    ApiResponse.success(res, {
      message: "Following retrieved",
      data: {
        users,
      },
    });
  };

  public listReviews = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string };
    const reviews = await this.userService.listReviews(id);

    ApiResponse.success(res, {
      message: "Reviews retrieved",
      data: reviews,
    });
  };

  public follow = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string };
    const follow = await this.userService.followUser(req.authUser as AuthUser, id);

    ApiResponse.success(res, {
      statusCode: httpStatus.CREATED,
      message: "User followed",
      data: {
        follow,
      },
    });
  };

  public unfollow = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string };
    const follow = await this.userService.unfollowUser(req.authUser as AuthUser, id);

    ApiResponse.success(res, {
      message: "User unfollowed",
      data: {
        follow,
      },
    });
  };

  public update = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string };
    const user = await this.userService.update(id, req.body);

    ApiResponse.success(res, {
      message: "User updated",
      data: user,
    });
  };

  public delete = async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string };
    const user = await this.userService.delete(id);

    ApiResponse.success(res, {
      message: "User deleted",
      data: user,
    });
  };
}
