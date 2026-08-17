import httpStatus from "http-status";
import { AppError } from "../../core/errors/app-error.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { StorageService } from "../storage/storage.service.js";
import { UserFollowRepository } from "../user/user-follow.repository.js";
import { ChatService } from "./chat.service.js";
import { GroupRepository } from "./group.repository.js";
import type {
  CreateGroupDto,
  CreateGroupMessageDto,
  GroupConversationResponse,
  GroupMessageResponse,
  IGroup,
  IGroupMember,
  IGroupMessage,
  LeaveGroupResponse,
  ListGroupMessageHistoryQuery,
  ListGroupsQuery,
} from "./group.interface.js";

export class GroupService {
  public constructor(
    private readonly groupRepository = new GroupRepository(),
    private readonly userFollowRepository = new UserFollowRepository(),
    private readonly storageService = new StorageService(),
    private readonly chatService = new ChatService(),
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

    const type = payload.type ?? payload.attachment?.type ?? "text";
    const text = payload.text?.trim() ?? "";
    const attachment = await this.chatService.normalizeAttachment(user.id, type, payload.attachment ?? null);

    const message = await this.groupRepository.createMessage({
      groupId,
      senderId: user.id,
      type,
      text,
      attachment,
    });

    await this.groupRepository.updateLastMessage(
      groupId,
      this.chatService.getMessageSummary(message.type, message.text, message.attachment ?? null),
      message.createdAt,
    );

    return {
      id: message._id.toString(),
      groupId: message.groupId.toString(),
      senderId: message.senderId.toString(),
      senderName: user.name,
      type: message.type,
      text: message.text,
      attachment: await this.chatService.resolveAttachmentUrls(message.attachment ?? null),
      editedAt: message.editedAt ?? null,
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

    return Promise.all(
      messages.reverse().map(async (message) => ({
        id: message._id.toString(),
        groupId: message.groupId.toString(),
        senderId: message.senderId.toString(),
        senderName: "",
        type: message.type,
        text: message.text,
        attachment: await this.chatService.resolveAttachmentUrls(message.attachment ?? null),
        editedAt: message.editedAt ?? null,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
      })),
    );
  }

  public async editGroupMessage(
    user: AuthUser,
    messageId: string,
    text: string,
  ): Promise<GroupMessageResponse> {
    const message = await this.groupRepository.findMessageById(messageId);

    if (!message) {
      throw new AppError("Message not found.", httpStatus.NOT_FOUND);
    }

    if (message.senderId.toString() !== user.id) {
      throw new AppError("You can only edit your own messages.", httpStatus.FORBIDDEN);
    }

    if (message.type !== "text") {
      throw new AppError("Only text messages can be edited.", httpStatus.BAD_REQUEST);
    }

    const trimmedText = text.trim();
    if (!trimmedText) {
      throw new AppError("Message text is required.", httpStatus.BAD_REQUEST);
    }

    const updated = await this.groupRepository.updateOwnedMessageText(messageId, user.id, trimmedText);
    if (!updated) {
      throw new AppError("Message not found.", httpStatus.NOT_FOUND);
    }

    await this.syncGroupLastMessage(updated.groupId.toString());
    return this.toGroupMessageResponse(updated, user.name);
  }

  public async deleteGroupMessage(user: AuthUser, messageId: string): Promise<GroupMessageResponse> {
    const message = await this.groupRepository.findMessageById(messageId);

    if (!message) {
      throw new AppError("Message not found.", httpStatus.NOT_FOUND);
    }

    if (message.senderId.toString() !== user.id) {
      throw new AppError("You can only delete your own messages.", httpStatus.FORBIDDEN);
    }

    const deleted = await this.groupRepository.deleteOwnedMessage(messageId, user.id);
    if (!deleted) {
      throw new AppError("Message not found.", httpStatus.NOT_FOUND);
    }

    await this.syncGroupLastMessage(deleted.groupId.toString());
    return this.toGroupMessageResponse(deleted, user.name);
  }

  // Leave-group is a real membership mutation, never a reused DM action.
  // All decisions (member vs. owner, successor selection, deletion) are
  // made here against fresh in-transaction DB state — never trusting
  // role/owner info the frontend might supply.
  public async leaveGroup(user: AuthUser, groupId: string): Promise<LeaveGroupResponse> {
    return this.groupRepository.runTransaction(async (session) => {
      const group = await this.groupRepository.findByIdInSession(groupId, session);

      if (!group) {
        throw new AppError("Group not found.", httpStatus.NOT_FOUND);
      }

      const isMember = group.members.some((member) => member.userId.toString() === user.id);
      if (!isMember) {
        throw new AppError("You are not a member of this group.", httpStatus.FORBIDDEN);
      }

      const isOwner = group.createdBy.toString() === user.id;

      if (!isOwner) {
        const removed = await this.groupRepository.pullNonOwnerMember(groupId, user.id, session);
        if (!removed) {
          throw new AppError("Group membership changed, please try again.", httpStatus.CONFLICT);
        }

        return { groupId, status: "left" };
      }

      const remainingMembers = group.members.filter((member) => member.userId.toString() !== user.id);

      if (remainingMembers.length === 0) {
        const deleted = await this.groupRepository.deleteGroupWithMessages(groupId, session);
        if (!deleted) {
          throw new AppError("Group membership changed, please try again.", httpStatus.CONFLICT);
        }

        return { groupId, status: "group_deleted" };
      }

      const successor = this.selectOwnershipSuccessor(remainingMembers);

      const transferred = await this.groupRepository.transferOwnership(
        groupId,
        user.id,
        successor.userId.toString(),
        session,
      );
      if (!transferred) {
        throw new AppError("Group membership changed, please try again.", httpStatus.CONFLICT);
      }

      const removed = await this.groupRepository.pullFormerOwnerMember(groupId, user.id, session);
      if (!removed) {
        throw new AppError("Group membership changed, please try again.", httpStatus.CONFLICT);
      }

      return { groupId, status: "left", newOwnerId: successor.userId.toString() };
    });
  }

  // Deterministic successor selection: regular members are preferred over
  // admins (Priority 1), oldest `joinedAt` wins, and ties (identical
  // timestamps) are broken by ascending ObjectId string comparison — never
  // by array order or randomness — so the outcome is reproducible.
  private selectOwnershipSuccessor(candidates: IGroupMember[]): IGroupMember {
    const byJoinedAtThenId = (a: IGroupMember, b: IGroupMember): number => {
      const timeDiff = a.joinedAt.getTime() - b.joinedAt.getTime();
      return timeDiff !== 0 ? timeDiff : a.userId.toString().localeCompare(b.userId.toString());
    };

    const regularMembers = candidates.filter((member) => member.role === "member").sort(byJoinedAtThenId);
    const admins = candidates.filter((member) => member.role === "admin").sort(byJoinedAtThenId);
    const successor = regularMembers[0] ?? admins[0];

    if (!successor) {
      throw new AppError("Unable to determine group ownership successor.", httpStatus.INTERNAL_SERVER_ERROR);
    }

    return successor;
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

  private async syncGroupLastMessage(groupId: string): Promise<void> {
    const latest = await this.groupRepository.findLatestMessage(groupId);
    await this.groupRepository.updateLastMessage(
      groupId,
      latest
        ? this.chatService.getMessageSummary(latest.type, latest.text, latest.attachment ?? null)
        : null,
      latest?.createdAt ?? null,
    );
  }

  private async toGroupMessageResponse(
    message: IGroupMessage,
    senderName: string,
  ): Promise<GroupMessageResponse> {
    return {
      id: message._id.toString(),
      groupId: message.groupId.toString(),
      senderId: message.senderId.toString(),
      senderName,
      type: message.type,
      text: message.text,
      attachment: await this.chatService.resolveAttachmentUrls(message.attachment ?? null),
      editedAt: message.editedAt ?? null,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    };
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
