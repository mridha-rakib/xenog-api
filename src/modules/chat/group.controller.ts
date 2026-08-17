import type { Request, Response } from "express";
import httpStatus from "http-status";
import { ApiResponse } from "../../core/http/api-response.js";
import type { AuthUser } from "../auth/auth.interface.js";
import type {
  CreateGroupDto,
  CreateGroupMessageDto,
  ListGroupMessageHistoryQuery,
  ListGroupsQuery,
} from "./group.interface.js";
import { GroupService } from "./group.service.js";
import { createGroupMessageWithSideEffects } from "../realtime/chat-events.service.js";

export class GroupController {
  public constructor(private readonly groupService = new GroupService()) {}

  public createGroup = async (req: Request, res: Response): Promise<void> => {
    const group = await this.groupService.createGroup(
      req.authUser as AuthUser,
      req.body as CreateGroupDto,
    );

    ApiResponse.success(res, {
      statusCode: httpStatus.CREATED,
      message: "Group created successfully",
      data: { group },
    });
  };

  public listGroups = async (req: Request, res: Response): Promise<void> => {
    const groups = await this.groupService.listGroups(
      req.authUser as AuthUser,
      req.query as ListGroupsQuery,
    );

    ApiResponse.success(res, {
      message: "Groups retrieved",
      data: { groups },
    });
  };

  public createGroupMessage = async (req: Request, res: Response): Promise<void> => {
    // Same shared side-effect path as chat.controller.ts's DM equivalent —
    // ensures any future REST-based group message creation also broadcasts
    // and evaluates push, matching the Socket.IO/raw-ws behavior.
    const message = await createGroupMessageWithSideEffects(
      req.authUser as AuthUser,
      req.params.groupId as string,
      req.body as CreateGroupMessageDto,
    );

    ApiResponse.success(res, {
      statusCode: httpStatus.CREATED,
      message: "Message sent",
      data: { message },
    });
  };

  public listGroupMessages = async (req: Request, res: Response): Promise<void> => {
    const messages = await this.groupService.listGroupMessages(
      req.authUser as AuthUser,
      req.params.groupId as string,
      req.query as ListGroupMessageHistoryQuery,
    );

    ApiResponse.success(res, {
      message: "Group messages retrieved",
      data: { messages },
    });
  };

  public leaveGroup = async (req: Request, res: Response): Promise<void> => {
    const result = await this.groupService.leaveGroup(
      req.authUser as AuthUser,
      req.params.groupId as string,
    );

    ApiResponse.success(res, {
      message: result.status === "group_deleted" ? "Group deleted" : "Left group",
      data: { leave: result },
    });
  };
}
