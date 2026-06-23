import type { FilterQuery, UpdateQuery } from "mongoose";
import { EventModel } from "./event.model.js";
import type { EventMapQuery, EventReward, IEvent, NowModeQuery, PublishEventDto, SaveEventDraftDto } from "./event.interface.js";

interface CreateEventRecord extends SaveEventDraftDto {
  userId: string;
  status: "draft" | "published" | "live";
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

  public async findPublicFeedEvents(excludeUserIds: string[] = []): Promise<IEvent[]> {
    return EventModel.find({
      status: { $in: ["published", "live"] },
      privacy: { $in: ["public", "locked"] },
      ...(excludeUserIds.length > 0 ? { userId: { $nin: excludeUserIds } } : {}),
    }).sort({ publishedAt: -1, createdAt: -1, _id: -1 });
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
    activeSince: Date,
  ): Promise<{ active: IEvent[]; past: IEvent[] }> {
    const baseQuery: FilterQuery<IEvent> = {
      userId,
      status: { $in: ["published", "live"] },
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
      { _id: id, userId, status: { $in: ["published", "live"] } },
      { $set: { status: "completed", completedAt: now } },
      { new: true, runValidators: true },
    );
  }

  public async cancelById(id: string, userId: string): Promise<IEvent | null> {
    const now = new Date();

    return EventModel.findOneAndUpdate(
      { _id: id, userId, status: { $in: ["published", "live", "completed"] } },
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

  public async autoStartScheduled(now: Date): Promise<number> {
    const result = await EventModel.updateMany(
      {
        status: "published",
        scheduledAt: { $ne: null, $lte: now },
        $or: [{ endAt: null }, { endAt: { $exists: false } }, { endAt: { $gt: now } }],
      },
      { $set: { status: "live", startedAt: now } },
    );

    return result.modifiedCount;
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
