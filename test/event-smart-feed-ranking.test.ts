import assert from "node:assert/strict";
import test from "node:test";
import {
  EVENT_GEOIP_PROXIMITY_SCORES,
  EVENT_SMART_FEED_WEIGHTS,
  EVENT_STATUS_SCORES,
  buildEventCategoryInterestProfile,
  buildEventTextInterestProfile,
  buildEventVenueInterestProfile,
  calculateEventCategoryScore,
  calculateEventExactProximityScore,
  calculateEventGeoIpProximityScore,
  calculateEventHostScore,
  calculateEventPopularityScore,
  calculateEventSmartFeedScore,
  calculateEventStatusScore,
  calculateEventTitleScore,
  calculateEventVenueScore,
  compareEventSmartFeedDesc,
  resolveEventProximity,
  tokenizeEventText,
} from "../src/modules/feed/event-smart-feed-ranking.js";
import {
  isActiveSmartFeedEvent,
  ACTIVE_EVENT_WINDOW_MS,
} from "../src/modules/events/event-temporal-status.js";

const NOW = Date.UTC(2026, 7, 11, 12, 0, 0);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// --- §5 / §37: continuous distance decay, NO 200-mile cutoff ------------------
test("event proximity uses 1/(1+km/50) with no hard geographic cutoff", () => {
  assert.equal(calculateEventExactProximityScore(0), 1);
  assert.ok(Math.abs(calculateEventExactProximityScore(10) - 0.8333) < 0.001);
  assert.ok(Math.abs(calculateEventExactProximityScore(50) - 0.5) < 1e-9);
  assert.ok(Math.abs(calculateEventExactProximityScore(100) - 0.3333) < 0.001);
  assert.ok(Math.abs(calculateEventExactProximityScore(500) - 0.0909) < 0.001);

  // 100km > 500km > 2000km, all finite and strictly positive (no 200mi zero).
  const near = calculateEventExactProximityScore(100);
  const mid = calculateEventExactProximityScore(500);
  const far = calculateEventExactProximityScore(2000);
  assert.ok(near > mid && mid > far && far > 0 && Number.isFinite(far));

  // No abrupt boundary around ~200 miles (~322 km).
  const justUnder = calculateEventExactProximityScore(321);
  const justOver = calculateEventExactProximityScore(323);
  assert.ok(justUnder > 0 && justOver > 0);
  assert.ok(Math.abs(justUnder - justOver) < 0.001);
});

test("event proximity is deterministic and safe for bad inputs", () => {
  assert.equal(calculateEventExactProximityScore(Number.NaN), 0);
  assert.equal(calculateEventExactProximityScore(-1), 0);
  assert.equal(calculateEventExactProximityScore(Number.POSITIVE_INFINITY), 0);
});

// --- §6 / §38: GeoIP admin-area fallback -------------------------------------
test("geoip proximity honours city > region > country > different-country, country-gated", () => {
  const dhakaBd = {
    city: "Dhaka",
    region: "Dhaka Division",
    regionCode: "C",
    country: "Bangladesh",
    countryCode: "BD",
  };
  assert.equal(
    calculateEventGeoIpProximityScore(dhakaBd, { ...dhakaBd }),
    EVENT_GEOIP_PROXIMITY_SCORES.sameCity,
  );
  assert.equal(
    calculateEventGeoIpProximityScore(dhakaBd, { ...dhakaBd, city: "Gazipur" }),
    EVENT_GEOIP_PROXIMITY_SCORES.sameRegion,
  );
  assert.equal(
    calculateEventGeoIpProximityScore(dhakaBd, {
      ...dhakaBd,
      city: "Chittagong",
      region: "Chattogram",
      regionCode: "B",
    }),
    EVENT_GEOIP_PROXIMITY_SCORES.sameCountry,
  );
  assert.equal(
    calculateEventGeoIpProximityScore(dhakaBd, {
      city: "Dhaka",
      country: "India",
      countryCode: "IN",
    }),
    EVENT_GEOIP_PROXIMITY_SCORES.differentCountry,
  );
  // same city NAME, different country → NOT same city
  assert.equal(
    calculateEventGeoIpProximityScore(
      { city: "London", country: "United Kingdom", countryCode: "GB" },
      { city: "London", country: "Canada", countryCode: "CA" },
    ),
    EVENT_GEOIP_PROXIMITY_SCORES.differentCountry,
  );
  // missing country info anywhere → unknown (0)
  assert.equal(
    calculateEventGeoIpProximityScore({ city: "Dhaka" }, { city: "Dhaka" }),
    EVENT_GEOIP_PROXIMITY_SCORES.unknown,
  );
  assert.equal(calculateEventGeoIpProximityScore(null, dhakaBd), 0);
});

test("ranking-only exact coords beat geoip; geoip beats nothing", () => {
  const exact = resolveEventProximity({
    exactDistanceKm: 5,
    viewerRegional: { city: "x", country: "y", countryCode: "YY" },
  });
  assert.equal(exact.proximitySource, "exact");
  assert.ok(exact.proximityScore > 0.9);

  const geoip = resolveEventProximity({
    viewerRegional: { city: "Dhaka", country: "BD", countryCode: "BD" },
    eventRegional: { city: "Dhaka", country: "BD", countryCode: "BD" },
  });
  assert.equal(geoip.proximitySource, "geoip");
  assert.equal(geoip.proximityScore, 1);

  const none = resolveEventProximity({});
  assert.equal(none.proximitySource, "none");
  assert.equal(none.proximityScore, 0);
});

// --- §7: active-window eligibility -----------------------------------------
test("isActiveSmartFeedEvent excludes ended / stale-active events only", () => {
  assert.equal(isActiveSmartFeedEvent(new Date(NOW - HOUR), new Date(NOW + HOUR), NOW), true); // live, endAt future
  assert.equal(isActiveSmartFeedEvent(new Date(NOW - 2 * HOUR), new Date(NOW - HOUR), NOW), false); // ended
  assert.equal(isActiveSmartFeedEvent(new Date(NOW + DAY), null, NOW), true); // upcoming, no endAt
  assert.equal(
    isActiveSmartFeedEvent(new Date(NOW - ACTIVE_EVENT_WINDOW_MS - MIN), null, NOW),
    false,
  ); // started long ago, no endAt → stale
  assert.equal(isActiveSmartFeedEvent(new Date(NOW - HOUR), null, NOW), true); // started recently, within window
});

// --- §8 / §39: date/status score -----------------------------------------
test("status score maps live > starting-soon > later buckets, all in [0,1]", () => {
  const at = (msUntil: number, endOffset: number | null = HOUR) =>
    calculateEventStatusScore({
      scheduledAt: new Date(NOW + msUntil),
      endAt: endOffset === null ? null : new Date(NOW + msUntil + endOffset),
      now: NOW,
    });

  assert.equal(at(-30 * MIN), EVENT_STATUS_SCORES.liveNow); // live now
  assert.equal(at(30 * MIN), EVENT_STATUS_SCORES.startingSoon); // +30m
  assert.equal(at(2 * HOUR), EVENT_STATUS_SCORES.lastCall); // +2h
  assert.equal(at(8 * HOUR), EVENT_STATUS_SCORES.within12h); // +8h
  assert.equal(at(20 * HOUR), EVENT_STATUS_SCORES.within24h); // +20h
  assert.equal(at(2 * DAY), EVENT_STATUS_SCORES.within3d); // +2d
  assert.equal(at(5 * DAY), EVENT_STATUS_SCORES.within7d); // +5d
  assert.equal(at(30 * DAY), EVENT_STATUS_SCORES.laterUpcoming); // far future

  const values = [
    at(-30 * MIN),
    at(30 * MIN),
    at(2 * HOUR),
    at(8 * HOUR),
    at(20 * HOUR),
    at(2 * DAY),
    at(5 * DAY),
    at(30 * DAY),
  ];
  for (const v of values) assert.ok(v >= 0 && v <= 1);
  for (let i = 1; i < values.length; i += 1) assert.ok(values[i - 1]! >= values[i]!); // monotonically non-increasing
});

// --- §11: title relevance (behavioral) ----------------------------------
test("title score rises with token overlap and is 0 without history", () => {
  const profile = buildEventTextInterestProfile([
    "Indie Rock Night at the Warehouse",
    "Live Rock Session",
    "Jazz Brunch",
  ]);
  const strong = calculateEventTitleScore("Rock Night Live", profile);
  const weak = calculateEventTitleScore("Pottery Workshop Morning", profile);
  assert.ok(strong > weak);
  assert.ok(strong > 0 && weak === 0);
  assert.equal(calculateEventTitleScore("Rock Night", buildEventTextInterestProfile([])), 0);
  assert.equal(calculateEventTitleScore(null, profile), 0);
});

test("tokenizer lowercases, strips punctuation/accents, drops <3 char tokens", () => {
  assert.deepEqual(tokenizeEventText("Café-Night: DJ & Co. #2"), ["cafe", "night"]);
});

// --- §12: category relevance ------------------------------------------
test("category score: explicit request match = 1; behavioral otherwise; 0 with neither", () => {
  const profile = buildEventCategoryInterestProfile([
    ["Live Music & Concerts"],
    ["Live Music & Concerts"],
    ["Nightlife & Clubs"],
  ]);
  assert.equal(
    calculateEventCategoryScore({
      candidateCategories: ["Arts & Culture"],
      explicitCategory: "Arts & Culture",
    }),
    1,
  );
  const musicScore = calculateEventCategoryScore({
    candidateCategories: ["Live Music & Concerts"],
    profile,
  });
  const clubScore = calculateEventCategoryScore({
    candidateCategories: ["Nightlife & Clubs"],
    profile,
  });
  assert.ok(musicScore > clubScore && clubScore > 0);
  assert.equal(
    calculateEventCategoryScore({ candidateCategories: ["Sports & Outdoors"], profile }),
    0,
  );
  assert.equal(calculateEventCategoryScore({ candidateCategories: ["Anything"] }), 0);
});

// --- §13 / §42: host relevance --------------------------------------
test("host score: self > mutual > followed > prior-affinity > unrelated, strongest wins", () => {
  assert.equal(calculateEventHostScore({ isSelf: true, isMutualFriend: true }), 1);
  assert.equal(calculateEventHostScore({ isMutualFriend: true, isFollowed: true }), 0.8);
  assert.equal(calculateEventHostScore({ isFollowed: true, hasPriorAffinity: true }), 0.6);
  assert.equal(calculateEventHostScore({ hasPriorAffinity: true }), 0.4);
  assert.equal(calculateEventHostScore({}), 0);
  for (const s of [
    calculateEventHostScore({ isSelf: true }),
    calculateEventHostScore({ isMutualFriend: true }),
    calculateEventHostScore({ isFollowed: true }),
    calculateEventHostScore({ hasPriorAffinity: true }),
  ]) {
    assert.ok(s >= 0 && s <= 1);
  }
});

// --- §14: venue/location behavioral relevance ----------------------
test("venue score: venue > city > region > country, 0 without context; not physical distance", () => {
  const profile = buildEventVenueInterestProfile([
    {
      venue: "Warehouse 21",
      city: "Dhaka",
      region: "Dhaka",
      regionCode: "C",
      country: "BD",
      countryCode: "BD",
    },
  ]);
  assert.equal(
    calculateEventVenueScore({ venue: "Warehouse 21", city: "Dhaka", countryCode: "BD" }, profile),
    1,
  );
  const cityOnly = calculateEventVenueScore(
    { venue: "Other Hall", city: "Dhaka", countryCode: "BD" },
    profile,
  );
  const countryOnly = calculateEventVenueScore(
    { venue: "X", city: "Sylhet", countryCode: "BD" },
    profile,
  );
  assert.ok(cityOnly > countryOnly && countryOnly > 0);
  assert.equal(calculateEventVenueScore({ city: "Paris", countryCode: "FR" }, profile), 0);
  assert.equal(calculateEventVenueScore({ city: "Dhaka" }, buildEventVenueInterestProfile([])), 0);
});

// --- §15 / §43: popularity (log-normalized, capped) -----------------
test("popularity score is log-normalized, monotonic, and bounded to [0,1]", () => {
  assert.equal(calculateEventPopularityScore({}), 0);
  const a = calculateEventPopularityScore({ going: 5, reactions: 3, comments: 1, shares: 0 });
  const b = calculateEventPopularityScore({ going: 40, reactions: 20, comments: 8, shares: 4 });
  assert.ok(b > a && a > 0);
  const huge = calculateEventPopularityScore({
    going: 10000,
    reactions: 9000,
    comments: 9000,
    shares: 9000,
  });
  assert.ok(huge <= 1 && huge > 0.9);
  // a large raw count never pushes the score above 1
  assert.ok(calculateEventPopularityScore({ going: 10000 }) <= 1);
  // going carries the largest single weight (0.5)
  assert.ok(
    calculateEventPopularityScore({ going: 100 }) >
      calculateEventPopularityScore({ reactions: 50 }),
  );
  assert.ok(Math.abs(calculateEventPopularityScore({ going: 100 }) - 0.5) < 1e-9);
});

// --- §17: final weighted score ------------------------------------
test("final event score applies the locked 8-signal weights and clamps to [0,1]", () => {
  const w = EVENT_SMART_FEED_WEIGHTS;
  assert.ok(
    Math.abs(
      w.status +
        w.proximity +
        w.title +
        w.category +
        w.host +
        w.venue +
        w.popularity +
        w.freshness -
        1,
    ) < 1e-9,
  );

  const score = calculateEventSmartFeedScore({
    statusScore: 1,
    proximityScore: 0.5,
    titleScore: 0.4,
    categoryScore: 0.2,
    hostScore: 0.6,
    venueScore: 0.3,
    popularityScore: 0.25,
    freshnessScore: 0.9,
    proximitySource: "exact",
  });
  const expected =
    1 * w.status +
    0.5 * w.proximity +
    0.4 * w.title +
    0.2 * w.category +
    0.6 * w.host +
    0.3 * w.venue +
    0.25 * w.popularity +
    0.9 * w.freshness;
  assert.ok(Math.abs(score.finalScore - expected) < 1e-9);
  assert.equal(score.proximitySource, "exact");

  const maxed = calculateEventSmartFeedScore({
    statusScore: 5,
    proximityScore: 5,
    titleScore: 5,
    categoryScore: 5,
    hostScore: 5,
    venueScore: 5,
    popularityScore: 5,
    freshnessScore: 5,
  });
  assert.equal(maxed.finalScore, 1);
});

// --- §44 (pure): live+nearby+relevant beats weak+distant+far-future -----
test("acceptance (pure): live nearby medium-relevant outranks weak distant far-future", () => {
  const a = calculateEventSmartFeedScore({
    statusScore: EVENT_STATUS_SCORES.liveNow,
    proximityScore: calculateEventExactProximityScore(2),
    titleScore: 0.3,
    categoryScore: 0.3,
    hostScore: 0.4,
    venueScore: 0.2,
    popularityScore: 0.3,
    freshnessScore: 0.8,
  }).finalScore;
  const b = calculateEventSmartFeedScore({
    statusScore: EVENT_STATUS_SCORES.laterUpcoming,
    proximityScore: calculateEventExactProximityScore(1200),
    titleScore: 0.05,
    categoryScore: 0,
    hostScore: 0,
    venueScore: 0,
    popularityScore: 0.8,
    freshnessScore: 0.9,
  }).finalScore;
  assert.ok(a > b, `expected A(${a}) > B(${b})`);
});

// --- §45 (pure): strong-relevant distant can still beat irrelevant nearby ---
test("anti-over-correction (pure): strong distant relevance beats irrelevant nearby far-future", () => {
  const strongDistant = calculateEventSmartFeedScore({
    statusScore: EVENT_STATUS_SCORES.within12h,
    proximityScore: calculateEventExactProximityScore(120),
    titleScore: 0.9,
    categoryScore: 1,
    hostScore: 0.8,
    venueScore: 0.7,
    popularityScore: 0.6,
    freshnessScore: 0.8,
  }).finalScore;
  const weakNearby = calculateEventSmartFeedScore({
    statusScore: EVENT_STATUS_SCORES.laterUpcoming,
    proximityScore: calculateEventExactProximityScore(1),
    titleScore: 0,
    categoryScore: 0,
    hostScore: 0,
    venueScore: 0,
    popularityScore: 0.1,
    freshnessScore: 0.3,
  }).finalScore;
  assert.ok(
    strongDistant > weakNearby,
    `expected strongDistant(${strongDistant}) > weakNearby(${weakNearby})`,
  );
});

// --- §25 / §47: deterministic tie-break ------------------------------
test("compareEventSmartFeedDesc breaks ties by status, schedule, createdAt, then id", () => {
  const base = {
    smartFeedScore: 0.5,
    statusScore: 0.5,
    scheduledAt: new Date(NOW),
    createdAt: new Date(NOW),
  };
  const left = { ...base, id: "aaa" };
  const right = { ...base, id: "bbb" };
  assert.ok(compareEventSmartFeedDesc(left, right) < 0);
  assert.ok(compareEventSmartFeedDesc(right, left) > 0);
  assert.equal(compareEventSmartFeedDesc(left, left), 0);

  // score wins first
  assert.ok(compareEventSmartFeedDesc({ ...left, smartFeedScore: 0.9 }, right) < 0);
  // then statusScore
  assert.ok(compareEventSmartFeedDesc({ ...left, statusScore: 0.9 }, right) < 0);
  // then sooner schedule
  assert.ok(compareEventSmartFeedDesc({ ...left, scheduledAt: new Date(NOW - HOUR) }, right) < 0);

  const arr = [right, left, { ...base, id: "ccc" }];
  const sortedTwice = [...arr]
    .sort(compareEventSmartFeedDesc)
    .map((x) => x.id)
    .join(",");
  const again = [...arr]
    .reverse()
    .sort(compareEventSmartFeedDesc)
    .map((x) => x.id)
    .join(",");
  assert.equal(sortedTwice, "aaa,bbb,ccc");
  assert.equal(sortedTwice, again);
});
