import httpStatus from "http-status";
import { AppError } from "../../core/errors/app-error.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { StorageService } from "../storage/storage.service.js";
import type { IUser } from "../user/user.interface.js";
import { UserFollowRepository } from "../user/user-follow.repository.js";
import { UserRepository } from "../user/user.repository.js";
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
    private readonly storageService = new StorageService(),
    private readonly chatMessageRepository = new ChatMessageRepository(),
  ) {}

  public async listDirectMessages(
    user: AuthUser,
    query: ListDirectMessagesQuery,
  ): Promise<DirectMessageConversationResponse[]> {
    const friendIds = await this.userFollowRepository.findMutualFriendIds(user.id);

    if (friendIds.length === 0) {
      return [];
    }

    const friends = await this.userRepository.findFriendsByIds(friendIds, query.search, query.limit ?? friendIds.length);
    const conversationIdsByFriendId = new Map(
      friends.map((friend) => [friend._id.toString(), this.getConversationId(user.id, friend._id.toString())]),
    );
    const conversationIds = [...conversationIdsByFriendId.values()];
    const [latestMessages, unreadCounts] = await Promise.all([
      this.chatMessageRepository.findLatestByConversationIds(conversationIds),
      this.chatMessageRepository.countUnreadByConversationIds(user.id, conversationIds),
    ]);

    const conversations = await Promise.all(
      friends.map((friend) => {
        const friendId = friend._id.toString();
        const conversationId = conversationIdsByFriendId.get(friendId) ?? this.getConversationId(user.id, friendId);

        return this.toDirectMessageConversation(
          friend,
          conversationId,
          latestMessages.get(conversationId) ?? null,
          unreadCounts.get(conversationId) ?? 0,
        );
      }),
    );

    return conversations.sort((a, b) => {
      if (a.lastMessageAt && b.lastMessageAt) {
        return b.lastMessageAt.getTime() - a.lastMessageAt.getTime();
      }

      if (a.lastMessageAt) {
        return -1;
      }

      if (b.lastMessageAt) {
        return 1;
      }

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

    return messages.reverse().map((message) => this.toDirectMessageResponse(message));
  }

  public async createDirectMessage(
    user: AuthUser,
    friendId: string,
    payload: CreateDirectMessageDto,
  ): Promise<DirectMessageResponse> {
    await this.assertCanDirectMessage(user.id, friendId);

    const message = await this.chatMessageRepository.create({
      conversationId: this.getConversationId(user.id, friendId),
      recipientId: friendId,
      senderId: user.id,
      text: payload.text,
      type: "text",
    });

    return this.toDirectMessageResponse(message);
  }

  private async toDirectMessageConversation(
    user: IUser,
    conversationId: string,
    latestMessage: IChatMessage | null,
    unreadCount: number,
  ): Promise<DirectMessageConversationResponse> {
    const friendId = user._id.toString();
    const avatarUrl = user.avatarKey ? (await this.storageService.createDownloadUrl(user.avatarKey)).url : null;

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
      isOnline: false,
      isBlocked: false,
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
