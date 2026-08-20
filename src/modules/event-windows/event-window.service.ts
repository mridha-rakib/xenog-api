import httpStatus from "http-status";
import { AppError } from "../../core/errors/app-error.js";
import { env } from "../../config/env.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { EventRepository } from "../events/event.repository.js";
import type { IEvent } from "../events/event.interface.js";
import { TicketEntitlementService } from "../payments/ticket-entitlement.service.js";
import type { TicketEntitlement } from "../payments/ticket-entitlement.service.js";
import { TicketUsageRepository } from "../payments/ticket-usage.repository.js";
import { StorageService } from "../storage/storage.service.js";
import type { IUser } from "../user/user.interface.js";
import { UserRepository } from "../user/user.repository.js";
import type {
  CreateEventWindowDto,
  CreateEventWindowPostDto,
  EventWindowComputedStatus,
  EventWindowMediaItem,
  EventWindowParticipantPostVisibility,
  EventWindowPostingEligibility,
  EventWindowPostAuthorResponse,
  EventWindowPostMediaResponse,
  EventWindowPostListResponse,
  EventWindowPostResponse,
  EventWindowResponse,
  IEventWindow,
  IEventWindowPost,
  ListEventWindowPostsOptions,
  ListParticipatedEventsOptions,
  ParticipatedEventsResponse,
  ParticipatedEventSummary,
  ParticipatedWindowSummary,
  UpdateEventWindowDto,
} from "./event-window.interface.js";
import {
  DEFAULT_EVENT_WINDOW_PARTICIPANT_POST_VISIBILITY,
  DEFAULT_EVENT_WINDOW_POSTING_ELIGIBILITY,
  EVENT_WINDOW_MEDIA_LIMITS_BYTES as MEDIA_LIMITS,
} from "./event-window.interface.js";
import { EventWindowRepository } from "./event-window.repository.js";

type PostingAuthorization = {
  ticketUsageId: string | null;
  ticketEntitlement: TicketEntitlement | null;
};

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
    private readonly ticketEntitlementService = new TicketEntitlementService(),
    private readonly storageService = new StorageService(),
    private readonly userRepository = new UserRepository(),
  ) {}

  // Hosts can no longer opt a new/updated window into "video" while video is
  // temporarily disabled. Existing windows that already allow video keep
  // that configuration (checked only when allowedContentTypes is actually
  // part of this payload) — actual video posting is still blocked separately
  // in createPost above. Set ENABLE_VIDEO_UPLOADS=true (env.ts) to re-enable.
  private assertVideoContentTypeSelectable(allowedContentTypes?: string[]): void {
    if (env.ENABLE_VIDEO_UPLOADS || !allowedContentTypes?.includes("video")) {
      return;
    }

    throw new AppError("Video is temporarily unavailable for event windows.", httpStatus.BAD_REQUEST);
  }

  public async createWindow(user: AuthUser, eventId: string, payload: CreateEventWindowDto): Promise<EventWindowResponse> {
    this.assertVideoContentTypeSelectable(payload.allowedContentTypes);
    const event = await this.getEventForHost(user, eventId);
    this.validateWindowPayloadWithinEvent(event, payload.startsAt, payload.endsAt);
    this.ensureWindowEndsInFuture(payload.endsAt);

    const window = await this.eventWindowRepository.create({
      ...payload,
      eventId,
      hostUserId: user.id,
      postingEligibility: payload.postingEligibility ?? DEFAULT_EVENT_WINDOW_POSTING_ELIGIBILITY,
      participantPostVisibility: payload.participantPostVisibility ?? DEFAULT_EVENT_WINDOW_PARTICIPANT_POST_VISIBILITY,
    });

    return this.toWindowResponse(window, user, false, false, false, event);
  }

  public async listWindows(user: AuthUser, eventId: string): Promise<EventWindowResponse[]> {
    const event = await this.getAccessibleEvent(user, eventId);
    const windows = await this.eventWindowRepository.findByEventId(eventId);

    const postedWindowIds = new Set<string>();

    await Promise.all(windows.map(async (window) => {
      const post = await this.eventWindowRepository.findAcceptedPostByUser(window._id.toString(), user.id);
      if (post) {
        postedWindowIds.add(window._id.toString());
      }
    }));

    const canModerate = this.canModerateEvent(user, event);
    const visibleWindows = !canModerate && this.hasEventEnded(event)
      ? windows.filter((window) => postedWindowIds.has(window._id.toString()))
      : windows;

    // Eligibility checks are event-scoped, not window-scoped, so each is
    // resolved at most once per request rather than once per window — only
    // fetched when at least one visible window actually needs that mode.
    const needsCheckedIn = !canModerate && visibleWindows.some((window) => this.resolvePostingEligibility(window) === "checked_in_attendees");
    const needsTicketHolder = !canModerate && visibleWindows.some((window) => this.resolvePostingEligibility(window) === "ticket_holders");

    const [attendance, ticketEntitlement] = await Promise.all([
      needsCheckedIn ? this.ticketUsageRepository.findByEventIdAndHolderUserId(eventId, user.id) : Promise.resolve(null),
      needsTicketHolder ? this.ticketEntitlementService.findValidEntitlementForUser(user.id, eventId) : Promise.resolve(null),
    ]);

    return visibleWindows.map((window) => {
      const hasPosted = postedWindowIds.has(window._id.toString());
      const isEligibleToPost = this.resolvePostingEligibility(window) === "ticket_holders"
        ? Boolean(ticketEntitlement)
        : Boolean(attendance);

      return this.toWindowResponse(window, user, hasPosted, Boolean(attendance), isEligibleToPost, event);
    });
  }

  // "Windows" Home tab data source: the Events (and, within each, only the
  // specific Windows) where this user has an ACCEPTED EventWindowPost —
  // never any other signal (ticket ownership, check-in, eligibility, event
  // membership). Returns navigation metadata only; actual post content stays
  // behind listPosts/getAuthorizedMedia, which independently re-verify
  // access via ensureCanViewWindowPosts.
  public async listParticipatedEvents(
    user: AuthUser,
    options: ListParticipatedEventsOptions,
  ): Promise<ParticipatedEventsResponse> {
    const posts = await this.eventWindowRepository.findAcceptedPostsByUser(user.id);

    if (posts.length === 0) {
      return { events: [] };
    }

    // posts are already sorted most-recent-first, so the first time a
    // windowId/eventId is seen is its most recent participation.
    const lastParticipatedAtByWindowId = new Map<string, Date>();
    const windowIds: string[] = [];
    for (const post of posts) {
      const windowId = post.windowId.toString();
      if (!lastParticipatedAtByWindowId.has(windowId)) {
        lastParticipatedAtByWindowId.set(windowId, post.createdAt);
        windowIds.push(windowId);
      }
    }

    const windows = await this.eventWindowRepository.findByIds(windowIds);
    const windowsByEventId = new Map<string, IEventWindow[]>();
    for (const window of windows) {
      const eventId = window.eventId.toString();
      const bucket = windowsByEventId.get(eventId);
      if (bucket) {
        bucket.push(window);
      } else {
        windowsByEventId.set(eventId, [window]);
      }
    }

    const events = await this.eventRepository.findByIds([...windowsByEventId.keys()]);

    const summaries: ParticipatedEventSummary[] = [];
    for (const event of events) {
      if (!this.isEventVisibleForParticipationHistory(user, event)) {
        continue;
      }

      const eventWindows = windowsByEventId.get(event._id.toString()) ?? [];
      if (eventWindows.length === 0) {
        continue;
      }

      const participatedWindows: ParticipatedWindowSummary[] = eventWindows
        .map((window) => this.toParticipatedWindowSummary(window, event, lastParticipatedAtByWindowId))
        // Chronological, matching the existing EventWindow list convention
        // (EventWindowRepository#findByEventId sorts the same way).
        .sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime());

      const lastParticipatedAt = participatedWindows.reduce(
        (latest, window) => (window.lastParticipatedAt > latest ? window.lastParticipatedAt : latest),
        participatedWindows[0]!.lastParticipatedAt,
      );

      summaries.push({
        id: event._id.toString(),
        name: event.name ?? "",
        bannerImageKey: event.bannerImageKey ?? null,
        bannerImageDisplay: event.bannerImageDisplay ?? null,
        scheduledAt: event.scheduledAt ?? null,
        endAt: event.endAt ?? null,
        status: event.status,
        participatedWindows,
        lastParticipatedAt,
      });
    }

    summaries.sort((left, right) => right.lastParticipatedAt.getTime() - left.lastParticipatedAt.getTime());

    return { events: summaries.slice(0, options.limit) };
  }

  private toParticipatedWindowSummary(
    window: IEventWindow,
    event: IEvent,
    lastParticipatedAtByWindowId: Map<string, Date>,
  ): ParticipatedWindowSummary {
    const participantPostVisibility = this.resolveParticipantPostVisibility(window);
    const canViewPosts = participantPostVisibility === "instant" || this.hasEventEnded(event);

    return {
      id: window._id.toString(),
      title: window.title ?? null,
      details: window.details ?? null,
      startsAt: window.startsAt,
      endsAt: window.endsAt,
      computedStatus: this.computeWindowStatus(window),
      participantPostVisibility,
      canViewPosts,
      lastParticipatedAt: lastParticipatedAtByWindowId.get(window._id.toString())!,
    };
  }

  // Mirrors getAccessibleEvent's visibility rules (draft → owner only,
  // otherwise published/live/completed, private → membership required) but
  // filters instead of throwing, since this list spans many events at once.
  // A historical accepted post never overrides these rules — an event that
  // would 404 via getAccessibleEvent is silently excluded here too.
  private isEventVisibleForParticipationHistory(user: AuthUser, event: IEvent): boolean {
    if (this.canModerateEvent(user, event)) {
      return true;
    }

    if (event.status === "draft") {
      return event.userId.toString() === user.id;
    }

    if (event.status !== "published" && event.status !== "live" && event.status !== "completed") {
      return false;
    }

    if (event.privacy === "private" && !event.memberUserIds.some((id) => id.toString() === user.id)) {
      return false;
    }

    return true;
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
      this.assertVideoContentTypeSelectable(payload.allowedContentTypes);

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

    return this.toWindowResponse(updatedWindow, user, false, false, false, event);
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

    return this.toWindowResponse(window, user, false, false, false, event);
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

    // Event-window video posting is temporarily disabled while the
    // deployment host runs without the transcoding worker, even for windows
    // whose existing configuration already allows "video". Text/image/audio
    // posts are untouched. Set ENABLE_VIDEO_UPLOADS=true (env.ts) to re-enable.
    if (payload.contentType === "video" && !env.ENABLE_VIDEO_UPLOADS) {
      throw new AppError("Video posts are temporarily unavailable.", httpStatus.BAD_REQUEST);
    }

    const authorization = await this.resolvePostingAuthorization(user, event, window);

    const existingPost = await this.eventWindowRepository.findAcceptedPostByUser(windowId, user.id);
    if (existingPost) {
      throw new AppError("You have already posted in this window.", httpStatus.CONFLICT);
    }

    await this.validatePostMedia(eventId, windowId, user.id, payload.contentType, payload.mediaItems ?? []);

    const result = await this.eventWindowRepository.createPostWithCapacity({
      eventId,
      windowId,
      userId: user.id,
      ticketUsageId: authorization.ticketUsageId,
      ticketEntitlement: authorization.ticketEntitlement,
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
    const window = await this.getWindowForEvent(eventId, windowId);

    await this.ensureCanViewWindowPosts(user, event, window);

    const posts = await this.eventWindowRepository.listAcceptedPosts(windowId, options);
    const pagePosts = posts.slice(0, options.limit);
    const nextCursor = posts.length > options.limit ? posts[options.limit]!._id.toString() : null;
    const authorsById = await this.getPostAuthorsById(pagePosts);

    return {
      posts: await Promise.all(pagePosts.map((post) => this.toPostResponse(post, authorsById.get(post.userId.toString())))),
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
    const window = await this.getWindowForEvent(eventId, windowId);

    await this.ensureCanViewWindowPosts(user, event, window);

    const post = await this.eventWindowRepository.findAcceptedPostByIdForWindow(windowId, postId);
    if (!post) {
      throw new AppError("Event window post not found.", httpStatus.NOT_FOUND);
    }

    const mediaItem = post.mediaItems[mediaIndex];
    if (!mediaItem?.storageKey) {
      throw new AppError("Event window media not found.", httpStatus.NOT_FOUND);
    }

    // Video is temporarily disabled — never stream/serve a video window-post
    // media object, even an existing one, through this endpoint. Reliable
    // here (unlike the generic /storage endpoint) because the media item's
    // type is already known from the post document, before any object lookup.
    if (mediaItem.type === "video" && !env.ENABLE_VIDEO_UPLOADS) {
      throw new AppError("Video posts are temporarily unavailable.", httpStatus.BAD_REQUEST);
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

  // Normalizes a persisted window's policy fields to the legacy defaults.
  // Mongoose already applies the schema `default` when hydrating a
  // pre-migration document that never stored these fields, so this is a
  // defense-in-depth backstop (e.g. against a future .lean() query), not the
  // primary mechanism — it guarantees every code path here treats a missing
  // value exactly like a document created before these fields existed.
  private resolvePostingEligibility(window: IEventWindow): EventWindowPostingEligibility {
    return window.postingEligibility ?? DEFAULT_EVENT_WINDOW_POSTING_ELIGIBILITY;
  }

  private resolveParticipantPostVisibility(window: IEventWindow): EventWindowParticipantPostVisibility {
    return window.participantPostVisibility ?? DEFAULT_EVENT_WINDOW_PARTICIPANT_POST_VISIBILITY;
  }

  private async getWindowForEvent(eventId: string, windowId: string): Promise<IEventWindow> {
    const window = await this.eventWindowRepository.findByIdForEvent(eventId, windowId);

    if (!window) {
      throw new AppError("Event window not found.", httpStatus.NOT_FOUND);
    }

    return window;
  }

  // A window may start before the event itself does (e.g. a pre-show
  // posting window), but it may never outlast the event — endsAt is a hard
  // ceiling at event.endAt. Only the end boundary is enforced here.
  private validateWindowPayloadWithinEvent(event: IEvent, startsAt: Date, endsAt: Date): void {
    if (!event.scheduledAt || !event.endAt) {
      throw new AppError("Event must have a start and end time before windows can be created.", httpStatus.UNPROCESSABLE_ENTITY);
    }

    if (endsAt <= startsAt) {
      throw new AppError("Window end date and time must be after the start date and time.", httpStatus.BAD_REQUEST);
    }

    if (endsAt > event.endAt) {
      throw new AppError("Window end date and time cannot be after the event ends.", httpStatus.BAD_REQUEST);
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

  // A window's own open/closed computed status (startsAt/endsAt) is now the
  // authoritative posting-timing gate, since a window may legitimately open
  // before the event itself starts. This only screens out event states a
  // window should never accept posts in, regardless of window timing.
  private canEventAcceptWindowPosts(event: IEvent): boolean {
    return event.status === "published" || event.status === "live";
  }

  // Resolves what proves this user is allowed to post into this window,
  // per the window's own postingEligibility policy. Throws if the user
  // doesn't currently satisfy it.
  private async resolvePostingAuthorization(user: AuthUser, event: IEvent, window: IEventWindow): Promise<PostingAuthorization> {
    if (this.resolvePostingEligibility(window) === "ticket_holders") {
      const entitlement = await this.ticketEntitlementService.findValidEntitlementForUser(user.id, event._id.toString());
      if (!entitlement) {
        throw new AppError("You need a valid ticket for this event before posting in this window.", httpStatus.FORBIDDEN);
      }

      return { ticketUsageId: null, ticketEntitlement: entitlement };
    }

    const attendance = await this.ticketUsageRepository.findByEventIdAndHolderUserId(event._id.toString(), user.id);
    if (!attendance) {
      throw new AppError("You must check in with a scanned ticket before posting in this window.", httpStatus.FORBIDDEN);
    }

    return { ticketUsageId: attendance._id.toString(), ticketEntitlement: null };
  }

  // Viewing is gated purely by per-window participation (an accepted post
  // in THIS window) plus that window's participantPostVisibility policy —
  // not by check-in or ticket state, since a user may have legitimately
  // posted here without either (postingEligibility === "ticket_holders").
  // The accepted post itself is the participation proof.
  private async ensureCanViewWindowPosts(user: AuthUser, event: IEvent, window: IEventWindow): Promise<void> {
    if (this.canModerateEvent(user, event)) {
      return;
    }

    const ownPost = await this.eventWindowRepository.findAcceptedPostByUser(window._id.toString(), user.id);

    if (!ownPost) {
      throw new AppError("Post in this window to view its posts.", httpStatus.FORBIDDEN);
    }

    if (this.resolveParticipantPostVisibility(window) === "instant") {
      return;
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
    isEligibleToPost = false,
    event?: IEvent,
  ): EventWindowResponse {
    const computedStatus = this.computeWindowStatus(window);
    const remainingSlots = Math.max(0, window.maxPosts - window.acceptedPostCount);
    const canModerate = user.role === "admin" || window.hostUserId.toString() === user.id;
    const eventAcceptsPosts = event !== undefined && this.canEventAcceptWindowPosts(event);
    const postingEligibility = this.resolvePostingEligibility(window);
    const participantPostVisibility = this.resolveParticipantPostVisibility(window);
    const canViewPosts = canModerate
      || (hasPosted && (participantPostVisibility === "instant" || (event !== undefined && this.hasEventEnded(event))));

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
      postingEligibility,
      participantPostVisibility,
      cancelledAt: window.cancelledAt ?? null,
      hasAttended,
      hasPosted,
      isEligibleToPost,
      canPost: !canModerate && eventAcceptsPosts && isEligibleToPost && computedStatus === "open" && !hasPosted && remainingSlots > 0,
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

  private async getPostAuthorsById(posts: IEventWindowPost[]): Promise<Map<string, IUser>> {
    const userIds = [...new Set(posts.map((post) => post.userId.toString()))];
    const users = await this.userRepository.findByIds(userIds);
    return new Map(users.map((user) => [user._id.toString(), user]));
  }

  private async toPostAuthorResponse(user?: IUser): Promise<EventWindowPostAuthorResponse | null> {
    if (!user) {
      return null;
    }

    const avatarUrl = user.avatarKey
      ? await this.storageService.createDownloadUrl(user.avatarKey).then((download) => download.url).catch(() => null)
      : null;

    return {
      id: user._id.toString(),
      name: user.name,
      username: user.username,
      avatarKey: user.avatarKey ?? null,
      avatarUrl,
    };
  }

  private async toPostResponse(post: IEventWindowPost, author?: IUser): Promise<EventWindowPostResponse> {
    return {
      id: post._id.toString(),
      eventId: post.eventId.toString(),
      windowId: post.windowId.toString(),
      userId: post.userId.toString(),
      author: await this.toPostAuthorResponse(author),
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
