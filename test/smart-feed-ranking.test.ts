import assert from "node:assert/strict";
import test from "node:test";
import {
  SMART_FEED_LIMITS,
  SMART_FEED_REGIONAL_NEARBY_SCORES,
  SMART_FEED_RELATIONSHIP_TUNING,
  SMART_FEED_SOCIAL_SUBSCORES,
  calculateFreshnessScore,
  calculateNearbyScore,
  calculateRegionalNearbyScore,
  calculateSmartFeedNearbyScore,
  calculateSmartFeedScore,
  calculateSocialScore,
  compareSmartFeedScoreDesc,
} from "../src/modules/feed/smart-feed-ranking.js";

const milesToKm = (miles: number) => miles * 1.609344;

test("nearby score is normalized and stops boosting after 200 miles", () => {
  const distanceKm = (_left: { latitude: number; longitude: number }, right: { latitude: number }) =>
    milesToKm(right.latitude * 100);
  const viewer = { latitude: 0, longitude: 0 };

  for (const [miles, expected] of [
    [0, 1],
    [1, 0.995],
    [25, 0.875],
    [50, 0.75],
    [100, 0.5],
    [199, 0.005],
    [200, 0],
    [201, 0],
  ]) {
    assert.equal(
      Number(calculateNearbyScore(viewer, { latitude: miles / 100, longitude: 0 }, distanceKm).toFixed(3)),
      expected,
    );
  }
});

test("freshness score decays without becoming negative", () => {
  const now = new Date("2026-08-09T00:00:00.000Z");

  assert.equal(calculateFreshnessScore(now, now), 1);
  assert.equal(Number(calculateFreshnessScore("2026-08-06T00:00:00.000Z", now).toFixed(3)), 0.5);
  assert.ok(calculateFreshnessScore("2026-07-01T00:00:00.000Z", now) > 0);
});

test("social score is bounded and saturated", () => {
  assert.equal(calculateSocialScore({}), 0);
  assert.equal(calculateSocialScore({ mutualAuthor: true }), 0.45);
  assert.equal(calculateSocialScore({ mutualReactionUserCount: 99 }), 0.35);
  assert.equal(calculateSocialScore({ mutualAttendeeUserCount: 99 }), 0.2);
  assert.equal(calculateSocialScore({
    mutualAuthor: true,
    mutualReactionUserCount: 99,
    mutualAttendeeUserCount: 99,
  }), 1);
});

test("final score applies 50/20/30 weights", () => {
  const score = calculateSmartFeedScore({
    nearbyScore: 0.8,
    freshnessScore: 0.5,
    socialScore: 0.25,
  });

  assert.equal(score.finalScore, 0.575);
});

test("regional nearby score uses city, region, country hierarchy", () => {
  const viewer = {
    source: "ip" as const,
    city: " Dhaka ",
    region: "Dhaka Division",
    regionCode: "C",
    country: "Bangladesh",
    countryCode: "BD",
  };

  assert.equal(calculateRegionalNearbyScore(viewer, {
    city: "dhaka",
    region: "Dhaka Division",
    countryCode: "BD",
  }), SMART_FEED_REGIONAL_NEARBY_SCORES.sameCity);

  assert.equal(calculateRegionalNearbyScore(viewer, {
    city: "Savar",
    regionCode: "C",
    countryCode: "BD",
  }), SMART_FEED_REGIONAL_NEARBY_SCORES.sameRegion);

  assert.equal(calculateRegionalNearbyScore(viewer, {
    city: "Chittagong",
    region: "Chittagong",
    country: "Bangladesh",
  }), SMART_FEED_REGIONAL_NEARBY_SCORES.sameCountry);

  assert.equal(calculateRegionalNearbyScore(viewer, {
    city: "Kolkata",
    region: "West Bengal",
    countryCode: "IN",
  }), SMART_FEED_REGIONAL_NEARBY_SCORES.noMatch);
});

test("regional nearby score requires reliable country match for city or region", () => {
  assert.equal(calculateRegionalNearbyScore(
    { city: "Paris", countryCode: "FR" },
    { city: "Paris", countryCode: "US" },
  ), 0);

  assert.equal(calculateRegionalNearbyScore(
    { city: "Paris" },
    { city: "Paris" },
  ), 0);
});

test("smart nearby score uses exact distance only for non-IP candidate coordinates", () => {
  const viewer = { latitude: 0, longitude: 0 };
  const distanceKm = () => 0;

  assert.equal(calculateSmartFeedNearbyScore({
    viewerExactLocation: viewer,
    itemLocation: { source: "gps", latitude: 0, longitude: 0 },
    distanceKm,
  }), 1);

  assert.equal(calculateSmartFeedNearbyScore({
    viewerExactLocation: viewer,
    itemLocation: {
      source: "ip",
      latitude: 0,
      longitude: 0,
      city: "Dhaka",
      countryCode: "BD",
    },
    distanceKm,
  }), 0);
});

test("smart nearby score uses regional matching for IP-only viewer context", () => {
  assert.equal(calculateSmartFeedNearbyScore({
    viewerRegionalLocation: { source: "ip", city: "Dhaka", countryCode: "BD" },
    itemLocation: { source: "ip", city: "dhaka", countryCode: "BD" },
    distanceKm: () => {
      throw new Error("IP regional matching must not calculate distance");
    },
  }), SMART_FEED_REGIONAL_NEARBY_SCORES.sameCity);
});

// --- Own-content self-relevance (approved product rule #1) ---

test("fresh own content gets a very strong lift over the base 0.5/0.2/0.3 ceiling", () => {
  const noSelfBoost = calculateSmartFeedScore({ nearbyScore: 0, freshnessScore: 1, socialScore: 0 });
  const withSelfBoost = calculateSmartFeedScore({
    nearbyScore: 0,
    freshnessScore: 1,
    socialScore: 0,
    isAuthorSelf: true,
  });

  // Base formula's own ceiling for this signal mix (freshness alone) is 0.2 —
  // self relevance must push meaningfully past what nearby/social could add
  // on their own for a same-instant post with no other signals yet.
  assert.equal(noSelfBoost.finalScore, 0.2);
  assert.ok(withSelfBoost.finalScore > noSelfBoost.finalScore);
  assert.equal(
    Number(withSelfBoost.finalScore.toFixed(4)),
    Number((0.2 + 1 * SMART_FEED_RELATIONSHIP_TUNING.selfAuthorBoost).toFixed(4)),
  );
  // Beats the audit's own worked example of a strong non-self competitor
  // (3-day-old, mutual author, same-city, some reactions — ~0.7875).
  assert.ok(withSelfBoost.finalScore > 0.7875);
});

test("self relevance decays with freshness and is never a fixed/permanent boost", () => {
  const freshOwn = calculateSmartFeedScore({ nearbyScore: 0, freshnessScore: 1, socialScore: 0, isAuthorSelf: true });
  const halfLifeOwn = calculateSmartFeedScore({ nearbyScore: 0, freshnessScore: 0.5, socialScore: 0, isAuthorSelf: true });
  const oldOwn = calculateSmartFeedScore({ nearbyScore: 0, freshnessScore: 0.05, socialScore: 0, isAuthorSelf: true });
  const veryOldOwn = calculateSmartFeedScore({ nearbyScore: 0, freshnessScore: 0, socialScore: 0, isAuthorSelf: true });

  assert.ok(freshOwn.finalScore > halfLifeOwn.finalScore);
  assert.ok(halfLifeOwn.finalScore > oldOwn.finalScore);
  // At freshnessScore 0 the self boost itself is exactly 0 — old own content
  // is never permanently pinned above equivalent non-self content.
  assert.equal(veryOldOwn.finalScore, 0);
});

test("self boost does not silently apply when isAuthorSelf is omitted (backward compatible)", () => {
  const score = calculateSmartFeedScore({ nearbyScore: 0.8, freshnessScore: 0.5, socialScore: 0.25 });

  assert.equal(score.finalScore, 0.575);
});

// --- One-way follow vs. mutual friend author relationship (rule #2) ---

test("one-way followed author is a strong signal, weaker than mutual, stronger than unrelated", () => {
  const unrelated = calculateSocialScore({ authorRelationship: "none" });
  const followed = calculateSocialScore({ authorRelationship: "followed" });
  const mutual = calculateSocialScore({ authorRelationship: "mutual" });

  assert.equal(unrelated, 0);
  assert.equal(followed, SMART_FEED_SOCIAL_SUBSCORES.followedAuthor);
  assert.equal(mutual, SMART_FEED_SOCIAL_SUBSCORES.mutualAuthor);
  assert.ok(followed > unrelated);
  assert.ok(mutual > followed);
});

test("legacy mutualAuthor boolean still maps to the mutual relationship", () => {
  assert.equal(calculateSocialScore({ mutualAuthor: true }), SMART_FEED_SOCIAL_SUBSCORES.mutualAuthor);
  assert.equal(calculateSocialScore({ mutualAuthor: false }), 0);
});

// --- Followed-user reactions (weak signal, rule #4) ---

test("a followed (non-mutual) reactor is a weaker signal than a mutual-friend reactor", () => {
  const mutualOnly = calculateSocialScore({ mutualReactionUserCount: 1 });
  const followedOnly = calculateSocialScore({ followedReactionUserCount: 1 });

  assert.ok(followedOnly > 0);
  assert.ok(followedOnly < mutualOnly);
  assert.equal(
    followedOnly,
    (1 * SMART_FEED_RELATIONSHIP_TUNING.followedReactionWeight / SMART_FEED_LIMITS.reactionSaturationCount) *
      SMART_FEED_SOCIAL_SUBSCORES.reaction,
  );
});

test("mutual and followed reactors combine toward the same saturation budget without double counting", () => {
  const combined = calculateSocialScore({ mutualReactionUserCount: 4, followedReactionUserCount: 4 });
  const mutualAlone = calculateSocialScore({ mutualReactionUserCount: 4 });

  // Mutual reactors alone already saturate the reaction sub-budget — adding
  // more (even followed) reactors cannot push reactionScore past its own
  // 0.35 ceiling.
  assert.equal(mutualAlone, SMART_FEED_SOCIAL_SUBSCORES.reaction);
  assert.equal(combined, SMART_FEED_SOCIAL_SUBSCORES.reaction);
});

test("an unrelated user's reaction contributes nothing unless counted as mutual or followed", () => {
  // Simulates the caller correctly excluding a random/unrelated reactor from
  // both counts — calculateSocialScore has no third "count everyone" input.
  assert.equal(calculateSocialScore({ mutualReactionUserCount: 0, followedReactionUserCount: 0 }), 0);
});

// --- Followed/mutual repost (medium signal, rule #5) ---

test("a followed or mutual repost is a medium signal, between a single like and an author relationship", () => {
  const singleReaction = calculateSocialScore({ mutualReactionUserCount: 1 });
  const singleRepost = calculateSocialScore({ mutualRepostUserCount: 1 });
  const followedAuthor = calculateSocialScore({ authorRelationship: "followed" });

  assert.ok(singleRepost > singleReaction);
  assert.ok(singleRepost < followedAuthor);
  assert.equal(
    calculateSocialScore({ mutualRepostUserCount: SMART_FEED_LIMITS.repostSaturationCount }),
    SMART_FEED_SOCIAL_SUBSCORES.repost,
  );
});

test("repost signal saturates and stacks additively with author/reaction/attendance signals", () => {
  const maxed = calculateSocialScore({
    authorRelationship: "mutual",
    mutualReactionUserCount: 99,
    mutualAttendeeUserCount: 99,
    mutualRepostUserCount: 99,
  });

  // Every sub-budget saturated at once still clamps to 1 — matches the
  // original formula's own ceiling behavior.
  assert.equal(maxed, 1);
});

test("smart score sorting falls back to timestamp when scores are unavailable", () => {
  const scored = [
    { id: "older-high", smartFeedScore: 0.8, createdAt: "2026-08-08T00:00:00.000Z" },
    { id: "newer-low", smartFeedScore: 0.2, createdAt: "2026-08-09T00:00:00.000Z" },
  ].sort(compareSmartFeedScoreDesc);

  assert.deepEqual(scored.map((item) => item.id), ["older-high", "newer-low"]);

  const fallback = [
    { id: "older-scored", smartFeedScore: 0.8, createdAt: "2026-08-08T00:00:00.000Z" },
    { id: "newer-unscored", createdAt: "2026-08-09T00:00:00.000Z" },
  ].sort(compareSmartFeedScoreDesc);

  assert.deepEqual(fallback.map((item) => item.id), ["newer-unscored", "older-scored"]);
});
