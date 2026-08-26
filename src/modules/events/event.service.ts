import { randomUUID } from "node:crypto";
import httpStatus from "http-status";
import { Types } from "mongoose";
import { RedisClient } from "../../config/redis.js";
import { env } from "../../config/env.js";
import { AppError } from "../../core/errors/app-error.js";
import { logger } from "../../core/logger/logger.js";
import { createPaginationMeta, getPaginationOptions } from "../../core/utils/pagination.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { StorageService } from "../storage/storage.service.js";
import { UserRepository } from "../user/user.repository.js";
import { UserFollowRepository } from "../user/user-follow.repository.js";
import { UserBlockRepository } from "../user/user-block.repository.js";
import { EventSaveRepository } from "./event-save.repository.js";
import { EventInteractionSummaryService } from "./event-interaction-summary.js";
import { LiveRoomRepository } from "../live-rooms/live-room.repository.js";
import { MomentRepository } from "../moments/moment.repository.js";
import { MomentReactionRepository } from "../moments/moment-reaction.repository.js";
import { MomentCommentRepository } from "../moments/moment-comment.repository.js";
import { MomentCommentReactionRepository } from "../moments/moment-comment-reaction.repository.js";
import { MomentShareRepository } from "../moments/moment-share.repository.js";
import { MomentSaveRepository } from "../moments/moment-save.repository.js";
import { extractHashtags, normalizeHashtag } from "../moments/moment-hashtag.js";
import type { IUser } from "../user/user.interface.js";
import { ProductRepository } from "../products/product.repository.js";
import { EventRepository, getDistanceKm } from "./event.repository.js";
import { MAX_EVENT_FILTER_RADIUS_KM } from "./event.validation.js";
import { RewardClaimRepository } from "./reward-claim.repository.js";
import type { IRewardClaim } from "./reward-claim.model.js";
import { CheckoutPaymentRepository } from "../payments/checkout-payment.repository.js";
import { CheckoutPaymentService } from "../payments/checkout-payment.service.js";
import { CrowdStatusService } from "../payments/crowd-status.service.js";
import { CreatorEarningRepository } from "../payments/creator-earning.repository.js";
import { EventCancellationRefundService } from "../payments/event-cancellation-refund.service.js";
import type { CancelEventDto, CancellationBatchResponse } from "../payments/event-cancellation-refund.interface.js";
import { TicketShareRepository } from "../payments/ticket-share.repository.js";
import { TicketUsageRepository } from "../payments/ticket-usage.repository.js";
import { NotificationRepository } from "../notifications/notification.repository.js";
import { EventHostReviewRepository } from "./event-host-review.repository.js";
import { EventWindowRepository } from "../event-windows/event-window.repository.js";
import { ReportRepository } from "../reports/report.repository.js";
import {
  buildReactionSocialContext,
  calculateFreshnessScore,
  calculateSmartFeedNearbyScore,
  calculateSmartFeedScore,
  calculateSocialScore,
  compareSmartFeedScoreDesc,
  isValidSmartFeedCoordinate,
  type SmartFeedAuthorRelationship,
  type SmartFeedScore,
  type SmartFeedSocialContext,
  type SmartFeedSocialUser,
} from "../feed/smart-feed-ranking.js";
import { GeoIpService } from "../geoip/geoip.service.js";
import {
  EVENT_MEDIA_LIMITS_BYTES,
  MAX_EVENT_MEDIA_VIDEO_DURATION_SECONDS,
  eventCategories,
  supportedEventImageContentTypes,
  supportedEventVideoContentTypes,
} from "./event.interface.js";
import type {
  EventHostReviewEligibilityResponse,
  EventHostReviewResponse,
  IEventHostReview,
  SubmitEventHostReviewDto,
} from "./event-host-review.interface.js";
import type {
  AdminMapEventResponse,
  AddEventMediaDto,
  AddEventMediaResponse,
  CreateEventRewardDto,
  DeleteEventMediaResponse,
  EventFeedQuery,
  EventCategory,
  EventHostResponse,
  EventJoinRequestStatus,
  EventMapQuery,
  EventMemberResponse,
  EventMediaInput,
  EventMediaItem,
  EventMediaResponse,
  EventMediaType,
  EventReward,
  EventRewardInput,
  EventStatus,
  JoinRequestResponse,
  ProfileEventGroupsResponse,
  ProfileEventsQuery,
  CreateEventTicketDto,
  EventResponse,
  EventMapListResponse,
  EventMapPaginationCursor,
  EventTicket,
  EventTicketInput,
  IEvent,
  NowEventStatus,
  NowModeEventResponse,
  NowModeQuery,
  PostTagEventResponse,
  PostTagEventStatus,
  PublishEventDto,
  RewardClaimResponse,
  SaveEventDraftDto,
  TicketAccessResponse,
  UpdateEventRewardDto,
  UpdateEventTicketDto,
} from "./event.interface.js";

const ACTIVE_EVENT_WINDOW_MS = 12 * 60 * 60 * 1000;
const EVENT_MEDIA_STORAGE_PREFIX = "events/gallery/";
const TICKET_CREATION_CUTOFF_MS = 30 * 60 * 1000;
const TICKET_CREATION_CUTOFF_MESSAGE = "New tickets can’t be created within 30 minutes of the event end time.";
const TICKET_PRICE_EDIT_CUTOFF_MESSAGE = "Ticket price can’t be changed within 30 minutes of the event end time.";
const TICKET_SALES_END_DATE_AFTER_EVENT_END_MESSAGE = "Ticket sales end date must be before the event end date.";
const TICKET_SALES_END_TIME_NOT_BEFORE_EVENT_END_MESSAGE = "Ticket sales end time must be before the event end time.";
const REWARD_END_DATE_AFTER_TICKET_SALES_END_MESSAGE =
  "Reward end date cannot be after the ticket sales end date.";
const REWARD_END_TIME_AFTER_TICKET_SALES_END_MESSAGE =
  "Reward end time cannot be after the ticket sales end time.";
const eventCategorySet = new Set<string>(eventCategories);

type EventSmartFeedContext = {
  scoreByEventId: Map<string, SmartFeedScore>;
  socialContextByEventId: Map<string, SmartFeedSocialContext>;
};

type EventRequestContext = {
  clientIp?: string | null;
};

type TicketValidationCode =
  | "EVENT_END_REQUIRED_FOR_TICKET_MANAGEMENT"
  | "TICKET_MANAGEMENT_STATUS_NOT_ALLOWED"
  | "TICKET_CREATION_CUTOFF"
  | "TICKET_PRICE_EDIT_CUTOFF"
  | "TICKET_SALES_END_DATE_AFTER_EVENT_END"
  | "TICKET_SALES_END_TIME_NOT_BEFORE_EVENT_END";

type TicketValidationField = "endAt" | "salesEndAt" | "price";

type RewardValidationCode =
  | "REWARD_END_DATE_AFTER_TICKET_SALES_END"
  | "REWARD_END_TIME_AFTER_TICKET_SALES_END";

type RewardValidationField = "expiresAt";

type EventMapCursorPayload = {
  scheduledAt?: unknown;
  publishedAt?: unknown;
  id?: unknown;
};

const encodeMapCursor = (event: IEvent): string | null => {
  if (
    !(event.scheduledAt instanceof Date) ||
    Number.isNaN(event.scheduledAt.getTime()) ||
    !(event.publishedAt instanceof Date) ||
    Number.isNaN(event.publishedAt.getTime())
  ) {
    return null;
  }

  return Buffer.from(JSON.stringify({
    scheduledAt: event.scheduledAt.toISOString(),
    publishedAt: event.publishedAt.toISOString(),
    id: event._id.toString(),
  })).toString("base64url");
};

const decodeMapCursor = (cursor?: string): EventMapPaginationCursor | undefined => {
  if (!cursor) {
    return undefined;
  }

  try {
    const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as EventMapCursorPayload;
    const scheduledAt = typeof payload.scheduledAt === "string" ? new Date(payload.scheduledAt) : null;
    const publishedAt = typeof payload.publishedAt === "string" ? new Date(payload.publishedAt) : null;

    if (
      !scheduledAt ||
      !publishedAt ||
      Number.isNaN(scheduledAt.getTime()) ||
      Number.isNaN(publishedAt.getTime()) ||
      typeof payload.id !== "string" ||
      !payload.id
    ) {
      throw new Error("Invalid cursor payload");
    }

    return { scheduledAt, publishedAt, id: payload.id };
  } catch {
    throw new AppError("Invalid map cursor.", httpStatus.BAD_REQUEST);
  }
};
const NOW_MODE_LOOKAHEAD_MS = 3 * 60 * 60 * 1000;
const STARTING_SOON_MS = 60 * 60 * 1000;
const PROFILE_EVENTS_CACHE_VERSION = "v1";
const PROFILE_EVENTS_CACHE_TTL_SECONDS = 30;
const ADMIN_EVENT_DETAIL_STATUSES = new Set<EventStatus>(["published", "live", "completed", "cancelled"]);

const normalizeEventHashtags = (values: string[] | undefined): string[] =>
  [...new Set((values ?? []).map(normalizeHashtag).filter(Boolean))].slice(0, 20);

const getNowStatus = (
  scheduledAt: Date | null | undefined,
  endAt?: Date | null,
): NowEventStatus | null => {
  if (!scheduledAt) {
    return null;
  }

  const now = Date.now();
  const scheduled = scheduledAt.getTime();
  const ended = endAt?.getTime() ?? null;

  if (scheduled <= now && (ended ? ended >= now : now - scheduled <= ACTIVE_EVENT_WINDOW_MS)) {
    return "live_now";
  }

  if (scheduled > now && scheduled - now <= STARTING_SOON_MS) {
    return "starting_soon";
  }

  if (scheduled > now && scheduled - now <= NOW_MODE_LOOKAHEAD_MS) {
    return "last_call";
  }

  return null;
};

export class EventService {
  public constructor(
    private readonly eventRepository = new EventRepository(),
    private readonly userRepository = new UserRepository(),
    private readonly userFollowRepository = new UserFollowRepository(),
    private readonly storageService = new StorageService(),
    private readonly productRepository = new ProductRepository(),
    private readonly rewardClaimRepository = new RewardClaimRepository(),
    private readonly checkoutPaymentRepository = new CheckoutPaymentRepository(),
    private readonly checkoutPaymentService = new CheckoutPaymentService(),
    private readonly creatorEarningRepository = new CreatorEarningRepository(),
    private readonly ticketShareRepository = new TicketShareRepository(),
    private readonly notificationRepository = new NotificationRepository(),
    private readonly userBlockRepository = new UserBlockRepository(),
    private readonly eventSaveRepository = new EventSaveRepository(),
    private readonly liveRoomRepository = new LiveRoomRepository(),
    private readonly momentRepository = new MomentRepository(),
    private readonly momentReactionRepository = new MomentReactionRepository(),
    private readonly momentCommentRepository = new MomentCommentRepository(),
    private readonly momentCommentReactionRepository = new MomentCommentReactionRepository(),
    private readonly momentShareRepository = new MomentShareRepository(),
    private readonly momentSaveRepository = new MomentSaveRepository(),
    private readonly ticketUsageRepository = new TicketUsageRepository(),
    private readonly eventHostReviewRepository = new EventHostReviewRepository(),
    private readonly eventWindowRepository = new EventWindowRepository(),
    private readonly crowdStatusService = new CrowdStatusService(),
    private readonly getServerNow = () => new Date(Date.now()),
    private readonly eventCancellationRefundService = new EventCancellationRefundService(),
    private readonly reportRepository = new ReportRepository(),
    private readonly geoIpService = new GeoIpService(),
    private readonly eventInteractionSummaryService = new EventInteractionSummaryService(),
  ) {}

  public async saveDraft(
    user: AuthUser,
    payload: SaveEventDraftDto,
    eventId?: string,
  ): Promise<EventResponse> {
    const existingDraft = eventId ? await this.getDraftForUser(user, eventId) : null;
    const normalizedPayload = this.normalizeDraftPayload(payload, existingDraft);

    if (eventId) {
      const draft = existingDraft!;
      await this.assertPostingWindowsFitSchedule(draft, normalizedPayload);
      const scheduleCandidate = this.getEventScheduleCandidate(draft, normalizedPayload);
      this.assertEndAtChangeDoesNotEnterTicketCreationCutoff(draft, normalizedPayload);
      this.assertNewTicketsRespectCreationCutoff(draft, scheduleCandidate.tickets, scheduleCandidate.endAt);
      this.assertTicketAndRewardDatesFitEventSchedule(scheduleCandidate);

      const event = await this.eventRepository.updateDraftByIdForUser(
        eventId,
        user.id,
        normalizedPayload,
      );

      if (!event) {
        throw new AppError("Event draft not found.", httpStatus.NOT_FOUND);
      }

      return this.toResponse(event);
    }

    if ((normalizedPayload.tickets ?? []).length > 0) {
      this.assertTicketCreationAvailable({
        status: "draft",
        endAt: normalizedPayload.endAt ?? null,
      });
    }

    this.assertTicketAndRewardDatesFitEventSchedule({
      scheduledAt: normalizedPayload.scheduledAt ?? null,
      endAt: normalizedPayload.endAt ?? null,
      tickets: normalizedPayload.tickets ?? [],
      rewards: normalizedPayload.rewards ?? [],
    });

    const event = await this.eventRepository.create({
      ...normalizedPayload,
      userId: user.id,
      status: "draft",
    });

    return this.toResponse(event);
  }

  public async publish(
    user: AuthUser,
    payload: PublishEventDto,
    eventId?: string,
  ): Promise<EventResponse> {
    const existingEvent = eventId ? await this.eventRepository.findByIdForUser(eventId, user.id) : null;
    const normalizedPayload = this.normalizePublishPayload(payload, existingEvent);

    if (eventId) {
      if (existingEvent && existingEvent.status !== "draft") {
        if (existingEvent.status === "completed" || existingEvent.status === "cancelled") {
          throw new AppError(
            "This event cannot be published because it has already ended.",
            httpStatus.UNPROCESSABLE_ENTITY,
          );
        }

        await this.assertPostingWindowsFitSchedule(existingEvent, normalizedPayload);
        const scheduleCandidate = this.getEventScheduleCandidate(existingEvent, normalizedPayload);
        this.assertEndAtChangeDoesNotEnterTicketCreationCutoff(existingEvent, normalizedPayload);
        this.assertBulkTicketMutationsRespectCutoffs(existingEvent, scheduleCandidate.tickets, scheduleCandidate.endAt);
        this.assertTicketAndRewardDatesFitEventSchedule(scheduleCandidate);

        // Preserve the atomic availableCount counter — do NOT reset it to capacity on re-publish.
        // For new tickets added in the payload, start fully available.
        // For capacity changes, adjust the counter by the delta.
        const existingById = new Map(existingEvent.tickets.map((t) => [t.id, t]));
        const ticketsWithCounts = (normalizedPayload.tickets ?? []).map((ticket) => {
          // After normalizePublishPayload, every ticket has a UUID id — the optional type is a type-system artifact
          const existing = existingById.get(ticket.id ?? "");
          if (!existing) {
            return { ...ticket, availableCount: ticket.capacity };
          }
          const delta = ticket.capacity - existing.capacity;
          const currentAvailable = existing.availableCount ?? existing.capacity;
          return { ...ticket, availableCount: Math.max(0, currentAvailable + delta) };
        });

        const event = await this.eventRepository.updateByIdForUser(eventId, user.id, {
          ...normalizedPayload,
          tickets: ticketsWithCounts,
        });

        if (!event) {
          throw new AppError("Event not found.", httpStatus.NOT_FOUND);
        }

        return this.toProfileMutatingResponse(event);
      }

      if (existingEvent) {
        await this.assertPostingWindowsFitSchedule(existingEvent, normalizedPayload);
        const scheduleCandidate = this.getEventScheduleCandidate(existingEvent, normalizedPayload);
        this.assertEndAtChangeDoesNotEnterTicketCreationCutoff(existingEvent, normalizedPayload);
        this.assertNewTicketsRespectCreationCutoff(existingEvent, scheduleCandidate.tickets, scheduleCandidate.endAt);
        this.assertTicketAndRewardDatesFitEventSchedule(scheduleCandidate);
      }

      const event = await this.eventRepository.publishDraftByIdForUser(
        eventId,
        user.id,
        normalizedPayload,
      );

      if (!event) {
        throw new AppError("Event draft not found.", httpStatus.NOT_FOUND);
      }

      return this.toProfileMutatingResponse(event);
    }

    if (normalizedPayload.tickets.length > 0) {
      this.assertTicketCreationAvailable({
        status: "published",
        endAt: normalizedPayload.endAt,
      });
    }

    this.assertTicketAndRewardDatesFitEventSchedule({
      scheduledAt: normalizedPayload.scheduledAt,
      endAt: normalizedPayload.endAt,
      tickets: normalizedPayload.tickets,
      rewards: normalizedPayload.rewards ?? [],
    });

    const event = await this.eventRepository.create({
      ...normalizedPayload,
      userId: user.id,
      status: "published",
      publishedAt: new Date(),
    });

    return this.toProfileMutatingResponse(event);
  }

  public async updateEvent(
    user: AuthUser,
    eventId: string,
    payload: SaveEventDraftDto,
  ): Promise<EventResponse> {
    const existingEvent = await this.getModifiableEventForOwner(user, eventId);
    const normalizedPayload = this.normalizeDraftPayload(payload, existingEvent);
    this.assertPublishableCategories(this.getCategoryCandidate(existingEvent, normalizedPayload));
    const scheduleCandidate = this.getEventScheduleCandidate(existingEvent, normalizedPayload);
    this.assertOngoingEventScheduleUpdateAllowed(existingEvent, normalizedPayload, scheduleCandidate);
    await this.assertPostingWindowsFitSchedule(existingEvent, normalizedPayload);
    this.assertEndAtChangeDoesNotEnterTicketCreationCutoff(existingEvent, normalizedPayload);
    this.assertBulkTicketMutationsRespectCutoffs(existingEvent, scheduleCandidate.tickets, scheduleCandidate.endAt);
    this.assertTicketAndRewardDatesFitEventSchedule(scheduleCandidate);

    const event = await this.eventRepository.updateByIdForUser(
      eventId,
      user.id,
      normalizedPayload,
    );

    if (!event) {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    return this.toProfileMutatingResponse(event);
  }

  public async addEventMedia(
    user: AuthUser,
    eventId: string,
    payload: AddEventMediaDto,
  ): Promise<AddEventMediaResponse> {
    const existingEvent = await this.getEventForOwner(user, eventId);

    if (existingEvent.status === "cancelled") {
      throw new AppError("Event gallery uploads are disabled for cancelled events.", httpStatus.UNPROCESSABLE_ENTITY);
    }

    const mediaItems = payload.mediaItems ?? [];
    const failures: AddEventMediaResponse["failures"] = [];
    const persisted: EventMediaResponse[] = [];
    let latestEvent = existingEvent;

    for (const [index, mediaInput] of mediaItems.entries()) {
      try {
        const mediaItem = await this.prepareEventMediaItem(eventId, user.id, mediaInput, index);
        const updatedEvent = await this.eventRepository.appendEventMediaItem(eventId, user.id, mediaItem);

        if (!updatedEvent) {
          failures.push({
            index,
            message: "Event gallery is full or no longer accepts uploads.",
          });
          continue;
        }

        latestEvent = updatedEvent;
        const savedMedia = updatedEvent.eventMedia.find((item) => item.id === mediaItem.id);
        if (savedMedia) {
          persisted.push(this.toEventMediaResponse(eventId, savedMedia));
        }
      } catch (error) {
        failures.push({
          index,
          message: error instanceof AppError ? error.message : "Unable to upload this media item.",
        });
      }
    }

    const host = await this.userRepository.findById(latestEvent.userId.toString());

    return {
      event: this.toResponse(latestEvent, host, undefined, undefined, { includeEventMedia: true }),
      mediaItems: persisted,
      failures,
    };
  }

  public async getAuthorizedEventMedia(
    user: AuthUser,
    eventId: string,
    mediaId: string,
  ): Promise<{ key: string; contentType: string; filename: string }> {
    const event = await this.eventRepository.findByIdWithEventMedia(eventId);

    if (!event) {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    const isOwner = event.userId.toString() === user.id;

    if (event.status === "draft" && !isOwner) {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    if (event.privacy === "private" && !isOwner) {
      const isMember = event.memberUserIds.some((id) => id.toString() === user.id);
      if (!isMember) {
        throw new AppError("Event not found.", httpStatus.NOT_FOUND);
      }
    }

    const media = event.eventMedia.find((item) => item.id === mediaId);
    if (!media) {
      throw new AppError("Event media not found.", httpStatus.NOT_FOUND);
    }

    // Video is temporarily disabled — never stream/serve a video event-media
    // object, even an existing one, through this endpoint. Reliable here
    // (unlike the generic /storage endpoint) because the media item's type
    // is already known from the Event document, before any object lookup.
    if (media.type === "video" && !env.ENABLE_VIDEO_UPLOADS) {
      throw new AppError("Video event media is temporarily unavailable.", httpStatus.BAD_REQUEST);
    }

    return {
      key: media.storageKey,
      contentType: media.contentType,
      filename: media.storageKey.split("/").pop() || "media",
    };
  }

  public async deleteEventMedia(
    user: AuthUser,
    eventId: string,
    mediaId: string,
  ): Promise<DeleteEventMediaResponse> {
    const existingEvent = await this.getEventForOwner(user, eventId);

    if (existingEvent.status === "cancelled") {
      throw new AppError("Event gallery deletion is disabled for cancelled events.", httpStatus.UNPROCESSABLE_ENTITY);
    }

    const media = existingEvent.eventMedia.find((item) => item.id === mediaId);

    if (!media) {
      throw new AppError("Event media not found.", httpStatus.NOT_FOUND);
    }

    const updatedEvent = await this.eventRepository.removeEventMediaItem(eventId, user.id, mediaId);

    if (!updatedEvent) {
      throw new AppError("Event media not found.", httpStatus.NOT_FOUND);
    }

    const host = await this.userRepository.findById(updatedEvent.userId.toString());

    return {
      event: this.toResponse(updatedEvent, host, undefined, undefined, { includeEventMedia: true }),
      mediaItem: this.toEventMediaResponse(eventId, media),
    };
  }

  public async deleteEvent(user: AuthUser, eventId: string): Promise<EventResponse> {
    const existingEvent = await this.getEventForOwner(user, eventId);

    if (existingEvent.status !== "draft") {
      throw new AppError(
        "Published events cannot be deleted. Cancel the event instead.",
        httpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const event = await this.eventRepository.deleteByIdForUser(eventId, user.id);

    if (!event) {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    const shadowMoment = await this.momentRepository.findEventAnnouncement(eventId);

    if (shadowMoment) {
      const shadowMomentId = shadowMoment._id.toString();
      const comments = await this.momentCommentRepository.findByMomentId(shadowMomentId);
      const commentIds = comments.map((c) => c._id.toString());

      await Promise.all([
        this.momentReactionRepository.deleteByMomentId(shadowMomentId),
        this.momentCommentRepository.deleteByMomentId(shadowMomentId),
        this.momentCommentReactionRepository.deleteByCommentIds(commentIds),
        this.momentShareRepository.deleteByMomentId(shadowMomentId),
        this.momentSaveRepository.deleteByMomentId(shadowMomentId),
        this.momentRepository.deleteEventAnnouncement(eventId),
      ]);
    }

    return this.toProfileMutatingResponse(event);
  }

  public async getEventTicket(
    user: AuthUser,
    eventId: string,
    ticketId: string,
  ): Promise<EventResponse> {
    const event = await this.getEventById(user, eventId);
    const ticket = event.tickets.find((item) => item.id === ticketId);

    if (!ticket) {
      throw new AppError("Event ticket not found.", httpStatus.NOT_FOUND);
    }

    return event;
  }

  public async createEventTicket(
    user: AuthUser,
    eventId: string,
    payload: CreateEventTicketDto,
  ): Promise<EventResponse> {
    const event = await this.getEventForTicketOwner(user, eventId);
    this.assertTicketCreationAvailable(event);
    // New published tickets start fully available — availableCount is set here, not by normalizeTicket.
    const ticket: EventTicket = {
      ...this.normalizeTicket(payload),
      availableCount: payload.capacity,
    };
    this.assertTicketDatesFitEventSchedule(event, [ticket]);
    const updatedEvent = await this.eventRepository.addTicketToEvent(eventId, user.id, ticket);

    if (!updatedEvent) {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    return this.toProfileMutatingResponse(updatedEvent);
  }

  public async updateEventTicket(
    user: AuthUser,
    eventId: string,
    ticketId: string,
    payload: UpdateEventTicketDto,
  ): Promise<EventResponse> {
    const event = await this.getEventForTicketOwner(user, eventId);
    const existingTicket = event.tickets.find((t) => t.id === ticketId);

    if (!existingTicket) {
      throw new AppError("Event ticket not found.", httpStatus.NOT_FOUND);
    }

    const isCapacityChanging =
      payload.capacity !== undefined && payload.capacity !== existingTicket.capacity;

    if (isCapacityChanging) {
      const delta = payload.capacity! - existingTicket.capacity;
      const capacityUpdated = await this.eventRepository.adjustTicketCapacityAndCount(
        eventId,
        ticketId,
        payload.capacity!,
        delta,
      );

      if (!capacityUpdated) {
        throw new AppError(
          "Cannot reduce ticket capacity below the number of tickets already sold.",
          httpStatus.CONFLICT,
        );
      }
    }

    // Merge payload into existing ticket, then normalize all mutable fields except capacity/availableCount
    // (capacity is handled above; availableCount is never touched by updateTicketFields).
    const merged = this.normalizeTicket({
      ...existingTicket,
      ...payload,
      id: existingTicket.id,
      type: payload.type ?? existingTicket.type,
    });
    this.assertTicketPriceChangeAvailable(event, existingTicket, merged);
    this.assertTicketDatesFitEventSchedule(event, [merged]);

    const updatedEvent = await this.eventRepository.updateTicketFields(eventId, user.id, ticketId, {
      name: merged.name,
      description: merged.description,
      salesEndAt: merged.salesEndAt,
      type: merged.type,
      price: merged.price,
      ...(!isCapacityChanging ? { capacity: merged.capacity } : {}),
    });

    if (!updatedEvent) {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    return this.toProfileMutatingResponse(updatedEvent);
  }

  public async deleteEventTicket(
    user: AuthUser,
    eventId: string,
    ticketId: string,
  ): Promise<EventResponse> {
    const event = await this.getEventForTicketOwner(user, eventId);
    const exists = event.tickets.some((t) => t.id === ticketId);

    if (!exists) {
      throw new AppError("Event ticket not found.", httpStatus.NOT_FOUND);
    }

    const ticketSales = await this.checkoutPaymentRepository.getEventTicketSales(eventId);

    if ((ticketSales[ticketId] ?? 0) > 0) {
      throw new AppError(
        "Tickets with completed purchases cannot be deleted.",
        httpStatus.CONFLICT,
      );
    }

    const updatedEvent = await this.eventRepository.removeTicketFromEvent(
      eventId,
      user.id,
      ticketId,
    );

    if (!updatedEvent) {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    return this.toProfileMutatingResponse(updatedEvent);
  }

  public async createDraftTicket(
    user: AuthUser,
    eventId: string,
    payload: CreateEventTicketDto,
  ): Promise<EventResponse> {
    const event = await this.getDraftForUser(user, eventId);
    this.assertTicketCreationAvailable(event);
    const ticket = this.normalizeTicket(payload);
    this.assertTicketDatesFitEventSchedule(event, [ticket]);
    const updatedEvent = await this.eventRepository.updateDraftByIdForUser(eventId, user.id, {
      tickets: [...event.tickets.map((item) => this.normalizeTicket(item)), ticket],
    });

    if (!updatedEvent) {
      throw new AppError("Event draft not found.", httpStatus.NOT_FOUND);
    }

    return this.toResponse(updatedEvent);
  }

  public async updateDraftTicket(
    user: AuthUser,
    eventId: string,
    ticketId: string,
    payload: UpdateEventTicketDto,
  ): Promise<EventResponse> {
    const event = await this.getDraftForUser(user, eventId);
    let foundTicket = false;
    let existingTicket: EventTicket | null = null;
    let mergedTicket: EventTicket | null = null;
    const tickets = event.tickets.map((ticket) => {
      const normalizedTicket = this.normalizeTicket(ticket);

      if (normalizedTicket.id !== ticketId) {
        return normalizedTicket;
      }

      foundTicket = true;
      existingTicket = normalizedTicket;

      mergedTicket = this.normalizeTicket({
        ...normalizedTicket,
        ...payload,
        id: normalizedTicket.id,
        type: payload.type ?? normalizedTicket.type,
      });

      return mergedTicket;
    });

    if (!foundTicket) {
      throw new AppError("Event draft ticket not found.", httpStatus.NOT_FOUND);
    }
    if (existingTicket && mergedTicket) {
      this.assertTicketPriceChangeAvailable(event, existingTicket, mergedTicket);
    }
    this.assertTicketDatesFitEventSchedule(event, tickets);

    const updatedEvent = await this.eventRepository.updateDraftByIdForUser(eventId, user.id, {
      tickets,
    });

    if (!updatedEvent) {
      throw new AppError("Event draft not found.", httpStatus.NOT_FOUND);
    }

    return this.toResponse(updatedEvent);
  }

  public async deleteDraftTicket(
    user: AuthUser,
    eventId: string,
    ticketId: string,
  ): Promise<EventResponse> {
    const event = await this.getDraftForUser(user, eventId);
    const tickets = event.tickets.map((ticket) => this.normalizeTicket(ticket));
    const nextTickets = tickets.filter((ticket) => ticket.id !== ticketId);

    if (nextTickets.length === tickets.length) {
      throw new AppError("Event draft ticket not found.", httpStatus.NOT_FOUND);
    }

    const updatedEvent = await this.eventRepository.updateDraftByIdForUser(eventId, user.id, {
      tickets: nextTickets,
    });

    if (!updatedEvent) {
      throw new AppError("Event draft not found.", httpStatus.NOT_FOUND);
    }

    return this.toResponse(updatedEvent);
  }

  public async createEventReward(
    user: AuthUser,
    eventId: string,
    payload: CreateEventRewardDto,
  ): Promise<EventResponse> {
    const event = await this.getModifiableEventForOwner(user, eventId);
    const reward = await this.normalizeReward(payload, event, user.id);
    this.assertRewardDatesFitEventSchedule(event, [reward]);
    this.assertRewardDatesFitTicketSalesEnd(event, [reward]);
    const rewards = this.normalizeExistingRewards(event.rewards);
    this.assertTicketRewardAvailable(rewards, reward);
    const nextRewards = [...rewards, reward];
    const updatedEvent =
      reward.rewardType === "ticket" && reward.ticketId
        ? await this.eventRepository.updateRewardsIfTicketAvailable(
            eventId,
            user.id,
            nextRewards,
            reward.ticketId,
          )
        : await this.eventRepository.updateByIdForUser(eventId, user.id, { rewards: nextRewards });

    if (!updatedEvent) {
      if (reward.rewardType === "ticket") {
        this.throwTicketRewardConflict(reward.ticketId);
      }
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    return this.toProfileMutatingResponse(updatedEvent);
  }

  public async updateEventReward(
    user: AuthUser,
    eventId: string,
    rewardId: string,
    payload: UpdateEventRewardDto,
  ): Promise<EventResponse> {
    const event = await this.getModifiableEventForOwner(user, eventId);
    const rewards = this.normalizeExistingRewards(event.rewards);
    let foundReward = false;
    const nextRewards = await Promise.all(
      rewards.map(async (reward) => {
        if (reward.id !== rewardId) {
          return reward;
        }

        foundReward = true;

        return this.normalizeReward(
          {
            ...reward,
            ...payload,
            id: reward.id,
            rewardType: payload.rewardType ?? reward.rewardType,
          },
          event,
          user.id,
          reward,
        );
      }),
    );

    if (!foundReward) {
      throw new AppError("Event reward not found.", httpStatus.NOT_FOUND);
    }

    const updatedReward = nextRewards.find((reward) => reward.id === rewardId)!;
    const originalReward = rewards.find((reward) => reward.id === rewardId)!;
    const redeemedCount = await this.rewardClaimRepository.countSuccessfulCheckoutRedemptions(eventId, rewardId);
    if (redeemedCount > 0) {
      this.assertRedeemedRewardUpdateAllowed(originalReward, updatedReward);
    }
    this.assertRewardDatesFitEventSchedule(event, [updatedReward]);
    this.assertRewardDatesFitTicketSalesEnd(event, [updatedReward]);
    this.assertTicketRewardAvailable(rewards, updatedReward, rewardId);
    const updatedEvent =
      updatedReward.rewardType === "ticket" && updatedReward.ticketId
        ? await this.eventRepository.updateRewardsIfTicketAvailable(
            eventId,
            user.id,
            nextRewards,
            updatedReward.ticketId,
            { excludeRewardId: rewardId },
          )
        : await this.eventRepository.updateByIdForUser(eventId, user.id, { rewards: nextRewards });

    if (!updatedEvent) {
      if (updatedReward.rewardType === "ticket") {
        this.throwTicketRewardConflict(updatedReward.ticketId);
      }
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    return this.toProfileMutatingResponse(updatedEvent);
  }

  public async deleteEventReward(
    user: AuthUser,
    eventId: string,
    rewardId: string,
  ): Promise<EventResponse> {
    const event = await this.getModifiableEventForOwner(user, eventId);
    const rewards = this.normalizeExistingRewards(event.rewards);
    const nextRewards = rewards.filter((reward) => reward.id !== rewardId);

    if (nextRewards.length === rewards.length) {
      throw new AppError("Event reward not found.", httpStatus.NOT_FOUND);
    }

    const redeemedCount = await this.rewardClaimRepository.countSuccessfulCheckoutRedemptions(eventId, rewardId);
    if (redeemedCount > 0) {
      const nextDisabledRewards = rewards.map((reward) =>
        reward.id === rewardId ? { ...reward, disabledAt: reward.disabledAt ?? new Date() } : reward,
      );
      const disabledEvent = await this.eventRepository.updateByIdForUser(eventId, user.id, {
        rewards: nextDisabledRewards,
      });

      if (!disabledEvent) {
        throw new AppError("Event not found.", httpStatus.NOT_FOUND);
      }

      return this.toProfileMutatingResponse(disabledEvent);
    }

    const updatedEvent = await this.eventRepository.updateByIdForUser(eventId, user.id, {
      rewards: nextRewards,
    });

    if (!updatedEvent) {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    return this.toProfileMutatingResponse(updatedEvent);
  }

  public async createDraftReward(
    user: AuthUser,
    eventId: string,
    payload: CreateEventRewardDto,
  ): Promise<EventResponse> {
    const event = await this.getDraftForUser(user, eventId);
    const reward = await this.normalizeReward(payload, event, user.id);
    this.assertRewardDatesFitEventSchedule(event, [reward]);
    this.assertRewardDatesFitTicketSalesEnd(event, [reward]);
    const rewards = this.normalizeExistingRewards(event.rewards);
    this.assertTicketRewardAvailable(rewards, reward);
    const nextRewards = [...rewards, reward];
    const updatedEvent =
      reward.rewardType === "ticket" && reward.ticketId
        ? await this.eventRepository.updateRewardsIfTicketAvailable(
            eventId,
            user.id,
            nextRewards,
            reward.ticketId,
            { draftOnly: true },
          )
        : await this.eventRepository.updateDraftByIdForUser(eventId, user.id, {
            rewards: nextRewards,
          });

    if (!updatedEvent) {
      if (reward.rewardType === "ticket") {
        this.throwTicketRewardConflict(reward.ticketId);
      }
      throw new AppError("Event draft not found.", httpStatus.NOT_FOUND);
    }

    return this.toResponse(updatedEvent);
  }

  public async updateDraftReward(
    user: AuthUser,
    eventId: string,
    rewardId: string,
    payload: UpdateEventRewardDto,
  ): Promise<EventResponse> {
    const event = await this.getDraftForUser(user, eventId);
    const rewards = this.normalizeExistingRewards(event.rewards);
    let foundReward = false;
    const nextRewards = await Promise.all(
      rewards.map(async (reward) => {
        if (reward.id !== rewardId) {
          return reward;
        }

        foundReward = true;

        return this.normalizeReward(
          {
            ...reward,
            ...payload,
            id: reward.id,
            rewardType: payload.rewardType ?? reward.rewardType,
          },
          event,
          user.id,
          reward,
        );
      }),
    );

    if (!foundReward) {
      throw new AppError("Event draft reward not found.", httpStatus.NOT_FOUND);
    }

    const updatedReward = nextRewards.find((reward) => reward.id === rewardId)!;
    this.assertRewardDatesFitEventSchedule(event, [updatedReward]);
    this.assertRewardDatesFitTicketSalesEnd(event, [updatedReward]);
    this.assertTicketRewardAvailable(rewards, updatedReward, rewardId);
    const updatedEvent =
      updatedReward.rewardType === "ticket" && updatedReward.ticketId
        ? await this.eventRepository.updateRewardsIfTicketAvailable(
            eventId,
            user.id,
            nextRewards,
            updatedReward.ticketId,
            { excludeRewardId: rewardId, draftOnly: true },
          )
        : await this.eventRepository.updateDraftByIdForUser(eventId, user.id, {
            rewards: nextRewards,
          });

    if (!updatedEvent) {
      if (updatedReward.rewardType === "ticket") {
        this.throwTicketRewardConflict(updatedReward.ticketId);
      }
      throw new AppError("Event draft not found.", httpStatus.NOT_FOUND);
    }

    return this.toResponse(updatedEvent);
  }

  public async deleteDraftReward(
    user: AuthUser,
    eventId: string,
    rewardId: string,
  ): Promise<EventResponse> {
    const event = await this.getDraftForUser(user, eventId);
    const rewards = this.normalizeExistingRewards(event.rewards);
    const nextRewards = rewards.filter((reward) => reward.id !== rewardId);

    if (nextRewards.length === rewards.length) {
      throw new AppError("Event draft reward not found.", httpStatus.NOT_FOUND);
    }

    const updatedEvent = await this.eventRepository.updateDraftByIdForUser(eventId, user.id, {
      rewards: nextRewards,
    });

    if (!updatedEvent) {
      throw new AppError("Event draft not found.", httpStatus.NOT_FOUND);
    }

    return this.toResponse(updatedEvent);
  }

  public async listMyEvents(user: AuthUser): Promise<EventResponse[]> {
    const events = await this.eventRepository.findByUserId(user.id);

    return this.withCrowdStatuses(events, events.map((event) => this.toResponse(event)));
  }

  public async listMyDraftEvents(user: AuthUser): Promise<EventResponse[]> {
    const events = await this.eventRepository.findDraftsByUserId(user.id);

    return events.map((event) => this.toResponse(event));
  }

  public async listFeedEvents(
    user?: AuthUser,
    query: EventFeedQuery = {},
    context: EventRequestContext = {},
  ): Promise<EventResponse[]> {
    const isSmartFeedEnabled = env.ENABLE_SMART_FEED === true;
    const shouldLoadFriendIds = Boolean(user && (isSmartFeedEnabled || query.audience === "friends"));
    const [excludeUserIds, blockerUserIds, followingIds, friendIds] = await Promise.all([
      user ? this.userBlockRepository.findBlockedIds(user.id) : Promise.resolve([]),
      user && isSmartFeedEnabled ? this.userBlockRepository.findBlockerIds(user.id) : Promise.resolve([]),
      user ? this.userFollowRepository.findFollowingIds(user.id) : Promise.resolve([]),
      shouldLoadFriendIds && user
        ? this.userFollowRepository.findMutualFriendIds(user.id)
        : Promise.resolve([]),
    ]);

    const followingSet = new Set(followingIds);
    const hostUserIds = query.audience === "friends" ? friendIds : undefined;
    const hasNearbyFilter =
      typeof query.latitude === "number" && typeof query.longitude === "number";
    const feedOptions = {
      category: query.category,
      latitude: query.latitude,
      longitude: query.longitude,
      radiusKm: query.radiusKm,
      activeOnly: hasNearbyFilter,
      ageRestriction: query.ageRestriction,
      priceFilter: query.priceFilter,
      date: query.date,
      timePeriod: query.timePeriod,
      timezoneOffsetMinutes: query.timezoneOffsetMinutes,
      hashtags: query.hashtags,
      hostUserIds,
    };
    const [publicEvents, privateEvents] = await Promise.all([
      this.eventRepository.findPublicFeedEvents(excludeUserIds, feedOptions),
      user
        ? this.eventRepository.findPrivateFeedEventsForUser(user.id, excludeUserIds, feedOptions)
        : Promise.resolve([]),
    ]);
    const events = this.mergeFeedEvents(publicEvents, privateEvents, hasNearbyFilter, query.limit);
    const hostById = await this.getHostById(events);
    const interactionMoments = await Promise.all(
      events.map((event) => this.ensureEventInteractionMoment(event)),
    );
    const momentIds = interactionMoments.map((moment) => moment._id.toString());
    const publicGoingSummariesPromise = this.checkoutPaymentService.getPublicEventGoingSummaries(
      events.map((event) => ({
        id: event._id.toString(),
        status: event.status,
        hostUserId: event.userId.toString(),
      })),
      user?.id,
    );
    const eventIds = events.map((event) => event._id.toString());
    const smartFeedFriendIds = isSmartFeedEnabled
      ? friendIds.filter((id) => !excludeUserIds.includes(id) && !blockerUserIds.includes(id))
      : [];
    const smartFeedFollowedIds = isSmartFeedEnabled
      ? followingIds.filter((id) => !excludeUserIds.includes(id) && !blockerUserIds.includes(id))
      : [];
    const [likeCounts, commentCounts, shareCounts, likedMomentIds, savedMomentIds, publicGoingSummaries, reportedEventIds, smartFeedContext] =
      await Promise.all([
        this.momentReactionRepository.countByMomentIds(momentIds),
        this.momentCommentRepository.countByMomentIds(momentIds),
        this.momentShareRepository.countByMomentIds(momentIds),
        user
          ? this.momentReactionRepository.findLikedMomentIds(user.id, momentIds)
          : Promise.resolve(new Set<string>()),
        user
          ? this.momentSaveRepository.findSavedMomentIds(user.id, momentIds)
          : Promise.resolve(new Set<string>()),
        publicGoingSummariesPromise,
        user
          ? this.reportRepository.findReportedTargetIds(user.id, "event", eventIds)
          : Promise.resolve(new Set<string>()),
        isSmartFeedEnabled
          ? this.buildEventSmartFeedContext(
              events,
              momentIds,
              user?.id,
              smartFeedFriendIds,
              smartFeedFollowedIds,
              query,
              context,
            )
          : Promise.resolve(undefined),
      ]);

    const responseEvents = events.map((event, index) => {
      const host = hostById.get(event.userId.toString()) ?? null;
      const hostExtras =
        user && host ? { isFollowing: followingSet.has(event.userId.toString()) } : undefined;
      const interactionMomentId = interactionMoments[index]!._id.toString();
      return {
        ...this.toResponse(event, host, hostExtras),
        interactionMomentId,
        likesCount: likeCounts.get(interactionMomentId) ?? 0,
        commentsCount: commentCounts.get(interactionMomentId) ?? 0,
        sharesCount: shareCounts.get(interactionMomentId) ?? 0,
        isLiked: likedMomentIds.has(interactionMomentId),
        isSaved: savedMomentIds.has(interactionMomentId),
        hasReported: reportedEventIds.has(event._id.toString()),
        publicGoingSummary: publicGoingSummaries.get(event._id.toString()) ?? { going: 0, avatars: [] },
        ...(smartFeedContext?.socialContextByEventId.get(event._id.toString())
          ? { socialContext: smartFeedContext.socialContextByEventId.get(event._id.toString()) }
          : {}),
        ...(smartFeedContext?.scoreByEventId.get(event._id.toString())
          ? {
              smartFeed: smartFeedContext.scoreByEventId.get(event._id.toString()),
              smartFeedScore: smartFeedContext.scoreByEventId.get(event._id.toString())?.finalScore,
            }
          : {}),
      };
    });

    const eventsWithCrowdStatuses = await this.withCrowdStatuses(events, responseEvents);

    return isSmartFeedEnabled ? eventsWithCrowdStatuses.sort(compareSmartFeedScoreDesc) : eventsWithCrowdStatuses;
  }

  // Two-tier ordering deliberately mirrors the existing feed/map "nearby" convention
  // (bounding radius check via getDistanceKm, then a stable date-based sort) rather than
  // the Smart Feed blended score — a hashtag match should never be outranked by a farther,
  // more "popular" event. Nearby events (within radiusKm) come first, soonest-scheduled
  // first; everything else follows, most-recently-published first.
  public async listHashtagEvents(
    hashtagValue: string,
    user: AuthUser,
    options: { limit?: number; latitude?: number; longitude?: number; radiusKm?: number } = {},
  ): Promise<EventResponse[]> {
    const hashtag = normalizeHashtag(hashtagValue);

    if (!hashtag) {
      return [];
    }

    const limit = options.limit ?? 50;
    const excludeUserIds = await this.userBlockRepository.findBlockedIds(user.id);
    const candidates = await this.eventRepository.findPublicByHashtag(hashtag, excludeUserIds, 200, user.id);

    const hasNearbyFilter = typeof options.latitude === "number" && typeof options.longitude === "number";
    const radiusKm = options.radiusKm ?? MAX_EVENT_FILTER_RADIUS_KM;

    const nearbyEvents: IEvent[] = [];
    const remainingEvents: IEvent[] = [];

    for (const event of candidates) {
      const latitude = event.location?.latitude;
      const longitude = event.location?.longitude;
      const isNearby =
        hasNearbyFilter &&
        typeof latitude === "number" &&
        typeof longitude === "number" &&
        Number.isFinite(latitude) &&
        Number.isFinite(longitude) &&
        getDistanceKm(
          { latitude: options.latitude!, longitude: options.longitude! },
          { latitude, longitude },
        ) <= radiusKm;

      (isNearby ? nearbyEvents : remainingEvents).push(event);
    }

    nearbyEvents.sort(
      (left, right) =>
        this.compareDatesAsc(left.scheduledAt, right.scheduledAt) ||
        this.compareDatesDesc(left.publishedAt, right.publishedAt) ||
        right._id.toString().localeCompare(left._id.toString()),
    );
    remainingEvents.sort(
      (left, right) =>
        this.compareDatesDesc(left.publishedAt, right.publishedAt) ||
        this.compareDatesDesc(left.createdAt, right.createdAt) ||
        right._id.toString().localeCompare(left._id.toString()),
    );

    const orderedEvents = [...nearbyEvents, ...remainingEvents].slice(0, limit);
    const hostById = await this.getHostById(orderedEvents);

    return orderedEvents.map((event) =>
      this.toResponse(event, hostById.get(event.userId.toString()) ?? null),
    );
  }

  public async toggleSaveEvent(
    user: AuthUser,
    eventId: string,
  ): Promise<{ eventId: string; isSaved: boolean }> {
    const event = await this.eventRepository.findById(eventId);

    if (!event || event.status === "draft") {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    const result = await this.eventSaveRepository.toggleSave(user.id, eventId);

    return { eventId, isSaved: result.isSaved };
  }

  public async listMyPostTagEvents(user: AuthUser): Promise<PostTagEventResponse[]> {
    const now = Date.now();
    const activeSince = new Date(now - ACTIVE_EVENT_WINDOW_MS);

    const nowDate = new Date(now);

    // Public events can be tagged by any user while they are upcoming, live, or active.
    const [publicEvents, ownEvents] = await Promise.all([
      this.eventRepository.findPublicPostTaggable(activeSince, nowDate),
      this.eventRepository.findActiveAndUpcomingByUserId(user.id, activeSince, nowDate),
    ]);

    // Private ticket-holder events remain available only when live or active.
    const [paidEventIds, sharedEventIds] = await Promise.all([
      this.checkoutPaymentRepository.findPaidTicketEventIdsByUser(user.id),
      this.ticketShareRepository.findActiveEventIdsByRecipient(user.id),
    ]);

    const directlyAvailableEventIdSet = new Set(
      [...publicEvents, ...ownEvents].map((e) => e._id.toString()),
    );
    const foreignTicketEventIds = [...new Set([...paidEventIds, ...sharedEventIds])].filter(
      (id) => !directlyAvailableEventIdSet.has(id),
    );

    const ticketEvents = await this.eventRepository.findLiveActiveByIds(
      foreignTicketEventIds,
      activeSince,
      nowDate,
    );

    const eventById = new Map<string, IEvent>();
    [...publicEvents, ...ownEvents, ...ticketEvents].forEach((event) => {
      eventById.set(event._id.toString(), event);
    });
    const allEvents = [...eventById.values()];

    return Promise.all(
      allEvents.map(async (event) => {
        const bannerImageUrl = event.bannerImageKey
          ? await this.storageService
              .createDownloadUrl(event.bannerImageKey)
              .then((d) => d.url)
              .catch(() => null)
          : null;

        const scheduled = event.scheduledAt?.getTime() ?? null;
        let postTagStatus: PostTagEventStatus;

        const ended = event.endAt?.getTime() ?? null;

        if (scheduled === null || scheduled > now) {
          postTagStatus = "upcoming";
        } else if (ended ? ended >= now : now - scheduled <= NOW_MODE_LOOKAHEAD_MS) {
          postTagStatus = "live";
        } else {
          postTagStatus = "active";
        }

        return {
          id: event._id.toString(),
          name: event.name ?? "",
          bannerImageUrl,
          scheduledAt: event.scheduledAt!,
          location: event.location ?? null,
          postTagStatus,
        };
      }),
    );
  }

  public async getTicketAccess(user: AuthUser, eventId: string): Promise<TicketAccessResponse> {
    const event = await this.eventRepository.findById(eventId);

    if (!event || event.status === "draft") {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    // Generic ticket access is ownership/share based. Event chat has a stricter
    // checked-in active-event rule enforced by EventChatAccessService.
    const [hasPaidTicket, hasActiveShare] = await Promise.all([
      this.checkoutPaymentRepository.hasUserPaidTicketForEvent(user.id, eventId),
      this.ticketShareRepository.hasActiveShareForRecipientAtEvent(user.id, eventId),
    ]);

    return { hasAccess: hasPaidTicket || hasActiveShare };
  }

  public async listMyProfileEvents(user: AuthUser): Promise<ProfileEventGroupsResponse> {
    return this.listProfileEventsByUserId(user.id, true, {}, user.id);
  }

  public async listProfileEventsForUser(
    user: AuthUser,
    userId: string,
    query: ProfileEventsQuery = {},
  ): Promise<ProfileEventGroupsResponse> {
    const isOwner = user.id.toLowerCase() === userId.toLowerCase();

    if (!isOwner) {
      const [viewerHasBlockedTarget, targetHasBlockedViewer] = await Promise.all([
        this.userBlockRepository.isBlocked(user.id, userId),
        this.userBlockRepository.isBlocked(userId, user.id),
      ]);

      if (viewerHasBlockedTarget || targetHasBlockedViewer) {
        throw new AppError("Profile unavailable", httpStatus.FORBIDDEN);
      }
    }

    return this.listProfileEventsByUserId(userId, isOwner, query, user.id);
  }

  public async listUserEventsForAdmin(userId: string): Promise<ProfileEventGroupsResponse> {
    return this.listProfileEventsByUserId(userId, true);
  }

  public async getEventForAdmin(eventId: string): Promise<EventResponse> {
    const event = await this.eventRepository.findById(eventId);

    if (!event || !ADMIN_EVENT_DETAIL_STATUSES.has(event.status)) {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    const host = await this.userRepository.findById(event.userId.toString());
    const avatarUrl = host?.avatarKey
      ? await this.storageService
          .createDownloadUrl(host.avatarKey)
          .then((download) => download.url)
          .catch(() => null)
      : null;
    const response = this.toResponse(event, host, { avatarUrl }, undefined, { includeEventMedia: true });
    const [eventWithGoing] = await this.withPublicGoingSummaries([response]);
    const [eventWithCrowdStatus] = await this.withCrowdStatuses([event], eventWithGoing ? [eventWithGoing] : []);

    if (!eventWithCrowdStatus) {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    return eventWithCrowdStatus;
  }

  public async listProfileEventsByUserId(
    userId: string,
    includePrivateEvents = true,
    query: ProfileEventsQuery = {},
    viewerId?: string,
  ): Promise<ProfileEventGroupsResponse> {
    if (query.filter) {
      const filter = query.filter;
      const { page, limit, skip } = getPaginationOptions({ page: query.page, limit: query.limit ?? 10 });
      const [events, total, host] = await Promise.all([
        this.eventRepository.findProfileEventsByUserId(userId, includePrivateEvents, filter, skip, limit),
        this.eventRepository.countProfileEventsByUserId(userId, includePrivateEvents, filter),
        this.userRepository.findById(userId),
      ]);
      const interactionSummaries = await this.eventInteractionSummaryService.buildForEvents(
        events.map((event) => ({
          id: event._id.toString(),
          userId: event.userId.toString(),
          name: event.name,
          description: event.description,
        })),
        viewerId,
      );
      const responseEvents = await this.withCrowdStatuses(
        events,
        await this.withPublicGoingSummaries(
          events.map((event) => ({
            ...this.toResponse(event, host),
            ...interactionSummaries.get(event._id.toString()),
          })),
          viewerId,
        ),
      );

      return {
        active: filter === "past" ? [] : responseEvents,
        past: filter === "past" ? responseEvents : [],
        pagination: createPaginationMeta(page, limit, total),
      };
    }

    const cacheKey = this.getProfileEventsCacheKey(userId, includePrivateEvents);
    const cachedEvents = await this.getCachedProfileEvents(cacheKey);

    if (cachedEvents) {
      const withExtras = await this.withCrowdStatusesForGroups(await this.withPublicGoingSummariesForGroups(cachedEvents, viewerId));
      return this.withInteractionSummariesForGroups(withExtras, viewerId);
    }

    const [events, host] = await Promise.all([
      this.eventRepository.findPublishedProfileEventsByUserId(userId, includePrivateEvents),
      this.userRepository.findById(userId),
    ]);

    const response = {
      active: events.active.map((event) => this.toResponse(event, host)),
      past: events.past.map((event) => this.toResponse(event, host)),
    };

    await this.cacheProfileEvents(cacheKey, response);

    const withExtras = await this.withCrowdStatusesForGroups(await this.withPublicGoingSummariesForGroups(response, viewerId));
    return this.withInteractionSummariesForGroups(withExtras, viewerId);
  }

  // Interaction counts are event-wide but isLiked/isSaved are viewer-specific,
  // so — unlike withCrowdStatusesForGroups/withPublicGoingSummariesForGroups
  // above, whose outputs also aren't cached — this always runs after the
  // Redis-cached (viewer-agnostic) response is read, never before it's written.
  private async withInteractionSummariesForGroups(
    groups: ProfileEventGroupsResponse,
    viewerId?: string,
  ): Promise<ProfileEventGroupsResponse> {
    const interactionSummaries = await this.eventInteractionSummaryService.buildForEvents(
      [...groups.active, ...groups.past].map((event) => ({
        id: event.id,
        userId: event.userId,
        name: event.name,
        description: event.description,
      })),
      viewerId,
    );
    const applySummary = (event: EventResponse): EventResponse => ({
      ...event,
      ...interactionSummaries.get(event.id),
    });

    return {
      ...groups,
      active: groups.active.map(applySummary),
      past: groups.past.map(applySummary),
    };
  }

  public async startEvent(user: AuthUser, eventId: string): Promise<EventResponse> {
    const event = await this.eventRepository.startById(eventId, user.id);

    if (!event) {
      throw new AppError("Published event not found.", httpStatus.NOT_FOUND);
    }

    return this.toProfileMutatingResponse(event);
  }

  public async completeEvent(user: AuthUser, eventId: string): Promise<EventResponse> {
    const event = await this.eventRepository.completeById(eventId, user.id);

    if (!event) {
      throw new AppError("Live event not found.", httpStatus.NOT_FOUND);
    }

    const completedAt = event.completedAt ?? new Date();
    const eligibleAt = new Date(completedAt.getTime() + 72 * 60 * 60 * 1000);

    await this.creatorEarningRepository.setEligibleAtByEventId(eventId, eligibleAt);

    return this.toProfileMutatingResponse(event);
  }

  public async autoStartScheduledEvents(): Promise<number> {
    const started = await this.eventRepository.autoStartScheduled(new Date());

    await this.invalidateProfileEventsCacheForEvents(started);

    return started.length;
  }

  public async autoCompleteExpiredEvents(): Promise<number> {
    const now = new Date();
    const expired = await this.eventRepository.findAndAutoComplete(now);

    const eligibleAt = new Date(now.getTime() + 72 * 60 * 60 * 1000);

    await Promise.allSettled(
      expired.map((event) =>
        this.creatorEarningRepository.setEligibleAtByEventId(event._id.toString(), eligibleAt),
      ),
    );
    await this.invalidateProfileEventsCacheForEvents(expired);

    return expired.length;
  }

  public async cancelEvent(
    user: AuthUser,
    eventId: string,
    dto: CancelEventDto,
  ): Promise<{ event: EventResponse; refundBatch: CancellationBatchResponse }> {
    const result = await this.eventCancellationRefundService.cancelPublishedEvent(user, eventId, dto);

    return {
      event: await this.toProfileMutatingResponse(result.event),
      refundBatch: result.batch,
    };
  }

  public async listMapEvents(user: AuthUser, query: EventMapQuery): Promise<EventMapListResponse> {
    const activeSince = new Date(Date.now() - ACTIVE_EVENT_WINDOW_MS);
    const pageLimit = query.limit ?? 100;
    const mapQuery = {
      ...query,
      radiusKm: query.radiusKm ?? 50,
      limit: pageLimit + 1,
      activeSince,
      paginationCursor: decodeMapCursor(query.cursor),
    };
    const [publicEvents, privateEvents] = await Promise.all([
      this.eventRepository.findMapEvents(mapQuery),
      this.eventRepository.findPrivateMapEventsForUser(user.id, mapQuery),
    ]);
    const events = this.mergeMapEvents(publicEvents, privateEvents, pageLimit + 1);
    const pageEvents = events.slice(0, pageLimit);
    const nextCursor = events.length > pageLimit ? encodeMapCursor(pageEvents[pageEvents.length - 1]!) : null;
    const hostById = await this.getHostById(pageEvents);
    const responseEvents = pageEvents.map((event) =>
      this.toResponse(event, hostById.get(event.userId.toString()) ?? null),
    );
    const [eventsWithCrowdStatus, checkedInCountByEventId] = await Promise.all([
      this.withCrowdStatuses(pageEvents, responseEvents),
      this.crowdStatusService.getCheckedInCountsByEventId(pageEvents),
    ]);

    return {
      events: eventsWithCrowdStatus.map((event) => ({
        ...event,
        checkedInCount: checkedInCountByEventId.get(event.id) ?? 0,
      })),
      nextCursor,
    };
  }

  public async listAdminMapEvents(): Promise<AdminMapEventResponse[]> {
    const now = new Date();
    const activeSince = new Date(now.getTime() - ACTIVE_EVENT_WINDOW_MS);
    const events = await this.eventRepository.findAdminMapEvents(now, activeSince);
    const hostById = await this.getHostById(events);
    const crowdStatusByEventId = await this.crowdStatusService.getCrowdStatusByEventId(events);

    const items = await Promise.all(
      events.map(async (event): Promise<AdminMapEventResponse | null> => {
        const latitude = event.location?.latitude;
        const longitude = event.location?.longitude;

        if (
          typeof latitude !== "number" ||
          !Number.isFinite(latitude) ||
          latitude < -90 ||
          latitude > 90 ||
          typeof longitude !== "number" ||
          !Number.isFinite(longitude) ||
          longitude < -180 ||
          longitude > 180
        ) {
          return null;
        }

        const bannerImageUrl = event.bannerImageKey
          ? await this.storageService
              .createDownloadUrl(event.bannerImageKey)
              .then(({ url }) => url)
              .catch(() => null)
          : null;
        const isUpcoming = Boolean(
          event.scheduledAt && event.scheduledAt.getTime() > now.getTime(),
        );

        return {
          id: event._id.toString(),
          title: event.name?.trim() || "Untitled Event",
          status: event.status === "live" ? "live" : isUpcoming ? "upcoming" : "active",
          crowdStatus: crowdStatusByEventId.get(event._id.toString()) ?? null,
          scheduledAt: event.scheduledAt ?? null,
          endAt: event.endAt ?? null,
          latitude,
          longitude,
          locationName:
            event.location?.venue?.trim() ||
            event.location?.searchLabel?.trim() ||
            event.location?.address?.trim() ||
            "Location not specified",
          category: event.categories?.[0] ?? event.category ?? null,
          categories: event.categories?.length
            ? event.categories
            : event.category
              ? [event.category]
              : [],
          bannerImageUrl,
          hostName: hostById.get(event.userId.toString())?.name ?? null,
        };
      }),
    );

    return items.filter((item): item is AdminMapEventResponse => item !== null);
  }

  public async listNowModeEvents(query: NowModeQuery): Promise<NowModeEventResponse[]> {
    const now = Date.now();
    const activeSince = new Date(now - ACTIVE_EVENT_WINDOW_MS);
    const upcomingUntil = new Date(now + NOW_MODE_LOOKAHEAD_MS);

    const events = await this.eventRepository.findNowModeEvents({
      ...query,
      radiusKm: query.radiusKm ?? 50,
      limit: query.limit ?? 100,
      activeSince,
      upcomingUntil,
    });

    const hostById = await this.getHostById(events);
    const statusPriority: Record<NowEventStatus, number> = {
      live_now: 0,
      starting_soon: 1,
      last_call: 2,
    };

    const responseEvents = events
      .map((event) => {
        const nowStatus = getNowStatus(event.scheduledAt ?? null, event.endAt ?? null);

        if (!nowStatus) {
          return null;
        }

        return {
          ...this.toResponse(event, hostById.get(event.userId.toString()) ?? null),
          nowStatus,
        };
      })
      .filter((event): event is NowModeEventResponse => event !== null)
      .sort((a, b) => statusPriority[a.nowStatus] - statusPriority[b.nowStatus]);

    return this.withCrowdStatuses(events, responseEvents);
  }

  public async getEventById(user: AuthUser, eventId: string): Promise<EventResponse> {
    const event = await this.eventRepository.findById(eventId);

    if (!event) {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    const isOwner = event.userId.toString() === user.id;

    if (event.status === "draft" && !isOwner) {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    if (event.privacy === "private" && !isOwner) {
      const isMember = event.memberUserIds.some((id) => id.toString() === user.id);
      if (!isMember) {
        throw new AppError("Event not found.", httpStatus.NOT_FOUND);
      }
    }

    const host = await this.userRepository.findById(event.userId.toString());

    if (event.status === "draft") {
      const [avatarUrl, followersCount, eventsCount] = await Promise.all([
        host?.avatarKey
          ? this.storageService.createDownloadUrl(host.avatarKey).then((download) => download.url)
          : Promise.resolve(null),
        host ? this.userFollowRepository.countFollowers(host._id.toString()) : Promise.resolve(0),
        host
          ? this.eventRepository.countByUserId(host._id.toString(), ["published", "live"])
          : Promise.resolve(0),
      ]);

      return {
        ...this.toResponse(event, host, { avatarUrl, followersCount, eventsCount, isFollowing: false }, undefined, { includeEventMedia: true }),
        likesCount: 0,
        commentsCount: 0,
        sharesCount: 0,
        isLiked: false,
        isSaved: false,
        canReport: false,
        hasReported: false,
        isMember: false,
        hostReviewEligibility: { canReview: false, hasReviewed: false },
      };
    }

    const [avatarUrl, followersCount, eventsCount, isFollowing, interactionMoment] =
      await Promise.all([
        host?.avatarKey
          ? this.storageService.createDownloadUrl(host.avatarKey).then((download) => download.url)
          : Promise.resolve(null),
        host ? this.userFollowRepository.countFollowers(host._id.toString()) : Promise.resolve(0),
        host
          ? this.eventRepository.countByUserId(host._id.toString(), ["published", "live"])
          : Promise.resolve(0),
        host && host._id.toString() !== user.id
          ? this.userFollowRepository.isFollowing(user.id, host._id.toString())
          : Promise.resolve(false),
        this.ensureEventInteractionMoment(event),
        this.ensureEventChatRoom(event),
      ]);

    const interactionMomentId = interactionMoment._id.toString();
    const [
      likeCounts,
      commentCounts,
      shareCounts,
      likedMomentIds,
      savedMomentIds,
      attendance,
      publicGoingSummaries,
      crowdStatusByEventId,
      hasReported,
    ] = await Promise.all([
      this.momentReactionRepository.countByMomentIds([interactionMomentId]),
      this.momentCommentRepository.countByMomentIds([interactionMomentId]),
      this.momentShareRepository.countByMomentIds([interactionMomentId]),
      this.momentReactionRepository.findLikedMomentIds(user.id, [interactionMomentId]),
      this.momentSaveRepository.findSavedMomentIds(user.id, [interactionMomentId]),
      this.ticketUsageRepository.findByEventIdAndHolderUserId(event._id.toString(), user.id),
      this.checkoutPaymentService.getPublicEventGoingSummaries([
        { id: event._id.toString(), status: event.status, hostUserId: event.userId.toString() },
      ], user.id),
      this.crowdStatusService.getCrowdStatusByEventId([event]),
      this.reportRepository.hasReported(user.id, "event", event._id.toString()),
    ]);

    let myJoinRequestStatus: EventJoinRequestStatus | null = null;
    if (event.privacy === "locked" && !isOwner) {
      const joinRequest = await this.eventRepository.findUserJoinRequest(
        event._id.toString(),
        user.id,
      );
      myJoinRequestStatus = (joinRequest?.status as EventJoinRequestStatus) ?? null;
    }

    const hostReviewEligibility = await this.getHostReviewEligibility(event, user);

    return {
      ...this.toResponse(
        event,
        host,
        { avatarUrl, followersCount, eventsCount, isFollowing },
        myJoinRequestStatus,
        { includeEventMedia: true },
      ),
      interactionMomentId,
      likesCount: likeCounts.get(interactionMomentId) ?? 0,
      commentsCount: commentCounts.get(interactionMomentId) ?? 0,
      sharesCount: shareCounts.get(interactionMomentId) ?? 0,
      isLiked: likedMomentIds.has(interactionMomentId),
      isSaved: savedMomentIds.has(interactionMomentId),
      canReport: Boolean(attendance),
      hasReported,
      isMember: !isOwner && event.memberUserIds.some((id) => id.toString() === user.id),
      hostReviewEligibility,
      publicGoingSummary: publicGoingSummaries.get(event._id.toString()) ?? { going: 0, avatars: [] },
      crowdStatus: crowdStatusByEventId.get(event._id.toString()) ?? null,
    };
  }

  public async submitHostReview(
    user: AuthUser,
    eventId: string,
    payload: SubmitEventHostReviewDto,
  ): Promise<EventHostReviewResponse> {
    const event = await this.eventRepository.findById(eventId);

    if (!event) {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    if (event.status !== "completed") {
      throw new AppError(
        "You can review the host after the event is completed.",
        httpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    if (event.userId.toString() === user.id) {
      throw new AppError("You cannot review your own event.", httpStatus.FORBIDDEN);
    }

    const attendance = await this.ticketUsageRepository.findByEventIdAndHolderUserId(
      event._id.toString(),
      user.id,
    );

    if (!attendance) {
      throw new AppError("Only checked-in attendees can review this host.", httpStatus.FORBIDDEN);
    }

    const existingReview = await this.eventHostReviewRepository.findByEventIdAndReviewerUserId(
      event._id.toString(),
      user.id,
    );

    if (existingReview) {
      throw new AppError(
        "You have already reviewed this host for this event.",
        httpStatus.CONFLICT,
      );
    }

    let review: IEventHostReview;

    try {
      review = await this.eventHostReviewRepository.create({
        eventId: event._id.toString(),
        hostUserId: event.userId.toString(),
        reviewerUserId: user.id,
        ticketUsageId: attendance._id.toString(),
        liked: payload.liked,
        text: payload.text ?? null,
      });
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        throw new AppError(
          "You have already reviewed this host for this event.",
          httpStatus.CONFLICT,
        );
      }

      throw error;
    }

    const reviewer = await this.userRepository.findById(user.id);

    return this.toHostReviewResponse(review, reviewer, event);
  }

  public async listEventMembers(user: AuthUser, eventId: string): Promise<EventMemberResponse[]> {
    const event = await this.getNonDraftEventForOwner(user, eventId);
    return this.resolveMemberResponses(event.memberUserIds.map((id) => id.toString()));
  }

  public async addEventMember(
    user: AuthUser,
    eventId: string,
    memberId: string,
  ): Promise<EventMemberResponse[]> {
    const event = await this.getNonDraftEventForOwner(user, eventId);

    if (event.status === "completed" || event.status === "cancelled") {
      throw new AppError(
        "Members cannot be added to an event that has been completed or cancelled.",
        httpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    if (event.privacy !== "private") {
      throw new AppError("Members can only be added to private events.", httpStatus.BAD_REQUEST);
    }

    if (memberId === user.id) {
      throw new AppError("You cannot add yourself as a member.", httpStatus.BAD_REQUEST);
    }

    const memberUser = await this.userRepository.findById(memberId);

    if (!memberUser) {
      throw new AppError("User not found.", httpStatus.NOT_FOUND);
    }

    const isConnectedToCreator = await this.userFollowRepository.hasAnyFollowRelation(
      user.id,
      memberId,
    );

    if (!isConnectedToCreator) {
      throw new AppError(
        "Only your followers and people you follow can be added to a private event.",
        httpStatus.FORBIDDEN,
      );
    }

    const updatedEvent = await this.eventRepository.addMemberById(eventId, user.id, memberId);

    if (!updatedEvent) {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    void this.dispatchMemberAddedNotification(user, memberId, event.name ?? null, eventId);

    return this.resolveMemberResponses(updatedEvent.memberUserIds.map((id) => id.toString()));
  }

  public async removeEventMember(
    user: AuthUser,
    eventId: string,
    memberId: string,
  ): Promise<EventMemberResponse[]> {
    await this.getNonDraftEventForOwner(user, eventId);
    const updatedEvent = await this.eventRepository.removeMemberById(eventId, user.id, memberId);

    if (!updatedEvent) {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    return this.resolveMemberResponses(updatedEvent.memberUserIds.map((id) => id.toString()));
  }

  public async submitJoinRequest(
    user: AuthUser,
    eventId: string,
  ): Promise<{ status: EventJoinRequestStatus }> {
    const event = await this.eventRepository.findById(eventId);

    if (!event || (event.status !== "published" && event.status !== "live")) {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    if (event.privacy !== "locked") {
      throw new AppError("Join requests are only for locked events.", httpStatus.BAD_REQUEST);
    }

    if (event.userId.toString() === user.id) {
      throw new AppError("You cannot request to join your own event.", httpStatus.BAD_REQUEST);
    }

    const { alreadyExists, event: updatedEvent } = await this.eventRepository.addJoinRequest(
      eventId,
      user.id,
    );

    if (alreadyExists) {
      const existing = event.joinRequests.find((r) => r.userId.toString() === user.id);
      return { status: (existing?.status ?? "pending") as EventJoinRequestStatus };
    }

    if (!updatedEvent) {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    void this.dispatchJoinRequestNotification(
      user,
      event.userId.toString(),
      event.name ?? null,
      eventId,
    );

    return { status: "pending" };
  }

  public async listJoinRequests(user: AuthUser, eventId: string): Promise<JoinRequestResponse[]> {
    const event = await this.eventRepository.findById(eventId);

    if (!event || event.status === "draft") {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    if (event.userId.toString() !== user.id) {
      throw new AppError("Forbidden.", httpStatus.FORBIDDEN);
    }

    if (event.joinRequests.length === 0) {
      return [];
    }

    const requestUserIds = event.joinRequests.map((r) => r.userId.toString());
    const users = await this.userRepository.findMany(
      { _id: { $in: requestUserIds } },
      0,
      requestUserIds.length,
    );
    const urlResults = await Promise.all(
      users.map((u) =>
        u.avatarKey
          ? this.storageService
              .createDownloadUrl(u.avatarKey)
              .then((d) => d.url)
              .catch(() => null)
          : Promise.resolve(null),
      ),
    );
    const userMap = new Map(
      users.map((u, i) => [u._id.toString(), { user: u, avatarUrl: urlResults[i] }]),
    );

    return event.joinRequests.map((r) => {
      const userId = r.userId.toString();
      const entry = userMap.get(userId);
      return {
        userId,
        name: entry?.user.name ?? "Unknown",
        username: entry?.user.username,
        avatarKey: entry?.user.avatarKey ?? null,
        avatarUrl: entry?.avatarUrl ?? null,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
      };
    });
  }

  public async acceptJoinRequest(
    user: AuthUser,
    eventId: string,
    requestUserId: string,
  ): Promise<void> {
    const event = await this.getNonDraftEventForOwner(user, eventId);

    if (event.privacy !== "locked") {
      throw new AppError("Join requests are only for locked events.", httpStatus.BAD_REQUEST);
    }

    const updated = await this.eventRepository.updateJoinRequestStatus(
      eventId,
      user.id,
      requestUserId,
      "accepted",
    );

    if (!updated) {
      throw new AppError("Event or join request not found.", httpStatus.NOT_FOUND);
    }

    void this.dispatchJoinRequestAcceptedNotification(
      user,
      requestUserId,
      updated.name ?? null,
      eventId,
    );
  }

  private async dispatchMemberAddedNotification(
    actor: AuthUser,
    recipientId: string,
    eventName: string | null,
    eventId: string,
  ): Promise<void> {
    try {
      await this.notificationRepository.create({
        recipientUserId: recipientId,
        type: "event_member_added",
        actorUserId: actor.id,
        actorName: actor.name ?? null,
        actorUsername: actor.username ?? null,
        actorAvatarKey: actor.avatarKey ?? null,
        eventId,
        eventName,
      });
    } catch {
      // non-critical
    }
  }

  private async dispatchJoinRequestAcceptedNotification(
    actor: AuthUser,
    recipientId: string,
    eventName: string | null,
    eventId: string,
  ): Promise<void> {
    try {
      await this.notificationRepository.create({
        recipientUserId: recipientId,
        type: "join_request_accepted",
        actorUserId: actor.id,
        actorName: actor.name ?? null,
        actorUsername: actor.username ?? null,
        actorAvatarKey: actor.avatarKey ?? null,
        eventId,
        eventName,
      });
    } catch {
      // non-critical
    }
  }

  public async declineJoinRequest(
    user: AuthUser,
    eventId: string,
    requestUserId: string,
  ): Promise<void> {
    const event = await this.getNonDraftEventForOwner(user, eventId);

    if (event.privacy !== "locked") {
      throw new AppError("Join requests are only for locked events.", httpStatus.BAD_REQUEST);
    }

    const updated = await this.eventRepository.updateJoinRequestStatus(
      eventId,
      user.id,
      requestUserId,
      "declined",
    );

    if (!updated) {
      throw new AppError("Event or join request not found.", httpStatus.NOT_FOUND);
    }
  }

  private async dispatchJoinRequestNotification(
    actor: AuthUser,
    creatorId: string,
    eventName: string | null,
    eventId: string,
  ): Promise<void> {
    try {
      await this.notificationRepository.create({
        recipientUserId: creatorId,
        type: "join_request",
        actorUserId: actor.id,
        actorName: actor.name ?? null,
        actorUsername: actor.username ?? null,
        actorAvatarKey: actor.avatarKey ?? null,
        eventId,
        eventName,
      });
    } catch {
      // non-critical
    }
  }

  private async resolveMemberResponses(memberIds: string[]): Promise<EventMemberResponse[]> {
    if (memberIds.length === 0) {
      return [];
    }

    const users = await this.userRepository.findMany(
      { _id: { $in: memberIds } },
      0,
      memberIds.length,
    );
    const urlResults = await Promise.all(
      users.map((u) =>
        u.avatarKey
          ? this.storageService
              .createDownloadUrl(u.avatarKey)
              .then((d) => d.url)
              .catch(() => null)
          : Promise.resolve(null),
      ),
    );

    return users.map((u, i) => ({
      id: u._id.toString(),
      name: u.name,
      username: u.username,
      avatarKey: u.avatarKey ?? null,
      avatarUrl: urlResults[i],
    }));
  }

  // Event.hashtags has no provenance field distinguishing manually-supplied tags from
  // description-derived ones. We reconstruct that distinction on every save by diffing
  // against what the OLD description would have derived — whatever remains is treated as
  // manual and is preserved; whatever the NEW description derives is added; nothing else
  // is touched. This lets stale description hashtags disappear when the text changes while
  // never discarding hashtags that didn't come from the description in the first place.
  private mergeEventHashtags(
    payloadHashtags: string[] | undefined,
    newDescription: string | null | undefined,
    existingEvent?: Pick<IEvent, "hashtags" | "description"> | null,
  ): string[] | undefined {
    const descriptionChanging = newDescription !== undefined;
    const hashtagsProvided = payloadHashtags !== undefined;

    if (!descriptionChanging && !hashtagsProvided) {
      return undefined;
    }

    const manualHashtags = hashtagsProvided ? normalizeEventHashtags(payloadHashtags) : [];
    const storedHashtags = existingEvent?.hashtags ?? [];

    if (!descriptionChanging) {
      return normalizeEventHashtags([...storedHashtags, ...manualHashtags]);
    }

    const staleDerivedHashtags = new Set(extractHashtags(existingEvent?.description ?? null));
    const preservedHashtags = storedHashtags.filter((tag) => !staleDerivedHashtags.has(tag));
    const freshDerivedHashtags = extractHashtags(newDescription ?? null);

    return normalizeEventHashtags([...preservedHashtags, ...manualHashtags, ...freshDerivedHashtags]);
  }

  private normalizeDraftPayload(
    payload: SaveEventDraftDto,
    existingEvent?: Pick<IEvent, "hashtags" | "description"> | null,
  ): SaveEventDraftDto {
    const normalized: SaveEventDraftDto = { ...payload };

    if (payload.name !== undefined) {
      normalized.name = payload.name?.trim() || null;
    }

    if (payload.description !== undefined) {
      normalized.description = payload.description?.trim() || null;
    }

    if (payload.bannerImageKey !== undefined) {
      normalized.bannerImageKey = payload.bannerImageKey?.trim() || null;
    }

    if (payload.bannerOriginalImageKey !== undefined) {
      normalized.bannerOriginalImageKey = payload.bannerOriginalImageKey?.trim() || null;
    }

    if (payload.bannerImageDisplay !== undefined) {
      normalized.bannerImageDisplay = payload.bannerImageDisplay ?? null;
    }

    if (payload.category !== undefined) {
      normalized.category = payload.category ?? null;
      if (payload.categories === undefined) {
        normalized.categories = payload.category ? [payload.category] : [];
      }
    }

    const mergedHashtags = this.mergeEventHashtags(payload.hashtags, payload.description, existingEvent);
    if (mergedHashtags !== undefined) {
      normalized.hashtags = mergedHashtags;
    }

    if (payload.categories !== undefined) {
      normalized.categories = [...payload.categories];
      normalized.category = normalized.categories[0] ?? null;
    }

    if (payload.endAt !== undefined) {
      normalized.endAt = payload.endAt ?? null;
    }

    if (payload.location !== undefined) {
      normalized.location = payload.location
        ? {
            searchLabel: payload.location.searchLabel?.trim() || null,
            venue: payload.location.venue?.trim() || null,
            address: payload.location.address?.trim() || null,
            formattedAddress: payload.location.formattedAddress?.trim() || null,
            addressLine1: payload.location.addressLine1?.trim() || null,
            neighborhood: payload.location.neighborhood?.trim() || null,
            district: payload.location.district?.trim() || null,
            city: payload.location.city?.trim() || null,
            region: payload.location.region?.trim() || null,
            regionCode: payload.location.regionCode?.trim() || null,
            postalCode: payload.location.postalCode?.trim() || null,
            country: payload.location.country?.trim() || null,
            countryCode: payload.location.countryCode?.trim().toUpperCase() || null,
            additionalInfo: payload.location.additionalInfo?.trim() || null,
            latitude: payload.location.latitude ?? null,
            longitude: payload.location.longitude ?? null,
            mapboxPlaceId: payload.location.mapboxPlaceId?.trim() || null,
            locationProvider: payload.location.locationProvider?.trim() || null,
            providerResultType: payload.location.providerResultType?.trim() || null,
          }
        : null;
    }

    if (payload.tickets !== undefined) {
      normalized.tickets = payload.tickets?.map((ticket) => this.normalizeTicket(ticket)) ?? [];
    }

    if (payload.privacy !== undefined) {
      normalized.privacy = payload.privacy ?? "public";
    }

    return normalized;
  }

  private getCategoryCandidate(event: IEvent, payload: SaveEventDraftDto): EventCategory[] {
    if (payload.categories !== undefined) {
      return payload.categories;
    }

    if (payload.category !== undefined) {
      return payload.category ? [payload.category] : [];
    }

    return event.categories?.length
      ? event.categories
      : event.category
        ? [event.category]
        : [];
  }

  private assertPublishableCategories(categories: EventCategory[]): void {
    if (categories.length === 0) {
      throw new AppError("Select at least 1 category", httpStatus.BAD_REQUEST);
    }

    if (categories.length > 3) {
      throw new AppError("You can select up to 3 categories", httpStatus.BAD_REQUEST);
    }

    if (categories.some((category) => !eventCategorySet.has(category))) {
      throw new AppError("Category must be one of the predefined event categories", httpStatus.BAD_REQUEST);
    }

    if (new Set(categories).size !== categories.length) {
      throw new AppError("Categories must be unique", httpStatus.BAD_REQUEST);
    }
  }

  private normalizePublishPayload(
    payload: PublishEventDto,
    existingEvent?: Pick<IEvent, "hashtags" | "description"> | null,
  ): PublishEventDto {
    const draftPayload = this.normalizeDraftPayload(payload, existingEvent);
    const hashtags =
      this.mergeEventHashtags(payload.hashtags, payload.description, existingEvent) ??
      normalizeEventHashtags(existingEvent?.hashtags ?? []);

    return {
      ...payload,
      ...draftPayload,
      name: payload.name.trim(),
      ageRestriction: payload.ageRestriction,
      hashtags,
      category: payload.categories[0],
      categories: payload.categories,
      scheduledAt: payload.scheduledAt,
      endAt: payload.endAt,
      location: draftPayload.location ?? {},
      tickets: payload.tickets.map((ticket) => {
        const normalized = this.normalizeTicket(ticket);
        // On first publish, every ticket starts fully available.
        return { ...normalized, availableCount: normalized.capacity };
      }),
      privacy: payload.privacy,
    };
  }

  private normalizeTicket(ticket: EventTicketInput): EventTicket {
    return {
      id: ticket.id?.trim() || randomUUID(),
      name: ticket.name.trim(),
      description: ticket.description?.trim() || null,
      salesEndAt: ticket.salesEndAt ?? null,
      type: ticket.type,
      price: ticket.type === "free" ? 0 : ticket.price,
      capacity: ticket.capacity,
      availableCount: null,
    };
  }

  private normalizeExistingRewards(rewards?: EventReward[] | null): EventReward[] {
    const normalizedRewards = (rewards ?? []).map((reward) => ({
      id: reward.id?.trim() || randomUUID(),
      rewardType: reward.rewardType,
      ticketId: reward.ticketId ?? null,
      productId: reward.productId ? reward.productId.toString() : null,
      targetName: reward.targetName?.trim() || null,
      imageKeys: reward.imageKeys ?? [],
      name: reward.name.trim(),
      description: reward.description?.trim() || null,
      expiresAt: reward.expiresAt ?? null,
      discountEnabled: reward.discountEnabled ?? ((reward.discountPercent ?? 0) > 0),
      discountPercent: reward.discountEnabled === false ? null : reward.discountPercent ?? null,
      bogoEnabled: reward.bogoEnabled ?? (reward.buyQuantity !== null && reward.buyQuantity !== undefined && reward.freeQuantity !== null && reward.freeQuantity !== undefined),
      buyQuantity: reward.bogoEnabled === false ? null : reward.buyQuantity ?? null,
      freeQuantity: reward.bogoEnabled === false ? null : reward.freeQuantity ?? null,
      capacityLimited: reward.capacityLimited ?? ((reward.capacity ?? 0) > 0),
      capacity: reward.capacityLimited === false || reward.capacity === 0 ? null : reward.capacity ?? null,
      availableCount: reward.capacityLimited === false || reward.capacity === 0
        ? null
        : reward.availableCount ?? reward.capacity ?? null,
      disabledAt: reward.disabledAt ?? null,
    }));

    const ticketIds = new Set<string>();
    return normalizedRewards.filter((reward) => {
      if (reward.rewardType !== "ticket" || !reward.ticketId) {
        return true;
      }
      if (ticketIds.has(reward.ticketId)) {
        return false;
      }
      ticketIds.add(reward.ticketId);
      return true;
    });
  }

  private assertTicketRewardAvailable(
    rewards: EventReward[],
    candidate: EventReward,
    excludeRewardId?: string,
  ): void {
    if (
      candidate.rewardType === "ticket" &&
      candidate.ticketId &&
      rewards.some(
        (reward) =>
          reward.id !== excludeRewardId &&
          reward.rewardType === "ticket" &&
          reward.ticketId === candidate.ticketId,
      )
    ) {
      this.throwTicketRewardConflict(candidate.ticketId);
    }
  }

  private throwTicketRewardConflict(ticketId?: string | null): never {
    throw new AppError(
      "This ticket already has a reward. Each ticket can have only one reward. Edit or delete the existing reward before creating another.",
      httpStatus.CONFLICT,
      { code: "TICKET_REWARD_ALREADY_EXISTS", ticketId: ticketId ?? null },
    );
  }

  private isDiscountEnabled(reward: Pick<EventReward, "discountEnabled" | "discountPercent">): boolean {
    return reward.discountEnabled ?? ((reward.discountPercent ?? 0) > 0);
  }

  private isBogoEnabled(reward: Pick<EventReward, "bogoEnabled" | "buyQuantity" | "freeQuantity">): boolean {
    return reward.bogoEnabled ?? (typeof reward.buyQuantity === "number" && typeof reward.freeQuantity === "number");
  }

  private isCapacityLimited(reward: Pick<EventReward, "capacityLimited" | "capacity">): boolean {
    return reward.capacityLimited ?? ((reward.capacity ?? 0) > 0);
  }

  private getNextRewardAvailableCount(existingReward: EventReward, reward: EventRewardInput): number | null {
    const capacityLimited = reward.capacityLimited ?? ((reward.capacity ?? 0) > 0);
    const nextCapacity = capacityLimited ? reward.capacity ?? 0 : null;
    const existingCapacity = this.isCapacityLimited(existingReward) ? existingReward.capacity ?? 0 : null;

    if (!capacityLimited || !nextCapacity) {
      return null;
    }

    if (!existingCapacity) {
      return nextCapacity;
    }

    return Math.max(0, (existingReward.availableCount ?? existingCapacity) + (nextCapacity - existingCapacity));
  }

  private assertRewardBenefitConfiguration(
    reward: Pick<EventReward, "discountEnabled" | "discountPercent" | "bogoEnabled" | "buyQuantity" | "freeQuantity" | "capacityLimited" | "capacity">,
  ): void {
    const discountEnabled = this.isDiscountEnabled(reward);
    const bogoEnabled = this.isBogoEnabled(reward);

    if (!discountEnabled && !bogoEnabled) {
      throw new AppError("Enable a discount or Buy X Get Y offer.", httpStatus.BAD_REQUEST);
    }

    if (discountEnabled) {
      const value = reward.discountPercent;
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100) {
        throw new AppError("Discount must be a whole number between 1 and 100.", httpStatus.BAD_REQUEST);
      }
    }

    if (bogoEnabled) {
      if (!Number.isInteger(reward.buyQuantity) || (reward.buyQuantity ?? 0) < 1 || (reward.buyQuantity ?? 0) > 2) {
        throw new AppError("Buy quantity must be 1 or 2.", httpStatus.BAD_REQUEST);
      }
      if (!Number.isInteger(reward.freeQuantity) || (reward.freeQuantity ?? 0) < 1) {
        throw new AppError("Free quantity must be a positive whole number.", httpStatus.BAD_REQUEST);
      }
    }

    if (this.isCapacityLimited(reward)) {
      if (!Number.isInteger(reward.capacity) || (reward.capacity ?? 0) < 1) {
        throw new AppError("Capacity must be a positive whole number when users are limited.", httpStatus.BAD_REQUEST);
      }
    }
  }

  private assertRewardBundleFitsTicketAvailability(
    reward: Pick<EventReward, "bogoEnabled" | "buyQuantity" | "freeQuantity">,
    ticket: Pick<EventTicket, "availableCount" | "capacity">,
  ): void {
    if (!this.isBogoEnabled(reward)) {
      return;
    }

    const availableCount = ticket.availableCount ?? ticket.capacity;
    const requiredBundleInventory = (reward.buyQuantity ?? 0) + (reward.freeQuantity ?? 0);

    if (requiredBundleInventory > availableCount) {
      throw new AppError(
        "Buy X Get Y requires more tickets than are currently available.",
        httpStatus.UNPROCESSABLE_ENTITY,
        { code: "REWARD_BUNDLE_EXCEEDS_AVAILABLE_INVENTORY" },
      );
    }
  }

  private assertRedeemedRewardUpdateAllowed(originalReward: EventReward, updatedReward: EventReward): void {
    const protectedChanged =
      originalReward.rewardType !== updatedReward.rewardType
      || (originalReward.ticketId ?? null) !== (updatedReward.ticketId ?? null)
      || this.isDiscountEnabled(originalReward) !== this.isDiscountEnabled(updatedReward)
      || (originalReward.discountPercent ?? null) !== (updatedReward.discountPercent ?? null)
      || this.isBogoEnabled(originalReward) !== this.isBogoEnabled(updatedReward)
      || (originalReward.buyQuantity ?? null) !== (updatedReward.buyQuantity ?? null)
      || (originalReward.freeQuantity ?? null) !== (updatedReward.freeQuantity ?? null);

    if (protectedChanged) {
      throw new AppError(
        "This reward has already been used and its ticket, discount, and Buy X Get Y settings cannot be changed.",
        httpStatus.CONFLICT,
      );
    }

    if (this.isCapacityLimited(originalReward)) {
      if (!this.isCapacityLimited(updatedReward) || (updatedReward.capacity ?? 0) < (originalReward.capacity ?? 0)) {
        throw new AppError("Used reward capacity cannot be reduced.", httpStatus.CONFLICT);
      }
    } else if (this.isCapacityLimited(updatedReward)) {
      throw new AppError("Used unlimited rewards cannot be changed to limited capacity.", httpStatus.CONFLICT);
    }
  }

  private async normalizeReward(
    reward: EventRewardInput,
    event: IEvent,
    userId: string,
    existingReward?: EventReward,
  ): Promise<EventReward> {
    const rewardType = reward.rewardType ?? existingReward?.rewardType;

    if (!rewardType) {
      throw new AppError("Reward type is required.", httpStatus.BAD_REQUEST);
    }

    const baseReward = {
      id: reward.id?.trim() || existingReward?.id || randomUUID(),
      rewardType,
      name: reward.name?.trim() || existingReward?.name?.trim() || "Reward",
      description: reward.description?.trim() || null,
      expiresAt: reward.expiresAt ?? null,
      discountEnabled: reward.discountEnabled ?? (typeof reward.discountPercent === "number" && reward.discountPercent > 0),
      discountPercent: reward.discountEnabled === false ? null : reward.discountPercent ?? null,
      bogoEnabled: reward.bogoEnabled ?? (typeof reward.buyQuantity === "number" && typeof reward.freeQuantity === "number"),
      buyQuantity: reward.bogoEnabled === false ? null : reward.buyQuantity ?? null,
      freeQuantity: reward.bogoEnabled === false ? null : reward.freeQuantity ?? null,
      capacityLimited: reward.capacityLimited ?? ((reward.capacity ?? 0) > 0),
      capacity: reward.capacityLimited === false || reward.capacity === 0 ? null : reward.capacity ?? null,
      availableCount: existingReward
        ? this.getNextRewardAvailableCount(existingReward, reward)
        : reward.capacityLimited === false || reward.capacity === 0
          ? null
          : reward.capacity ?? null,
      disabledAt: reward.disabledAt ?? existingReward?.disabledAt ?? null,
    };

    this.assertRewardBenefitConfiguration(baseReward);

    if (rewardType === "ticket") {
      const ticketId = reward.ticketId?.trim() || existingReward?.ticketId || null;
      const ticket = event.tickets.find((item) => item.id === ticketId);

      if (!ticket || !ticketId) {
        throw new AppError("Select a valid event ticket for this reward.", httpStatus.BAD_REQUEST);
      }

      this.assertRewardBundleFitsTicketAvailability(baseReward, ticket);

      return {
        ...baseReward,
        rewardType: "ticket",
        ticketId,
        productId: null,
        targetName: ticket.name,
        imageKeys: [],
      };
    }

    const productId =
      reward.productId?.toString().trim() || existingReward?.productId?.toString() || null;

    if (!productId) {
      throw new AppError("Select a product for this reward.", httpStatus.BAD_REQUEST);
    }

    const product = await this.productRepository.findByIdForUser(productId, userId);

    if (!product) {
      throw new AppError("Selected product not found.", httpStatus.BAD_REQUEST);
    }

    return {
      ...baseReward,
      rewardType: "product",
      ticketId: null,
      productId: product._id.toString(),
      targetName: product.name,
      imageKeys: product.imageKeys,
    };
  }

  public async claimReward(
    user: AuthUser,
    eventId: string,
    rewardId: string,
  ): Promise<RewardClaimResponse> {
    const event = await this.eventRepository.findById(eventId);

    if (!event || (event.status !== "published" && event.status !== "live")) {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    const reward = this.normalizeExistingRewards(event.rewards).find((r) => r.id === rewardId);

    if (!reward) {
      throw new AppError("Reward not found.", httpStatus.NOT_FOUND);
    }

    if (reward.rewardType === "ticket") {
      throw new AppError("Ticket offers are applied during checkout.", httpStatus.GONE);
    }

    if (reward.expiresAt && new Date() > reward.expiresAt) {
      throw new AppError("This reward has expired.", httpStatus.GONE);
    }

    if (reward.ticketId) {
      const linkedTicket = event.tickets.find((t) => t.id === reward.ticketId);

      if (linkedTicket && linkedTicket.type !== "free" && linkedTicket.price > 0) {
        const purchasedCount = await this.checkoutPaymentRepository.getPurchasedCountForTicket(
          user.id,
          eventId,
          reward.ticketId,
        );

        if (purchasedCount === 0) {
          throw new AppError(
            "Purchase this ticket first to claim this reward.",
            httpStatus.PAYMENT_REQUIRED,
          );
        }
      }
    }

    const existingClaim = await this.rewardClaimRepository.findByUserAndReward(
      user.id,
      eventId,
      rewardId,
    );

    if (existingClaim) {
      throw new AppError("You have already claimed this reward.", httpStatus.CONFLICT);
    }

    if (this.isCapacityLimited(reward)) {
      const claimedCount = await this.rewardClaimRepository.countByReward(eventId, rewardId);

      if (claimedCount >= (reward.capacity ?? 0)) {
        throw new AppError("This reward has no remaining capacity.", httpStatus.GONE);
      }
    }

    const claim = await this.rewardClaimRepository.create({ userId: user.id, eventId, rewardId });

    return this.toClaimResponse(claim);
  }

  public async getMyEventRewardClaims(
    user: AuthUser,
    eventId: string,
  ): Promise<RewardClaimResponse[]> {
    const event = await this.eventRepository.findById(eventId);

    if (!event || event.status === "draft") {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    const claims = await this.rewardClaimRepository.findByUserAndEvent(user.id, eventId);
    const rewardById = new Map(this.normalizeExistingRewards(event.rewards).map((reward) => [reward.id, reward]));

    return claims
      .filter((claim) => {
        if (claim.status === "pending" || claim.status === "released") {
          return false;
        }

        const reward = rewardById.get(claim.rewardId);
        if (reward?.rewardType === "ticket") {
          return claim.source === "checkout" && claim.status === "redeemed";
        }

        return claim.status === "redeemed" || claim.status === "legacy_claim";
      })
      .map((claim) => this.toClaimResponse(claim));
  }

  // A window may legitimately start before the event does, so only the
  // event's end time can invalidate an existing window — a window ending
  // after the event's new end time. Moving the event's start time alone
  // never conflicts with any existing window.
  private async assertPostingWindowsFitSchedule(
    event: IEvent,
    payload: Pick<SaveEventDraftDto, "scheduledAt" | "endAt">,
  ): Promise<void> {
    if (payload.endAt === undefined) {
      return;
    }

    const nextEndsAt = payload.endAt ?? null;

    const conflicts = await this.eventWindowRepository.findConflictingForEventSchedule(
      event._id.toString(),
      nextEndsAt,
    );

    if (conflicts.length === 0) {
      return;
    }

    throw new AppError(
      "Event schedule cannot be changed while posting windows would end after the new event end time. Edit or cancel conflicting windows first.",
      httpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  private getEventScheduleCandidate(event: IEvent, payload: SaveEventDraftDto): {
    scheduledAt?: Date | null;
    endAt?: Date | null;
    tickets: EventTicket[];
    rewards: Array<Pick<EventReward, "name" | "rewardType" | "ticketId" | "expiresAt">>;
  } {
    return {
      scheduledAt: payload.scheduledAt !== undefined ? payload.scheduledAt : event.scheduledAt ?? null,
      endAt: payload.endAt !== undefined ? payload.endAt : event.endAt ?? null,
      tickets: payload.tickets !== undefined
        ? payload.tickets.map((ticket) => this.normalizeTicket(ticket))
        : event.tickets.map((ticket) => this.normalizeTicket(ticket)),
      rewards: payload.rewards !== undefined ? payload.rewards : this.normalizeExistingRewards(event.rewards),
    };
  }

  private assertTicketAndRewardDatesFitEventSchedule(event: {
    scheduledAt?: Date | null;
    endAt?: Date | null;
    tickets?: Array<Pick<EventTicket, "name" | "salesEndAt"> & { id?: string }>;
    rewards?: Array<Pick<EventReward, "name" | "rewardType" | "ticketId" | "expiresAt">>;
  }): void {
    this.assertTicketDatesFitEventSchedule(event, event.tickets ?? []);
    this.assertRewardDatesFitEventSchedule(event, event.rewards ?? []);
    this.assertRewardDatesFitTicketSalesEnd(
      { tickets: event.tickets ?? [] },
      event.rewards ?? [],
    );
  }

  private assertOngoingEventScheduleUpdateAllowed(
    event: Pick<IEvent, "scheduledAt" | "endAt">,
    payload: Pick<SaveEventDraftDto, "scheduledAt" | "endAt">,
    scheduleCandidate: Pick<SaveEventDraftDto, "endAt">,
  ): void {
    const persistedStartAt = this.getValidDateOrNull(event.scheduledAt);
    const persistedEndAt = this.getValidDateOrNull(event.endAt);

    if (!persistedStartAt || !persistedEndAt) {
      return;
    }

    const now = this.getServerNow();

    if (persistedStartAt.getTime() > now.getTime() || now.getTime() >= persistedEndAt.getTime()) {
      return;
    }

    if (payload.scheduledAt !== undefined) {
      const submittedStartAt = this.getValidDateOrNull(payload.scheduledAt);

      if (!submittedStartAt || submittedStartAt.getTime() !== persistedStartAt.getTime()) {
        throw new AppError(
          "Event start date and time cannot be changed after the event has started.",
          httpStatus.UNPROCESSABLE_ENTITY,
        );
      }
    }

    if (payload.endAt !== undefined) {
      const submittedEndAt = this.getValidDateOrNull(scheduleCandidate.endAt);

      if (!submittedEndAt || submittedEndAt.getTime() <= now.getTime()) {
        throw new AppError(
          "Event end date and time must remain in the future for an ongoing event.",
          httpStatus.UNPROCESSABLE_ENTITY,
        );
      }
    }
  }

  private assertEndAtChangeDoesNotEnterTicketCreationCutoff(
    event: Pick<IEvent, "endAt">,
    payload: Pick<SaveEventDraftDto, "endAt">,
  ): void {
    if (payload.endAt === undefined) {
      return;
    }

    const nextEndAt = this.getValidDateOrNull(payload.endAt);

    if (!nextEndAt) {
      return;
    }

    const currentEndAt = this.getValidDateOrNull(event.endAt);
    const nowMs = this.getServerNow().getTime();
    const wasAlreadyInCutoff = Boolean(
      currentEndAt && nowMs >= currentEndAt.getTime() - TICKET_CREATION_CUTOFF_MS,
    );
    const entersCutoff = nowMs >= nextEndAt.getTime() - TICKET_CREATION_CUTOFF_MS;

    if (!wasAlreadyInCutoff && entersCutoff) {
      throw new AppError(
        TICKET_CREATION_CUTOFF_MESSAGE,
        httpStatus.UNPROCESSABLE_ENTITY,
        this.getTicketValidationDetails("TICKET_CREATION_CUTOFF", "endAt", TICKET_CREATION_CUTOFF_MESSAGE),
      );
    }
  }

  private assertNewTicketsRespectCreationCutoff(
    event: Pick<IEvent, "tickets" | "status" | "endAt">,
    nextTickets: Array<Pick<EventTicket, "id">>,
    nextEndAt: Date | null | undefined,
  ): void {
    const existingTicketIds = new Set(event.tickets.map((ticket) => ticket.id).filter(Boolean));
    const hasNewTicket = nextTickets.some((ticket) => !ticket.id || !existingTicketIds.has(ticket.id));

    if (!hasNewTicket) {
      return;
    }

    this.assertTicketCreationAvailable({
      status: event.status,
      endAt: nextEndAt ?? null,
    });
  }

  private assertBulkTicketMutationsRespectCutoffs(
    event: Pick<IEvent, "tickets" | "status" | "endAt">,
    nextTickets: EventTicket[],
    nextEndAt: Date | null | undefined,
  ): void {
    this.assertNewTicketsRespectCreationCutoff(event, nextTickets, nextEndAt);

    const existingTicketById = new Map(event.tickets.map((ticket) => [ticket.id, ticket]));
    const hasPriceChange = nextTickets.some((ticket) => {
      const existingTicket = ticket.id ? existingTicketById.get(ticket.id) : undefined;

      return Boolean(existingTicket && this.hasTicketPriceChanged(existingTicket, ticket));
    });

    if (!hasPriceChange) {
      return;
    }

    this.assertTicketPriceEditingWindowOpen({
      endAt: nextEndAt ?? null,
    });
  }

  private assertTicketCreationAvailable(event: { status?: string | null; endAt?: Date | null }): void {
    this.assertTicketManagementStatus(event.status);
    this.assertTicketCreationWindowOpen(event);
  }

  private assertTicketPriceChangeAvailable(
    event: { status?: string | null; endAt?: Date | null },
    existingTicket: Pick<EventTicket, "type" | "price">,
    nextTicket: Pick<EventTicket, "type" | "price">,
  ): void {
    if (!this.hasTicketPriceChanged(existingTicket, nextTicket)) {
      return;
    }

    this.assertTicketManagementStatus(event.status);
    this.assertTicketPriceEditingWindowOpen(event);
  }

  private assertTicketManagementStatus(status?: string | null): void {
    if (status === "draft" || status === "published" || status === "live") {
      return;
    }

    throw new AppError(
      "Tickets cannot be managed for this event status.",
      httpStatus.UNPROCESSABLE_ENTITY,
      this.getTicketValidationDetails(
        "TICKET_MANAGEMENT_STATUS_NOT_ALLOWED",
        "endAt",
        "Tickets cannot be managed for this event status.",
      ),
    );
  }

  private assertTicketCreationWindowOpen(event: { endAt?: Date | null }): void {
    const eventEndsAt = this.getValidDateOrNull(event.endAt);

    if (!eventEndsAt) {
      throw new AppError(
        "Event end date and time is required before tickets can be created.",
        httpStatus.UNPROCESSABLE_ENTITY,
        this.getTicketValidationDetails(
          "EVENT_END_REQUIRED_FOR_TICKET_MANAGEMENT",
          "endAt",
          "Event end date and time is required before tickets can be created.",
        ),
      );
    }

    if (this.getServerNow().getTime() >= eventEndsAt.getTime() - TICKET_CREATION_CUTOFF_MS) {
      throw new AppError(
        TICKET_CREATION_CUTOFF_MESSAGE,
        httpStatus.UNPROCESSABLE_ENTITY,
        this.getTicketValidationDetails("TICKET_CREATION_CUTOFF", "endAt", TICKET_CREATION_CUTOFF_MESSAGE),
      );
    }
  }

  private assertTicketPriceEditingWindowOpen(event: { endAt?: Date | null }): void {
    const eventEndsAt = this.getValidDateOrNull(event.endAt);

    if (!eventEndsAt) {
      throw new AppError(
        "Event end date and time is required before ticket prices can be changed.",
        httpStatus.UNPROCESSABLE_ENTITY,
        this.getTicketValidationDetails(
          "EVENT_END_REQUIRED_FOR_TICKET_MANAGEMENT",
          "endAt",
          "Event end date and time is required before ticket prices can be changed.",
        ),
      );
    }

    if (this.getServerNow().getTime() >= eventEndsAt.getTime() - TICKET_CREATION_CUTOFF_MS) {
      throw new AppError(
        TICKET_PRICE_EDIT_CUTOFF_MESSAGE,
        httpStatus.UNPROCESSABLE_ENTITY,
        this.getTicketValidationDetails("TICKET_PRICE_EDIT_CUTOFF", "price", TICKET_PRICE_EDIT_CUTOFF_MESSAGE),
      );
    }
  }

  private hasTicketPriceChanged(
    existingTicket: Pick<EventTicket, "type" | "price">,
    nextTicket: Pick<EventTicket, "type" | "price">,
  ): boolean {
    return existingTicket.type !== nextTicket.type || this.normalizeTicketPrice(existingTicket.price) !== this.normalizeTicketPrice(nextTicket.price);
  }

  private normalizeTicketPrice(value: number): number {
    return Number.isFinite(value) ? value : 0;
  }

  private assertTicketDatesFitEventSchedule(
    event: { scheduledAt?: Date | null; endAt?: Date | null },
    tickets: Array<Pick<EventTicket, "name" | "salesEndAt">>,
  ): void {
    const eventEndsAt = this.getValidDateOrNull(event.endAt);

    tickets.forEach((ticket) => {
      const salesEndAt = this.getValidDateOrNull(ticket.salesEndAt);

      if (!salesEndAt) {
        return;
      }

      if (eventEndsAt && salesEndAt >= eventEndsAt) {
        const isLaterCalendarDate = this.getUtcCalendarKey(salesEndAt) > this.getUtcCalendarKey(eventEndsAt);
        const message = isLaterCalendarDate
          ? TICKET_SALES_END_DATE_AFTER_EVENT_END_MESSAGE
          : TICKET_SALES_END_TIME_NOT_BEFORE_EVENT_END_MESSAGE;
        const code: TicketValidationCode = isLaterCalendarDate
          ? "TICKET_SALES_END_DATE_AFTER_EVENT_END"
          : "TICKET_SALES_END_TIME_NOT_BEFORE_EVENT_END";

        throw new AppError(
          message,
          httpStatus.UNPROCESSABLE_ENTITY,
          this.getTicketValidationDetails(code, "salesEndAt", message),
        );
      }
    });
  }

  private getUtcCalendarKey(date: Date): number {
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  }

  private getTicketValidationDetails(
    code: TicketValidationCode,
    field: TicketValidationField,
    message: string,
  ): {
    code: TicketValidationCode;
    fields: Record<string, string[]>;
    issues: { code: TicketValidationCode; field: TicketValidationField; path: TicketValidationField; message: string }[];
  } {
    return {
      code,
      fields: {
        [field]: [message],
      },
      issues: [{
        code,
        field,
        path: field,
        message,
      }],
    };
  }

  private assertRewardDatesFitTicketSalesEnd(
    event: { tickets: Array<Pick<EventTicket, "salesEndAt"> & { id?: string }> },
    rewards: Array<Pick<EventReward, "name" | "rewardType" | "ticketId" | "expiresAt">>,
  ): void {
    rewards.forEach((reward) => {
      if (reward.rewardType !== "ticket" || !reward.ticketId) {
        return;
      }

      const ticket = event.tickets.find((item) => item.id === reward.ticketId);

      if (!ticket) {
        throw new AppError("Select a valid event ticket for this reward.", httpStatus.BAD_REQUEST);
      }

      const expiresAt = this.getValidDateOrNull(reward.expiresAt);
      const salesEndAt = this.getValidDateOrNull(ticket.salesEndAt);

      if (!expiresAt || !salesEndAt || expiresAt <= salesEndAt) {
        return;
      }

      const isLaterCalendarDate = this.getUtcCalendarKey(expiresAt) > this.getUtcCalendarKey(salesEndAt);
      const message = isLaterCalendarDate
        ? REWARD_END_DATE_AFTER_TICKET_SALES_END_MESSAGE
        : REWARD_END_TIME_AFTER_TICKET_SALES_END_MESSAGE;
      const code: RewardValidationCode = isLaterCalendarDate
        ? "REWARD_END_DATE_AFTER_TICKET_SALES_END"
        : "REWARD_END_TIME_AFTER_TICKET_SALES_END";

      throw new AppError(
        message,
        httpStatus.UNPROCESSABLE_ENTITY,
        this.getRewardValidationDetails(code, "expiresAt", message),
      );
    });
  }

  private getRewardValidationDetails(
    code: RewardValidationCode,
    field: RewardValidationField,
    message: string,
  ): {
    code: RewardValidationCode;
    fields: Record<string, string[]>;
    issues: {
      code: RewardValidationCode;
      field: RewardValidationField;
      path: RewardValidationField;
      message: string;
    }[];
  } {
    return {
      code,
      fields: {
        [field]: [message],
      },
      issues: [{
        code,
        field,
        path: field,
        message,
      }],
    };
  }

  private assertRewardDatesFitEventSchedule(
    event: { endAt?: Date | null },
    rewards: Array<Pick<EventReward, "name" | "expiresAt">>,
  ): void {
    const eventEndsAt = this.getValidDateOrNull(event.endAt);

    if (!eventEndsAt) {
      return;
    }

    rewards.forEach((reward) => {
      const expiresAt = this.getValidDateOrNull(reward.expiresAt);

      if (!expiresAt) {
        return;
      }

      if (expiresAt > eventEndsAt) {
        throw new AppError(
          `Reward "${reward.name?.trim() || "Reward"}" expiry date must not be after the event end date and time.`,
          httpStatus.UNPROCESSABLE_ENTITY,
        );
      }
    });
  }

  private getValidDateOrNull(value?: Date | null): Date | null {
    return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
  }

  private async prepareEventMediaItem(
    eventId: string,
    userId: string,
    mediaInput: EventMediaInput,
    batchIndex: number,
  ): Promise<EventMediaItem> {
    const storageKey = mediaInput.storageKey?.trim();
    const contentType = this.normalizeMediaContentType(mediaInput.contentType);

    if (!storageKey) {
      throw new AppError("Event media storage key is required.", httpStatus.BAD_REQUEST);
    }

    const expectedPrefix = `${EVENT_MEDIA_STORAGE_PREFIX}${eventId}/${userId}/`;
    if (!storageKey.startsWith(expectedPrefix)) {
      throw new AppError("Event media storage key is invalid.", httpStatus.BAD_REQUEST);
    }

    if (!contentType || !this.isSupportedEventMediaContentType(mediaInput.type, contentType)) {
      throw new AppError("Event media content type is not supported.", httpStatus.BAD_REQUEST);
    }

    if (!this.mediaContentTypeMatchesType(mediaInput.type, contentType)) {
      throw new AppError("Event media content type does not match the media type.", httpStatus.BAD_REQUEST);
    }

    if (mediaInput.type === "video") {
      // Event video media is temporarily disabled while the deployment host
      // runs without the transcoding worker. Image event media is untouched.
      // Set ENABLE_VIDEO_UPLOADS=true (env.ts) to re-enable.
      if (!env.ENABLE_VIDEO_UPLOADS) {
        throw new AppError("Video event media is temporarily unavailable.", httpStatus.BAD_REQUEST);
      }

      const durationSeconds = mediaInput.durationSeconds;
      if (durationSeconds == null || durationSeconds > MAX_EVENT_MEDIA_VIDEO_DURATION_SECONDS) {
        throw new AppError("Video duration cannot exceed 10 minutes.", httpStatus.BAD_REQUEST);
      }
    }

    let metadata: Awaited<ReturnType<StorageService["getObjectMetadata"]>>;
    try {
      metadata = await this.storageService.getObjectMetadata(storageKey);
    } catch {
      throw new AppError("Event media file was not found in storage.", httpStatus.BAD_REQUEST);
    }

    if (!metadata.contentLength || metadata.contentLength <= 0) {
      throw new AppError("Event media file is empty.", httpStatus.BAD_REQUEST);
    }

    if (metadata.contentLength > EVENT_MEDIA_LIMITS_BYTES[mediaInput.type]) {
      throw new AppError("Event media file is too large.", httpStatus.BAD_REQUEST);
    }

    const storedContentType = this.normalizeMediaContentType(metadata.contentType);
    if (!storedContentType || storedContentType !== contentType || !this.mediaContentTypeMatchesType(mediaInput.type, storedContentType)) {
      throw new AppError("Stored event media content type does not match the submitted media.", httpStatus.BAD_REQUEST);
    }

    return {
      id: mediaInput.id?.trim() || randomUUID(),
      storageKey,
      type: mediaInput.type,
      contentType,
      fileSize: metadata.contentLength,
      width: this.normalizeNullableNonNegativeNumber(mediaInput.width),
      height: this.normalizeNullableNonNegativeNumber(mediaInput.height),
      durationSeconds: mediaInput.type === "video" ? this.normalizeNullableNonNegativeNumber(mediaInput.durationSeconds) : null,
      uploaderId: new Types.ObjectId(userId),
      displayOrder: Date.now() * 100 + batchIndex,
      createdAt: new Date(),
    };
  }

  private normalizeMediaContentType(contentType?: string | null): string | null {
    const normalized = contentType?.trim().toLowerCase();
    if (!normalized) return null;
    if (normalized === "image/jpg") return "image/jpeg";
    if (normalized === "image/heic-sequence") return "image/heic";
    if (normalized === "image/heif-sequence") return "image/heif";
    if (normalized === "video/mov") return "video/quicktime";
    return normalized;
  }

  private normalizeNullableNonNegativeNumber(value?: number | null): number | null {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  }

  private mediaContentTypeMatchesType(type: EventMediaType, contentType: string): boolean {
    return contentType.startsWith(`${type}/`);
  }

  private isSupportedEventMediaContentType(type: EventMediaType, contentType: string): boolean {
    const supported = type === "image" ? supportedEventImageContentTypes : supportedEventVideoContentTypes;
    return (supported as readonly string[]).includes(contentType);
  }

  private async getDraftForUser(user: AuthUser, eventId: string): Promise<IEvent> {
    const event = await this.eventRepository.findByIdForUser(eventId, user.id);

    if (!event || event.status !== "draft") {
      throw new AppError("Event draft not found.", httpStatus.NOT_FOUND);
    }

    return event;
  }

  private async getEventForTicketOwner(user: AuthUser, eventId: string): Promise<IEvent> {
    return this.getModifiableEventForOwner(user, eventId);
  }

  private async getModifiableEventForOwner(user: AuthUser, eventId: string): Promise<IEvent> {
    const event = await this.getEventForOwner(user, eventId);

    if (event.status === "draft") {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    if (event.status === "completed" || event.status === "cancelled") {
      throw new AppError(
        "This event cannot be modified because it has been completed or cancelled.",
        httpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const eventEndsAt = this.getValidDateOrNull(event.endAt);

    if (eventEndsAt && this.getServerNow().getTime() >= eventEndsAt.getTime()) {
      throw new AppError(
        "This event cannot be modified because it has already ended.",
        httpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    return event;
  }

  private async getNonDraftEventForOwner(user: AuthUser, eventId: string): Promise<IEvent> {
    const event = await this.getEventForOwner(user, eventId);

    if (event.status === "draft") {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    return event;
  }

  private async getEventForOwner(user: AuthUser, eventId: string): Promise<IEvent> {
    const event = await this.eventRepository.findByIdForUser(eventId, user.id);

    if (!event) {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    return event;
  }

  private async getHostById(events: IEvent[]): Promise<Map<string, IUser>> {
    const hostIds = [...new Set(events.map((event) => event.userId.toString()))];

    if (hostIds.length === 0) {
      return new Map();
    }

    const hosts = await this.userRepository.findMany({ _id: { $in: hostIds } }, 0, hostIds.length);

    return new Map(hosts.map((host) => [host._id.toString(), host]));
  }

  private mergeFeedEvents(
    publicEvents: IEvent[],
    privateEvents: IEvent[],
    hasNearbyFilter: boolean,
    limit?: number,
  ): IEvent[] {
    const eventById = new Map<string, IEvent>();
    [...publicEvents, ...privateEvents].forEach((event) => {
      eventById.set(event._id.toString(), event);
    });

    const events = [...eventById.values()].sort((left, right) => {
      if (hasNearbyFilter) {
        return (
          this.compareDatesAsc(left.scheduledAt, right.scheduledAt) ||
          this.compareDatesDesc(left.publishedAt, right.publishedAt) ||
          right._id.toString().localeCompare(left._id.toString())
        );
      }

      return (
        this.compareDatesDesc(left.publishedAt, right.publishedAt) ||
        this.compareDatesDesc(left.createdAt, right.createdAt) ||
        right._id.toString().localeCompare(left._id.toString())
      );
    });

    return limit ? events.slice(0, limit) : events;
  }

  private mergeMapEvents(publicEvents: IEvent[], privateEvents: IEvent[], limit: number): IEvent[] {
    const eventById = new Map<string, IEvent>();
    [...publicEvents, ...privateEvents].forEach((event) => {
      eventById.set(event._id.toString(), event);
    });

    return [...eventById.values()]
      .sort(
        (left, right) =>
          this.compareDatesAsc(left.scheduledAt, right.scheduledAt) ||
          this.compareDatesDesc(left.publishedAt, right.publishedAt) ||
          right._id.toString().localeCompare(left._id.toString()),
      )
      .slice(0, limit);
  }

  private compareDatesAsc(left?: Date | null, right?: Date | null): number {
    return (left?.getTime() ?? 0) - (right?.getTime() ?? 0);
  }

  private compareDatesDesc(left?: Date | null, right?: Date | null): number {
    return (right?.getTime() ?? 0) - (left?.getTime() ?? 0);
  }

  private async ensureEventInteractionMoment(event: IEvent) {
    return this.momentRepository.ensureEventAnnouncement({
      eventId: event._id.toString(),
      userId: event.userId.toString(),
      eventTitle: event.name ?? null,
      caption: event.description ?? null,
    });
  }

  private async buildEventSmartFeedContext(
    events: IEvent[],
    interactionMomentIds: string[],
    viewerId: string | undefined,
    mutualFriendIds: string[],
    followedAuthorIds: string[],
    query: EventFeedQuery,
    context: EventRequestContext,
  ): Promise<EventSmartFeedContext> {
    const interactionMomentIdByEventId = new Map<string, string>();

    interactionMomentIds.forEach((momentId, index) => {
      const event = events[index];

      if (event) {
        interactionMomentIdByEventId.set(event._id.toString(), momentId);
      }
    });

    const mutualFriendSet = new Set(mutualFriendIds);
    // "followed-only" = one-way follows that aren't already mutual friends,
    // mirroring MomentService.buildMomentSmartFeedContext's partitioning so
    // a reactor/reposter/host is never counted toward both signals at once.
    const followedOnlyIds = followedAuthorIds.filter((id) => !mutualFriendSet.has(id));
    const followedOnlySet = new Set(followedOnlyIds);
    const relationshipUserIds = [...new Set([...mutualFriendIds, ...followedOnlyIds])];

    const [reactedUserIdsByMomentId, reposterUserIdsByMomentId, attendeeIdsByEventId] = await Promise.all([
      this.momentReactionRepository.findLikedUserIdsByMomentIds(interactionMomentIds, relationshipUserIds),
      // Event reposts are recorded as MomentShare rows against the event's
      // interaction Moment (same id space as reactions/comments) — see
      // MomentService.shareMoment's isEventAnnouncement branch.
      this.momentShareRepository.findReposterUserIdsByMomentIds(interactionMomentIds, relationshipUserIds),
      // Attendance stays mutual-friend-only, unchanged — not part of the
      // approved one-way-follow extension for this task.
      this.checkoutPaymentService.getMutualAttendeeIdsByEventIds(
        events.map((event) => ({ id: event._id.toString(), status: event.status })),
        mutualFriendIds,
      ),
    ]);

    // Preview avatars stay scoped to mutual friends only, exactly as before.
    const mutualReactedUserIds = [...new Set(
      [...reactedUserIdsByMomentId.values()].flat().filter((id) => mutualFriendSet.has(id)),
    )];
    const reactedUsers = mutualReactedUserIds.length > 0
      ? await this.userRepository.findActiveUsersByIds(mutualReactedUserIds, undefined, mutualReactedUserIds.length)
      : [];
    const userById = new Map<string, SmartFeedSocialUser>(
      reactedUsers.map((item) => [item._id.toString(), {
        id: item._id.toString(),
        name: item.name,
        avatarKey: item.avatarKey ?? null,
      }]),
    );
    const viewerLocation = isValidSmartFeedCoordinate(query.latitude, query.longitude)
      ? { latitude: query.latitude, longitude: query.longitude }
      : null;
    const viewerRegionalLocation = viewerLocation
      ? null
      : await this.geoIpService.lookup(context.clientIp);
    const scoreByEventId = new Map<string, SmartFeedScore>();
    const socialContextByEventId = new Map<string, SmartFeedSocialContext>();
    const now = new Date();

    for (const event of events) {
      const eventId = event._id.toString();
      const interactionMomentId = interactionMomentIdByEventId.get(eventId);
      const reactedUserIdsForEvent = interactionMomentId
        ? reactedUserIdsByMomentId.get(interactionMomentId) ?? []
        : [];
      const mutualReactedForEvent = reactedUserIdsForEvent.filter((id) => mutualFriendSet.has(id));
      const followedReactedForEvent = reactedUserIdsForEvent.filter((id) => followedOnlySet.has(id));
      const socialContext = buildReactionSocialContext(mutualReactedForEvent, userById);

      if (socialContext) {
        socialContextByEventId.set(eventId, socialContext);
      }

      const reposterIdsForEvent = interactionMomentId
        ? reposterUserIdsByMomentId.get(interactionMomentId) ?? []
        : [];
      const mutualRepostCount = reposterIdsForEvent.filter((id) => mutualFriendSet.has(id)).length;
      const followedRepostCount = reposterIdsForEvent.filter((id) => followedOnlySet.has(id)).length;

      const hostId = event.userId.toString();
      const authorRelationship: SmartFeedAuthorRelationship = mutualFriendSet.has(hostId)
        ? "mutual"
        : followedOnlySet.has(hostId)
          ? "followed"
          : "none";

      const score = calculateSmartFeedScore({
        isAuthorSelf: Boolean(viewerId) && hostId === viewerId,
        nearbyScore: calculateSmartFeedNearbyScore({
          viewerExactLocation: viewerLocation,
          viewerRegionalLocation,
          itemLocation: event.location,
          distanceKm: getDistanceKm,
        }),
        freshnessScore: calculateFreshnessScore(event.publishedAt ?? event.createdAt, now),
        socialScore: calculateSocialScore({
          authorRelationship,
          mutualReactionUserCount: new Set(mutualReactedForEvent).size,
          followedReactionUserCount: new Set(followedReactedForEvent).size,
          mutualAttendeeUserCount: attendeeIdsByEventId.get(eventId)?.size ?? 0,
          mutualRepostUserCount: mutualRepostCount,
          followedRepostUserCount: followedRepostCount,
        }),
      });

      scoreByEventId.set(eventId, score);
    }

    return {
      scoreByEventId,
      socialContextByEventId,
    };
  }

  private async ensureEventChatRoom(event: IEvent): Promise<void> {
    await this.liveRoomRepository.ensureById(event._id.toString(), {
      hostUserId: event.userId.toString(),
      title: (event.name ?? "Event Chat").slice(0, 160),
    });
  }

  private toClaimResponse(claim: IRewardClaim): RewardClaimResponse {
    return {
      id: claim._id.toString(),
      userId: claim.userId.toString(),
      eventId: claim.eventId.toString(),
      rewardId: claim.rewardId,
      claimedAt: claim.claimedAt,
      createdAt: claim.createdAt,
    };
  }

  private toHostResponse(
    host: IUser | null,
    extras?: {
      avatarUrl?: string | null;
      followersCount?: number;
      eventsCount?: number;
      isFollowing?: boolean;
    },
  ): EventHostResponse | null {
    if (!host) {
      return null;
    }

    return {
      id: host._id.toString(),
      name: host.name,
      username: host.username,
      avatarKey: host.avatarKey ?? null,
      avatarUrl: extras?.avatarUrl ?? null,
      bio: host.bio ?? null,
      followersCount: extras?.followersCount,
      eventsCount: extras?.eventsCount,
      ...(extras?.isFollowing !== undefined ? { isFollowing: extras.isFollowing } : {}),
    };
  }

  private async withPublicGoingSummaries(events: EventResponse[], viewerId?: string): Promise<EventResponse[]> {
    if (events.length === 0) {
      return events;
    }

    const summaries = await this.checkoutPaymentService.getPublicEventGoingSummaries(
      events.map((event) => ({ id: event.id, status: event.status, hostUserId: event.userId })),
      viewerId,
    );

    return events.map((event) => ({
      ...event,
      publicGoingSummary: summaries.get(event.id) ?? { going: 0, avatars: [] },
    }));
  }

  private async withPublicGoingSummariesForGroups(
    groups: ProfileEventGroupsResponse,
    viewerId?: string,
  ): Promise<ProfileEventGroupsResponse> {
    const [active, past] = await Promise.all([
      this.withPublicGoingSummaries(groups.active, viewerId),
      this.withPublicGoingSummaries(groups.past, viewerId),
    ]);

    return {
      ...groups,
      active,
      past,
    };
  }

  private async withCrowdStatuses<T extends EventResponse>(
    sourceEvents: Array<IEvent | EventResponse>,
    responseEvents: T[],
  ): Promise<T[]> {
    if (responseEvents.length === 0) {
      return responseEvents;
    }

    const crowdStatusByEventId = await this.crowdStatusService.getCrowdStatusByEventId(sourceEvents);

    return responseEvents.map((event) => ({
      ...event,
      crowdStatus: crowdStatusByEventId.get(event.id) ?? null,
    }));
  }

  private async withCrowdStatusesForGroups(
    groups: ProfileEventGroupsResponse,
  ): Promise<ProfileEventGroupsResponse> {
    const [active, past] = await Promise.all([
      this.withCrowdStatuses(groups.active, groups.active),
      this.withCrowdStatuses(groups.past, groups.past),
    ]);

    return {
      ...groups,
      active,
      past,
    };
  }

  private getProfileEventsCacheKey(userId: string, includePrivateEvents: boolean): string {
    return [
      "events",
      "profile",
      PROFILE_EVENTS_CACHE_VERSION,
      userId.toLowerCase(),
      includePrivateEvents ? "owner" : "public",
    ].join(":");
  }

  private async getCachedProfileEvents(
    cacheKey: string,
  ): Promise<ProfileEventGroupsResponse | null> {
    try {
      const redis = RedisClient.getClient();

      if (redis.status !== "ready") {
        return null;
      }

      const cached = await redis.get(cacheKey);

      if (!cached) {
        return null;
      }

      const parsed = JSON.parse(cached) as Partial<ProfileEventGroupsResponse>;

      if (!Array.isArray(parsed.active) || !Array.isArray(parsed.past)) {
        return null;
      }

      return parsed as ProfileEventGroupsResponse;
    } catch (error) {
      logger.warn({ error, cacheKey }, "Profile events cache read failed");
      return null;
    }
  }

  private async cacheProfileEvents(
    cacheKey: string,
    events: ProfileEventGroupsResponse,
  ): Promise<void> {
    try {
      const redis = RedisClient.getClient();

      if (redis.status !== "ready") {
        return;
      }

      await redis.set(
        cacheKey,
        JSON.stringify(events),
        "EX",
        this.getProfileEventsCacheTtlSeconds(events),
      );
    } catch (error) {
      logger.warn({ error, cacheKey }, "Profile events cache write failed");
    }
  }

  private getProfileEventsCacheTtlSeconds(events: ProfileEventGroupsResponse): number {
    const now = Date.now();
    const eventTimes = [...events.active, ...events.past]
      .map((event) => event.endAt)
      .filter((value): value is Date => Boolean(value))
      .map((value) => new Date(value).getTime())
      .filter((time) => Number.isFinite(time) && time > now);
    const nextBoundaryMs =
      eventTimes.length > 0
        ? Math.min(...eventTimes) - now
        : PROFILE_EVENTS_CACHE_TTL_SECONDS * 1000;
    const ttlMs = Math.min(PROFILE_EVENTS_CACHE_TTL_SECONDS * 1000, Math.max(1000, nextBoundaryMs));

    return Math.ceil(ttlMs / 1000);
  }

  private async invalidateProfileEventsCache(userId: string): Promise<void> {
    try {
      const redis = RedisClient.getClient();

      if (redis.status !== "ready") {
        return;
      }

      await redis.del(
        this.getProfileEventsCacheKey(userId, true),
        this.getProfileEventsCacheKey(userId, false),
      );
    } catch (error) {
      logger.warn({ error, userId }, "Profile events cache invalidation failed");
    }
  }

  private async invalidateProfileEventsCacheForEvents(events: IEvent[]): Promise<void> {
    const userIds = [...new Set(events.map((event) => event.userId.toString()))];

    await Promise.all(userIds.map((userId) => this.invalidateProfileEventsCache(userId)));
  }

  private async toProfileMutatingResponse(event: IEvent): Promise<EventResponse> {
    await this.invalidateProfileEventsCache(event.userId.toString());

    return this.toResponse(event);
  }

  private async getHostReviewEligibility(
    event: IEvent,
    user: AuthUser,
  ): Promise<EventHostReviewEligibilityResponse> {
    if (event.status !== "completed" || event.userId.toString() === user.id) {
      return { canReview: false, hasReviewed: false };
    }

    const existingReview = await this.eventHostReviewRepository.findByEventIdAndReviewerUserId(
      event._id.toString(),
      user.id,
    );

    if (existingReview) {
      return { canReview: false, hasReviewed: true };
    }

    const attendance = await this.ticketUsageRepository.findByEventIdAndHolderUserId(
      event._id.toString(),
      user.id,
    );

    return { canReview: Boolean(attendance), hasReviewed: false };
  }

  private async toHostReviewResponse(
    review: IEventHostReview,
    reviewer: IUser | null,
    event: IEvent,
  ): Promise<EventHostReviewResponse> {
    const avatarUrl = reviewer?.avatarKey
      ? await this.storageService
          .createDownloadUrl(reviewer.avatarKey)
          .then((download) => download.url)
          .catch(() => null)
      : null;

    return {
      id: review._id.toString(),
      author: reviewer
        ? {
            id: reviewer._id.toString(),
            name: reviewer.name,
            username: reviewer.username,
            avatarKey: reviewer.avatarKey ?? null,
            avatarUrl,
          }
        : null,
      text: review.text ?? "",
      liked: review.rating === "like",
      event: {
        id: event._id.toString(),
        name: event.name ?? null,
      },
      createdAt: review.createdAt,
    };
  }

  private toResponse(
    event: IEvent,
    host?: IUser | null,
    hostExtras?: {
      avatarUrl?: string | null;
      followersCount?: number;
      eventsCount?: number;
      isFollowing?: boolean;
    },
    myJoinRequestStatus?: EventJoinRequestStatus | null,
    options: { includeEventMedia?: boolean } = {},
  ): EventResponse {
    return {
      id: event._id.toString(),
      userId: event.userId.toString(),
      ...(host !== undefined ? { host: this.toHostResponse(host, hostExtras) } : {}),
      status: event.status,
      crowdStatus: null,
      name: event.name ?? null,
      description: event.description ?? null,
      bannerImageKey: event.bannerImageKey ?? null,
      bannerOriginalImageKey: event.bannerOriginalImageKey ?? null,
      bannerImageDisplay: event.bannerImageDisplay ?? null,
      ageRestriction: event.ageRestriction ?? null,
      hashtags: event.hashtags ?? [],
      category: event.categories?.[0] ?? event.category ?? null,
      categories: event.categories?.length
        ? event.categories
        : event.category
          ? [event.category]
          : [],
      scheduledAt: event.scheduledAt ?? null,
      endAt: event.endAt ?? null,
      location: event.location ?? null,
      tickets: event.tickets,
      rewards: this.normalizeExistingRewards(event.rewards),
      ...(options.includeEventMedia
        ? { eventMedia: (event.eventMedia ?? []).map((mediaItem) => this.toEventMediaResponse(event._id.toString(), mediaItem)) }
        : {}),
      privacy: event.privacy,
      memberCount: event.memberUserIds.length,
      ...(myJoinRequestStatus !== undefined
        ? { myJoinRequestStatus: myJoinRequestStatus ?? null }
        : {}),
      publishedAt: event.publishedAt ?? null,
      startedAt: event.startedAt ?? null,
      completedAt: event.completedAt ?? null,
      cancelledAt: event.cancelledAt ?? null,
      cancellationReasonType: event.cancellationReasonType ?? null,
      cancellationCustomReason: event.cancellationCustomReason ?? null,
      cancellationDisplayReason: event.cancellationDisplayReason ?? null,
      refundBatchId: event.refundBatchId?.toString() ?? null,
      cancellationOperationId: event.cancellationOperationId ?? null,
      cancellationWorkflowVersion: event.cancellationWorkflowVersion ?? null,
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
    };
  }

  private toEventMediaResponse(eventId: string, mediaItem: EventMediaItem): EventMediaResponse {
    return {
      id: mediaItem.id,
      url: `/events/${eventId}/media/${encodeURIComponent(mediaItem.id)}`,
      type: mediaItem.type,
      contentType: mediaItem.contentType,
      fileSize: mediaItem.fileSize,
      width: mediaItem.width ?? null,
      height: mediaItem.height ?? null,
      durationSeconds: mediaItem.durationSeconds ?? null,
      uploaderId: mediaItem.uploaderId.toString(),
      displayOrder: mediaItem.displayOrder,
      createdAt: mediaItem.createdAt,
    };
  }
}
