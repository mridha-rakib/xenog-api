import { randomUUID } from "node:crypto";
import httpStatus from "http-status";
import { RedisClient } from "../../config/redis.js";
import { AppError } from "../../core/errors/app-error.js";
import { logger } from "../../core/logger/logger.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { StorageService } from "../storage/storage.service.js";
import { UserRepository } from "../user/user.repository.js";
import { UserFollowRepository } from "../user/user-follow.repository.js";
import { UserBlockRepository } from "../user/user-block.repository.js";
import { EventSaveRepository } from "./event-save.repository.js";
import { LiveRoomRepository } from "../live-rooms/live-room.repository.js";
import { MomentRepository } from "../moments/moment.repository.js";
import { MomentReactionRepository } from "../moments/moment-reaction.repository.js";
import { MomentCommentRepository } from "../moments/moment-comment.repository.js";
import { MomentCommentReactionRepository } from "../moments/moment-comment-reaction.repository.js";
import { MomentShareRepository } from "../moments/moment-share.repository.js";
import { MomentSaveRepository } from "../moments/moment-save.repository.js";
import type { IUser } from "../user/user.interface.js";
import { ProductRepository } from "../products/product.repository.js";
import { EventRepository } from "./event.repository.js";
import { RewardClaimRepository } from "./reward-claim.repository.js";
import type { IRewardClaim } from "./reward-claim.model.js";
import { CheckoutPaymentRepository } from "../payments/checkout-payment.repository.js";
import { CheckoutPaymentService } from "../payments/checkout-payment.service.js";
import { CreatorEarningRepository } from "../payments/creator-earning.repository.js";
import { TicketShareRepository } from "../payments/ticket-share.repository.js";
import { TicketUsageRepository } from "../payments/ticket-usage.repository.js";
import { NotificationRepository } from "../notifications/notification.repository.js";
import { EventHostReviewRepository } from "./event-host-review.repository.js";
import type {
  EventHostReviewEligibilityResponse,
  EventHostReviewResponse,
  IEventHostReview,
  SubmitEventHostReviewDto,
} from "./event-host-review.interface.js";
import type {
  AdminMapEventResponse,
  CreateEventRewardDto,
  EventFeedQuery,
  EventHostResponse,
  EventJoinRequestStatus,
  EventMapQuery,
  EventMemberResponse,
  EventReward,
  EventRewardInput,
  JoinRequestResponse,
  ProfileEventGroupsResponse,
  CreateEventTicketDto,
  EventResponse,
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
const NOW_MODE_LOOKAHEAD_MS = 3 * 60 * 60 * 1000;
const STARTING_SOON_MS = 60 * 60 * 1000;
const PROFILE_EVENTS_CACHE_VERSION = "v1";
const PROFILE_EVENTS_CACHE_TTL_SECONDS = 30;

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
  ) {}

  public async saveDraft(
    user: AuthUser,
    payload: SaveEventDraftDto,
    eventId?: string,
  ): Promise<EventResponse> {
    const normalizedPayload = this.normalizeDraftPayload(payload);

    if (eventId) {
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
    const normalizedPayload = this.normalizePublishPayload(payload);

    if (eventId) {
      const existingEvent = await this.eventRepository.findByIdForUser(eventId, user.id);

      if (existingEvent && existingEvent.status !== "draft") {
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
    await this.getModifiableEventForOwner(user, eventId);
    const event = await this.eventRepository.updateByIdForUser(
      eventId,
      user.id,
      this.normalizeDraftPayload(payload),
    );

    if (!event) {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    return this.toProfileMutatingResponse(event);
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
    await this.getEventForTicketOwner(user, eventId);
    // New published tickets start fully available — availableCount is set here, not by normalizeTicket.
    const ticket: EventTicket = {
      ...this.normalizeTicket(payload),
      availableCount: payload.capacity,
    };
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
    const ticket = this.normalizeTicket(payload);
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
    const tickets = event.tickets.map((ticket) => {
      const normalizedTicket = this.normalizeTicket(ticket);

      if (normalizedTicket.id !== ticketId) {
        return normalizedTicket;
      }

      foundTicket = true;

      return this.normalizeTicket({
        ...normalizedTicket,
        ...payload,
        id: normalizedTicket.id,
        type: payload.type ?? normalizedTicket.type,
      });
    });

    if (!foundTicket) {
      throw new AppError("Event draft ticket not found.", httpStatus.NOT_FOUND);
    }

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

    return events.map((event) => this.toResponse(event));
  }

  public async listMyDraftEvents(user: AuthUser): Promise<EventResponse[]> {
    const events = await this.eventRepository.findDraftsByUserId(user.id);

    return events.map((event) => this.toResponse(event));
  }

  public async listFeedEvents(
    user?: AuthUser,
    query: EventFeedQuery = {},
  ): Promise<EventResponse[]> {
    const [excludeUserIds, followingIds] = await Promise.all([
      user ? this.userBlockRepository.findBlockedIds(user.id) : Promise.resolve([]),
      user ? this.userFollowRepository.findFollowingIds(user.id) : Promise.resolve([]),
    ]);

    const followingSet = new Set(followingIds);
    const hasNearbyFilter =
      typeof query.latitude === "number" && typeof query.longitude === "number";
    const feedOptions = {
      category: query.category,
      latitude: query.latitude,
      longitude: query.longitude,
      radiusKm: query.radiusKm,
      activeOnly: hasNearbyFilter,
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
    const [likeCounts, commentCounts, shareCounts, likedMomentIds, savedMomentIds] =
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
      ]);

    return events.map((event, index) => {
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
      };
    });
  }

  public async toggleSaveEvent(
    user: AuthUser,
    eventId: string,
  ): Promise<{ eventId: string; isSaved: boolean }> {
    const event = await this.eventRepository.findById(eventId);

    if (!event) {
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

    if (!event) {
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
    return this.listProfileEventsByUserId(user.id, true);
  }

  public async listProfileEventsForUser(
    user: AuthUser,
    userId: string,
  ): Promise<ProfileEventGroupsResponse> {
    const isOwner = user.id.toLowerCase() === userId.toLowerCase();
    return this.listProfileEventsByUserId(userId, isOwner);
  }

  public async listUserEventsForAdmin(userId: string): Promise<ProfileEventGroupsResponse> {
    return this.listProfileEventsByUserId(userId, true);
  }

  public async listProfileEventsByUserId(
    userId: string,
    includePrivateEvents = true,
  ): Promise<ProfileEventGroupsResponse> {
    const cacheKey = this.getProfileEventsCacheKey(userId, includePrivateEvents);
    const cachedEvents = await this.getCachedProfileEvents(cacheKey);

    if (cachedEvents) {
      return cachedEvents;
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

    return response;
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

  public async cancelEvent(user: AuthUser, eventId: string): Promise<EventResponse> {
    const event = await this.eventRepository.cancelById(eventId, user.id);

    if (!event) {
      throw new AppError(
        "Published event not found or event has already started.",
        httpStatus.NOT_FOUND,
      );
    }

    const paidOrders = await this.checkoutPaymentRepository.findPaidTicketOrdersByEventId(eventId);

    for (const order of paidOrders) {
      await this.checkoutPaymentService.processRefundForCancelledEvent(order._id.toString());
    }

    await this.creatorEarningRepository.markRefundedByEventId(eventId);

    return this.toProfileMutatingResponse(event);
  }

  public async listMapEvents(user: AuthUser, query: EventMapQuery): Promise<EventResponse[]> {
    const activeSince = new Date(Date.now() - ACTIVE_EVENT_WINDOW_MS);
    const mapQuery = {
      ...query,
      radiusKm: query.radiusKm ?? 50,
      limit: query.limit ?? 100,
      activeSince,
    };
    const [publicEvents, privateEvents] = await Promise.all([
      this.eventRepository.findMapEvents(mapQuery),
      this.eventRepository.findPrivateMapEventsForUser(user.id, mapQuery),
    ]);
    const events = this.mergeMapEvents(publicEvents, privateEvents, query.limit ?? 100);
    const hostById = await this.getHostById(events);

    return events.map((event) =>
      this.toResponse(event, hostById.get(event.userId.toString()) ?? null),
    );
  }

  public async listAdminMapEvents(): Promise<AdminMapEventResponse[]> {
    const now = new Date();
    const activeSince = new Date(now.getTime() - ACTIVE_EVENT_WINDOW_MS);
    const events = await this.eventRepository.findAdminMapEvents(now, activeSince);
    const hostById = await this.getHostById(events);

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

    return events
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
    const [likeCounts, commentCounts, shareCounts, likedMomentIds] = await Promise.all([
      this.momentReactionRepository.countByMomentIds([interactionMomentId]),
      this.momentCommentRepository.countByMomentIds([interactionMomentId]),
      this.momentShareRepository.countByMomentIds([interactionMomentId]),
      this.momentReactionRepository.findLikedMomentIds(user.id, [interactionMomentId]),
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
      ),
      interactionMomentId,
      likesCount: likeCounts.get(interactionMomentId) ?? 0,
      commentsCount: commentCounts.get(interactionMomentId) ?? 0,
      sharesCount: shareCounts.get(interactionMomentId) ?? 0,
      isLiked: likedMomentIds.has(interactionMomentId),
      isMember: !isOwner && event.memberUserIds.some((id) => id.toString() === user.id),
      hostReviewEligibility,
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
    const event = await this.getEventForOwner(user, eventId);
    return this.resolveMemberResponses(event.memberUserIds.map((id) => id.toString()));
  }

  public async addEventMember(
    user: AuthUser,
    eventId: string,
    memberId: string,
  ): Promise<EventMemberResponse[]> {
    const event = await this.eventRepository.findByIdForUser(eventId, user.id);

    if (!event) {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

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

    if (!event) {
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

  private normalizeDraftPayload(payload: SaveEventDraftDto): SaveEventDraftDto {
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
    }

    if (payload.categories !== undefined) {
      normalized.categories = [...new Set(payload.categories)];
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
            additionalInfo: payload.location.additionalInfo?.trim() || null,
            latitude: payload.location.latitude ?? null,
            longitude: payload.location.longitude ?? null,
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

  private normalizePublishPayload(payload: PublishEventDto): PublishEventDto {
    const draftPayload = this.normalizeDraftPayload(payload);

    return {
      ...payload,
      ...draftPayload,
      name: payload.name.trim(),
      ageRestriction: payload.ageRestriction,
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
      discountPercent: reward.discountPercent,
      buyQuantity: reward.buyQuantity,
      freeQuantity: reward.freeQuantity,
      capacity: reward.capacity,
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
      discountPercent: reward.discountPercent,
      buyQuantity: reward.buyQuantity,
      freeQuantity: reward.freeQuantity,
      capacity: reward.capacity,
    };

    if (rewardType === "ticket") {
      const ticketId = reward.ticketId?.trim() || existingReward?.ticketId || null;
      const ticket = event.tickets.find((item) => item.id === ticketId);

      if (!ticket || !ticketId) {
        throw new AppError("Select a valid event ticket for this reward.", httpStatus.BAD_REQUEST);
      }

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

    if (reward.capacity > 0) {
      const claimedCount = await this.rewardClaimRepository.countByReward(eventId, rewardId);

      if (claimedCount >= reward.capacity) {
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

    if (!event) {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    const claims = await this.rewardClaimRepository.findByUserAndEvent(user.id, eventId);

    return claims.map((claim) => this.toClaimResponse(claim));
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

    if (event.status === "completed" || event.status === "cancelled") {
      throw new AppError(
        "This event cannot be modified because it has been completed or cancelled.",
        httpStatus.UNPROCESSABLE_ENTITY,
      );
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
  ): EventResponse {
    return {
      id: event._id.toString(),
      userId: event.userId.toString(),
      ...(host !== undefined ? { host: this.toHostResponse(host, hostExtras) } : {}),
      status: event.status,
      name: event.name ?? null,
      description: event.description ?? null,
      bannerImageKey: event.bannerImageKey ?? null,
      bannerOriginalImageKey: event.bannerOriginalImageKey ?? null,
      bannerImageDisplay: event.bannerImageDisplay ?? null,
      ageRestriction: event.ageRestriction ?? null,
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
      privacy: event.privacy,
      memberCount: event.memberUserIds.length,
      ...(myJoinRequestStatus !== undefined
        ? { myJoinRequestStatus: myJoinRequestStatus ?? null }
        : {}),
      publishedAt: event.publishedAt ?? null,
      startedAt: event.startedAt ?? null,
      completedAt: event.completedAt ?? null,
      cancelledAt: event.cancelledAt ?? null,
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
    };
  }
}
