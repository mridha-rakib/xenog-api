import assert from "node:assert/strict";
import test from "node:test";
import {
  SMART_FEED_REGIONAL_NEARBY_SCORES,
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
