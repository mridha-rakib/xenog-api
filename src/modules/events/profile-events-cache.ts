import { RedisClient } from "../../config/redis.js";
import { logger } from "../../core/logger/logger.js";
import { EventModel } from "./event.model.js";

// Shared so the payments/refund/cancellation services can invalidate the same
// profile-events Redis cache that EventService.listProfileEventsByUserId reads,
// when a ticket purchase/reservation/refund changes authoritative inventory.
// This is the EXISTING cache (same key, same version, same TTL policy) — no new
// cache is introduced here.
export const PROFILE_EVENTS_CACHE_VERSION = "v1";

export const getProfileEventsCacheKey = (userId: string, includePrivateEvents: boolean): string =>
  [
    "events",
    "profile",
    PROFILE_EVENTS_CACHE_VERSION,
    userId.toLowerCase(),
    includePrivateEvents ? "owner" : "public",
  ].join(":");

export const invalidateProfileEventsCache = async (userId: string): Promise<void> => {
  try {
    const redis = RedisClient.getClient();

    if (redis.status !== "ready") {
      return;
    }

    await redis.del(
      getProfileEventsCacheKey(userId, true),
      getProfileEventsCacheKey(userId, false),
    );
  } catch (error) {
    logger.warn({ error, userId }, "Profile events cache invalidation failed");
  }
};

// Resolves each event's host once and invalidates that host's profile-events
// cache. Fire-and-forget friendly: never throws.
export const invalidateProfileEventsCacheForEventIds = async (eventIds: string[]): Promise<void> => {
  const uniqueEventIds = [...new Set(eventIds.map((id) => id?.toString().trim()).filter(Boolean))] as string[];

  if (uniqueEventIds.length === 0) {
    return;
  }

  try {
    const events = await EventModel.find({ _id: { $in: uniqueEventIds } })
      .select("userId")
      .lean<{ userId: { toString: () => string } }[]>();
    const hostUserIds = [...new Set(events.map((event) => event.userId.toString()))];

    await Promise.all(hostUserIds.map((userId) => invalidateProfileEventsCache(userId)));
  } catch (error) {
    logger.warn({ error, eventIds: uniqueEventIds }, "Profile events cache invalidation (by event ids) failed");
  }
};
