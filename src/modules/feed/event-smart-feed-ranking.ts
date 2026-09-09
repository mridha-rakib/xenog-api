import { calculateFreshnessScore } from "./smart-feed-ranking.js";
import {
  getNowStatus,
  NOW_MODE_LOOKAHEAD_MS,
  STARTING_SOON_MS,
} from "../events/event-temporal-status.js";

/**
 * EVENT-SPECIFIC Smart Feed ranking.
 *
 * This is deliberately a SEPARATE layer from the generic
 * `calculateSmartFeedScore` used by Posts. Post ranking (weights, formula,
 * expected scores) is intentionally left byte-for-byte unchanged — see
 * smart-feed-ranking.ts. Only Events use the weights/sub-scores below.
 *
 * Product requirement covered here:
 *   "Rank title relevance, category, host, venue/location, date/status,
 *    proximity, popularity, and freshness."
 * Acceptance:
 *   "Live/starting-soon nearby matches outrank weak distant results."
 */

// ---------------------------------------------------------------------------
// Locked Event weights (sum = 1.00). Do NOT apply these to Posts.
// ---------------------------------------------------------------------------
export const EVENT_SMART_FEED_WEIGHTS = {
  status: 0.22,
  proximity: 0.2,
  title: 0.1,
  category: 0.1,
  host: 0.15,
  venue: 0.06,
  popularity: 0.09,
  freshness: 0.08,
} as const;

// Continuous distance decay — NO hard geographic cutoff (unlike the generic
// Post nearby scorer's 200-mile cap). Locked: 1 / (1 + km / 50).
export const EVENT_PROXIMITY_DECAY_KM = 50;

// Locked GeoIP administrative-area fallback scores.
export const EVENT_GEOIP_PROXIMITY_SCORES = {
  sameCity: 1.0,
  sameRegion: 0.7,
  sameCountry: 0.35,
  differentCountry: 0.05,
  unknown: 0,
} as const;

// Locked date/status buckets.
export const EVENT_STATUS_SCORES = {
  liveNow: 1.0,
  startingSoon: 0.95,
  lastCall: 0.85,
  within12h: 0.75,
  within24h: 0.65,
  within3d: 0.5,
  within7d: 0.35,
  laterUpcoming: 0.15,
  ended: 0,
} as const;

// Locked host relationship base values (strongest match wins — never summed).
export const EVENT_HOST_SCORES = {
  self: 1.0,
  mutualFriend: 0.8,
  followed: 0.6,
  priorAffinity: 0.4,
  unrelated: 0,
} as const;

// Behavioral venue/location match (separate from physical proximity).
export const EVENT_VENUE_SCORES = {
  sameVenue: 1.0,
  sameCity: 0.7,
  sameRegion: 0.45,
  sameCountry: 0.2,
  none: 0,
} as const;

// Popularity log-normalization caps (locked).
export const EVENT_POPULARITY_CAPS = {
  going: 100,
  reactions: 50,
  comments: 20,
  shares: 20,
} as const;

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export const clamp01 = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
};

// ---------------------------------------------------------------------------
// Text tokenization (Event-ranking local; no NLP / fuzzy-search dependency).
// ---------------------------------------------------------------------------
const TOKEN_MIN_LENGTH = 3;

export const tokenizeEventText = (value: string | null | undefined): string[] => {
  if (!value) {
    return [];
  }

  let normalized: string;
  try {
    normalized = value.normalize("NFKD");
  } catch {
    normalized = value;
  }

  return (
    normalized
      .toLocaleLowerCase()
      // Drop combining marks left by NFKD so "Café" and "Cafe" tokenize alike.
      .replace(/\p{M}+/gu, "")
      .replace(/[\p{P}\p{S}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .filter((token) => token.length >= TOKEN_MIN_LENGTH)
  );
};

export type EventTextInterestProfile = {
  // token -> accumulated weight across the viewer's recent positive history
  tokenWeights: Map<string, number>;
  totalWeight: number;
};

export const buildEventTextInterestProfile = (
  historyTitles: Array<string | null | undefined>,
): EventTextInterestProfile => {
  const tokenWeights = new Map<string, number>();

  for (const title of historyTitles) {
    // Distinct tokens per history item so one very long title cannot dominate.
    const tokens = new Set(tokenizeEventText(title));
    for (const token of tokens) {
      tokenWeights.set(token, (tokenWeights.get(token) ?? 0) + 1);
    }
  }

  let totalWeight = 0;
  for (const weight of tokenWeights.values()) {
    totalWeight += weight;
  }

  return { tokenWeights, totalWeight };
};

export const calculateEventTitleScore = (
  candidateName: string | null | undefined,
  profile: EventTextInterestProfile | null | undefined,
): number => {
  if (!profile || profile.totalWeight <= 0) {
    return 0;
  }

  const candidateTokens = new Set(tokenizeEventText(candidateName));
  if (candidateTokens.size === 0) {
    return 0;
  }

  let overlapWeight = 0;
  for (const token of candidateTokens) {
    overlapWeight += profile.tokenWeights.get(token) ?? 0;
  }

  return clamp01(overlapWeight / profile.totalWeight);
};

// ---------------------------------------------------------------------------
// Category relevance
// ---------------------------------------------------------------------------
export type EventCategoryInterestProfile = {
  categoryWeights: Map<string, number>;
  maxWeight: number;
};

const normalizeCategoryKey = (value: string | null | undefined): string | null => {
  const normalized = value?.trim().toLocaleLowerCase();
  return normalized ? normalized : null;
};

export const buildEventCategoryInterestProfile = (
  historyCategories: Array<Array<string | null | undefined> | string | null | undefined>,
): EventCategoryInterestProfile => {
  const categoryWeights = new Map<string, number>();

  for (const entry of historyCategories) {
    const list = Array.isArray(entry) ? entry : [entry];
    const distinct = new Set(
      list.map(normalizeCategoryKey).filter((value): value is string => value !== null),
    );
    for (const category of distinct) {
      categoryWeights.set(category, (categoryWeights.get(category) ?? 0) + 1);
    }
  }

  let maxWeight = 0;
  for (const weight of categoryWeights.values()) {
    maxWeight = Math.max(maxWeight, weight);
  }

  return { categoryWeights, maxWeight };
};

export const calculateEventCategoryScore = (signals: {
  candidateCategories: Array<string | null | undefined>;
  explicitCategory?: string | null;
  profile?: EventCategoryInterestProfile | null;
}): number => {
  const candidate = new Set(
    signals.candidateCategories
      .map(normalizeCategoryKey)
      .filter((value): value is string => value !== null),
  );

  const explicit = normalizeCategoryKey(signals.explicitCategory);
  if (explicit && candidate.has(explicit)) {
    return 1;
  }

  const profile = signals.profile;
  if (!profile || profile.maxWeight <= 0 || candidate.size === 0) {
    return 0;
  }

  let best = 0;
  for (const category of candidate) {
    const weight = profile.categoryWeights.get(category) ?? 0;
    best = Math.max(best, weight / profile.maxWeight);
  }

  return clamp01(best);
};

// ---------------------------------------------------------------------------
// Host relevance
// ---------------------------------------------------------------------------
export const calculateEventHostScore = (signals: {
  isSelf?: boolean;
  isMutualFriend?: boolean;
  isFollowed?: boolean;
  hasPriorAffinity?: boolean;
}): number => {
  if (signals.isSelf) {
    return EVENT_HOST_SCORES.self;
  }
  if (signals.isMutualFriend) {
    return EVENT_HOST_SCORES.mutualFriend;
  }
  if (signals.isFollowed) {
    return EVENT_HOST_SCORES.followed;
  }
  if (signals.hasPriorAffinity) {
    return EVENT_HOST_SCORES.priorAffinity;
  }
  return EVENT_HOST_SCORES.unrelated;
};

// ---------------------------------------------------------------------------
// Regional text helpers (shared by GeoIP proximity + behavioral venue score)
// ---------------------------------------------------------------------------
export type RegionalLocation = {
  city?: string | null;
  region?: string | null;
  regionCode?: string | null;
  country?: string | null;
  countryCode?: string | null;
  venue?: string | null;
};

const normalizeText = (value: string | null | undefined): string | null => {
  const normalized = value?.trim().toLocaleLowerCase();
  return normalized ? normalized : null;
};

const normalizeCode = (value: string | null | undefined): string | null => {
  const normalized = value?.trim().toLocaleUpperCase();
  return normalized ? normalized : null;
};

const countryKey = (location: RegionalLocation): string | null =>
  normalizeCode(location.countryCode) ?? normalizeText(location.country);

const regionKey = (location: RegionalLocation): string | null =>
  normalizeCode(location.regionCode) ?? normalizeText(location.region);

export const calculateEventGeoIpProximityScore = (
  viewer: RegionalLocation | null | undefined,
  event: RegionalLocation | null | undefined,
): number => {
  if (!viewer || !event) {
    return EVENT_GEOIP_PROXIMITY_SCORES.unknown;
  }

  const viewerCountry = countryKey(viewer);
  const eventCountry = countryKey(event);

  if (!viewerCountry || !eventCountry) {
    return EVENT_GEOIP_PROXIMITY_SCORES.unknown;
  }

  if (viewerCountry !== eventCountry) {
    return EVENT_GEOIP_PROXIMITY_SCORES.differentCountry;
  }

  const viewerCity = normalizeText(viewer.city);
  const eventCity = normalizeText(event.city);
  if (viewerCity && eventCity && viewerCity === eventCity) {
    return EVENT_GEOIP_PROXIMITY_SCORES.sameCity;
  }

  const viewerRegion = regionKey(viewer);
  const eventRegion = regionKey(event);
  if (viewerRegion && eventRegion && viewerRegion === eventRegion) {
    return EVENT_GEOIP_PROXIMITY_SCORES.sameRegion;
  }

  return EVENT_GEOIP_PROXIMITY_SCORES.sameCountry;
};

// ---------------------------------------------------------------------------
// Physical proximity (exact coordinates) — continuous, no 200-mile cutoff.
// ---------------------------------------------------------------------------
export const calculateEventExactProximityScore = (distanceKm: number): number => {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) {
    return 0;
  }
  return clamp01(1 / (1 + distanceKm / EVENT_PROXIMITY_DECAY_KM));
};

export type EventProximitySource = "exact" | "geoip" | "none";

export type EventProximityResult = {
  proximityScore: number;
  proximitySource: EventProximitySource;
};

export const resolveEventProximity = (signals: {
  exactDistanceKm?: number | null;
  viewerRegional?: RegionalLocation | null;
  eventRegional?: RegionalLocation | null;
}): EventProximityResult => {
  if (typeof signals.exactDistanceKm === "number" && Number.isFinite(signals.exactDistanceKm)) {
    return {
      proximityScore: calculateEventExactProximityScore(signals.exactDistanceKm),
      proximitySource: "exact",
    };
  }

  if (signals.viewerRegional) {
    const score = calculateEventGeoIpProximityScore(signals.viewerRegional, signals.eventRegional);
    if (score > 0) {
      return { proximityScore: score, proximitySource: "geoip" };
    }
    // viewer regional context existed but produced nothing usable
    return { proximityScore: 0, proximitySource: "geoip" };
  }

  return { proximityScore: 0, proximitySource: "none" };
};

// ---------------------------------------------------------------------------
// Behavioral venue/location relevance (NOT physical distance)
// ---------------------------------------------------------------------------
export type EventVenueInterestProfile = {
  venues: Set<string>;
  cities: Set<string>;
  regions: Set<string>;
  countries: Set<string>;
};

export const buildEventVenueInterestProfile = (
  historyLocations: Array<RegionalLocation | null | undefined>,
): EventVenueInterestProfile => {
  const profile: EventVenueInterestProfile = {
    venues: new Set(),
    cities: new Set(),
    regions: new Set(),
    countries: new Set(),
  };

  for (const location of historyLocations) {
    if (!location) {
      continue;
    }
    const venue = normalizeText(location.venue);
    if (venue) profile.venues.add(venue);
    const city = normalizeText(location.city);
    if (city) profile.cities.add(city);
    const region = regionKey(location);
    if (region) profile.regions.add(region);
    const country = countryKey(location);
    if (country) profile.countries.add(country);
  }

  return profile;
};

export const calculateEventVenueScore = (
  eventLocation: RegionalLocation | null | undefined,
  profile: EventVenueInterestProfile | null | undefined,
): number => {
  if (!eventLocation || !profile) {
    return EVENT_VENUE_SCORES.none;
  }

  const venue = normalizeText(eventLocation.venue);
  if (venue && profile.venues.has(venue)) {
    return EVENT_VENUE_SCORES.sameVenue;
  }

  const city = normalizeText(eventLocation.city);
  if (city && profile.cities.has(city)) {
    return EVENT_VENUE_SCORES.sameCity;
  }

  const region = regionKey(eventLocation);
  if (region && profile.regions.has(region)) {
    return EVENT_VENUE_SCORES.sameRegion;
  }

  const country = countryKey(eventLocation);
  if (country && profile.countries.has(country)) {
    return EVENT_VENUE_SCORES.sameCountry;
  }

  return EVENT_VENUE_SCORES.none;
};

// ---------------------------------------------------------------------------
// Date / status score (reuses the canonical temporal helper — no second
// "starting soon" definition).
// ---------------------------------------------------------------------------
export const calculateEventStatusScore = (signals: {
  scheduledAt: Date | null | undefined;
  endAt: Date | null | undefined;
  now: number;
}): number => {
  const nowStatus = getNowStatus(signals.scheduledAt, signals.endAt, signals.now);
  if (nowStatus === "live_now") {
    return EVENT_STATUS_SCORES.liveNow;
  }
  if (nowStatus === "starting_soon") {
    return EVENT_STATUS_SCORES.startingSoon;
  }
  if (nowStatus === "last_call") {
    return EVENT_STATUS_SCORES.lastCall;
  }

  const scheduled = signals.scheduledAt?.getTime() ?? null;
  if (scheduled === null || !Number.isFinite(scheduled)) {
    return EVENT_STATUS_SCORES.laterUpcoming;
  }

  const msUntil = scheduled - signals.now;
  if (msUntil <= 0) {
    // Already started; not classified live by getNowStatus (outside the active
    // window and/or ended). Eligibility filter should have removed it.
    return EVENT_STATUS_SCORES.ended;
  }
  // getNowStatus already covered <= NOW_MODE_LOOKAHEAD_MS (3h) as last_call.
  if (msUntil <= NOW_MODE_LOOKAHEAD_MS) {
    return EVENT_STATUS_SCORES.lastCall;
  }
  if (msUntil <= 12 * MS_PER_HOUR) {
    return EVENT_STATUS_SCORES.within12h;
  }
  if (msUntil <= 24 * MS_PER_HOUR) {
    return EVENT_STATUS_SCORES.within24h;
  }
  if (msUntil <= 3 * MS_PER_DAY) {
    return EVENT_STATUS_SCORES.within3d;
  }
  if (msUntil <= 7 * MS_PER_DAY) {
    return EVENT_STATUS_SCORES.within7d;
  }
  return EVENT_STATUS_SCORES.laterUpcoming;
};

// Re-export so callers have one import site.
export { STARTING_SOON_MS, calculateFreshnessScore };

// ---------------------------------------------------------------------------
// Popularity (log-normalized, capped — locked formula)
// ---------------------------------------------------------------------------
const logNorm = (count: number, cap: number): number => {
  if (!Number.isFinite(count) || count <= 0) {
    return 0;
  }
  return Math.min(Math.log1p(count) / Math.log1p(cap), 1);
};

export const calculateEventPopularityScore = (signals: {
  going?: number | null;
  reactions?: number | null;
  comments?: number | null;
  shares?: number | null;
}): number => {
  const goingNorm = logNorm(signals.going ?? 0, EVENT_POPULARITY_CAPS.going);
  const reactionNorm = logNorm(signals.reactions ?? 0, EVENT_POPULARITY_CAPS.reactions);
  const commentNorm = logNorm(signals.comments ?? 0, EVENT_POPULARITY_CAPS.comments);
  const shareNorm = logNorm(signals.shares ?? 0, EVENT_POPULARITY_CAPS.shares);

  return clamp01(goingNorm * 0.5 + reactionNorm * 0.2 + commentNorm * 0.15 + shareNorm * 0.15);
};

// ---------------------------------------------------------------------------
// Final Event score
// ---------------------------------------------------------------------------
export type EventSmartFeedSubScores = {
  statusScore: number;
  proximityScore: number;
  titleScore: number;
  categoryScore: number;
  hostScore: number;
  venueScore: number;
  popularityScore: number;
  freshnessScore: number;
};

export type EventSmartFeedScore = EventSmartFeedSubScores & {
  proximitySource: EventProximitySource;
  finalScore: number;
};

export const calculateEventSmartFeedScore = (
  sub: EventSmartFeedSubScores & { proximitySource?: EventProximitySource },
): EventSmartFeedScore => {
  const statusScore = clamp01(sub.statusScore);
  const proximityScore = clamp01(sub.proximityScore);
  const titleScore = clamp01(sub.titleScore);
  const categoryScore = clamp01(sub.categoryScore);
  const hostScore = clamp01(sub.hostScore);
  const venueScore = clamp01(sub.venueScore);
  const popularityScore = clamp01(sub.popularityScore);
  const freshnessScore = clamp01(sub.freshnessScore);

  const finalScore = clamp01(
    statusScore * EVENT_SMART_FEED_WEIGHTS.status +
      proximityScore * EVENT_SMART_FEED_WEIGHTS.proximity +
      titleScore * EVENT_SMART_FEED_WEIGHTS.title +
      categoryScore * EVENT_SMART_FEED_WEIGHTS.category +
      hostScore * EVENT_SMART_FEED_WEIGHTS.host +
      venueScore * EVENT_SMART_FEED_WEIGHTS.venue +
      popularityScore * EVENT_SMART_FEED_WEIGHTS.popularity +
      freshnessScore * EVENT_SMART_FEED_WEIGHTS.freshness,
  );

  return {
    statusScore,
    proximityScore,
    titleScore,
    categoryScore,
    hostScore,
    venueScore,
    popularityScore,
    freshnessScore,
    proximitySource: sub.proximitySource ?? "none",
    finalScore,
  };
};

// ---------------------------------------------------------------------------
// Deterministic Event-vs-Event ordering
// ---------------------------------------------------------------------------
export type EventSmartFeedSortable = {
  smartFeedScore?: number;
  statusScore?: number;
  scheduledAt?: Date | string | null;
  createdAt?: Date | string | null;
  id?: string;
};

const toTime = (value: Date | string | null | undefined): number | null => {
  if (!value) {
    return null;
  }
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
};

export const compareEventSmartFeedDesc = (
  left: EventSmartFeedSortable,
  right: EventSmartFeedSortable,
): number => {
  const leftScore = typeof left.smartFeedScore === "number" ? left.smartFeedScore : -1;
  const rightScore = typeof right.smartFeedScore === "number" ? right.smartFeedScore : -1;
  if (leftScore !== rightScore) {
    return rightScore - leftScore;
  }

  const leftStatus = typeof left.statusScore === "number" ? left.statusScore : -1;
  const rightStatus = typeof right.statusScore === "number" ? right.statusScore : -1;
  if (leftStatus !== rightStatus) {
    return rightStatus - leftStatus;
  }

  const leftScheduled = toTime(left.scheduledAt);
  const rightScheduled = toTime(right.scheduledAt);
  if (leftScheduled !== null && rightScheduled !== null && leftScheduled !== rightScheduled) {
    return leftScheduled - rightScheduled; // sooner-scheduled first
  }
  if ((leftScheduled === null) !== (rightScheduled === null)) {
    return leftScheduled === null ? 1 : -1; // events with a schedule first
  }

  const leftCreated = toTime(left.createdAt) ?? 0;
  const rightCreated = toTime(right.createdAt) ?? 0;
  if (leftCreated !== rightCreated) {
    return rightCreated - leftCreated; // newer first
  }

  const leftId = left.id ?? "";
  const rightId = right.id ?? "";
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
};
