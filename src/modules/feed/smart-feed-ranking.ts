export const SMART_FEED_WEIGHTS = {
  nearby: 0.5,
  freshness: 0.2,
  social: 0.3,
} as const;

export const SMART_FEED_LIMITS = {
  maxNearbyMiles: 200,
  freshnessHalfLifeHours: 72,
  reactionSaturationCount: 4,
  attendanceSaturationCount: 4,
  socialPreviewUserLimit: 2,
} as const;

export const SMART_FEED_REGIONAL_NEARBY_SCORES = {
  sameCity: 1,
  sameRegion: 0.65,
  sameCountry: 0.25,
  noMatch: 0,
} as const;

export type SmartFeedLocation = {
  source?: "gps" | "ip" | "none";
  latitude?: number | null;
  longitude?: number | null;
  city?: string | null;
  region?: string | null;
  regionCode?: string | null;
  country?: string | null;
  countryCode?: string | null;
};

export type SmartFeedScore = {
  nearbyScore: number;
  freshnessScore: number;
  socialScore: number;
  finalScore: number;
};

export type SmartFeedSocialUser = {
  id: string;
  name: string;
  avatarKey?: string | null;
  avatarUrl?: string | null;
};

export type SmartFeedSocialContext = {
  previewUsers: SmartFeedSocialUser[];
  totalMutualReactions: number;
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export const isValidSmartFeedCoordinate = (
  latitude: unknown,
  longitude: unknown,
): latitude is number =>
  typeof latitude === "number" &&
  typeof longitude === "number" &&
  Number.isFinite(latitude) &&
  Number.isFinite(longitude) &&
  latitude >= -90 &&
  latitude <= 90 &&
  longitude >= -180 &&
  longitude <= 180;

export const calculateNearbyScore = (
  viewerLocation: SmartFeedLocation | null,
  itemLocation: SmartFeedLocation | null | undefined,
  distanceKm: (
    first: { latitude: number; longitude: number },
    second: { latitude: number; longitude: number },
  ) => number,
): number => {
  if (
    !viewerLocation ||
    !isValidSmartFeedCoordinate(viewerLocation.latitude, viewerLocation.longitude) ||
    !isValidSmartFeedCoordinate(itemLocation?.latitude, itemLocation?.longitude)
  ) {
    return 0;
  }

  const viewerLatitude = Number(viewerLocation.latitude);
  const viewerLongitude = Number(viewerLocation.longitude);
  const itemLatitude = Number(itemLocation.latitude);
  const itemLongitude = Number(itemLocation.longitude);

  const miles = distanceKm(
    { latitude: viewerLatitude, longitude: viewerLongitude },
    { latitude: itemLatitude, longitude: itemLongitude },
  ) / 1.609344;

  if (miles > SMART_FEED_LIMITS.maxNearbyMiles) {
    return 0;
  }

  return clamp01(1 - miles / SMART_FEED_LIMITS.maxNearbyMiles);
};

const normalizeRegionalText = (value: string | null | undefined): string | null => {
  const normalized = value?.trim().toLocaleLowerCase();
  return normalized || null;
};

const normalizeRegionalCode = (value: string | null | undefined): string | null => {
  const normalized = value?.trim().toLocaleUpperCase();
  return normalized || null;
};

const sameCountry = (
  viewerLocation: SmartFeedLocation,
  itemLocation: SmartFeedLocation,
): boolean => {
  const viewerCountryCode = normalizeRegionalCode(viewerLocation.countryCode);
  const itemCountryCode = normalizeRegionalCode(itemLocation.countryCode);

  if (viewerCountryCode && itemCountryCode) {
    return viewerCountryCode === itemCountryCode;
  }

  const viewerCountry = normalizeRegionalText(viewerLocation.country);
  const itemCountry = normalizeRegionalText(itemLocation.country);

  return Boolean(viewerCountry && itemCountry && viewerCountry === itemCountry);
};

const sameRegion = (
  viewerLocation: SmartFeedLocation,
  itemLocation: SmartFeedLocation,
): boolean => {
  if (!sameCountry(viewerLocation, itemLocation)) {
    return false;
  }

  const viewerRegionCode = normalizeRegionalCode(viewerLocation.regionCode);
  const itemRegionCode = normalizeRegionalCode(itemLocation.regionCode);

  if (viewerRegionCode && itemRegionCode) {
    return viewerRegionCode === itemRegionCode;
  }

  const viewerRegion = normalizeRegionalText(viewerLocation.region);
  const itemRegion = normalizeRegionalText(itemLocation.region);

  return Boolean(viewerRegion && itemRegion && viewerRegion === itemRegion);
};

const sameCity = (
  viewerLocation: SmartFeedLocation,
  itemLocation: SmartFeedLocation,
): boolean => {
  if (!sameCountry(viewerLocation, itemLocation)) {
    return false;
  }

  const viewerCity = normalizeRegionalText(viewerLocation.city);
  const itemCity = normalizeRegionalText(itemLocation.city);

  return Boolean(viewerCity && itemCity && viewerCity === itemCity);
};

export const calculateRegionalNearbyScore = (
  viewerLocation: SmartFeedLocation | null | undefined,
  itemLocation: SmartFeedLocation | null | undefined,
): number => {
  if (!viewerLocation || !itemLocation) {
    return SMART_FEED_REGIONAL_NEARBY_SCORES.noMatch;
  }

  if (sameCity(viewerLocation, itemLocation)) {
    return SMART_FEED_REGIONAL_NEARBY_SCORES.sameCity;
  }

  if (sameRegion(viewerLocation, itemLocation)) {
    return SMART_FEED_REGIONAL_NEARBY_SCORES.sameRegion;
  }

  if (sameCountry(viewerLocation, itemLocation)) {
    return SMART_FEED_REGIONAL_NEARBY_SCORES.sameCountry;
  }

  return SMART_FEED_REGIONAL_NEARBY_SCORES.noMatch;
};

export const calculateSmartFeedNearbyScore = (signals: {
  viewerExactLocation?: SmartFeedLocation | null;
  viewerRegionalLocation?: SmartFeedLocation | null;
  itemLocation?: SmartFeedLocation | null;
  distanceKm: (
    first: { latitude: number; longitude: number },
    second: { latitude: number; longitude: number },
  ) => number;
}): number => {
  if (
    signals.viewerExactLocation &&
    signals.itemLocation?.source !== "ip" &&
    isValidSmartFeedCoordinate(signals.itemLocation?.latitude, signals.itemLocation?.longitude)
  ) {
    return calculateNearbyScore(signals.viewerExactLocation, signals.itemLocation, signals.distanceKm);
  }

  if (signals.viewerRegionalLocation) {
    return calculateRegionalNearbyScore(signals.viewerRegionalLocation, signals.itemLocation);
  }

  return 0;
};

export const calculateFreshnessScore = (createdAt?: Date | string | null, now = new Date()): number => {
  const timestamp = createdAt ? new Date(createdAt).getTime() : 0;

  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return 0;
  }

  const ageHours = Math.max(0, (now.getTime() - timestamp) / (60 * 60 * 1000));
  return clamp01(1 / (1 + ageHours / SMART_FEED_LIMITS.freshnessHalfLifeHours));
};

export const calculateSocialScore = (signals: {
  mutualAuthor?: boolean;
  mutualReactionUserCount?: number;
  mutualAttendeeUserCount?: number;
}): number => {
  const authorScore = signals.mutualAuthor ? 0.45 : 0;
  const reactionScore =
    Math.min(signals.mutualReactionUserCount ?? 0, SMART_FEED_LIMITS.reactionSaturationCount) /
    SMART_FEED_LIMITS.reactionSaturationCount *
    0.35;
  const attendanceScore =
    Math.min(signals.mutualAttendeeUserCount ?? 0, SMART_FEED_LIMITS.attendanceSaturationCount) /
    SMART_FEED_LIMITS.attendanceSaturationCount *
    0.2;

  return clamp01(authorScore + reactionScore + attendanceScore);
};

export const calculateSmartFeedScore = (signals: {
  nearbyScore: number;
  freshnessScore: number;
  socialScore: number;
}): SmartFeedScore => {
  const nearbyScore = clamp01(signals.nearbyScore);
  const freshnessScore = clamp01(signals.freshnessScore);
  const socialScore = clamp01(signals.socialScore);

  return {
    nearbyScore,
    freshnessScore,
    socialScore,
    finalScore: clamp01(
      nearbyScore * SMART_FEED_WEIGHTS.nearby +
      freshnessScore * SMART_FEED_WEIGHTS.freshness +
      socialScore * SMART_FEED_WEIGHTS.social,
    ),
  };
};

export const buildReactionSocialContext = (
  reactedUserIds: string[] | undefined,
  userById: Map<string, SmartFeedSocialUser>,
): SmartFeedSocialContext | undefined => {
  const uniqueReactedUserIds = [...new Set(reactedUserIds ?? [])];

  if (uniqueReactedUserIds.length === 0) {
    return undefined;
  }

  const previewUsers = uniqueReactedUserIds
    .map((id) => userById.get(id))
    .filter((user): user is SmartFeedSocialUser => Boolean(user))
    .slice(0, SMART_FEED_LIMITS.socialPreviewUserLimit);

  if (previewUsers.length === 0) {
    return undefined;
  }

  return {
    previewUsers,
    totalMutualReactions: uniqueReactedUserIds.length,
  };
};

export const compareSmartFeedScoreDesc = <T extends { smartFeedScore?: number; createdAt?: Date | string | null }>(
  left: T,
  right: T,
): number => {
  const leftScore = typeof left.smartFeedScore === "number" ? left.smartFeedScore : null;
  const rightScore = typeof right.smartFeedScore === "number" ? right.smartFeedScore : null;

  if (leftScore !== null && rightScore !== null && leftScore !== rightScore) {
    return rightScore - leftScore;
  }

  const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
  const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0;
  return rightTime - leftTime;
};
