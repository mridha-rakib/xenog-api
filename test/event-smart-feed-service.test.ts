import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";
process.env.ENABLE_SMART_FEED = "true";

const eventServiceModulePromise = import("../src/modules/events/event.service.js");

const NOW = new Date("2026-08-11T12:00:00.000Z");
const MS = { min: 60 * 1000, hour: 60 * 60 * 1000, day: 24 * 60 * 60 * 1000 };

const viewerId = new Types.ObjectId();
const viewer = { id: viewerId.toString(), name: "Viewer" };

const makeEvent = (overrides: Record<string, unknown> = {}) => {
  const id = (overrides._id as Types.ObjectId) ?? new Types.ObjectId();
  const scheduledAt = (overrides.scheduledAt as Date) ?? new Date(NOW.getTime() + MS.hour);
  return {
    _id: id,
    userId: (overrides.userId as Types.ObjectId) ?? new Types.ObjectId(),
    status: "published",
    privacy: "public",
    name: "Event",
    category: null,
    categories: [] as string[],
    hashtags: [] as string[],
    memberUserIds: [] as Types.ObjectId[],
    location: null,
    scheduledAt,
    endAt: new Date(scheduledAt.getTime() + 2 * MS.hour),
    publishedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
};

type Harness = {
  events: Record<string, unknown>[];
  now?: Date;
  followingIds?: string[];
  mutualFriendIds?: string[];
  geoIpLocation?: Record<string, unknown> | null;
  savedEventIds?: string[];
  historyEvents?: Record<string, unknown>[];
  capturedFeedOptions?: { value?: Record<string, unknown> };
};

const createService = async (h: Harness) => {
  const { EventService } = await eventServiceModulePromise;
  const hostIds = [...new Set(h.events.map((e) => (e.userId as Types.ObjectId).toString()))];
  const hostDocs = hostIds.map((id) => ({
    _id: new Types.ObjectId(id),
    name: `host-${id.slice(-4)}`,
    username: `h${id.slice(-4)}`,
    avatarKey: null,
  }));
  const noop = {};

  return new EventService(
    {
      findPublicFeedEvents: async (_exclude: string[], options: Record<string, unknown>) => {
        if (h.capturedFeedOptions) h.capturedFeedOptions.value = options;
        return h.events;
      },
      findPrivateFeedEventsForUser: async () => [],
      findByIds: async () => h.historyEvents ?? [],
    } as never,
    {
      findMany: async () => hostDocs,
      findById: async () => hostDocs[0] ?? null,
      findActiveUsersByIds: async () => [],
    } as never,
    {
      findFollowingIds: async () => h.followingIds ?? [],
      findMutualFriendIds: async () => h.mutualFriendIds ?? [],
    } as never,
    noop as never,
    noop as never,
    noop as never,
    { findRecentPaidTicketEventIdsByUser: async () => [] } as never,
    { getPublicEventGoingSummaries: async () => new Map() } as never,
    noop as never,
    noop as never,
    noop as never,
    { findBlockedIds: async () => [], findBlockerIds: async () => [] } as never,
    { findRecentSavedEventIds: async () => h.savedEventIds ?? [] } as never,
    noop as never,
    {
      ensureEventAnnouncement: async (p: { eventId: string }) => ({
        _id: new Types.ObjectId(),
        eventId: p.eventId,
      }),
      findEventAnnouncementsByEventIds: async () => [],
    } as never,
    {
      countByMomentIds: async () => new Map(),
      findLikedMomentIds: async () => new Set<string>(),
      findLikedUserIdsByMomentIds: async () => new Map<string, string[]>(),
    } as never,
    { countByMomentIds: async () => new Map() } as never,
    noop as never,
    { countByMomentIds: async () => new Map() } as never,
    { findSavedMomentIds: async () => new Set<string>() } as never,
    noop as never,
    noop as never,
    noop as never,
    {
      getCrowdStatusByEventId: async () => new Map(),
      getCheckedInCountsByEventId: async () => new Map(),
    } as never,
    () => new Date(h.now ?? NOW),
    noop as never,
    {
      findReportedTargetIds: async () => new Set<string>(),
      hasReported: async () => false,
    } as never,
    { lookup: async () => h.geoIpLocation ?? null } as never,
  );
};

// --- §40: ended events are excluded from the active Smart Feed --------------
test("an ended event (endAt < now) is excluded from the active Smart Feed", async () => {
  const live = makeEvent({ scheduledAt: new Date(NOW.getTime() - MS.hour) });
  const ended = makeEvent({
    scheduledAt: new Date(NOW.getTime() - 5 * MS.hour),
    endAt: new Date(NOW.getTime() - MS.hour),
  });
  const service = await createService({ events: [live, ended] });

  const results = await service.listFeedEvents(viewer as never, {});
  const ids = results.map((r) => r.id);
  assert.ok(ids.includes(live._id.toString()));
  assert.ok(!ids.includes(ended._id.toString()));
});

test("a no-endAt event older than the active window is excluded; a recent one stays", async () => {
  const staleNoEnd = makeEvent({
    scheduledAt: new Date(NOW.getTime() - 13 * MS.hour),
    endAt: null,
  });
  const recentNoEnd = makeEvent({
    scheduledAt: new Date(NOW.getTime() - MS.hour),
    endAt: null,
  });
  const service = await createService({ events: [staleNoEnd, recentNoEnd] });

  const ids = (await service.listFeedEvents(viewer as never, {})).map((r) => r.id);
  assert.ok(!ids.includes(staleNoEnd._id.toString()));
  assert.ok(ids.includes(recentNoEnd._id.toString()));
});

// --- §2 / §36D: ranking-only coords never activate the Nearby filter -------
test("rankingLatitude/Longitude do NOT activate candidate/radius/activeOnly filtering", async () => {
  const captured: { value?: Record<string, unknown> } = {};
  const service = await createService({ events: [makeEvent()], capturedFeedOptions: captured });

  await service.listFeedEvents(
    viewer as never,
    {
      rankingLatitude: 40.7,
      rankingLongitude: -73.9,
    } as never,
  );

  assert.equal(captured.value?.latitude, undefined);
  assert.equal(captured.value?.longitude, undefined);
  assert.equal(captured.value?.radiusKm, undefined);
  assert.equal(captured.value?.activeOnly, false);
});

test("explicit Nearby filter coords still flow to the candidate query unchanged", async () => {
  const captured: { value?: Record<string, unknown> } = {};
  const service = await createService({ events: [makeEvent()], capturedFeedOptions: captured });

  await service.listFeedEvents(
    viewer as never,
    {
      latitude: 40.7,
      longitude: -73.9,
      radiusKm: 10,
    } as never,
  );

  assert.equal(captured.value?.latitude, 40.7);
  assert.equal(captured.value?.longitude, -73.9);
  assert.equal(captured.value?.radiusKm, 10);
  assert.equal(captured.value?.activeOnly, true);
});

// --- §44: core acceptance (exact GPS + GeoIP fallback) --------------------
const nyc = { latitude: 40.7128, longitude: -74.006 };
const nearNyc = {
  latitude: 40.72,
  longitude: -74.0,
  venue: "Nearby Hall",
  city: "New York",
  region: "NY",
  regionCode: "NY",
  country: "United States",
  countryCode: "US",
};
const farLondon = {
  latitude: 51.5072,
  longitude: -0.1276,
  venue: "Far Hall",
  city: "London",
  region: "England",
  regionCode: "ENG",
  country: "United Kingdom",
  countryCode: "GB",
};

test("acceptance (exact GPS): live nearby medium-relevant outranks weak distant far-future", async () => {
  const a = makeEvent({
    name: "Rock Night",
    categories: ["Live Music & Concerts"],
    location: nearNyc,
    scheduledAt: new Date(NOW.getTime() - 20 * MS.min), // live now
    endAt: new Date(NOW.getTime() + MS.hour),
  });
  const b = makeEvent({
    name: "Unrelated Expo",
    categories: ["Markets & Shopping"],
    location: farLondon,
    scheduledAt: new Date(NOW.getTime() + 21 * MS.day), // weeks away
    endAt: new Date(NOW.getTime() + 21 * MS.day + MS.hour),
  });

  const service = await createService({ events: [a, b] });
  const results = await service.listFeedEvents(
    viewer as never,
    {
      rankingLatitude: nyc.latitude,
      rankingLongitude: nyc.longitude,
    } as never,
  );

  assert.equal(results[0]?.id, a._id.toString());
  assert.ok((results[0]?.smartFeedScore ?? 0) > (results[1]?.smartFeedScore ?? 0));
  assert.equal(results[0]?.smartFeed?.proximitySource, "exact");
});

test("acceptance (GeoIP fallback): same-city live outranks other-country later; source=geoip", async () => {
  const a = makeEvent({
    location: nearNyc,
    scheduledAt: new Date(NOW.getTime() - 20 * MS.min),
    endAt: new Date(NOW.getTime() + MS.hour),
  });
  const b = makeEvent({
    location: farLondon,
    scheduledAt: new Date(NOW.getTime() + 21 * MS.day),
    endAt: new Date(NOW.getTime() + 21 * MS.day + MS.hour),
  });

  const service = await createService({
    events: [a, b],
    geoIpLocation: {
      source: "ip",
      city: "New York",
      region: "NY",
      regionCode: "NY",
      country: "United States",
      countryCode: "US",
    },
  });
  const results = await service.listFeedEvents(viewer as never, {});

  assert.equal(results[0]?.id, a._id.toString());
  assert.equal(results[0]?.smartFeed?.proximitySource, "geoip");
});

test("no viewer location at all → proximitySource none, deterministic (no throw / NaN)", async () => {
  const a = makeEvent({
    location: nearNyc,
    scheduledAt: new Date(NOW.getTime() - 20 * MS.min),
    endAt: new Date(NOW.getTime() + MS.hour),
  });
  const b = makeEvent({ location: null, scheduledAt: new Date(NOW.getTime() + 5 * MS.day) });
  const service = await createService({ events: [a, b] });

  const results = await service.listFeedEvents(viewer as never, {});
  assert.equal(results.length, 2);
  for (const r of results) {
    assert.equal(r.smartFeed?.proximitySource, "none");
    assert.ok(Number.isFinite(r.smartFeedScore ?? 0));
  }
  // live event still wins on status alone
  assert.equal(results[0]?.id, a._id.toString());
});

// --- §46: rank happens BEFORE the response limit -------------------------
test("a top-ranked old-but-live nearby event survives ranking despite being outside the newest-N slice", async () => {
  const filler = Array.from({ length: 120 }, (_, i) =>
    makeEvent({
      name: `Filler ${i}`,
      location: farLondon,
      scheduledAt: new Date(NOW.getTime() + (30 + i) * MS.day), // far future, far away
      endAt: new Date(NOW.getTime() + (30 + i) * MS.day + MS.hour),
      publishedAt: new Date(NOW.getTime() - i * MS.min), // all newer than the gem
    }),
  );
  const gem = makeEvent({
    name: "Live Nearby Gem",
    categories: ["Live Music & Concerts"],
    location: nearNyc,
    scheduledAt: new Date(NOW.getTime() - 15 * MS.min), // live now
    endAt: new Date(NOW.getTime() + MS.hour),
    publishedAt: new Date(NOW.getTime() - 999 * MS.day), // oldest publish → outside newest-100
  });

  const service = await createService({ events: [...filler, gem] });
  const results = await service.listFeedEvents(
    viewer as never,
    {
      limit: 100,
      rankingLatitude: nyc.latitude,
      rankingLongitude: nyc.longitude,
    } as never,
  );

  assert.equal(results.length, 100);
  assert.equal(results[0]?.id, gem._id.toString());
});

// --- §47: deterministic tie-break -----------------------------------
test("two identical events get a stable id-based order across repeated calls", async () => {
  const idA = new Types.ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa");
  const idB = new Types.ObjectId("bbbbbbbbbbbbbbbbbbbbbbbb");
  const common = {
    scheduledAt: new Date(NOW.getTime() + MS.hour),
    endAt: new Date(NOW.getTime() + 3 * MS.hour),
  };
  const events = [makeEvent({ _id: idB, ...common }), makeEvent({ _id: idA, ...common })];
  const service = await createService({ events });

  const first = (await service.listFeedEvents(viewer as never, {})).map((r) => r.id);
  const second = (await service.listFeedEvents(viewer as never, {})).map((r) => r.id);
  assert.deepEqual(first, second);
  assert.deepEqual(first, [idA.toString(), idB.toString()]);
});

// --- §41: no behavioral history → behavioral terms are 0, feed still loads --
test("no behavioral history → title/category/venue scores are 0 and the feed still returns", async () => {
  const e = makeEvent({ name: "Something", categories: ["Arts & Culture"], location: nearNyc });
  const service = await createService({ events: [e], savedEventIds: [], historyEvents: [] });

  const [res] = await service.listFeedEvents(viewer as never, {});
  assert.equal(res?.smartFeed?.titleScore, 0);
  assert.equal(res?.smartFeed?.categoryScore, 0);
  assert.equal(res?.smartFeed?.venueScore, 0);
});
