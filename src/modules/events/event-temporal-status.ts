import type { EventLifecycle } from "./event.interface.js";

/** Canonical display-lifecycle constants and classifier. */
export const ACTIVE_EVENT_WINDOW_MS = 12 * 60 * 60 * 1000;
export const NOW_MODE_LOOKAHEAD_MS = 3 * 60 * 60 * 1000;
export const STARTING_SOON_MS = 2 * 60 * 60 * 1000;

/**
 * Derives the one display lifecycle for a normally eligible Event from absolute
 * instants. Persisted Event status is deliberately not an input: scheduler
 * writes must never make the displayed state lag a start or end boundary.
 */
export const getEventLifecycle = (
  scheduledAt: Date | null | undefined,
  endAt: Date | null | undefined,
  now: number = Date.now(),
): EventLifecycle | null => {
  const scheduled = scheduledAt?.getTime() ?? Number.NaN;
  const ended = endAt?.getTime() ?? Number.NaN;

  if (!Number.isFinite(scheduled) || !Number.isFinite(ended)) {
    return null;
  }

  if (now >= ended) {
    return "ended";
  }
  if (now >= scheduled) {
    return "live";
  }
  if (scheduled - now < STARTING_SOON_MS) {
    return "starting_soon";
  }
  return "upcoming";
};

/**
 * Smart Feed's legacy ranking buckets are intentionally separate from display
 * lifecycle. In particular, `last_call` remains a score bucket, never an API
 * lifecycle label, so canonical display changes do not silently alter ranking.
 */
export type SmartFeedTemporalBucket = "live_now" | "starting_soon" | "last_call" | null;
const SMART_FEED_STARTING_SOON_MS = 60 * 60 * 1000;

export const getSmartFeedTemporalBucket = (
  scheduledAt: Date | null | undefined,
  endAt: Date | null | undefined,
  now: number = Date.now(),
): SmartFeedTemporalBucket => {
  const scheduled = scheduledAt?.getTime() ?? Number.NaN;
  if (!Number.isFinite(scheduled)) return null;

  const ended = endAt?.getTime() ?? Number.NaN;
  if (scheduled <= now && (Number.isFinite(ended) ? ended >= now : now - scheduled <= ACTIVE_EVENT_WINDOW_MS)) {
    return "live_now";
  }
  if (scheduled > now && scheduled - now <= SMART_FEED_STARTING_SOON_MS) {
    return "starting_soon";
  }
  if (scheduled > now && scheduled - now <= NOW_MODE_LOOKAHEAD_MS) {
    return "last_call";
  }
  return null;
};

/**
 * Smart Feed "active event" eligibility (hard filter, NOT a score term).
 *
 * An Event is still an *active* Smart Feed result when:
 *  - it has an `endAt` that is still in the future, OR
 *  - it has no `endAt` but started less than ACTIVE_EVENT_WINDOW_MS ago, OR
 *  - it has no `endAt` and has not started yet (any future upcoming Event).
 *
 * Ended Events (`endAt < now`) and stale no-`endAt` Events whose `scheduledAt`
 * is older than the active window are excluded. This mirrors the existing
 * `activeOnly` repository window; it is applied to the normal Smart Feed here
 * so a since-ended Event does not linger indefinitely as an "active result".
 */
export const isActiveSmartFeedEvent = (
  scheduledAt: Date | null | undefined,
  endAt: Date | null | undefined,
  now: number = Date.now(),
): boolean => {
  const ended = endAt?.getTime() ?? null;

  if (ended !== null) {
    return Number.isFinite(ended) ? ended >= now : true;
  }

  const scheduled = scheduledAt?.getTime() ?? null;

  if (scheduled === null || !Number.isFinite(scheduled)) {
    // No schedule at all — leave eligibility to the other hard filters.
    return true;
  }

  if (scheduled > now) {
    return true;
  }

  return now - scheduled <= ACTIVE_EVENT_WINDOW_MS;
};
