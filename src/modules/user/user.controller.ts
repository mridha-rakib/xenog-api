import type { Request, Response } from "express";
import httpStatus from "http-status";
import { ApiResponse } from "../../core/http/api-response.js";
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
