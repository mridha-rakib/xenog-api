import type { Request, Response } from "express";
import { z } from "zod";
import { ApiResponse } from "../../core/http/api-response.js";
import { AppError } from "../../core/errors/app-error.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { NotificationService } from "./notification.service.js";
import { FcmTokenRepository } from "./fcm-token.repository.js";

const fcmTokenSchema = z.object({
  token: z.string().trim().min(1).max(512),
  platform: z.enum(["android", "ios"]).optional(),
  deviceId: z.string().trim().max(256).optional(),
});

export class NotificationController {
  public constructor(
    private readonly service = new NotificationService(),
    private readonly fcmTokenRepository = new FcmTokenRepository(),
  ) {}

  public list = async (req: Request, res: Response): Promise<void> => {
    const notifications = await this.service.listForUser(req.authUser as AuthUser);

    ApiResponse.success(res, {
      message: "Notifications retrieved",
      data: { notifications },
    });
  };

  public markAllRead = async (req: Request, res: Response): Promise<void> => {
    const unreadCount = await this.service.markAllRead(req.authUser as AuthUser);

    ApiResponse.success(res, {
      message: "Notifications marked as read",
      data: { unreadCount },
    });
  };

  public markRead = async (req: Request, res: Response): Promise<void> => {
    const unreadCount = await this.service.markRead(
      req.authUser as AuthUser,
      req.params.notificationId as string,
    );

    ApiResponse.success(res, {
      message: "Notification marked as read",
      data: { unreadCount },
    });
  };

  public countUnread = async (req: Request, res: Response): Promise<void> => {
    const count = await this.service.countUnread(req.authUser as AuthUser);

    ApiResponse.success(res, {
      message: "Unread notification count retrieved",
      data: { count },
    });
  };

  public registerFcmToken = async (req: Request, res: Response): Promise<void> => {
    const parsed = fcmTokenSchema.safeParse(req.body);

    if (!parsed.success) {
      throw new AppError("Invalid FCM token payload.", 400);
    }

    const user = req.authUser as AuthUser;
    const { token, platform, deviceId } = parsed.data;

    await this.fcmTokenRepository.upsert(user.id, token, platform, deviceId);

    ApiResponse.success(res, { message: "FCM token registered" });
  };

  public removeFcmToken = async (req: Request, res: Response): Promise<void> => {
    const token = (req.body as { token?: unknown })?.token;

    if (typeof token !== "string" || !token.trim()) {
      throw new AppError("Invalid FCM token.", 400);
    }

    const user = req.authUser as AuthUser;

    await this.fcmTokenRepository.remove(user.id, token.trim());

    ApiResponse.success(res, { message: "FCM token removed" });
  };
}
