import type { FilterQuery, SortOrder, Types, UpdateQuery } from "mongoose";
import { EventModel } from "./event.model.js";
import type {
  EventCategory,
  EventMapQuery,
  EventReward,
  EventTicket,
  IEvent,
  NowModeQuery,
  PublishEventDto,
  SaveEventDraftDto,
} from "./event.interface.js";

interface CreateEventRecord extends SaveEventDraftDto {
  userId: string;
  status: "draft" | "published" | "live";
  publishedAt?: Date | null;
}

type PublicFeedEventOptions = {
  category?: EventCategory;
  latitude?: number;
  longitude?: number;
  radiusKm?: number;
  activeOnly?: boolean;
  limit?: number;
};

const toRadians = (value: number) => (value * Math.PI) / 180;

const getDistanceKm = (
  first: { latitude: number; longitude: number },
  second: { latitude: number; longitude: number },
) => {
  const earthRadiusKm = 6371;
  const latitudeDelta = toRadians(second.latitude - first.latitude);
  const longitudeDelta = toRadians(second.longitude - first.longitude);
  const firstLatitude = toRadians(first.latitude);
  const secondLatitude = toRadians(second.latitude);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(firstLatitude) *
      Math.cos(secondLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;

  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const isFiniteCoordinate = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export class EventRepository {
  public async countStatusesByUserIds(
    userIds: Types.ObjectId[],
  ): Promise<Map<string, { total: number; completed: number; cancelled: number }>> {
    if (userIds.length === 0) {
      return new Map();
    }

    const rows = await EventModel.aggregate<{
      _id: Types.ObjectId;
      total: number;
      completed: number;
      cancelled: number;
    }>([
      { $match: { userId: { $in: userIds } } },
      {
        $group: {
          _id: "$userId",
          total: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] } },
        },
      },
    ]);

    return new Map(rows.map((row) => [row._id.toString(), row]));
  }

  public async create(payload: CreateEventRecord): Promise<IEvent> {
    return EventModel.create({
      userId: payload.userId,
      status: payload.status,
      name: payload.name ?? null,
      description: payload.description ?? null,
      bannerImageKey: payload.bannerImageKey ?? null,
      bannerOriginalImageKey: payload.bannerOriginalImageKey ?? null,
      bannerImageDisplay: payload.bannerImageDisplay ?? null,
      ageRestriction: payload.ageRestriction ?? null,
      category: payload.categories?.[0] ?? payload.category ?? null,
      categories: payload.categories ?? (payload.category ? [payload.category] : []),
      scheduledAt: payload.scheduledAt ?? null,
      endAt: payload.endAt ?? null,
      location: payload.location ?? null,
      tickets: payload.tickets ?? [],
      rewards: payload.rewards ?? [],
      privacy: payload.privacy ?? "public",
      publishedAt: payload.publishedAt ?? null,
    });
  }

  public async findByIdForUser(id: string, userId: string): Promise<IEvent | null> {
    return EventModel.findOne({ _id: id, userId });
  }

  public async findById(id: string): Promise<IEvent | null> {
    return EventModel.findById(id);
  }

  public async findManyByIds(ids: string[]): Promise<IEvent[]> {
    return EventModel.find({ _id: { $in: ids } });
  }

  public async updateByIdForUser(id: string, userId: string, payload: SaveEventDraftDto): Promise<IEvent | null> {
    const update: UpdateQuery<IEvent> = this.toUpdate(payload);

    return EventModel.findOneAndUpdate({ _id: id, userId }, update, {
      new: true,
      runValidators: true,
    });
  }

  public async updateRewardsIfTicketAvailable(
    id: string,
    userId: string,
    rewards: EventReward[],
    ticketId: string,
    options: { excludeRewardId?: string; draftOnly?: boolean } = {},
  ): Promise<IEvent | null> {
    return EventModel.findOneAndUpdate(
      {
        _id: id,
        userId,
        ...(options.draftOnly ? { status: "draft" } : {}),
        rewards: {
          $not: {
            $elemMatch: {
              rewardType: "ticket",
              ticketId,
              ...(options.excludeRewardId ? { id: { $ne: options.excludeRewardId } } : {}),
            },
          },
        },
      },
      { $set: { rewards } },
      { new: true, runValidators: true },
    );
  }

  public async deleteByIdForUser(id: string, userId: string): Promise<IEvent | null> {
    return EventModel.findOneAndDelete({ _id: id, userId });
  }

  public async findByUserId(userId: string): Promise<IEvent[]> {
    return EventModel.find({ userId }).sort({ createdAt: -1, _id: -1 });
  }

  public async findDraftsByUserId(userId: string): Promise<IEvent[]> {
    return EventModel.find({ userId, status: "draft" }).sort({ updatedAt: -1, _id: -1 });
  }

  public async findPublicFeedEvents(
    excludeUserIds: string[] = [],
    options: PublicFeedEventOptions = {},
  ): Promise<IEvent[]> {
    const filters: FilterQuery<IEvent>[] = [{
      status: { $in: ["published", "live"] },
      privacy: { $in: ["public", "locked"] },
    }];

    if (excludeUserIds.length > 0) {
      filters.push({ userId: { $nin: excludeUserIds } });
    }

    if (options.category) {
      filters.push({ $or: [{ categories: options.category }, { category: options.category }] });
    }

    if (options.activeOnly) {
      const now = new Date();
      const activeSince = new Date(now.getTime() - 12 * 60 * 60 * 1000);
      filters.push({
        $or: [
          { endAt: { $gte: now } },
          { endAt: null, scheduledAt: { $gte: activeSince } },
          { endAt: { $exists: false }, scheduledAt: { $gte: activeSince } },
        ],
      });
    }

    const locationFilter =
      isFiniteCoordinate(options.latitude) &&
      isFiniteCoordinate(options.longitude) &&
      isFiniteCoordinate(options.radiusKm)
        ? {
            latitude: options.latitude,
            longitude: options.longitude,
            radiusKm: options.radiusKm,
          }
        : null;

    if (locationFilter) {
      const radiusKm = Math.max(1, locationFilter.radiusKm);
      const latitudeDelta = radiusKm / 111.32;
      const longitudeDelta = radiusKm / (111.32 * Math.max(Math.cos((locationFilter.latitude * Math.PI) / 180), 0.01));

      filters.push({
        "location.latitude": {
          $type: "number",
          $gte: locationFilter.latitude - latitudeDelta,
          $lte: locationFilter.latitude + latitudeDelta,
        },
        "location.longitude": {
          $type: "number",
          $gte: locationFilter.longitude - longitudeDelta,
          $lte: locationFilter.longitude + longitudeDelta,
        },
      });
    }

    const query: FilterQuery<IEvent> = filters.length > 1 ? { $and: filters } : filters[0]!;
    const sort: Record<string, SortOrder> = locationFilter
      ? { scheduledAt: 1, publishedAt: -1, _id: -1 }
      : { publishedAt: -1, createdAt: -1, _id: -1 };
    const events = await EventModel.find(query).sort(sort);

    const exactEvents = locationFilter
      ? events.filter((event) => {
          const latitude = event.location?.latitude;
          const longitude = event.location?.longitude;

          if (!isFiniteCoordinate(latitude) || !isFiniteCoordinate(longitude)) {
            return false;
          }

          return getDistanceKm(
            { latitude: locationFilter.latitude, longitude: locationFilter.longitude },
            { latitude, longitude },
          ) <= locationFilter.radiusKm;
        })
      : events;

    return options.limit ? exactEvents.slice(0, options.limit) : exactEvents;
  }

  public async findPrivateFeedEventsForUser(
    userId: string,
    excludeUserIds: string[] = [],
    options: PublicFeedEventOptions = {},
  ): Promise<IEvent[]> {
    const filters: FilterQuery<IEvent>[] = [{
      status: { $in: ["published", "live"] },
      privacy: "private",
      $or: [{ userId }, { memberUserIds: userId }],
    }];

    if (excludeUserIds.length > 0) {
      filters.push({ userId: { $nin: excludeUserIds } });
    }

    if (options.category) {
      filters.push({ $or: [{ categories: options.category }, { category: options.category }] });
    }

    if (options.activeOnly) {
      const now = new Date();
      const activeSince = new Date(now.getTime() - 12 * 60 * 60 * 1000);
      filters.push({
        $or: [
          { endAt: { $gte: now } },
          { endAt: null, scheduledAt: { $gte: activeSince } },
          { endAt: { $exists: false }, scheduledAt: { $gte: activeSince } },
        ],
      });
    }

    const locationFilter =
      isFiniteCoordinate(options.latitude) &&
      isFiniteCoordinate(options.longitude) &&
      isFiniteCoordinate(options.radiusKm)
        ? {
            latitude: options.latitude,
            longitude: options.longitude,
            radiusKm: options.radiusKm,
          }
        : null;

    if (locationFilter) {
      const radiusKm = Math.max(1, locationFilter.radiusKm);
      const latitudeDelta = radiusKm / 111.32;
      const longitudeDelta = radiusKm / (111.32 * Math.max(Math.cos((locationFilter.latitude * Math.PI) / 180), 0.01));

      filters.push({
        "location.latitude": {
          $type: "number",
          $gte: locationFilter.latitude - latitudeDelta,
          $lte: locationFilter.latitude + latitudeDelta,
        },
        "location.longitude": {
          $type: "number",
          $gte: locationFilter.longitude - longitudeDelta,
          $lte: locationFilter.longitude + longitudeDelta,
        },
      });
    }

    const query: FilterQuery<IEvent> = filters.length > 1 ? { $and: filters } : filters[0]!;
    const sort: Record<string, SortOrder> = locationFilter
      ? { scheduledAt: 1, publishedAt: -1, _id: -1 }
      : { publishedAt: -1, createdAt: -1, _id: -1 };
    const events = await EventModel.find(query).sort(sort);

    const exactEvents = locationFilter
      ? events.filter((event) => {
          const latitude = event.location?.latitude;
          const longitude = event.location?.longitude;

          if (!isFiniteCoordinate(latitude) || !isFiniteCoordinate(longitude)) {
            return false;
          }

          return getDistanceKm(
            { latitude: locationFilter.latitude, longitude: locationFilter.longitude },
            { latitude, longitude },
          ) <= locationFilter.radiusKm;
        })
      : events;

    return options.limit ? exactEvents.slice(0, options.limit) : exactEvents;
  }

  public async findActiveAndUpcomingByUserId(userId: string, activeSince: Date, now: Date): Promise<IEvent[]> {
    return EventModel.find({
      userId,
      status: { $in: ["published", "live"] },
      $or: [
        { endAt: { $gte: now } },
        { endAt: null, scheduledAt: { $gte: activeSince } },
        { endAt: { $exists: false }, scheduledAt: { $gte: activeSince } },
      ],
    }).sort({ scheduledAt: 1, _id: -1 });
  }

  public async findPublicPostTaggable(activeSince: Date, now: Date, limit = 100): Promise<IEvent[]> {
    return EventModel.find({
      status: { $in: ["published", "live"] },
      privacy: "public",
      $or: [
        { endAt: { $gte: now } },
        { endAt: null, scheduledAt: { $gte: activeSince } },
        { endAt: { $exists: false }, scheduledAt: { $gte: activeSince } },
      ],
    })
      .sort({ scheduledAt: 1, publishedAt: -1, _id: -1 })
      .limit(limit);
  }

  public async findLiveActiveByIds(eventIds: string[], activeSince: Date, until: Date): Promise<IEvent[]> {
    if (eventIds.length === 0) {
      return [];
    }

    return EventModel.find({
      _id: { $in: eventIds },
      status: { $in: ["published", "live"] },
      scheduledAt: { $lte: until },
      $or: [
        { endAt: { $gte: until } },
        { endAt: null, scheduledAt: { $gte: activeSince } },
        { endAt: { $exists: false }, scheduledAt: { $gte: activeSince } },
      ],
    }).sort({ scheduledAt: 1, _id: -1 });
  }

  public async findPublishedProfileEventsByUserId(
    userId: string,
    includePrivateEvents: boolean,
  ): Promise<{ active: IEvent[]; past: IEvent[] }> {
    const baseQuery: FilterQuery<IEvent> = {
      userId,
      ...(includePrivateEvents ? {} : { privacy: { $in: ["public", "locked"] } }),
    };

    const now = new Date();

    const [active, past] = await Promise.all([
      EventModel.find({
        ...baseQuery,
        status: { $in: ["published", "live"] },
        $or: [
          { scheduledAt: { $gt: now } },
          { scheduledAt: { $lte: now }, endAt: { $gte: now } },
        ],
      }).sort({ scheduledAt: 1, publishedAt: -1, _id: -1 }),
      EventModel.find({
        ...baseQuery,
        $or: [
          { status: { $in: ["completed", "cancelled"] } },
          {
            status: { $in: ["published", "live"] },
            endAt: { $lt: now },
          },
        ],
      }).sort({ scheduledAt: -1, publishedAt: -1, _id: -1 }),
    ]);

    return { active, past };
  }

  public async findMapEvents(query: EventMapQuery & { activeSince: Date }): Promise<IEvent[]> {
    const eventQuery: FilterQuery<IEvent> = {
      status: { $in: ["published", "live"] },
      privacy: { $in: ["public", "locked"] },
      $or: [
        { endAt: { $gte: new Date() } },
        { endAt: null, scheduledAt: { $gte: query.activeSince } },
        { endAt: { $exists: false }, scheduledAt: { $gte: query.activeSince } },
      ],
      "location.latitude": { $type: "number" },
      "location.longitude": { $type: "number" },
    };

    if (typeof query.latitude === "number" && typeof query.longitude === "number" && typeof query.radiusKm === "number") {
      const latitudeDelta = query.radiusKm / 111.32;
      const longitudeDelta = query.radiusKm / (111.32 * Math.max(Math.cos((query.latitude * Math.PI) / 180), 0.01));

      eventQuery["location.latitude"] = {
        $type: "number",
        $gte: query.latitude - latitudeDelta,
        $lte: query.latitude + latitudeDelta,
      };
      eventQuery["location.longitude"] = {
        $type: "number",
        $gte: query.longitude - longitudeDelta,
        $lte: query.longitude + longitudeDelta,
      };
    }

    return EventModel.find(eventQuery)
      .sort({ scheduledAt: 1, publishedAt: -1, _id: -1 })
      .limit(query.limit ?? 100);
  }

  public async findPrivateMapEventsForUser(
    userId: string,
    query: EventMapQuery & { activeSince: Date },
  ): Promise<IEvent[]> {
    const eventQuery: FilterQuery<IEvent> = {
      status: { $in: ["published", "live"] },
      privacy: "private",
      $or: [{ userId }, { memberUserIds: userId }],
      $and: [{
        $or: [
          { endAt: { $gte: new Date() } },
          { endAt: null, scheduledAt: { $gte: query.activeSince } },
          { endAt: { $exists: false }, scheduledAt: { $gte: query.activeSince } },
        ],
      }],
      "location.latitude": { $type: "number" },
      "location.longitude": { $type: "number" },
    };

    if (typeof query.latitude === "number" && typeof query.longitude === "number" && typeof query.radiusKm === "number") {
      const latitudeDelta = query.radiusKm / 111.32;
      const longitudeDelta = query.radiusKm / (111.32 * Math.max(Math.cos((query.latitude * Math.PI) / 180), 0.01));

      eventQuery["location.latitude"] = {
        $type: "number",
        $gte: query.latitude - latitudeDelta,
        $lte: query.latitude + latitudeDelta,
      };
      eventQuery["location.longitude"] = {
        $type: "number",
        $gte: query.longitude - longitudeDelta,
        $lte: query.longitude + longitudeDelta,
      };
    }

    return EventModel.find(eventQuery)
      .sort({ scheduledAt: 1, publishedAt: -1, _id: -1 })
      .limit(query.limit ?? 100);
  }

  public async findAdminMapEvents(now: Date, activeSince: Date): Promise<IEvent[]> {
    return EventModel.find({
      status: { $in: ["published", "live"] },
      $or: [
        { endAt: { $gt: now } },
        { endAt: null, scheduledAt: { $gte: activeSince } },
        { endAt: { $exists: false }, scheduledAt: { $gte: activeSince } },
      ],
      "location.latitude": { $type: "number", $gte: -90, $lte: 90 },
      "location.longitude": { $type: "number", $gte: -180, $lte: 180 },
    }).sort({ scheduledAt: 1, publishedAt: -1, _id: -1 });
  }

  public async findNowModeEvents(query: NowModeQuery & { activeSince: Date; upcomingUntil: Date }): Promise<IEvent[]> {
    const eventQuery: FilterQuery<IEvent> = {
      status: { $in: ["published", "live"] },
      privacy: "public",
      scheduledAt: { $lte: query.upcomingUntil },
      $or: [
        { endAt: { $gte: new Date() } },
        { endAt: null, scheduledAt: { $gte: query.activeSince } },
        { endAt: { $exists: false }, scheduledAt: { $gte: query.activeSince } },
      ],
      "location.latitude": { $type: "number" },
      "location.longitude": { $type: "number" },
    };

    if (typeof query.latitude === "number" && typeof query.longitude === "number" && typeof query.radiusKm === "number") {
      const latitudeDelta = query.radiusKm / 111.32;
      const longitudeDelta = query.radiusKm / (111.32 * Math.max(Math.cos((query.latitude * Math.PI) / 180), 0.01));

      eventQuery["location.latitude"] = {
        $type: "number",
        $gte: query.latitude - latitudeDelta,
        $lte: query.latitude + latitudeDelta,
      };
      eventQuery["location.longitude"] = {
        $type: "number",
        $gte: query.longitude - longitudeDelta,
        $lte: query.longitude + longitudeDelta,
      };
    }

    return EventModel.find(eventQuery)
      .sort({ scheduledAt: 1, _id: -1 })
      .limit(query.limit ?? 100);
  }

  public async startById(id: string, userId: string): Promise<IEvent | null> {
    const now = new Date();

    return EventModel.findOneAndUpdate(
      { _id: id, userId, status: "published" },
      { $set: { status: "live", startedAt: now } },
      { new: true, runValidators: true },
    );
  }

  public async completeById(id: string, userId: string): Promise<IEvent | null> {
    const now = new Date();

    return EventModel.findOneAndUpdate(
      { _id: id, userId, status: "live" },
      { $set: { status: "completed", completedAt: now } },
      { new: true, runValidators: true },
    );
  }

  public async cancelById(id: string, userId: string): Promise<IEvent | null> {
    const now = new Date();

    return EventModel.findOneAndUpdate(
      { _id: id, userId, status: "published" },
      { $set: { status: "cancelled", cancelledAt: now } },
      { new: true, runValidators: true },
    );
  }

  public async countByUserId(userId: string, status?: string | string[]): Promise<number> {
    const filter: FilterQuery<IEvent> = { userId };

    if (status) {
      filter.status = Array.isArray(status) ? { $in: status } : status;
    }

    return EventModel.countDocuments(filter);
  }

  public async autoStartScheduled(now: Date): Promise<IEvent[]> {
    const events = await EventModel.find({
      status: "published",
      scheduledAt: { $ne: null, $lte: now },
      $or: [{ endAt: null }, { endAt: { $exists: false } }, { endAt: { $gt: now } }],
    });

    if (events.length === 0) {
      return [];
    }

    await EventModel.updateMany(
      { _id: { $in: events.map((event) => event._id) }, status: "published" },
      { $set: { status: "live", startedAt: now } },
    );

    return events;
  }

  public async findAndAutoComplete(now: Date): Promise<IEvent[]> {
    const expired = await EventModel.find({
      status: { $in: ["live", "published"] },
      endAt: { $ne: null, $lte: now },
    });

    if (expired.length === 0) {
      return [];
    }

    const ids = expired.map((e) => e._id);

    await EventModel.updateMany(
      { _id: { $in: ids }, status: { $in: ["live", "published"] } },
      { $set: { status: "completed", completedAt: now } },
    );

    return expired;
  }

  public async updateDraftByIdForUser(id: string, userId: string, payload: SaveEventDraftDto): Promise<IEvent | null> {
    const update: UpdateQuery<IEvent> = this.toUpdate(payload);

    return EventModel.findOneAndUpdate({ _id: id, userId, status: "draft" }, update, {
      new: true,
      runValidators: true,
    });
  }

  public async publishDraftByIdForUser(id: string, userId: string, payload: PublishEventDto): Promise<IEvent | null> {
    const update: UpdateQuery<IEvent> = {
      ...this.toUpdate(payload),
      status: "published",
      publishedAt: new Date(),
    };

    return EventModel.findOneAndUpdate({ _id: id, userId, status: "draft" }, update, {
      new: true,
      runValidators: true,
    });
  }

  public async addMemberById(eventId: string, hostUserId: string, memberId: string): Promise<IEvent | null> {
    return EventModel.findOneAndUpdate(
      { _id: eventId, userId: hostUserId, privacy: "private" },
      { $addToSet: { memberUserIds: memberId } },
      { new: true, runValidators: true },
    );
  }

  public async removeMemberById(eventId: string, hostUserId: string, memberId: string): Promise<IEvent | null> {
    return EventModel.findOneAndUpdate(
      { _id: eventId, userId: hostUserId },
      { $pull: { memberUserIds: memberId } },
      { new: true, runValidators: true },
    );
  }

  public async addJoinRequest(eventId: string, userId: string): Promise<{ event: IEvent | null; alreadyExists: boolean }> {
    const existing = await EventModel.findOne({ _id: eventId, "joinRequests.userId": userId });
    if (existing) {
      return { event: existing, alreadyExists: true };
    }

    const event = await EventModel.findOneAndUpdate(
      { _id: eventId },
      { $push: { joinRequests: { userId, status: "pending", createdAt: new Date() } } },
      { new: true },
    );

    return { event, alreadyExists: false };
  }

  public async findJoinRequests(eventId: string): Promise<IEvent | null> {
    return EventModel.findById(eventId);
  }

  public async findUserJoinRequest(eventId: string, userId: string): Promise<{ status: string } | null> {
    const event = await EventModel.findOne(
      { _id: eventId, "joinRequests.userId": userId },
      { "joinRequests.$": 1 },
    );
    const req = event?.joinRequests?.[0];
    return req ? { status: req.status } : null;
  }

  public async updateJoinRequestStatus(
    eventId: string,
    hostUserId: string,
    requestUserId: string,
    status: "accepted" | "declined",
  ): Promise<IEvent | null> {
    return EventModel.findOneAndUpdate(
      { _id: eventId, userId: hostUserId, "joinRequests.userId": requestUserId },
      { $set: { "joinRequests.$.status": status } },
      { new: true },
    );
  }

  /**
   * Atomically decrements availableCount by quantity only if availableCount >= quantity.
   * Returns the updated event on success, null if insufficient capacity.
   */
  public async reserveTicketCapacity(eventId: string, ticketId: string, quantity: number): Promise<IEvent | null> {
    return EventModel.findOneAndUpdate(
      {
        _id: eventId,
        tickets: { $elemMatch: { id: ticketId, availableCount: { $gte: quantity } } },
      },
      { $inc: { "tickets.$.availableCount": -quantity } },
      { new: true },
    );
  }

  /**
   * Atomically increments availableCount by quantity.
   * Only operates if availableCount is not null (pre-migration tickets are skipped safely).
   */
  public async releaseTicketCapacity(eventId: string, ticketId: string, quantity: number): Promise<void> {
    await EventModel.updateOne(
      {
        _id: eventId,
        tickets: { $elemMatch: { id: ticketId, availableCount: { $ne: null } } },
      },
      { $inc: { "tickets.$.availableCount": quantity } },
    );
  }

  /**
   * Atomically updates capacity and adjusts availableCount by delta.
   * For capacity decrease (delta < 0), requires availableCount >= |delta| to avoid going negative.
   * Returns the updated event on success, null if the decrease would go below zero.
   */
  public async adjustTicketCapacityAndCount(
    eventId: string,
    ticketId: string,
    newCapacity: number,
    delta: number,
  ): Promise<IEvent | null> {
    if (delta < 0) {
      return EventModel.findOneAndUpdate(
        {
          _id: eventId,
          tickets: { $elemMatch: { id: ticketId, availableCount: { $gte: -delta } } },
        },
        { $set: { "tickets.$.capacity": newCapacity }, $inc: { "tickets.$.availableCount": delta } },
        { new: true, runValidators: true },
      );
    }

    return EventModel.findOneAndUpdate(
      { _id: eventId, "tickets.id": ticketId },
      { $set: { "tickets.$.capacity": newCapacity }, $inc: { "tickets.$.availableCount": delta } },
      { new: true, runValidators: true },
    );
  }

  /**
   * Atomically pushes a new ticket onto the event's tickets array.
   * Safer than a full array replace because it never overwrites existing tickets' availableCount.
   */
  public async addTicketToEvent(eventId: string, userId: string, ticket: EventTicket): Promise<IEvent | null> {
    return EventModel.findOneAndUpdate(
      { _id: eventId, userId },
      { $push: { tickets: ticket } },
      { new: true, runValidators: true },
    );
  }

  /**
   * Atomically removes a ticket from the event's tickets array by ticket id.
   * Safer than a full array replace because it never overwrites other tickets' availableCount.
   */
  public async removeTicketFromEvent(eventId: string, userId: string, ticketId: string): Promise<IEvent | null> {
    return EventModel.findOneAndUpdate(
      { _id: eventId, userId },
      { $pull: { tickets: { id: ticketId } } },
      { new: true, runValidators: true },
    );
  }

  /**
   * Atomically updates specific non-capacity fields on a single ticket via positional $set.
   * Never touches availableCount, so it is safe under concurrent reservations.
   */
  public async updateTicketFields(
    eventId: string,
    userId: string,
    ticketId: string,
    fields: Partial<Pick<EventTicket, "name" | "description" | "salesEndAt" | "type" | "price" | "capacity">>,
  ): Promise<IEvent | null> {
    const setPayload: Record<string, unknown> = {};

    if (fields.name !== undefined) setPayload["tickets.$.name"] = fields.name;
    if ("description" in fields) setPayload["tickets.$.description"] = fields.description ?? null;
    if ("salesEndAt" in fields) setPayload["tickets.$.salesEndAt"] = fields.salesEndAt ?? null;
    if (fields.type !== undefined) setPayload["tickets.$.type"] = fields.type;
    if (fields.price !== undefined) setPayload["tickets.$.price"] = fields.price;
    if (fields.capacity !== undefined) setPayload["tickets.$.capacity"] = fields.capacity;

    if (Object.keys(setPayload).length === 0) {
      return EventModel.findOne({ _id: eventId, userId, "tickets.id": ticketId });
    }

    return EventModel.findOneAndUpdate(
      { _id: eventId, userId, "tickets.id": ticketId },
      { $set: setPayload },
      { new: true, runValidators: true },
    );
  }

  private toUpdate(payload: SaveEventDraftDto): UpdateQuery<IEvent> {
    const update: UpdateQuery<IEvent> = {};

    if (payload.name !== undefined) update.name = payload.name;
    if (payload.description !== undefined) update.description = payload.description;
    if (payload.bannerImageKey !== undefined) update.bannerImageKey = payload.bannerImageKey;
    if (payload.bannerOriginalImageKey !== undefined) update.bannerOriginalImageKey = payload.bannerOriginalImageKey;
    if (payload.bannerImageDisplay !== undefined) update.bannerImageDisplay = payload.bannerImageDisplay;
    if (payload.ageRestriction !== undefined) update.ageRestriction = payload.ageRestriction;
    if (payload.category !== undefined) update.category = payload.category;
    if (payload.categories !== undefined) {
      update.categories = payload.categories;
      update.category = payload.categories[0] ?? null;
    }
    if (payload.scheduledAt !== undefined) update.scheduledAt = payload.scheduledAt;
    if (payload.endAt !== undefined) update.endAt = payload.endAt;
    if (payload.location !== undefined) update.location = payload.location;
    if (payload.tickets !== undefined) update.tickets = payload.tickets;
    if (payload.rewards !== undefined) update.rewards = payload.rewards;
    if (payload.privacy !== undefined) update.privacy = payload.privacy;

    return update;
  }
}
