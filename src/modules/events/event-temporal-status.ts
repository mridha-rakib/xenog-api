import type { NowEventStatus } from "./event.interface.js";

/**
 * Canonical Event temporal constants + classifier.
 *
 * Extracted verbatim from EventService (Now Mode) so the Smart Feed Event
 * ranking layer can reuse the SAME "starting soon" / "last call" / active-window
 * definitions instead of inventing a second one. Behaviour is unchanged — the
 * only addition is an injectable `now` (ms) for deterministic tests; it defaults
 * to `Date.now()`, so existing 2-argument callers behave exactly as before.
 */
export const ACTIVE_EVENT_WINDOW_MS = 12 * 60 * 60 * 1000;
export const NOW_MODE_LOOKAHEAD_MS = 3 * 60 * 60 * 1000;
export const STARTING_SOON_MS = 60 * 60 * 1000;

export const getNowStatus = (
  scheduledAt: Date | null | undefined,
  endAt?: Date | null,
  now: number = Date.now(),
): NowEventStatus | null => {
  if (!scheduledAt) {
    return null;
  }

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
