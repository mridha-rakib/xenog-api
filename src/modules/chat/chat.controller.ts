import type { Request, Response } from "express";
import httpStatus from "http-status";
import { ApiResponse } from "../../core/http/api-response.js";
import type { AuthUser } from "../auth/auth.interface.js";
import type {
  CreateDirectMessageDto,
  ListDirectMessageHistoryQuery,
  ListDirectMessagesQuery,
} from "./chat.interface.js";
import { ChatService } from "./chat.service.js";

export class ChatController {
  public constructor(private readonly chatService = new ChatService()) {}

  public listDirectMessages = async (req: Request, res: Response): Promise<void> => {
    const dms = await this.chatService.listDirectMessages(
      req.authUser as AuthUser,
      req.query as ListDirectMessagesQuery,
    );

    ApiResponse.success(res, {
      message: "Direct message conversations retrieved",
      data: {
        dms,
      },
    });
  };

  public listDirectMessageHistory = async (req: Request, res: Response): Promise<void> => {
    const messages = await this.chatService.listDirectMessageHistory(
      req.authUser as AuthUser,
      req.params.friendId as string,
      req.query as ListDirectMessageHistoryQuery,
    );

    ApiResponse.success(res, {
      message: "Direct messages retrieved",
      data: {
        messages,
      },
    });
  };

  public createDirectMessage = async (req: Request, res: Response): Promise<void> => {
    const message = await this.chatService.createDirectMessage(
      req.authUser as AuthUser,
      req.params.friendId as string,
      req.body as CreateDirectMessageDto,
    );

    ApiResponse.success(res, {
      statusCode: httpStatus.CREATED,
      message: "Direct message sent",
      data: { message },
    });
  };

  public deleteConversation = async (req: Request, res: Response): Promise<void> => {
    await this.chatService.deleteConversation(
      req.authUser as AuthUser,
      req.params.friendId as string,
    );

    ApiResponse.success(res, { message: "Conversation deleted" });
  };
}
