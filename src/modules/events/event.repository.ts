import type { FilterQuery, UpdateQuery } from "mongoose";
import { EventModel } from "./event.model.js";
import type { EventMapQuery, IEvent, NowModeQuery, PublishEventDto, SaveEventDraftDto } from "./event.interface.js";

interface CreateEventRecord extends SaveEventDraftDto {
  userId: string;
  status: "draft" | "published";
  publishedAt?: Date | null;
}

export class EventRepository {
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
      category: payload.category ?? null,
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

  public async deleteByIdForUser(id: string, userId: string): Promise<IEvent | null> {
    return EventModel.findOneAndDelete({ _id: id, userId });
  }

  public async findByUserId(userId: string): Promise<IEvent[]> {
    return EventModel.find({ userId }).sort({ createdAt: -1, _id: -1 });
  }

  public async findActiveAndUpcomingByUserId(userId: string, activeSince: Date, now: Date): Promise<IEvent[]> {
    return EventModel.find({
      userId,
      status: "published",
      $or: [
        { endAt: { $gte: now } },
        { endAt: null, scheduledAt: { $gte: activeSince } },
        { endAt: { $exists: false }, scheduledAt: { $gte: activeSince } },
      ],
    }).sort({ scheduledAt: 1, _id: -1 });
  }

  public async findLiveActiveByIds(eventIds: string[], activeSince: Date, until: Date): Promise<IEvent[]> {
    if (eventIds.length === 0) {
      return [];
    }

    return EventModel.find({
      _id: { $in: eventIds },
      status: "published",
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
    activeSince: Date,
  ): Promise<{ active: IEvent[]; past: IEvent[] }> {
    const baseQuery: FilterQuery<IEvent> = {
      userId,
      status: "published",
    };

    const now = new Date();
    const activeFallbackQuery = {
      $or: [{ endAt: null }, { endAt: { $exists: false } }],
      scheduledAt: { $gte: activeSince },
    };

    const [active, past] = await Promise.all([
      EventModel.find({
        ...baseQuery,
        $or: [{ endAt: { $gte: now } }, activeFallbackQuery],
      }).sort({ scheduledAt: 1, publishedAt: -1, _id: -1 }),
      EventModel.find({
        ...baseQuery,
        $or: [
          { endAt: { $lt: now } },
          {
            $or: [{ endAt: null }, { endAt: { $exists: false } }],
            scheduledAt: { $lt: activeSince },
          },
        ],
      }).sort({ scheduledAt: -1, publishedAt: -1, _id: -1 }),
    ]);

    return { active, past };
  }

  public async findMapEvents(query: EventMapQuery & { activeSince: Date }): Promise<IEvent[]> {
    const eventQuery: FilterQuery<IEvent> = {
      status: "published",
      privacy: "public",
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

  public async findNowModeEvents(query: NowModeQuery & { activeSince: Date; upcomingUntil: Date }): Promise<IEvent[]> {
    const eventQuery: FilterQuery<IEvent> = {
      status: "published",
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

  public async completeById(id: string, userId: string): Promise<IEvent | null> {
    const now = new Date();

    return EventModel.findOneAndUpdate(
      { _id: id, userId, status: "published" },
      { $set: { status: "completed", completedAt: now } },
      { new: true, runValidators: true },
    );
  }

  public async cancelById(id: string, userId: string): Promise<IEvent | null> {
    const now = new Date();

    return EventModel.findOneAndUpdate(
      { _id: id, userId, status: { $in: ["published", "completed"] } },
      { $set: { status: "cancelled", cancelledAt: now } },
      { new: true, runValidators: true },
    );
  }

  public async countByUserId(userId: string, status?: "draft" | "published"): Promise<number> {
    const filter: FilterQuery<IEvent> = { userId };

    if (status) {
      filter.status = status;
    }

    return EventModel.countDocuments(filter);
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

  private toUpdate(payload: SaveEventDraftDto): UpdateQuery<IEvent> {
    const update: UpdateQuery<IEvent> = {};

    if (payload.name !== undefined) update.name = payload.name;
    if (payload.description !== undefined) update.description = payload.description;
    if (payload.bannerImageKey !== undefined) update.bannerImageKey = payload.bannerImageKey;
    if (payload.bannerOriginalImageKey !== undefined) update.bannerOriginalImageKey = payload.bannerOriginalImageKey;
    if (payload.bannerImageDisplay !== undefined) update.bannerImageDisplay = payload.bannerImageDisplay;
    if (payload.ageRestriction !== undefined) update.ageRestriction = payload.ageRestriction;
    if (payload.category !== undefined) update.category = payload.category;
    if (payload.scheduledAt !== undefined) update.scheduledAt = payload.scheduledAt;
    if (payload.endAt !== undefined) update.endAt = payload.endAt;
    if (payload.location !== undefined) update.location = payload.location;
    if (payload.tickets !== undefined) update.tickets = payload.tickets;
    if (payload.rewards !== undefined) update.rewards = payload.rewards;
    if (payload.privacy !== undefined) update.privacy = payload.privacy;

    return update;
  }
}
