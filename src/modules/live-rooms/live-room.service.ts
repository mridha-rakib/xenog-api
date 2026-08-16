import httpStatus from "http-status";
import { AppError } from "../../core/errors/app-error.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { EventChatAccessService } from "../events/event-chat-access.service.js";
import { StorageService } from "../storage/storage.service.js";
import type { IUser } from "../user/user.interface.js";
import { UserRepository } from "../user/user.repository.js";
import type {
  CreateLiveRoomMessageDto,
  CreateLiveRoomDto,
  ILiveRoom,
  ILiveRoomMessage,
  ILiveRoomParticipant,
  ListLiveRoomMessagesQuery,
  LiveRoomMessageResponse,
  LiveRoomParticipantResponse,
  LiveRoomResponse,
  LiveRoomUserResponse,
  UpdateLiveRoomPermissionsDto,
} from "./live-room.interface.js";
import { LiveRoomMessageRepository } from "./live-room-message.repository.js";
import { LiveRoomParticipantRepository } from "./live-room-participant.repository.js";
import { LiveRoomRepository } from "./live-room.repository.js";

export class LiveRoomService {
  public constructor(
    private readonly liveRoomRepository = new LiveRoomRepository(),
    private readonly participantRepository = new LiveRoomParticipantRepository(),
    private readonly messageRepository = new LiveRoomMessageRepository(),
    private readonly userRepository = new UserRepository(),
    private readonly storageService = new StorageService(),
    private readonly eventChatAccessService = new EventChatAccessService(),
  ) {}

  public async createLiveRoom(
    user: AuthUser,
    payload: CreateLiveRoomDto,
  ): Promise<LiveRoomResponse> {
    const liveRoom = await this.liveRoomRepository.create({
      hostUserId: user.id,
      title: payload.title.trim(),
      allowAllParticipantsToSpeak: payload.allowAllParticipantsToSpeak,
      speakerIds: this.normalizeSpeakerIds(payload.speakerIds ?? [], user.id),
    });

    await this.participantRepository.join(liveRoom._id.toString(), user.id);

    return this.toResponse(liveRoom, user);
  }

  public async getLiveRoom(user: AuthUser, liveRoomId: string): Promise<LiveRoomResponse> {
    await this.assertEventChatAccess(user, liveRoomId);

    const liveRoom = await this.getExistingLiveRoom(liveRoomId);

    return this.toResponse(liveRoom, user);
  }

  public async joinLiveRoom(user: AuthUser, liveRoomId: string): Promise<LiveRoomResponse> {
    await this.assertEventChatAccess(user, liveRoomId);

    const liveRoom = await this.getExistingLiveRoom(liveRoomId);

    if (liveRoom.status !== "live") {
      throw new AppError("This live room has ended.", httpStatus.BAD_REQUEST);
    }

    await this.participantRepository.join(liveRoomId, user.id);

    return this.toResponse(liveRoom, user);
  }

  public async leaveLiveRoom(user: AuthUser, liveRoomId: string): Promise<LiveRoomResponse> {
    const liveRoom = await this.getExistingLiveRoom(liveRoomId);

    await this.participantRepository.leave(liveRoomId, user.id);

    return this.toResponse(liveRoom, user);
  }

  public async updatePermissions(
    user: AuthUser,
    liveRoomId: string,
    payload: UpdateLiveRoomPermissionsDto,
  ): Promise<LiveRoomResponse> {
    const liveRoom = await this.getExistingLiveRoom(liveRoomId);

    if (liveRoom.hostUserId.toString() !== user.id) {
      throw new AppError(
        "Only the room host can update speaking permissions.",
        httpStatus.FORBIDDEN,
      );
    }

    const updatedLiveRoom = await this.liveRoomRepository.updatePermissionsByIdForHost(
      liveRoomId,
      user.id,
      {
        allowAllParticipantsToSpeak: payload.allowAllParticipantsToSpeak,
        speakerIds:
          payload.speakerIds === undefined
            ? undefined
            : this.normalizeSpeakerIds(payload.speakerIds, user.id),
      },
    );

    if (!updatedLiveRoom) {
      throw new AppError("Live room not found.", httpStatus.NOT_FOUND);
    }

    return this.toResponse(updatedLiveRoom, user);
  }

  public async listMessages(
    user: AuthUser,
    liveRoomId: string,
    query: ListLiveRoomMessagesQuery,
  ): Promise<LiveRoomMessageResponse[]> {
    await this.assertEventChatAccess(user, liveRoomId);

    const liveRoom = await this.liveRoomRepository.findById(liveRoomId);

    if (!liveRoom) {
      return [];
    }

    const messages = await this.messageRepository.findByLiveRoomId(liveRoomId, query);
    const orderedMessages = messages.reverse();
    const senderById = await this.loadUsersByIds(
      orderedMessages.map((message) => message.senderId.toString()),
      user,
    );

    return Promise.all(
      orderedMessages.map((message) =>
        this.toMessageResponse(message, senderById.get(message.senderId.toString()) ?? null),
      ),
    );
  }

  public async createMessage(
    user: AuthUser,
    liveRoomId: string,
    payload: CreateLiveRoomMessageDto,
  ): Promise<LiveRoomMessageResponse> {
    await this.assertEventChatAccess(user, liveRoomId);

    const liveRoom = await this.getExistingLiveRoom(liveRoomId);

    if (liveRoom.status !== "live") {
      throw new AppError("This live room has ended.", httpStatus.BAD_REQUEST);
    }

    const message = await this.messageRepository.create({
      liveRoomId,
      senderId: user.id,
      text: payload.text.trim(),
      clientMessageId: payload.clientMessageId ?? null,
    });

    await this.participantRepository.join(liveRoomId, user.id);

    return this.toMessageResponse(message, user);
  }

  public async assertEventChatAccess(user: AuthUser, eventId: string): Promise<void> {
    await this.eventChatAccessService.assertEventChatAccess(eventId, user.id);
  }

  private normalizeSpeakerIds(speakerIds: string[], hostUserId: string): string[] {
    return [
      ...new Set(
        speakerIds
          .map((speakerId) => speakerId.trim())
          .filter((speakerId) => speakerId !== hostUserId),
      ),
    ];
  }

  private async getExistingLiveRoom(liveRoomId: string): Promise<ILiveRoom> {
    const liveRoom = await this.liveRoomRepository.findById(liveRoomId);

    if (!liveRoom) {
      throw new AppError("Live room not found.", httpStatus.NOT_FOUND);
    }

    return liveRoom;
  }

  private async toResponse(liveRoom: ILiveRoom, viewer: AuthUser): Promise<LiveRoomResponse> {
    const hostUserId = liveRoom.hostUserId.toString();
    const speakerIds = liveRoom.speakerIds.map((speakerId) => speakerId.toString());
    const isHost = hostUserId === viewer.id;
    const isDesignatedSpeaker = speakerIds.includes(viewer.id);
    const canSpeak = isHost || liveRoom.allowAllParticipantsToSpeak || isDesignatedSpeaker;
    const liveRoomId = liveRoom._id.toString();
    const [host, participants, listenerCount] = await Promise.all([
      this.userRepository.findById(hostUserId),
      this.participantRepository.findActiveByLiveRoomId(liveRoomId),
      this.participantRepository.countActiveByLiveRoomId(liveRoomId),
    ]);
    const participantUserById = await this.loadUsersByIds(
      participants.map((participant) => participant.userId.toString()),
      viewer,
    );

    return {
      id: liveRoomId,
      hostUserId,
      host: await this.toUserResponse(host),
      title: liveRoom.title,
      allowAllParticipantsToSpeak: liveRoom.allowAllParticipantsToSpeak,
      speakerIds,
      listenerCount,
      participants: await Promise.all(
        participants.map((participant) =>
          this.toParticipantResponse(
            participant,
            liveRoom,
            participantUserById.get(participant.userId.toString()) ?? null,
          ),
        ),
      ),
      status: liveRoom.status,
      viewerPermissions: {
        isHost,
        canSpeak,
        canManagePermissions: isHost,
      },
      createdAt: liveRoom.createdAt,
      updatedAt: liveRoom.updatedAt,
    };
  }

  private async toParticipantResponse(
    participant: ILiveRoomParticipant,
    liveRoom: ILiveRoom,
    user: IUser | AuthUser | null,
  ): Promise<LiveRoomParticipantResponse> {
    const userId = participant.userId.toString();
    const hostUserId = liveRoom.hostUserId.toString();
    const isHost = hostUserId === userId;

    return {
      id: participant._id.toString(),
      user: await this.toUserResponse(user),
      isActive: participant.isActive,
      canSpeak:
        isHost ||
        liveRoom.allowAllParticipantsToSpeak ||
        liveRoom.speakerIds.some((speakerId) => speakerId.toString() === userId),
      isHost,
      joinedAt: participant.joinedAt,
      leftAt: participant.leftAt ?? null,
    };
  }

  private async toMessageResponse(
    message: ILiveRoomMessage,
    sender: IUser | AuthUser | null,
  ): Promise<LiveRoomMessageResponse> {
    const senderResponse = await this.toUserResponse(sender);

    return {
      id: message._id.toString(),
      liveRoomId: message.liveRoomId.toString(),
      senderId: message.senderId.toString(),
      senderName: senderResponse?.name ?? "Mooment User",
      senderAvatarUrl: senderResponse?.avatarUrl ?? null,
      text: message.text,
      clientMessageId: message.clientMessageId ?? null,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    };
  }

  /** Batches a list of user ids into a single query (plus the viewer, which
   * is already in hand) instead of one `findById` per row — used by both
   * message-sender and participant rendering. */
  private async loadUsersByIds(
    userIds: string[],
    viewer: AuthUser,
  ): Promise<Map<string, IUser | AuthUser>> {
    const distinctIds = [...new Set(userIds)];
    const idsToFetch = distinctIds.filter((id) => id !== viewer.id);
    const fetchedUsers = idsToFetch.length > 0 ? await this.userRepository.findByIds(idsToFetch) : [];

    const usersById = new Map<string, IUser | AuthUser>(
      fetchedUsers.map((fetchedUser) => [fetchedUser._id.toString(), fetchedUser]),
    );

    if (distinctIds.includes(viewer.id)) {
      usersById.set(viewer.id, viewer);
    }

    return usersById;
  }

  private async toUserResponse(
    user: IUser | AuthUser | null,
  ): Promise<LiveRoomUserResponse | null> {
    if (!user) {
      return null;
    }

    return {
      id: "_id" in user ? user._id.toString() : user.id,
      name: user.name,
      username: user.username,
      avatarKey: user.avatarKey ?? null,
      avatarUrl: user.avatarKey ? await this.getAvatarUrl(user.avatarKey) : null,
    };
  }

  private async getAvatarUrl(avatarKey: string): Promise<string | null> {
    try {
      const download = await this.storageService.createDownloadUrl(avatarKey);

      return download.url;
    } catch {
      return null;
    }
  }
}
