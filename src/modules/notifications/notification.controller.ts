import type { Request, Response } from "express";
import { ApiResponse } from "../../core/http/api-response.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { NotificationService } from "./notification.service.js";

export class NotificationController {
  public constructor(private readonly service = new NotificationService()) {}

  public list = async (req: Request, res: Response): Promise<void> => {
    const notifications = await this.service.listForUser(req.authUser as AuthUser);

    ApiResponse.success(res, {
      message: "Notifications retrieved",
      data: { notifications },
    });
  };

  public markAllRead = async (req: Request, res: Response): Promise<void> => {
    await this.service.markAllRead(req.authUser as AuthUser);

    ApiResponse.success(res, {
      message: "Notifications marked as read",
    });
  };

  public countUnread = async (req: Request, res: Response): Promise<void> => {
    const count = await this.service.countUnread(req.authUser as AuthUser);

    ApiResponse.success(res, {
      message: "Unread notification count retrieved",
      data: { count },
    });
  };
}
