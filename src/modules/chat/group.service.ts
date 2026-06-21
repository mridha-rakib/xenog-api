import httpStatus from "http-status";
import { AppError } from "../../core/errors/app-error.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { StorageService } from "../storage/storage.service.js";
import { UserFollowRepository } from "../user/user-follow.repository.js";
import { GroupRepository } from "./group.repository.js";
import type {
  CreateGroupDto,
  CreateGroupMessageDto,
  GroupConversationResponse,
  GroupMessageResponse,
  IGroup,
  ListGroupMessageHistoryQuery,
  ListGroupsQuery,
} from "./group.interface.js";

export class GroupService {
  public constructor(
    private readonly groupRepository = new GroupRepository(),
    private readonly userFollowRepository = new UserFollowRepository(),
    private readonly storageService = new StorageService(),
  ) {}

  public async createGroup(user: AuthUser, payload: CreateGroupDto): Promise<GroupConversationResponse> {
    const trimmedName = payload.name?.trim();

    if (!trimmedName) {
      throw new AppError("Group name is required.", httpStatus.BAD_REQUEST);
    }

    if (!payload.memberIds || payload.memberIds.length === 0) {
      throw new AppError("At least one member is required to create a group.", httpStatus.BAD_REQUEST);
    }

    if (payload.memberIds.length > 50) {
      throw new AppError("A group can have at most 50 members.", httpStatus.BAD_REQUEST);
    }

    const uniqueMemberIds = [...new Set(payload.memberIds.filter((id) => id !== user.id))];

    if (uniqueMemberIds.length === 0) {
      throw new AppError("At least one member other than yourself is required.", httpStatus.BAD_REQUEST);
    }

    const mutualFriendIds = await this.userFollowRepository.findMutualFriendIds(user.id);
    const mutualFriendIdSet = new Set(mutualFriendIds);
    const invalidMembers = uniqueMemberIds.filter((id) => !mutualFriendIdSet.has(id));

    if (invalidMembers.length > 0) {
      throw new AppError("You can only add mutual friends to a group.", httpStatus.FORBIDDEN);
    }

    const allMemberIds = [user.id, ...uniqueMemberIds];

    const group = await this.groupRepository.create({
      name: trimmedName,
      avatarKey: payload.avatarKey ?? null,
      createdBy: user.id,
      memberIds: allMemberIds,
    });

    return this.toGroupConversationResponse(group);
  }

  public async listGroups(user: AuthUser, query: ListGroupsQuery): Promise<GroupConversationResponse[]> {
    const groups = await this.groupRepository.findGroupsForUser(user.id, query.limit ?? 100);

    return Promise.all(groups.map((group) => this.toGroupConversationResponse(group)));
  }

  public async createGroupMessage(
    user: AuthUser,
    groupId: string,
    payload: CreateGroupMessageDto,
  ): Promise<GroupMessageResponse> {
    const isMember = await this.groupRepository.isMember(groupId, user.id);

    if (!isMember) {
      throw new AppError("You are not a member of this group.", httpStatus.FORBIDDEN);
    }

    const message = await this.groupRepository.createMessage({
      groupId,
      senderId: user.id,
      text: payload.text,
    });

    await this.groupRepository.updateLastMessage(groupId, payload.text, message.createdAt);

    return {
      id: message._id.toString(),
      groupId: message.groupId.toString(),
      senderId: message.senderId.toString(),
      senderName: user.name,
      text: message.text,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    };
  }

  public async listGroupMessages(
    user: AuthUser,
    groupId: string,
    query: ListGroupMessageHistoryQuery,
  ): Promise<GroupMessageResponse[]> {
    const isMember = await this.groupRepository.isMember(groupId, user.id);

    if (!isMember) {
      throw new AppError("You are not a member of this group.", httpStatus.FORBIDDEN);
    }

    const messages = await this.groupRepository.findMessages(groupId, query.limit ?? 50, query.before);

    return messages.reverse().map((message) => ({
      id: message._id.toString(),
      groupId: message.groupId.toString(),
      senderId: message.senderId.toString(),
      senderName: "",
      text: message.text,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    }));
  }

  public async assertIsMember(userId: string, groupId: string): Promise<void> {
    const isMember = await this.groupRepository.isMember(groupId, userId);

    if (!isMember) {
      throw new AppError("You are not a member of this group.", httpStatus.FORBIDDEN);
    }
  }

  public async getGroupMemberIds(groupId: string): Promise<string[]> {
    return this.groupRepository.getMemberIds(groupId);
  }

  private async toGroupConversationResponse(group: IGroup): Promise<GroupConversationResponse> {
    const avatarUrl = group.avatarKey
      ? (await this.storageService.createDownloadUrl(group.avatarKey)).url
      : null;

    return {
      id: group._id.toString(),
      type: "group",
      name: group.name,
      avatarKey: group.avatarKey ?? null,
      avatarUrl,
      memberCount: group.members.length,
      lastMessage: group.lastMessage ?? null,
      lastMessageAt: group.lastMessageAt ?? null,
      unreadCount: 0,
      createdBy: group.createdBy.toString(),
    };
  }
}
