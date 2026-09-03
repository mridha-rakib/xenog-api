import httpStatus from "http-status";
import { AppError } from "../../core/errors/app-error.js";
import { env } from "../../config/env.js";
import { createPaginationMeta, getPaginationOptions, type PaginatedResult } from "../../core/utils/pagination.js";
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
import { DirectMessageBlockRepository, type MessageBlockedUserRecord } from "./direct-message-block.repository.js";
import type {
  ChatFileAttachment,
  ChatMessageAttachment,
  ChatMessageType,
  CreateDirectMessageDto,
  DirectMessageConversationResponse,
  DirectMessageRelationshipResponse,
  DirectMessageResponse,
  IChatMessage,
  ListDirectMessageHistoryQuery,
  ListDirectMessagesQuery,
  MessageBlockedUserResponse,
  MessageBlockStatusResponse,
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
    private readonly directMessageBlockRepository = new DirectMessageBlockRepository(),
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
    await this.assertCanReadDirectMessages(user.id, friendId);

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
    await this.assertCanSendDirectMessage(user.id, friendId);

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

    // Video is temporarily disabled — never resolve/return a playable URL
    // *or* the raw storage key for a video attachment, even an existing
    // one. `key` is redacted (not just left without a `url`) because
    // GET /storage/file resolves any key it's given, unauthenticated, so
    // leaving it in the response would still let a client stream the video
    // directly. Non-video attachment fields (fileName, size, dimensions,
    // etc.) are left untouched.
    if (attachment.type === "video" && !env.ENABLE_VIDEO_UPLOADS) {
      return { ...attachment, key: "", url: null };
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
    // Video chat attachments are temporarily disabled server-side too
    // (defense-in-depth — the mobile client already blocks video attachment
    // creation at its own single choke point). Text/image/audio messages are
    // untouched. Set ENABLE_VIDEO_UPLOADS=true (env.ts) to re-enable.
    if (attachment.type === "video" && !env.ENABLE_VIDEO_UPLOADS) {
      throw new AppError("Video attachments are temporarily unavailable.", httpStatus.BAD_REQUEST);
    }

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

  // Full/Profile Block (UserBlockModel) + mutual-friend requirement only —
  // the exact pre-existing assertCanDirectMessage body, unchanged, extracted
  // so both the read and send gates below share it instead of duplicating
  // it. Message-only block is deliberately NOT checked here: history reads
  // must remain unaffected by a message-only block (only Full Block may
  // restrict reading, exactly as it did before this split).
  private async assertNotFullyBlocked(userId: string, friendId: string): Promise<IUser> {
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

    if (!friend || friend.role !== "user") {
      throw new AppError("Friend not found.", httpStatus.NOT_FOUND);
    }

    // A deactivated (deleted) account keeps its rows so history stays intact,
    // but no new direct message may be started with it.
    if (!friend.isActive) {
      throw new AppError("This user is no longer available.", httpStatus.NOT_FOUND);
    }

    if (!friend.emailVerified) {
      throw new AppError("Friend not found.", httpStatus.NOT_FOUND);
    }

    if (senderBlockedRecipient || recipientBlockedSender) {
      throw new AppError("You cannot message this user.", httpStatus.FORBIDDEN);
    }

    if (!senderFollowsRecipient || !recipientFollowsSender) {
      throw new AppError("You can only message mutual friends.", httpStatus.FORBIDDEN);
    }

    return friend;
  }

  // Reading history: Full Block only, byte-identical to the pre-split
  // assertCanDirectMessage — a message-only block must never hide history.
  public async assertCanReadDirectMessages(userId: string, friendId: string): Promise<void> {
    await this.assertNotFullyBlocked(userId, friendId);
  }

  // Sending (and typing indicators, which reuse this): Full Block OR
  // Message Block, either direction. Both HTTP and Socket.IO/legacy-ws
  // message creation already funnel through createDirectMessage, so this
  // one method is the single centralized send gate for every transport.
  public async assertCanSendDirectMessage(userId: string, friendId: string): Promise<void> {
    await this.assertNotFullyBlocked(userId, friendId);

    const [senderMessageBlockedRecipient, recipientMessageBlockedSender] = await Promise.all([
      this.directMessageBlockRepository.isBlocked(userId, friendId),
      this.directMessageBlockRepository.isBlocked(friendId, userId),
    ]);

    if (senderMessageBlockedRecipient || recipientMessageBlockedSender) {
      throw new AppError("You cannot message this user.", httpStatus.FORBIDDEN);
    }
  }

  // ── Message-only block (DirectMessageBlock) — Chat-domain only. Must
  // never touch UserFollowRepository or UserBlockModel; must never be
  // consulted by Feed/Moment/Event/profile-visibility code. ──────────────

  public async blockMessages(user: AuthUser, targetUserId: string): Promise<MessageBlockStatusResponse> {
    if (user.id === targetUserId) {
      throw new AppError("You cannot message-block yourself.", httpStatus.BAD_REQUEST);
    }

    const target = await this.userRepository.findById(targetUserId);

    if (!target || target.role !== "user" || !target.isActive) {
      throw new AppError("User not found", httpStatus.NOT_FOUND);
    }

    await this.directMessageBlockRepository.block(user.id, targetUserId);

    return { userId: targetUserId, isMessageBlocked: true };
  }

  public async unblockMessages(user: AuthUser, targetUserId: string): Promise<MessageBlockStatusResponse> {
    if (user.id === targetUserId) {
      throw new AppError("You cannot message-unblock yourself.", httpStatus.BAD_REQUEST);
    }

    await this.directMessageBlockRepository.unblock(user.id, targetUserId);

    return { userId: targetUserId, isMessageBlocked: false };
  }

  public async listMessageBlockedUsers(
    user: AuthUser,
    query: { page?: number; limit?: number },
  ): Promise<PaginatedResult<MessageBlockedUserResponse>> {
    const { page, limit, skip } = getPaginationOptions({ page: query.page, limit: query.limit ?? 30 });
    const result = await this.directMessageBlockRepository.findBlockedUsers(user.id, skip, limit);

    return {
      data: await Promise.all(result.users.map((blockedUser) => this.toMessageBlockedUserResponse(blockedUser))),
      meta: createPaginationMeta(page, limit, result.total),
    };
  }

  // Combined Full Block + Message Block directional state for a single DM
  // pair, in one round trip — this is what Chat Detail polls on focus.
  public async getDirectMessageRelationship(
    user: AuthUser,
    friendId: string,
  ): Promise<DirectMessageRelationshipResponse> {
    const [fullBlockedByMe, fullBlockedMe, messageBlockedByMe, messageBlockedMe] = await Promise.all([
      this.userBlockRepository.isBlocked(user.id, friendId),
      this.userBlockRepository.isBlocked(friendId, user.id),
      this.directMessageBlockRepository.isBlocked(user.id, friendId),
      this.directMessageBlockRepository.isBlocked(friendId, user.id),
    ]);

    return {
      fullBlockedByMe,
      fullBlockedMe,
      messageBlockedByMe,
      messageBlockedMe,
      canMessage: !fullBlockedByMe && !fullBlockedMe && !messageBlockedByMe && !messageBlockedMe,
    };
  }

  private async toMessageBlockedUserResponse(
    user: MessageBlockedUserRecord,
  ): Promise<MessageBlockedUserResponse> {
    const avatarUrl = user.avatarKey
      ? await this.storageService.createDownloadUrl(user.avatarKey).then((download) => download.url).catch(() => null)
      : null;

    return {
      id: user._id.toString(),
      name: user.name,
      username: user.username,
      avatarKey: user.avatarKey ?? null,
      avatarUrl,
      blockedAt: user.blockedAt,
    };
  }

  private getConversationId(userId: string, friendId: string): string {
    return [userId.toLowerCase(), friendId.toLowerCase()].sort().join(":");
  }
}
