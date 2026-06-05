import httpStatus from "http-status";
import { AppError } from "../../core/errors/app-error.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { UserRepository } from "../user/user.repository.js";
import type { IUser } from "../user/user.interface.js";
import { EventRepository } from "./event.repository.js";
import type {
  EventHostResponse,
  EventMapQuery,
  EventResponse,
  EventTicket,
  IEvent,
  PublishEventDto,
  SaveEventDraftDto,
} from "./event.interface.js";

const ACTIVE_EVENT_WINDOW_MS = 12 * 60 * 60 * 1000;

export class EventService {
  public constructor(
    private readonly eventRepository = new EventRepository(),
    private readonly userRepository = new UserRepository(),
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

  public async listMyEvents(user: AuthUser): Promise<EventResponse[]> {
    const events = await this.eventRepository.findByUserId(user.id);

    return events.map((event) => this.toResponse(event));
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

  private normalizeDraftPayload(payload: SaveEventDraftDto): SaveEventDraftDto {
    return {
      ...payload,
      name: payload.name?.trim() || null,
      description: payload.description?.trim() || null,
      bannerImageKey: payload.bannerImageKey?.trim() || null,
      category: payload.category ?? null,
      location: payload.location
        ? {
            searchLabel: payload.location.searchLabel?.trim() || null,
            venue: payload.location.venue?.trim() || null,
            address: payload.location.address?.trim() || null,
            latitude: payload.location.latitude ?? null,
            longitude: payload.location.longitude ?? null,
          }
        : null,
      tickets: payload.tickets?.map((ticket) => this.normalizeTicket(ticket)) ?? [],
      privacy: payload.privacy ?? "public",
    };
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

  private normalizeTicket(ticket: EventTicket): EventTicket {
    return {
      name: ticket.name.trim(),
      description: ticket.description?.trim() || null,
      salesEndAt: ticket.salesEndAt ?? null,
      type: ticket.type,
      price: ticket.type === "free" ? 0 : ticket.price,
      capacity: ticket.capacity,
    };
  }

  private async getHostById(events: IEvent[]): Promise<Map<string, IUser>> {
    const hostIds = [...new Set(events.map((event) => event.userId.toString()))];

    if (hostIds.length === 0) {
      return new Map();
    }

    const hosts = await this.userRepository.findMany({ _id: { $in: hostIds } }, 0, hostIds.length);

    return new Map(hosts.map((host) => [host._id.toString(), host]));
  }

  private toHostResponse(host: IUser | null): EventHostResponse | null {
    if (!host) {
      return null;
    }

    return {
      id: host._id.toString(),
      name: host.name,
      username: host.username,
      avatarKey: host.avatarKey ?? null,
    };
  }

  private toResponse(event: IEvent, host?: IUser | null): EventResponse {
    return {
      id: event._id.toString(),
      userId: event.userId.toString(),
      ...(host !== undefined ? { host: this.toHostResponse(host) } : {}),
      status: event.status,
      name: event.name ?? null,
      description: event.description ?? null,
      bannerImageKey: event.bannerImageKey ?? null,
      ageRestriction: event.ageRestriction ?? null,
      category: event.category ?? null,
      scheduledAt: event.scheduledAt ?? null,
      location: event.location ?? null,
      tickets: event.tickets,
      privacy: event.privacy,
      publishedAt: event.publishedAt ?? null,
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
    };
  }
}
