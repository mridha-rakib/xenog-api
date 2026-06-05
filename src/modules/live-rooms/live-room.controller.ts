import type { Request, Response } from "express";
import httpStatus from "http-status";
import { ApiResponse } from "../../core/http/api-response.js";
import type { AuthUser } from "../auth/auth.interface.js";
import type {
  CreateLiveRoomDto,
  CreateLiveRoomMessageDto,
  ListLiveRoomMessagesQuery,
  UpdateLiveRoomPermissionsDto,
} from "./live-room.interface.js";
import { LiveRoomService } from "./live-room.service.js";

export class LiveRoomController {
  public constructor(private readonly liveRoomService = new LiveRoomService()) {}

  public createLiveRoom = async (req: Request, res: Response): Promise<void> => {
    const liveRoom = await this.liveRoomService.createLiveRoom(req.authUser as AuthUser, req.body as CreateLiveRoomDto);

    ApiResponse.success(res, {
      statusCode: httpStatus.CREATED,
      message: "Live room created",
      data: {
        liveRoom,
      },
    });
  };

  public getLiveRoom = async (req: Request, res: Response): Promise<void> => {
    const liveRoom = await this.liveRoomService.getLiveRoom(req.authUser as AuthUser, req.params.id as string);

    ApiResponse.success(res, {
      message: "Live room retrieved",
      data: {
        liveRoom,
      },
    });
  };

  public joinLiveRoom = async (req: Request, res: Response): Promise<void> => {
    const liveRoom = await this.liveRoomService.joinLiveRoom(req.authUser as AuthUser, req.params.id as string);

    ApiResponse.success(res, {
      message: "Live room joined",
      data: {
        liveRoom,
      },
    });
  };

  public leaveLiveRoom = async (req: Request, res: Response): Promise<void> => {
    const liveRoom = await this.liveRoomService.leaveLiveRoom(req.authUser as AuthUser, req.params.id as string);

    ApiResponse.success(res, {
      message: "Live room left",
      data: {
        liveRoom,
      },
    });
  };

  public updatePermissions = async (req: Request, res: Response): Promise<void> => {
    const liveRoom = await this.liveRoomService.updatePermissions(
      req.authUser as AuthUser,
      req.params.id as string,
      req.body as UpdateLiveRoomPermissionsDto,
    );

    ApiResponse.success(res, {
      message: "Live room permissions updated",
      data: {
        liveRoom,
      },
    });
  };

  public listMessages = async (req: Request, res: Response): Promise<void> => {
    const messages = await this.liveRoomService.listMessages(
      req.authUser as AuthUser,
      req.params.id as string,
      req.query as ListLiveRoomMessagesQuery,
    );

    ApiResponse.success(res, {
      message: "Live room messages retrieved",
      data: {
        messages,
      },
    });
  };

  public createMessage = async (req: Request, res: Response): Promise<void> => {
    const message = await this.liveRoomService.createMessage(
      req.authUser as AuthUser,
      req.params.id as string,
      req.body as CreateLiveRoomMessageDto,
    );

    ApiResponse.success(res, {
      statusCode: httpStatus.CREATED,
      message: "Live room message created",
      data: {
        message,
      },
    });
  };
}
