import { randomUUID } from "node:crypto";
import httpStatus from "http-status";
import { AppError } from "../../core/errors/app-error.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { StorageService } from "../storage/storage.service.js";
import { UserRepository } from "../user/user.repository.js";
import { UserFollowRepository } from "../user/user-follow.repository.js";
import type { IUser } from "../user/user.interface.js";
import { ProductRepository } from "../products/product.repository.js";
import { EventRepository } from "./event.repository.js";
import type {
  CreateEventRewardDto,
  EventHostResponse,
  EventMapQuery,
  EventReward,
  EventRewardInput,
  ProfileEventGroupsResponse,
  CreateEventTicketDto,
  EventResponse,
  EventTicket,
  EventTicketInput,
  IEvent,
  PublishEventDto,
  SaveEventDraftDto,
  UpdateEventRewardDto,
  UpdateEventTicketDto,
} from "./event.interface.js";

const ACTIVE_EVENT_WINDOW_MS = 12 * 60 * 60 * 1000;

export class EventService {
  public constructor(
    private readonly eventRepository = new EventRepository(),
    private readonly userRepository = new UserRepository(),
    private readonly userFollowRepository = new UserFollowRepository(),
    private readonly storageService = new StorageService(),
    private readonly productRepository = new ProductRepository(),
  ) {}

  public async saveDraft(user: AuthUser, payload: SaveEventDraftDto, eventId?: string): Promise<EventResponse> {
    const normalizedPayload = this.normalizeDraftPayload(payload);

    if (eventId) {
      const event = await this.eventRepository.updateDraftByIdForUser(eventId, user.id, normalizedPayload);

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

  public async publish(user: AuthUser, payload: PublishEventDto, eventId?: string): Promise<EventResponse> {
    const normalizedPayload = this.normalizePublishPayload(payload);

    if (eventId) {
      const existingEvent = await this.eventRepository.findByIdForUser(eventId, user.id);

      if (existingEvent?.status === "published") {
        const event = await this.eventRepository.updateByIdForUser(eventId, user.id, normalizedPayload);

        if (!event) {
          throw new AppError("Event not found.", httpStatus.NOT_FOUND);
        }

        return this.toResponse(event);
      }

      const event = await this.eventRepository.publishDraftByIdForUser(eventId, user.id, normalizedPayload);

      if (!event) {
        throw new AppError("Event draft not found.", httpStatus.NOT_FOUND);
      }

      return this.toResponse(event);
    }

    const event = await this.eventRepository.create({
      ...normalizedPayload,
      userId: user.id,
      status: "published",
      publishedAt: new Date(),
    });

    return this.toResponse(event);
  }

  public async updateEvent(user: AuthUser, eventId: string, payload: SaveEventDraftDto): Promise<EventResponse> {
    const event = await this.eventRepository.updateByIdForUser(eventId, user.id, this.normalizeDraftPayload(payload));

    if (!event) {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    return this.toResponse(event);
  }

  public async deleteEvent(user: AuthUser, eventId: string): Promise<EventResponse> {
    const event = await this.eventRepository.deleteByIdForUser(eventId, user.id);

    if (!event) {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    return this.toResponse(event);
  }

  public async getEventTicket(user: AuthUser, eventId: string, ticketId: string): Promise<EventResponse> {
    const event = await this.getEventById(user, eventId);
    const ticket = event.tickets.find((item) => item.id === ticketId);

    if (!ticket) {
      throw new AppError("Event ticket not found.", httpStatus.NOT_FOUND);
    }

    return event;
  }

  public async createEventTicket(user: AuthUser, eventId: string, payload: CreateEventTicketDto): Promise<EventResponse> {
    const event = await this.getEventForTicketOwner(user, eventId);
    const ticket = this.normalizeTicket(payload);
    const updatedEvent = await this.eventRepository.updateByIdForUser(eventId, user.id, {
      tickets: [...event.tickets.map((item) => this.normalizeTicket(item)), ticket],
    });

    if (!updatedEvent) {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    return this.toResponse(updatedEvent);
  }

  public async updateEventTicket(
    user: AuthUser,
    eventId: string,
    ticketId: string,
    payload: UpdateEventTicketDto,
  ): Promise<EventResponse> {
    const event = await this.getEventForTicketOwner(user, eventId);
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
      throw new AppError("Event ticket not found.", httpStatus.NOT_FOUND);
    }

    const updatedEvent = await this.eventRepository.updateByIdForUser(eventId, user.id, { tickets });

    if (!updatedEvent) {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    return this.toResponse(updatedEvent);
  }

  public async deleteEventTicket(user: AuthUser, eventId: string, ticketId: string): Promise<EventResponse> {
    const event = await this.getEventForTicketOwner(user, eventId);
    const tickets = event.tickets.map((ticket) => this.normalizeTicket(ticket));
    const nextTickets = tickets.filter((ticket) => ticket.id !== ticketId);

    if (nextTickets.length === tickets.length) {
      throw new AppError("Event ticket not found.", httpStatus.NOT_FOUND);
    }

    const updatedEvent = await this.eventRepository.updateByIdForUser(eventId, user.id, { tickets: nextTickets });

    if (!updatedEvent) {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    return this.toResponse(updatedEvent);
  }

  public async createDraftTicket(user: AuthUser, eventId: string, payload: CreateEventTicketDto): Promise<EventResponse> {
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

    const updatedEvent = await this.eventRepository.updateDraftByIdForUser(eventId, user.id, { tickets });

    if (!updatedEvent) {
      throw new AppError("Event draft not found.", httpStatus.NOT_FOUND);
    }

    return this.toResponse(updatedEvent);
  }

  public async deleteDraftTicket(user: AuthUser, eventId: string, ticketId: string): Promise<EventResponse> {
    const event = await this.getDraftForUser(user, eventId);
    const tickets = event.tickets.map((ticket) => this.normalizeTicket(ticket));
    const nextTickets = tickets.filter((ticket) => ticket.id !== ticketId);

    if (nextTickets.length === tickets.length) {
      throw new AppError("Event draft ticket not found.", httpStatus.NOT_FOUND);
    }

    const updatedEvent = await this.eventRepository.updateDraftByIdForUser(eventId, user.id, { tickets: nextTickets });

    if (!updatedEvent) {
      throw new AppError("Event draft not found.", httpStatus.NOT_FOUND);
    }

    return this.toResponse(updatedEvent);
  }

  public async createEventReward(user: AuthUser, eventId: string, payload: CreateEventRewardDto): Promise<EventResponse> {
    const event = await this.getEventForOwner(user, eventId);
    const reward = await this.normalizeReward(payload, event, user.id);
    const updatedEvent = await this.eventRepository.updateByIdForUser(eventId, user.id, {
      rewards: [...this.normalizeExistingRewards(event.rewards), reward],
    });

    if (!updatedEvent) {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    return this.toResponse(updatedEvent);
  }

  public async updateEventReward(
    user: AuthUser,
    eventId: string,
    rewardId: string,
    payload: UpdateEventRewardDto,
  ): Promise<EventResponse> {
    const event = await this.getEventForOwner(user, eventId);
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

    const updatedEvent = await this.eventRepository.updateByIdForUser(eventId, user.id, { rewards: nextRewards });

    if (!updatedEvent) {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    return this.toResponse(updatedEvent);
  }

  public async deleteEventReward(user: AuthUser, eventId: string, rewardId: string): Promise<EventResponse> {
    const event = await this.getEventForOwner(user, eventId);
    const rewards = this.normalizeExistingRewards(event.rewards);
    const nextRewards = rewards.filter((reward) => reward.id !== rewardId);

    if (nextRewards.length === rewards.length) {
      throw new AppError("Event reward not found.", httpStatus.NOT_FOUND);
    }

    const updatedEvent = await this.eventRepository.updateByIdForUser(eventId, user.id, { rewards: nextRewards });

    if (!updatedEvent) {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    return this.toResponse(updatedEvent);
  }

  public async createDraftReward(user: AuthUser, eventId: string, payload: CreateEventRewardDto): Promise<EventResponse> {
    const event = await this.getDraftForUser(user, eventId);
    const reward = await this.normalizeReward(payload, event, user.id);
    const updatedEvent = await this.eventRepository.updateDraftByIdForUser(eventId, user.id, {
      rewards: [...this.normalizeExistingRewards(event.rewards), reward],
    });

    if (!updatedEvent) {
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

    const updatedEvent = await this.eventRepository.updateDraftByIdForUser(eventId, user.id, { rewards: nextRewards });

    if (!updatedEvent) {
      throw new AppError("Event draft not found.", httpStatus.NOT_FOUND);
    }

    return this.toResponse(updatedEvent);
  }

  public async deleteDraftReward(user: AuthUser, eventId: string, rewardId: string): Promise<EventResponse> {
    const event = await this.getDraftForUser(user, eventId);
    const rewards = this.normalizeExistingRewards(event.rewards);
    const nextRewards = rewards.filter((reward) => reward.id !== rewardId);

    if (nextRewards.length === rewards.length) {
      throw new AppError("Event draft reward not found.", httpStatus.NOT_FOUND);
    }

    const updatedEvent = await this.eventRepository.updateDraftByIdForUser(eventId, user.id, { rewards: nextRewards });

    if (!updatedEvent) {
      throw new AppError("Event draft not found.", httpStatus.NOT_FOUND);
    }

    return this.toResponse(updatedEvent);
  }

  public async listMyEvents(user: AuthUser): Promise<EventResponse[]> {
    const events = await this.eventRepository.findByUserId(user.id);

    return events.map((event) => this.toResponse(event));
  }

  public async listMyProfileEvents(user: AuthUser): Promise<ProfileEventGroupsResponse> {
    return this.listProfileEventsByUserId(user.id);
  }

  public async listProfileEventsForUser(user: AuthUser, userId: string): Promise<ProfileEventGroupsResponse> {
    if (user.id.toLowerCase() !== userId.toLowerCase()) {
      throw new AppError("Profile events are only available for the authenticated user.", httpStatus.FORBIDDEN);
    }

    return this.listProfileEventsByUserId(user.id);
  }

  public async listProfileEventsByUserId(userId: string): Promise<ProfileEventGroupsResponse> {
    const activeSince = new Date(Date.now() - ACTIVE_EVENT_WINDOW_MS);
    const events = await this.eventRepository.findPublishedProfileEventsByUserId(userId, activeSince);
    const host = await this.userRepository.findById(userId);

    return {
      active: events.active.map((event) => this.toResponse(event, host)),
      past: events.past.map((event) => this.toResponse(event, host)),
    };
  }

  public async listMapEvents(query: EventMapQuery): Promise<EventResponse[]> {
    const activeSince = new Date(Date.now() - ACTIVE_EVENT_WINDOW_MS);
    const events = await this.eventRepository.findMapEvents({
      ...query,
      radiusKm: query.radiusKm ?? 50,
      limit: query.limit ?? 100,
      activeSince,
    });
    const hostById = await this.getHostById(events);

    return events.map((event) => this.toResponse(event, hostById.get(event.userId.toString()) ?? null));
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

    const host = await this.userRepository.findById(event.userId.toString());
    const [avatarUrl, followersCount, eventsCount, isFollowing] = await Promise.all([
      host?.avatarKey ? this.storageService.createDownloadUrl(host.avatarKey).then((download) => download.url) : Promise.resolve(null),
      host ? this.userFollowRepository.countFollowers(host._id.toString()) : Promise.resolve(0),
      host ? this.eventRepository.countByUserId(host._id.toString(), "published") : Promise.resolve(0),
      host && host._id.toString() !== user.id ? this.userFollowRepository.isFollowing(user.id, host._id.toString()) : Promise.resolve(false),
    ]);

    return this.toResponse(event, host, {
      avatarUrl,
      followersCount,
      eventsCount,
      isFollowing,
    });
  }

  private normalizeDraftPayload(payload: SaveEventDraftDto): SaveEventDraftDto {
    const normalized: SaveEventDraftDto = { ...payload };

    if ("name" in payload) {
      normalized.name = payload.name?.trim() || null;
    }

    if ("description" in payload) {
      normalized.description = payload.description?.trim() || null;
    }

    if ("bannerImageKey" in payload) {
      normalized.bannerImageKey = payload.bannerImageKey?.trim() || null;
    }

    if ("bannerOriginalImageKey" in payload) {
      normalized.bannerOriginalImageKey = payload.bannerOriginalImageKey?.trim() || null;
    }

    if ("bannerImageDisplay" in payload) {
      normalized.bannerImageDisplay = payload.bannerImageDisplay ?? null;
    }

    if ("category" in payload) {
      normalized.category = payload.category ?? null;
    }

    if ("location" in payload) {
      normalized.location = payload.location
        ? {
            searchLabel: payload.location.searchLabel?.trim() || null,
            venue: payload.location.venue?.trim() || null,
            address: payload.location.address?.trim() || null,
            latitude: payload.location.latitude ?? null,
            longitude: payload.location.longitude ?? null,
          }
        : null;
    }

    if ("tickets" in payload) {
      normalized.tickets = payload.tickets?.map((ticket) => this.normalizeTicket(ticket)) ?? [];
    }

    if ("privacy" in payload) {
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
      category: payload.category,
      scheduledAt: payload.scheduledAt,
      location: draftPayload.location ?? {},
      tickets: payload.tickets.map((ticket) => this.normalizeTicket(ticket)),
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
    };
  }

  private normalizeExistingRewards(rewards?: EventReward[] | null): EventReward[] {
    return (rewards ?? []).map((reward) => ({
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

    const productId = reward.productId?.toString().trim() || existingReward?.productId?.toString() || null;

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

  private async getDraftForUser(user: AuthUser, eventId: string): Promise<IEvent> {
    const event = await this.eventRepository.findByIdForUser(eventId, user.id);

    if (!event || event.status !== "draft") {
      throw new AppError("Event draft not found.", httpStatus.NOT_FOUND);
    }

    return event;
  }

  private async getEventForTicketOwner(user: AuthUser, eventId: string): Promise<IEvent> {
    return this.getEventForOwner(user, eventId);
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

  private toResponse(
    event: IEvent,
    host?: IUser | null,
    hostExtras?: {
      avatarUrl?: string | null;
      followersCount?: number;
      eventsCount?: number;
      isFollowing?: boolean;
    },
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
      category: event.category ?? null,
      scheduledAt: event.scheduledAt ?? null,
      location: event.location ?? null,
      tickets: event.tickets,
      rewards: this.normalizeExistingRewards(event.rewards),
      privacy: event.privacy,
      publishedAt: event.publishedAt ?? null,
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
    };
  }
}
