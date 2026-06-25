import httpStatus from "http-status";
import { AppError } from "../../core/errors/app-error.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { StorageService } from "../storage/storage.service.js";
import type { IUser } from "../user/user.interface.js";
import { UserBlockRepository } from "../user/user-block.repository.js";
import { UserFollowRepository } from "../user/user-follow.repository.js";
import { UserRepository } from "../user/user.repository.js";
import { presenceService } from "../realtime/presence.service.js";
import { ChatDeletionRepository } from "./chat-deletion.repository.js";
import { ChatMessageRepository } from "./chat-message.repository.js";
import type {
  CreateDirectMessageDto,
  DirectMessageConversationResponse,
  DirectMessageResponse,
  IChatMessage,
  ListDirectMessageHistoryQuery,
  ListDirectMessagesQuery,
} from "./chat.interface.js";

export class ChatService {
  public constructor(
    private readonly userRepository = new UserRepository(),
    private readonly userFollowRepository = new UserFollowRepository(),
    private readonly userBlockRepository = new UserBlockRepository(),
    private readonly storageService = new StorageService(),
    private readonly chatMessageRepository = new ChatMessageRepository(),
    private readonly chatDeletionRepository = new ChatDeletionRepository(),
  ) {}

  public async listDirectMessages(
    user: AuthUser,
    query: ListDirectMessagesQuery,
  ): Promise<DirectMessageConversationResponse[]> {
    const friendIds = await this.userFollowRepository.findMutualFriendIds(user.id);

    if (friendIds.length === 0) {
      return [];
    }

    const friends = await this.userRepository.findFriendsByIds(
      friendIds,
      query.search,
      query.limit ?? friendIds.length,
    );

    const conversationIdsByFriendId = new Map(
      friends.map((f) => [f._id.toString(), this.getConversationId(user.id, f._id.toString())]),
    );
    const conversationIds = [...conversationIdsByFriendId.values()];

    const [latestMessages, unreadCounts, blockedIds, hiddenConversationIds] = await Promise.all([
      this.chatMessageRepository.findLatestByConversationIds(conversationIds),
      this.chatMessageRepository.countUnreadByConversationIds(user.id, conversationIds),
      this.userBlockRepository.findBlockedIds(user.id),
      this.chatDeletionRepository.findHiddenIds(user.id),
    ]);

    const blockedSet = new Set(blockedIds);

    const visible = friends.filter((f) => {
      const conversationId =
        conversationIdsByFriendId.get(f._id.toString()) ??
        this.getConversationId(user.id, f._id.toString());
      return !hiddenConversationIds.has(conversationId);
    });

    const conversations = await Promise.all(
      visible.map((friend) => {
        const friendId = friend._id.toString();
        const conversationId =
          conversationIdsByFriendId.get(friendId) ?? this.getConversationId(user.id, friendId);

        return this.toDirectMessageConversation(
          friend,
          conversationId,
          latestMessages.get(conversationId) ?? null,
          unreadCounts.get(conversationId) ?? 0,
          blockedSet.has(friendId),
        );
      }),
    );

    return conversations.sort((a, b) => {
      if (a.lastMessageAt && b.lastMessageAt) {
        return b.lastMessageAt.getTime() - a.lastMessageAt.getTime();
      }
      if (a.lastMessageAt) return -1;
      if (b.lastMessageAt) return 1;
      return a.name.localeCompare(b.name);
    });
  }

  public async listDirectMessageHistory(
    user: AuthUser,
    friendId: string,
    query: ListDirectMessageHistoryQuery,
  ): Promise<DirectMessageResponse[]> {
    await this.assertCanDirectMessage(user.id, friendId);

    const conversationId = this.getConversationId(user.id, friendId);
    const messages = await this.chatMessageRepository.findConversationMessages(
      conversationId,
      query.limit ?? 50,
      query.before,
    );

    await this.chatMessageRepository.markConversationRead(conversationId, user.id);

    return messages.reverse().map((m) => this.toDirectMessageResponse(m));
  }

  public async createDirectMessage(
    user: AuthUser,
    friendId: string,
    payload: CreateDirectMessageDto,
  ): Promise<DirectMessageResponse> {
    await this.assertCanDirectMessage(user.id, friendId);

    const conversationId = this.getConversationId(user.id, friendId);

    // Restore conversation if the user had previously deleted it
    await this.chatDeletionRepository.restore(user.id, conversationId);

    const message = await this.chatMessageRepository.create({
      conversationId,
      recipientId: friendId,
      senderId: user.id,
      text: payload.text,
      type: "text",
    });

    return this.toDirectMessageResponse(message);
  }

  public async deleteConversation(user: AuthUser, friendId: string): Promise<void> {
    if (user.id === friendId) {
      throw new AppError("Invalid conversation.", httpStatus.BAD_REQUEST);
    }

    const conversationId = this.getConversationId(user.id, friendId);
    await this.chatDeletionRepository.hide(user.id, conversationId);
  }

  private async toDirectMessageConversation(
    user: IUser,
    conversationId: string,
    latestMessage: IChatMessage | null,
    unreadCount: number,
    isBlocked: boolean,
  ): Promise<DirectMessageConversationResponse> {
    const friendId = user._id.toString();
    const avatarUrl = user.avatarKey
      ? (await this.storageService.createDownloadUrl(user.avatarKey)).url
      : null;

    return {
      id: conversationId,
      type: "direct",
      friendId,
      name: user.name,
      username: user.username,
      avatarKey: user.avatarKey ?? null,
      avatarUrl,
      lastMessage: latestMessage?.text ?? null,
      lastMessageAt: latestMessage?.createdAt ?? null,
      unreadCount,
      isOnline: presenceService.isOnline(friendId),
      isBlocked,
    };
  }

  private toDirectMessageResponse(message: IChatMessage): DirectMessageResponse {
    return {
      id: message._id.toString(),
      conversationId: message.conversationId,
      senderId: message.senderId.toString(),
      recipientId: message.recipientId.toString(),
      type: message.type,
      text: message.text,
      readAt: message.readAt ?? null,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    };
  }

  public async assertCanDirectMessage(userId: string, friendId: string): Promise<void> {
    if (userId === friendId) {
      throw new AppError("You cannot send a direct message to yourself.", httpStatus.BAD_REQUEST);
    }

    const [friend, senderFollowsRecipient, recipientFollowsSender] = await Promise.all([
      this.userRepository.findById(friendId),
      this.userFollowRepository.isFollowing(userId, friendId),
      this.userFollowRepository.isFollowing(friendId, userId),
    ]);

    if (!friend || friend.role !== "user" || !friend.isActive || !friend.emailVerified) {
      throw new AppError("Friend not found.", httpStatus.NOT_FOUND);
    }

    if (!senderFollowsRecipient || !recipientFollowsSender) {
      throw new AppError("You can only message mutual friends.", httpStatus.FORBIDDEN);
    }
  }

  private getConversationId(userId: string, friendId: string): string {
    return [userId.toLowerCase(), friendId.toLowerCase()].sort().join(":");
  }
}
