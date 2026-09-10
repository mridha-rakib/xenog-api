import tzLookup from "@photostructure/tz-lookup";

/**
 * Event-local timezone foundation (Batch 3A).
 *
 * ONE place for:
 *   - validating an IANA timezone string,
 *   - resolving an IANA timezone from venue coordinates (offline, server-only),
 *   - converting a venue-local wall-clock <-> an absolute UTC instant.
 *
 * Everything here is pure and side-effect free. It never reads the process /
 * device timezone: the multi-argument local Date constructor is deliberately
 * NOT used for interpreting a venue-local wall-clock. Offsets are derived from
 * the IANA database via `Intl` for the specific date in question, so DST is
 * always resolved with that date's rules.
 *
 * DST disambiguation policy (APPROVED, deterministic):
 *   - spring-forward GAP (local time does not exist): the first valid local
 *     instant after the gap (the transition boundary itself).
 *   - fall-back FOLD (local time occurs twice): the EARLIER occurrence.
 */

export const EVENT_TIME_ZONE_MAX_LENGTH = 64;

export interface EventLocalDateTimeParts {
  /** Full year, e.g. 2026. */
  year: number;
  /** 1-12. */
  month: number;
  /** 1-31. */
  day: number;
  /** 0-23. */
  hour: number;
  /** 0-59. */
  minute: number;
}

// Characters that appear in real IANA zone ids (plus the legacy "Etc/GMT+5"
// style). Anything outside this set is rejected before it can reach `Intl`.
const TIME_ZONE_PATTERN = /^[A-Za-z0-9+_./-]{1,64}$/;

const ianaValidationCache = new Map<string, boolean>();

/**
 * True when `value` is a syntactically safe string that `Intl` accepts as a
 * timezone. Cached because the create/edit path can validate the same zone many
 * times per request batch.
 */
export const isValidIanaTimeZone = (value: unknown): value is string => {
  if (typeof value !== "string") {
    return false;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > EVENT_TIME_ZONE_MAX_LENGTH) {
    return false;
  }
  if (!TIME_ZONE_PATTERN.test(trimmed)) {
    return false;
  }

  const cached = ianaValidationCache.get(trimmed);
  if (cached !== undefined) {
    return cached;
  }

  let ok = false;
  try {
    // Throws a RangeError for an unknown zone.
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
    ok = true;
  } catch {
    ok = false;
  }

  ianaValidationCache.set(trimmed, ok);
  return ok;
};

const isFiniteInRange = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

/**
 * Resolve the IANA timezone for a venue from its coordinates. Offline and
 * synchronous — no network, no Mapbox call. Returns `null` (never throws) for
 * missing / out-of-range / non-finite coordinates or an unexpected lookup
 * failure, so create/edit flows can fall back safely.
 */
export const resolveEventTimeZoneFromCoordinates = (
  latitude: unknown,
  longitude: unknown,
): string | null => {
  if (!isFiniteInRange(latitude, -90, 90) || !isFiniteInRange(longitude, -180, 180)) {
    return null;
  }

  try {
    const zone = tzLookup(latitude, longitude);
    return isValidIanaTimeZone(zone) ? zone : null;
  } catch {
    return null;
  }
};

const partFormatterCache = new Map<string, Intl.DateTimeFormat>();

const getPartFormatter = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = partFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    partFormatterCache.set(timeZone, formatter);
  }
  return formatter;
};

const readParts = (date: Date, timeZone: string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const part of getPartFormatter(timeZone).formatToParts(date)) {
    if (part.type !== "literal") {
      out[part.type] = Number(part.value);
    }
  }
  return out;
};

/** The zone's wall-clock at `instantMs`, expressed as if it were a UTC instant. */
const zoneWallClockAsUtcMs = (instantMs: number, timeZone: string): number => {
  const p = readParts(new Date(instantMs), timeZone);
  const hour = p.hour === 24 ? 0 : p.hour ?? 0;
  return Date.UTC(p.year ?? 1970, (p.month ?? 1) - 1, p.day ?? 1, hour, p.minute ?? 0, p.second ?? 0);
};

/**
 * Signed offset (ms) the zone is ahead of UTC at `instantMs`. `Intl` only
 * exposes the wall-clock to whole-second precision, so the sub-second remainder
 * of `instantMs` is added back — otherwise the offset would appear to drift for
 * non-whole-second instants (which breaks the transition binary-search).
 */
const getZoneOffsetMs = (instantMs: number, timeZone: string): number => {
  const subSecond = instantMs - Math.floor(instantMs / 1000) * 1000;
  return zoneWallClockAsUtcMs(instantMs, timeZone) + subSecond - instantMs;
};

// Larger than any real UTC offset (max |14h|) plus a buffer, small enough that
// two DST transitions can never both fall inside the probe window.
const OFFSET_PROBE_MS = 26 * 60 * 60 * 1000;

const assertValidParts = (parts: EventLocalDateTimeParts): void => {
  const { year, month, day, hour, minute } = parts;
  if (
    !Number.isInteger(year) ||
    year < 1970 ||
    year > 2200 ||
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12 ||
    !Number.isInteger(day) ||
    day < 1 ||
    day > 31 ||
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59
  ) {
    throw new Error("Invalid event local date-time parts");
  }
};

const wallClockMatches = (
  instantMs: number,
  parts: EventLocalDateTimeParts,
  timeZone: string,
): boolean => {
  const p = instantToEventLocalParts(new Date(instantMs), timeZone);
  return (
    p.year === parts.year &&
    p.month === parts.month &&
    p.day === parts.day &&
    p.hour === parts.hour &&
    p.minute === parts.minute
  );
};

// Binary-search the exact instant at which the offset flips inside `[lowMs, highMs]`.
// Returns the first millisecond that carries the post-transition offset, i.e. the
// first valid local instant after a spring-forward gap.
const findTransitionInstantMs = (lowMs: number, highMs: number, timeZone: string): number => {
  let lo = lowMs;
  let hi = highMs;
  const loOffset = getZoneOffsetMs(lo, timeZone);

  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (getZoneOffsetMs(mid, timeZone) === loOffset) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  return hi;
};

/**
 * venue-local wall-clock + IANA timezone  ->  absolute UTC instant.
 *
 * Deterministic. Applies the APPROVED DST policy: gap -> first valid instant
 * after the gap; fold -> earlier occurrence. Throws only for structurally
 * invalid `parts` (callers validate/parse first and wrap in try/catch).
 */
export const eventLocalPartsToInstant = (
  parts: EventLocalDateTimeParts,
  timeZone: string,
): Date => {
  assertValidParts(parts);

  const asUtcMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);

  const candidateOffsets = Array.from(
    new Set([
      getZoneOffsetMs(asUtcMs - OFFSET_PROBE_MS, timeZone),
      getZoneOffsetMs(asUtcMs, timeZone),
      getZoneOffsetMs(asUtcMs + OFFSET_PROBE_MS, timeZone),
    ]),
  );

  const validInstants = Array.from(new Set(candidateOffsets.map((offset) => asUtcMs - offset)))
    .filter((instantMs) => wallClockMatches(instantMs, parts, timeZone))
    .sort((a, b) => a - b);

  if (validInstants.length > 0) {
    // 1 match  -> unambiguous.
    // 2 matches -> fall-back fold; "earlier" policy keeps the smallest instant.
    return new Date(validInstants[0]!);
  }

  // No instant renders the requested wall-clock -> spring-forward gap.
  const lo = asUtcMs - Math.max(...candidateOffsets);
  const hi = asUtcMs - Math.min(...candidateOffsets);
  return new Date(findTransitionInstantMs(lo, hi, timeZone));
};

/**
 * absolute UTC instant + IANA timezone  ->  venue-local wall-clock parts.
 * Uses `Intl` only; safe on any runtime with full ICU (Node >= 20).
 */
export const instantToEventLocalParts = (
  date: Date,
  timeZone: string,
): EventLocalDateTimeParts => {
  const p = readParts(date, timeZone);
  return {
    year: p.year ?? 1970,
    month: p.month ?? 1,
    day: p.day ?? 1,
    hour: p.hour === 24 ? 0 : p.hour ?? 0,
    minute: p.minute ?? 0,
  };
};

/**
 * Preserve the local wall-clock of `instant` while moving it from `fromZone` to
 * `toZone` (the APPROVED venue-change semantic). Returns `null` for an invalid
 * instant. May throw only via `eventLocalPartsToInstant` on a corrupt zone.
 */
export const reinterpretInstantInZone = (
  instant: Date | null | undefined,
  fromZone: string,
  toZone: string,
): Date | null => {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    return null;
  }
  return eventLocalPartsToInstant(instantToEventLocalParts(instant, fromZone), toZone);
};

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_KEY_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Parse a `YYYY-MM-DD` + `HH:mm` transport pair into calendar parts. Returns
 * `null` for malformed input or an impossible calendar date (e.g. `2026-02-30`).
 */
export const parseEventLocalDateTime = (
  dateKey: string,
  timeKey: string,
): EventLocalDateTimeParts | null => {
  const dateMatch = DATE_KEY_PATTERN.exec(dateKey);
  const timeMatch = TIME_KEY_PATTERN.exec(timeKey);
  if (!dateMatch || !timeMatch) {
    return null;
  }

  const parts: EventLocalDateTimeParts = {
    year: Number(dateMatch[1]),
    month: Number(dateMatch[2]),
    day: Number(dateMatch[3]),
    hour: Number(timeMatch[1]),
    minute: Number(timeMatch[2]),
  };

  try {
    assertValidParts(parts);
  } catch {
    return null;
  }

  // Reject impossible calendar dates.
  const probe = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (
    probe.getUTCFullYear() !== parts.year ||
    probe.getUTCMonth() !== parts.month - 1 ||
    probe.getUTCDate() !== parts.day
  ) {
    return null;
  }

  return parts;
};

/** Convenience: parse an optional transport pair, `null` when either side is absent. */
export const parseOptionalEventLocalDateTime = (
  dateKey: string | null | undefined,
  timeKey: string | null | undefined,
): EventLocalDateTimeParts | null => {
  if (!dateKey || !timeKey) {
    return null;
  }
  return parseEventLocalDateTime(dateKey, timeKey);
};
