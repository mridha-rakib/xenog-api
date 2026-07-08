import httpStatus from "http-status";
import { AppError } from "../../core/errors/app-error.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { StorageService } from "../storage/storage.service.js";
import type { IUser } from "../user/user.interface.js";
import { UserBlockRepository } from "../user/user-block.repository.js";
import { UserFollowRepository } from "../user/user-follow.repository.js";
import { UserRepository } from "../user/user.repository.js";
import { presenceService } from "../realtime/presence.service.js";
import { EventRepository } from "../events/event.repository.js";
import { MomentRepository } from "../moments/moment.repository.js";
import { ChatDeletionRepository } from "./chat-deletion.repository.js";
import { ChatMessageRepository } from "./chat-message.repository.js";
import type {
  ChatFileAttachment,
  ChatMessageAttachment,
  ChatMessageType,
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
    private readonly eventRepository = new EventRepository(),
    private readonly momentRepository = new MomentRepository(),
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

    const visible = query.includeHidden ? friends : friends.filter((f) => {
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

    return Promise.all(messages.reverse().map((m) => this.toDirectMessageResponse(m)));
  }

  public async createDirectMessage(
    user: AuthUser,
    friendId: string,
    payload: CreateDirectMessageDto,
  ): Promise<DirectMessageResponse> {
    await this.assertCanDirectMessage(user.id, friendId);

    const conversationId = this.getConversationId(user.id, friendId);
    const type = payload.type ?? payload.attachment?.type ?? "text";
    const text = payload.text?.trim() ?? "";
    const attachment = await this.normalizeAttachment(user.id, type, payload.attachment ?? null);

    // Restore conversation if the user had previously deleted it
    await this.chatDeletionRepository.restore(user.id, conversationId);

    const message = await this.chatMessageRepository.create({
      conversationId,
      recipientId: friendId,
      senderId: user.id,
      text,
      type,
      attachment,
      clientMessageId: payload.clientMessageId ?? null,
    });

    return this.toDirectMessageResponse(message);
  }

  public async editDirectMessage(
    user: AuthUser,
    messageId: string,
    text: string,
  ): Promise<DirectMessageResponse> {
    const message = await this.chatMessageRepository.findById(messageId);

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

    const updated = await this.chatMessageRepository.updateOwnedText(messageId, user.id, trimmedText);
    if (!updated) {
      throw new AppError("Message not found.", httpStatus.NOT_FOUND);
    }

    return this.toDirectMessageResponse(updated);
  }

  public async deleteDirectMessage(user: AuthUser, messageId: string): Promise<DirectMessageResponse> {
    const message = await this.chatMessageRepository.findById(messageId);

    if (!message) {
      throw new AppError("Message not found.", httpStatus.NOT_FOUND);
    }

    if (message.senderId.toString() !== user.id) {
      throw new AppError("You can only delete your own messages.", httpStatus.FORBIDDEN);
    }

    const deleted = await this.chatMessageRepository.deleteOwned(messageId, user.id);
    if (!deleted) {
      throw new AppError("Message not found.", httpStatus.NOT_FOUND);
    }

    return this.toDirectMessageResponse(deleted);
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
      lastMessage: latestMessage
        ? this.getMessageSummary(latestMessage.type, latestMessage.text, latestMessage.attachment ?? null)
        : null,
      lastMessageAt: latestMessage?.createdAt ?? null,
      unreadCount,
      isOnline: presenceService.isOnline(friendId),
      isBlocked,
    };
  }

  private async toDirectMessageResponse(message: IChatMessage): Promise<DirectMessageResponse> {
    return {
      id: message._id.toString(),
      conversationId: message.conversationId,
      senderId: message.senderId.toString(),
      recipientId: message.recipientId.toString(),
      type: message.type,
      text: message.text,
      attachment: await this.resolveAttachmentUrls(message.attachment ?? null),
      readAt: message.readAt ?? null,
      editedAt: message.editedAt ?? null,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    };
  }

  public async normalizeAttachment(
    userId: string,
    type: ChatMessageType,
    attachment: ChatMessageAttachment | null,
  ): Promise<ChatMessageAttachment | null> {
    if (type === "text") {
      return null;
    }

    if (!attachment || attachment.type !== type) {
      throw new AppError("Attachment is required.", httpStatus.BAD_REQUEST);
    }

    if (attachment.type === "location") {
      return {
        type: "location",
        latitude: attachment.latitude,
        longitude: attachment.longitude,
        label: attachment.label?.trim() || null,
        address: attachment.address?.trim() || null,
      };
    }

    if (attachment.type === "event") {
      return this.normalizeEventAttachment(userId, attachment.eventId);
    }

    if (attachment.type === "post") {
      return this.normalizePostAttachment(attachment.postId);
    }

    return this.normalizeFileAttachment(userId, attachment);
  }

  public async resolveAttachmentUrls(
    attachment: ChatMessageAttachment | null,
  ): Promise<ChatMessageAttachment | null> {
    if (!attachment) {
      return null;
    }

    if (attachment.type === "image" || attachment.type === "video" || attachment.type === "audio") {
      try {
        const download = await this.storageService.createDownloadUrl(attachment.key);
        return { ...attachment, url: download.url };
      } catch {
        return attachment;
      }
    }

    if (attachment.type === "event" && attachment.coverImageKey) {
      try {
        const download = await this.storageService.createDownloadUrl(attachment.coverImageKey);
        return { ...attachment, coverImageUrl: download.url };
      } catch {
        return attachment;
      }
    }

    if (attachment.type === "post" && attachment.imageKey) {
      try {
        const download = await this.storageService.createDownloadUrl(attachment.imageKey);
        return { ...attachment, imageUrl: attachment.imageUrl ?? download.url };
      } catch {
        return attachment;
      }
    }

    return attachment;
  }

  public getMessageSummary(
    type: ChatMessageType,
    text: string,
    attachment: ChatMessageAttachment | null,
  ): string {
    if (type === "text") {
      return text;
    }

    if (type === "event" && attachment?.type === "event") {
      return `Event: ${attachment.title ?? "Shared event"}`;
    }

    if (type === "post" && attachment?.type === "post") {
      return `Post: ${attachment.preview ?? "Shared post"}`;
    }

    const labels: Record<Exclude<ChatMessageType, "text">, string> = {
      image: "Photo",
      video: "Video",
      audio: "Audio",
      location: "Location",
      event: "Event",
      post: "Post",
    };

    return text || labels[type];
  }

  private async normalizeFileAttachment(
    userId: string,
    attachment: ChatFileAttachment,
  ): Promise<ChatFileAttachment> {
    const key = attachment.key.trim();
    const mimeType = attachment.mimeType.trim().toLowerCase();
    const maxSize = this.getMaxFileSize(attachment.type);

    if (!key.startsWith(`chat/${userId}/`)) {
      throw new AppError("Attachment key does not belong to this user.", httpStatus.FORBIDDEN);
    }

    if (!this.isAllowedMimeType(attachment.type, mimeType)) {
      throw new AppError("Unsupported attachment file type.", httpStatus.BAD_REQUEST);
    }

    if (attachment.size > maxSize) {
      throw new AppError("Attachment file is too large.", 413);
    }

    const metadata = await this.storageService.getObjectMetadata(key).catch(() => null);

    if (!metadata) {
      throw new AppError("Attachment file was not found in storage.", httpStatus.BAD_REQUEST);
    }

    const storedContentType = metadata.contentType?.toLowerCase().split(";")[0] ?? null;
    const storedSize = metadata.contentLength ?? attachment.size;

    if (storedSize > maxSize) {
      throw new AppError("Attachment file is too large.", 413);
    }

    if (storedContentType && storedContentType !== mimeType) {
      throw new AppError("Attachment MIME type does not match the uploaded file.", httpStatus.BAD_REQUEST);
    }

    return {
      type: attachment.type,
      key,
      mimeType,
      size: storedSize,
      fileName: attachment.fileName?.trim() || null,
      width: attachment.width ?? null,
      height: attachment.height ?? null,
      durationSeconds: attachment.durationSeconds ?? null,
    };
  }

  private async normalizeEventAttachment(userId: string, eventId: string): Promise<ChatMessageAttachment> {
    const event = await this.eventRepository.findById(eventId);

    if (!event || event.status === "draft") {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    const isOwner = event.userId.toString() === userId;
    const isMember = event.memberUserIds.some((id) => id.toString() === userId);

    if (event.privacy === "private" && !isOwner && !isMember) {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    return {
      type: "event",
      eventId: event._id.toString(),
      title: event.name ?? "Event",
      scheduledAt: event.scheduledAt ?? null,
      endAt: event.endAt ?? null,
      coverImageKey: event.bannerImageKey ?? null,
      locationName: event.location?.venue ?? event.location?.searchLabel ?? null,
      address: event.location?.address ?? null,
    };
  }

  private async normalizePostAttachment(postId: string): Promise<ChatMessageAttachment> {
    const moment = await this.momentRepository.findById(postId);

    if (!moment || moment.isEventAnnouncement || moment.audience !== "public") {
      throw new AppError("Post not found or cannot be shared.", httpStatus.NOT_FOUND);
    }

    const author = await this.userRepository.findById(moment.userId.toString());
    const image = moment.mediaItems.find((item) => item.type === "image");

    return {
      type: "post",
      postId: moment._id.toString(),
      preview: moment.caption?.trim().slice(0, 240) || "Shared post",
      imageKey: image?.storageKey ?? null,
      imageUrl: image?.url ?? null,
      authorName: author?.name ?? null,
    };
  }

  private getMaxFileSize(type: ChatFileAttachment["type"]): number {
    if (type === "image") return 15 * 1024 * 1024;
    if (type === "audio") return 50 * 1024 * 1024;
    return 250 * 1024 * 1024;
  }

  private isAllowedMimeType(type: ChatFileAttachment["type"], mimeType: string): boolean {
    const allowed: Record<ChatFileAttachment["type"], Set<string>> = {
      image: new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]),
      video: new Set(["video/mp4", "video/quicktime", "video/webm", "video/3gpp", "video/x-m4v"]),
      audio: new Set([
        "audio/mpeg",
        "audio/mp4",
        "audio/x-m4a",
        "audio/aac",
        "audio/wav",
        "audio/x-wav",
        "audio/webm",
        "audio/3gpp",
        "audio/ogg",
      ]),
    };

    return allowed[type].has(mimeType);
  }

  public async assertCanDirectMessage(userId: string, friendId: string): Promise<void> {
    if (userId === friendId) {
      throw new AppError("You cannot send a direct message to yourself.", httpStatus.BAD_REQUEST);
    }

    const [
      friend,
      senderFollowsRecipient,
      recipientFollowsSender,
      senderBlockedRecipient,
      recipientBlockedSender,
    ] = await Promise.all([
      this.userRepository.findById(friendId),
      this.userFollowRepository.isFollowing(userId, friendId),
      this.userFollowRepository.isFollowing(friendId, userId),
      this.userBlockRepository.isBlocked(userId, friendId),
      this.userBlockRepository.isBlocked(friendId, userId),
    ]);

    if (!friend || friend.role !== "user" || !friend.isActive || !friend.emailVerified) {
      throw new AppError("Friend not found.", httpStatus.NOT_FOUND);
    }

    if (senderBlockedRecipient || recipientBlockedSender) {
      throw new AppError("You cannot message this user.", httpStatus.FORBIDDEN);
    }

    if (!senderFollowsRecipient || !recipientFollowsSender) {
      throw new AppError("You can only message mutual friends.", httpStatus.FORBIDDEN);
    }
  }

  private getConversationId(userId: string, friendId: string): string {
    return [userId.toLowerCase(), friendId.toLowerCase()].sort().join(":");
  }
}
