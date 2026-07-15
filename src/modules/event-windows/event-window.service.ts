import httpStatus from "http-status";
import { AppError } from "../../core/errors/app-error.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { EventRepository } from "../events/event.repository.js";
import type { IEvent } from "../events/event.interface.js";
import { TicketUsageRepository } from "../payments/ticket-usage.repository.js";
import { StorageService } from "../storage/storage.service.js";
import type {
  CreateEventWindowDto,
  CreateEventWindowPostDto,
  EventWindowComputedStatus,
  EventWindowMediaItem,
  EventWindowPostMediaResponse,
  EventWindowPostListResponse,
  EventWindowPostResponse,
  EventWindowResponse,
  IEventWindow,
  IEventWindowPost,
  ListEventWindowPostsOptions,
  UpdateEventWindowDto,
} from "./event-window.interface.js";
import { EVENT_WINDOW_MEDIA_LIMITS_BYTES as MEDIA_LIMITS } from "./event-window.interface.js";
import { EventWindowRepository } from "./event-window.repository.js";

type AuthorizedEventWindowMedia = {
  key: string;
  contentType?: string | null;
  filename: string;
};

const normalizeContentType = (value?: string | null): string => value?.split(";")[0]?.trim().toLowerCase() ?? "";

const contentTypeMatchesPostType = (contentType: string, postType: Exclude<EventWindowMediaItem["type"], undefined>): boolean =>
  contentType.startsWith(`${postType}/`);

export class EventWindowService {
  public constructor(
    private readonly eventWindowRepository = new EventWindowRepository(),
    private readonly eventRepository = new EventRepository(),
    private readonly ticketUsageRepository = new TicketUsageRepository(),
    private readonly storageService = new StorageService(),
  ) {}

  public async createWindow(user: AuthUser, eventId: string, payload: CreateEventWindowDto): Promise<EventWindowResponse> {
    const event = await this.getEventForHost(user, eventId);
    this.validateWindowPayloadWithinEvent(event, payload.startsAt, payload.endsAt);
    this.ensureWindowEndsInFuture(payload.endsAt);

    const window = await this.eventWindowRepository.create({
      ...payload,
      eventId,
      hostUserId: user.id,
    });

    return this.toWindowResponse(window, user, false, false, event);
  }

  public async listWindows(user: AuthUser, eventId: string): Promise<EventWindowResponse[]> {
    const event = await this.getAccessibleEvent(user, eventId);
    const [windows, attendance] = await Promise.all([
      this.eventWindowRepository.findByEventId(eventId),
      this.ticketUsageRepository.findByEventIdAndHolderUserId(eventId, user.id),
    ]);
    const postedWindowIds = new Set<string>();

    await Promise.all(windows.map(async (window) => {
      const post = await this.eventWindowRepository.findAcceptedPostByUser(window._id.toString(), user.id);
      if (post) {
        postedWindowIds.add(window._id.toString());
      }
    }));

    const visibleWindows = !this.canModerateEvent(user, event) && this.hasEventEnded(event)
      ? windows.filter((window) => postedWindowIds.has(window._id.toString()))
      : windows;

    return visibleWindows.map((window) => this.toWindowResponse(
      window,
      user,
      postedWindowIds.has(window._id.toString()),
      Boolean(attendance),
      event,
    ));
  }

  public async updateWindow(
    user: AuthUser,
    eventId: string,
    windowId: string,
    payload: UpdateEventWindowDto,
  ): Promise<EventWindowResponse> {
    const event = await this.getEventForHost(user, eventId);
    const window = await this.getWindowForEvent(eventId, windowId);
    const computedStatus = this.computeWindowStatus(window);

    if (window.status === "cancelled") {
      throw new AppError("Cancelled windows cannot be edited.", httpStatus.UNPROCESSABLE_ENTITY);
    }

    if (computedStatus === "closed") {
      throw new AppError("Closed windows cannot be edited.", httpStatus.UNPROCESSABLE_ENTITY);
    }

    if (computedStatus === "open" && (payload.startsAt !== undefined || payload.allowedContentTypes !== undefined)) {
      throw new AppError("Open windows cannot change start time or allowed content types.", httpStatus.UNPROCESSABLE_ENTITY);
    }

    const startsAt = payload.startsAt ?? window.startsAt;
    const endsAt = payload.endsAt ?? window.endsAt;
    this.validateWindowPayloadWithinEvent(event, startsAt, endsAt);
    this.ensureWindowEndsInFuture(endsAt);

    if (payload.maxPosts !== undefined && payload.maxPosts < window.acceptedPostCount) {
      throw new AppError("Window post limit cannot be lower than accepted post count.", httpStatus.UNPROCESSABLE_ENTITY);
    }

    if (payload.allowedContentTypes !== undefined) {
      const postCount = await this.eventWindowRepository.countAcceptedPosts(windowId);
      if (postCount > 0) {
        throw new AppError("Allowed content types cannot be changed after posts exist.", httpStatus.UNPROCESSABLE_ENTITY);
      }
    }

    const updatedWindow = await this.eventWindowRepository.updateByIdForEvent(eventId, windowId, payload);

    if (!updatedWindow) {
      if (payload.maxPosts !== undefined) {
        throw new AppError("Window post limit cannot be lower than accepted post count.", httpStatus.CONFLICT);
      }

      throw new AppError("Event window not found.", httpStatus.NOT_FOUND);
    }

    return this.toWindowResponse(updatedWindow, user, false, false, event);
  }

  public async cancelWindow(user: AuthUser, eventId: string, windowId: string): Promise<EventWindowResponse> {
    const event = await this.getEventForHost(user, eventId);
    const currentWindow = await this.getWindowForEvent(eventId, windowId);
    const computedStatus = this.computeWindowStatus(currentWindow);

    if (currentWindow.status === "cancelled") {
      throw new AppError("This window has already been cancelled.", httpStatus.UNPROCESSABLE_ENTITY);
    }

    if (computedStatus === "closed") {
      throw new AppError("Closed windows cannot be cancelled.", httpStatus.UNPROCESSABLE_ENTITY);
    }

    const window = await this.eventWindowRepository.cancelByIdForEvent(eventId, windowId);

    if (!window) {
      throw new AppError("Event window not found.", httpStatus.NOT_FOUND);
    }

    return this.toWindowResponse(window, user, false, false, event);
  }

  public async createPost(
    user: AuthUser,
    eventId: string,
    windowId: string,
    payload: CreateEventWindowPostDto,
  ): Promise<EventWindowPostResponse> {
    const event = await this.getAccessibleEvent(user, eventId);
    const window = await this.getWindowForEvent(eventId, windowId);
    const computedStatus = this.computeWindowStatus(window);

    if (this.canModerateEvent(user, event)) {
      throw new AppError("Hosts and admins cannot post as attendees in event windows.", httpStatus.FORBIDDEN);
    }

    if (!this.canEventAcceptWindowPosts(event)) {
      throw new AppError("This event is not accepting window posts.", httpStatus.FORBIDDEN);
    }

    if (computedStatus !== "open") {
      throw new AppError("This window is not accepting posts.", httpStatus.FORBIDDEN);
    }

    if (!window.allowedContentTypes.includes(payload.contentType)) {
      throw new AppError("This content type is not allowed in this window.", httpStatus.BAD_REQUEST);
    }

    const attendance = await this.ticketUsageRepository.findByEventIdAndHolderUserId(eventId, user.id);
    if (!attendance) {
      throw new AppError("You must check in with a scanned ticket before posting in this window.", httpStatus.FORBIDDEN);
    }

    const existingPost = await this.eventWindowRepository.findAcceptedPostByUser(windowId, user.id);
    if (existingPost) {
      throw new AppError("You have already posted in this window.", httpStatus.CONFLICT);
    }

    await this.validatePostMedia(eventId, windowId, user.id, payload.contentType, payload.mediaItems ?? []);

    const result = await this.eventWindowRepository.createPostWithCapacity({
      eventId,
      windowId,
      userId: user.id,
      ticketUsageId: attendance._id.toString(),
      contentType: payload.contentType,
      text: payload.text ?? null,
      mediaItems: payload.mediaItems ?? [],
    });

    if (result.status === "duplicate") {
      throw new AppError("You have already posted in this window.", httpStatus.CONFLICT);
    }

    if (result.status === "unavailable") {
      throw new AppError("This window is full or no longer accepting posts.", httpStatus.CONFLICT);
    }

    return this.toPostResponse(result.post);
  }

  public async listPosts(
    user: AuthUser,
    eventId: string,
    windowId: string,
    options: ListEventWindowPostsOptions,
  ): Promise<EventWindowPostListResponse> {
    const event = await this.getAccessibleEvent(user, eventId);
    await this.getWindowForEvent(eventId, windowId);

    await this.ensureCanViewWindowPosts(user, event, windowId);

    const posts = await this.eventWindowRepository.listAcceptedPosts(windowId, options);
    const pagePosts = posts.slice(0, options.limit);
    const nextCursor = posts.length > options.limit ? posts[options.limit]!._id.toString() : null;

    return {
      posts: await Promise.all(pagePosts.map((post) => this.toPostResponse(post))),
      nextCursor,
    };
  }

  public async getAuthorizedMedia(
    user: AuthUser,
    eventId: string,
    windowId: string,
    postId: string,
    mediaIndex: number,
  ): Promise<AuthorizedEventWindowMedia> {
    const event = await this.getAccessibleEvent(user, eventId);
    await this.getWindowForEvent(eventId, windowId);

    await this.ensureCanViewWindowPosts(user, event, windowId);

    const post = await this.eventWindowRepository.findAcceptedPostByIdForWindow(windowId, postId);
    if (!post) {
      throw new AppError("Event window post not found.", httpStatus.NOT_FOUND);
    }

    const mediaItem = post.mediaItems[mediaIndex];
    if (!mediaItem?.storageKey) {
      throw new AppError("Event window media not found.", httpStatus.NOT_FOUND);
    }

    return {
      key: mediaItem.storageKey,
      contentType: mediaItem.contentType ?? null,
      filename: mediaItem.storageKey.split("/").pop() || "media",
    };
  }

  private async getAccessibleEvent(user: AuthUser, eventId: string): Promise<IEvent> {
    const event = await this.eventRepository.findById(eventId);

    if (!event) {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    if (event.status === "draft") {
      if (event.userId.toString() === user.id) {
        return event;
      }

      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    if (this.canModerateEvent(user, event)) {
      return event;
    }

    if (event.status !== "published" && event.status !== "live" && event.status !== "completed") {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    if (event.privacy === "private" && !event.memberUserIds.some((id) => id.toString() === user.id)) {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    return event;
  }

  private async getEventForHost(user: AuthUser, eventId: string): Promise<IEvent> {
    const event = await this.eventRepository.findById(eventId);

    if (!event) {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    if (event.userId.toString() !== user.id) {
      throw new AppError("Only the event host can manage event windows.", httpStatus.FORBIDDEN);
    }

    this.ensureEventWindowManagementAllowed(event);

    return event;
  }

  private async getWindowForEvent(eventId: string, windowId: string): Promise<IEventWindow> {
    const window = await this.eventWindowRepository.findByIdForEvent(eventId, windowId);

    if (!window) {
      throw new AppError("Event window not found.", httpStatus.NOT_FOUND);
    }

    return window;
  }

  private validateWindowPayloadWithinEvent(event: IEvent, startsAt: Date, endsAt: Date): void {
    if (!event.scheduledAt || !event.endAt) {
      throw new AppError("Event must have a start and end time before windows can be created.", httpStatus.UNPROCESSABLE_ENTITY);
    }

    if (endsAt <= startsAt) {
      throw new AppError("Window end date and time must be after the start date and time.", httpStatus.BAD_REQUEST);
    }

    if (startsAt < event.scheduledAt || endsAt > event.endAt) {
      throw new AppError("Window start and end time must stay inside the event time.", httpStatus.BAD_REQUEST);
    }
  }

  private ensureEventWindowManagementAllowed(event: IEvent): void {
    if (event.status !== "draft" && event.status !== "published" && event.status !== "live") {
      throw new AppError("Event windows can only be managed before the event is completed or cancelled.", httpStatus.UNPROCESSABLE_ENTITY);
    }

    if (!event.scheduledAt || !event.endAt) {
      throw new AppError("Event must have a start and end time before windows can be managed.", httpStatus.UNPROCESSABLE_ENTITY);
    }

    if (event.endAt <= new Date()) {
      throw new AppError("Event windows cannot be managed after the event has ended.", httpStatus.UNPROCESSABLE_ENTITY);
    }
  }

  private ensureWindowEndsInFuture(endsAt: Date): void {
    if (endsAt <= new Date()) {
      throw new AppError("Window end time must be in the future.", httpStatus.BAD_REQUEST);
    }
  }

  private canModerateEvent(user: AuthUser, event: IEvent): boolean {
    return user.role === "admin" || event.userId.toString() === user.id;
  }

  private hasEventEnded(event: IEvent): boolean {
    return event.status === "completed";
  }

  private canEventAcceptWindowPosts(event: IEvent): boolean {
    if (event.status !== "live") {
      return false;
    }

    if (!event.scheduledAt || !event.endAt) {
      return false;
    }

    const now = Date.now();

    return event.scheduledAt.getTime() <= now && event.endAt.getTime() > now;
  }

  private async ensureCanViewWindowPosts(user: AuthUser, event: IEvent, windowId: string): Promise<void> {
    if (this.canModerateEvent(user, event)) {
      return;
    }

    const [attendance, ownPost] = await Promise.all([
      this.ticketUsageRepository.findByEventIdAndHolderUserId(event._id.toString(), user.id),
      this.eventWindowRepository.findAcceptedPostByUser(windowId, user.id),
    ]);

    if (!attendance) {
      throw new AppError("You must check in with a scanned ticket before viewing this window.", httpStatus.FORBIDDEN);
    }

    if (!ownPost) {
      throw new AppError("Post in this window to view its posts.", httpStatus.FORBIDDEN);
    }

    if (!this.hasEventEnded(event)) {
      throw new AppError("Window posts are revealed after the event ends.", httpStatus.FORBIDDEN);
    }
  }

  private computeWindowStatus(window: IEventWindow): EventWindowComputedStatus {
    if (window.status === "cancelled") {
      return "cancelled";
    }

    const now = Date.now();

    if (now < window.startsAt.getTime()) {
      return "scheduled";
    }

    if (now >= window.endsAt.getTime()) {
      return "closed";
    }

    return "open";
  }

  private toWindowResponse(
    window: IEventWindow,
    user: AuthUser,
    hasPosted = false,
    hasAttended = false,
    event?: IEvent,
  ): EventWindowResponse {
    const computedStatus = this.computeWindowStatus(window);
    const remainingSlots = Math.max(0, window.maxPosts - window.acceptedPostCount);
    const canModerate = user.role === "admin" || window.hostUserId.toString() === user.id;
    const eventAcceptsPosts = event !== undefined && this.canEventAcceptWindowPosts(event);
    const canViewPosts = canModerate || (hasPosted && event !== undefined && this.hasEventEnded(event));

    return {
      id: window._id.toString(),
      eventId: window.eventId.toString(),
      hostUserId: window.hostUserId.toString(),
      title: window.title ?? null,
      details: window.details ?? null,
      startsAt: window.startsAt,
      endsAt: window.endsAt,
      allowedContentTypes: window.allowedContentTypes,
      maxPosts: window.maxPosts,
      acceptedPostCount: window.acceptedPostCount,
      status: window.status,
      computedStatus,
      cancelledAt: window.cancelledAt ?? null,
      hasAttended,
      hasPosted,
      canPost: !canModerate && eventAcceptsPosts && hasAttended && computedStatus === "open" && !hasPosted && remainingSlots > 0,
      canViewPosts,
      remainingSlots,
      createdAt: window.createdAt,
      updatedAt: window.updatedAt,
    };
  }

  private async validatePostMedia(
    eventId: string,
    windowId: string,
    userId: string,
    contentType: CreateEventWindowPostDto["contentType"],
    mediaItems: EventWindowMediaItem[],
  ): Promise<void> {
    if (contentType === "text") {
      if (mediaItems.length > 0) {
        throw new AppError("Text posts cannot include media.", httpStatus.BAD_REQUEST);
      }
      return;
    }

    if (mediaItems.length === 0) {
      throw new AppError("Media is required for this post type.", httpStatus.BAD_REQUEST);
    }

    await Promise.all(mediaItems.map(async (mediaItem) => {
      if (!mediaItem.storageKey) {
        throw new AppError("Event window media storage key is required.", httpStatus.BAD_REQUEST);
      }

      if (mediaItem.url) {
        throw new AppError("Event window media cannot use external URLs.", httpStatus.BAD_REQUEST);
      }

      const expectedPrefix = `event-windows/${eventId}/${windowId}/${userId}/`;
      if (!mediaItem.storageKey.startsWith(expectedPrefix)) {
        throw new AppError("Event window media storage key is invalid.", httpStatus.BAD_REQUEST);
      }

      if (mediaItem.type !== contentType) {
        throw new AppError("Media item type must match the post content type.", httpStatus.BAD_REQUEST);
      }

      const submittedContentType = normalizeContentType(mediaItem.contentType);
      if (!submittedContentType || !contentTypeMatchesPostType(submittedContentType, mediaItem.type)) {
        throw new AppError("Media content type does not match the post content type.", httpStatus.BAD_REQUEST);
      }

      let metadata: Awaited<ReturnType<StorageService["getObjectMetadata"]>>;
      try {
        metadata = await this.storageService.getObjectMetadata(mediaItem.storageKey);
      } catch {
        throw new AppError("Event window media file was not found in storage.", httpStatus.BAD_REQUEST);
      }

      if (!metadata.contentLength || metadata.contentLength <= 0) {
        throw new AppError("Event window media file is empty.", httpStatus.BAD_REQUEST);
      }

      if (metadata.contentLength > MEDIA_LIMITS[mediaItem.type]) {
        throw new AppError("Event window media file is too large.", httpStatus.BAD_REQUEST);
      }

      const storedContentType = normalizeContentType(metadata.contentType);
      if (!storedContentType || storedContentType !== submittedContentType || !contentTypeMatchesPostType(storedContentType, mediaItem.type)) {
        throw new AppError("Stored media content type does not match the submitted media.", httpStatus.BAD_REQUEST);
      }
    }));
  }

  private async toPostResponse(post: IEventWindowPost): Promise<EventWindowPostResponse> {
    return {
      id: post._id.toString(),
      eventId: post.eventId.toString(),
      windowId: post.windowId.toString(),
      userId: post.userId.toString(),
      contentType: post.contentType,
      text: post.text ?? null,
      mediaItems: post.mediaItems.map((mediaItem, index) => this.toMediaResponse(post, mediaItem, index)),
      status: post.status,
      createdAt: post.createdAt,
      updatedAt: post.updatedAt,
    };
  }

  private toMediaResponse(post: IEventWindowPost, mediaItem: EventWindowMediaItem, index: number): EventWindowPostMediaResponse {
    const base = {
      type: mediaItem.type,
      source: mediaItem.source,
      contentType: mediaItem.contentType ?? null,
      durationSeconds: mediaItem.durationSeconds ?? null,
    };

    if (!mediaItem.storageKey) {
      return base;
    }

    return {
      ...base,
      url: `/events/${post.eventId.toString()}/windows/${post.windowId.toString()}/posts/${post._id.toString()}/media/${index}`,
    };
  }
}
