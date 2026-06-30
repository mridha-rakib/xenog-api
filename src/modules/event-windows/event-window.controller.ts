import type { Request, Response } from "express";
import httpStatus from "http-status";
import { pipeline } from "node:stream/promises";
import { AppError } from "../../core/errors/app-error.js";
import { ApiResponse } from "../../core/http/api-response.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { StorageService } from "../storage/storage.service.js";
import type { CreateEventWindowDto, CreateEventWindowPostDto, UpdateEventWindowDto } from "./event-window.interface.js";
import { EventWindowService } from "./event-window.service.js";

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

export class EventWindowController {
  public constructor(
    private readonly eventWindowService = new EventWindowService(),
    private readonly storageService = new StorageService(),
  ) {}

  public createWindow = async (req: Request, res: Response): Promise<void> => {
    const window = await this.eventWindowService.createWindow(
      req.authUser as AuthUser,
      req.params.eventId as string,
      req.body as CreateEventWindowDto,
    );

    ApiResponse.success(res, {
      statusCode: httpStatus.CREATED,
      message: "Event window created",
      data: { window },
    });
  };

  public listWindows = async (req: Request, res: Response): Promise<void> => {
    const windows = await this.eventWindowService.listWindows(
      req.authUser as AuthUser,
      req.params.eventId as string,
    );

    ApiResponse.success(res, {
      message: "Event windows retrieved",
      data: { windows },
    });
  };

  public updateWindow = async (req: Request, res: Response): Promise<void> => {
    const window = await this.eventWindowService.updateWindow(
      req.authUser as AuthUser,
      req.params.eventId as string,
      req.params.windowId as string,
      req.body as UpdateEventWindowDto,
    );

    ApiResponse.success(res, {
      message: "Event window updated",
      data: { window },
    });
  };

  public cancelWindow = async (req: Request, res: Response): Promise<void> => {
    const window = await this.eventWindowService.cancelWindow(
      req.authUser as AuthUser,
      req.params.eventId as string,
      req.params.windowId as string,
    );

    ApiResponse.success(res, {
      message: "Event window cancelled",
      data: { window },
    });
  };

  public createPost = async (req: Request, res: Response): Promise<void> => {
    const post = await this.eventWindowService.createPost(
      req.authUser as AuthUser,
      req.params.eventId as string,
      req.params.windowId as string,
      req.body as CreateEventWindowPostDto,
    );

    ApiResponse.success(res, {
      statusCode: httpStatus.CREATED,
      message: "Event window post created",
      data: { post },
    });
  };

  public listPosts = async (req: Request, res: Response): Promise<void> => {
    const result = await this.eventWindowService.listPosts(
      req.authUser as AuthUser,
      req.params.eventId as string,
      req.params.windowId as string,
      req.query as unknown as { limit: number; cursor?: string },
    );

    ApiResponse.success(res, {
      message: "Event window posts retrieved",
      data: result,
    });
  };

  public streamMedia = async (req: Request, res: Response): Promise<void> => {
    const media = await this.eventWindowService.getAuthorizedMedia(
      req.authUser as AuthUser,
      req.params.eventId as string,
      req.params.windowId as string,
      req.params.postId as string,
      Number(req.params.mediaIndex),
    );
    const range = getSupportedRangeHeader(req.headers.range);
    const file = await this.storageService.getObject(media.key, range);

    res.setHeader("Accept-Ranges", "bytes");

    const responseContentType = media.contentType || file.contentType;
    if (responseContentType) {
      res.setHeader("Content-Type", responseContentType);
    }

    if (file.contentRange) {
      res.status(httpStatus.PARTIAL_CONTENT);
      res.setHeader("Content-Range", file.contentRange);
    }

    if (file.contentLength !== undefined) {
      res.setHeader("Content-Length", file.contentLength);
    }

    res.setHeader("Content-Disposition", `inline; filename="${escapeHeaderFilename(media.filename)}"`);
    res.setHeader("Cache-Control", "private, no-store");

    await pipeline(file.body, res);
  };
}
