import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { EventModel } from "../src/modules/events/event.model.js";
import { EventRepository } from "../src/modules/events/event.repository.js";
import { eventValidation } from "../src/modules/events/event.validation.js";

const now = new Date("2026-07-14T12:00:00.000Z");
const hostId = new Types.ObjectId();

const makeEvent = (overrides: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  userId: hostId,
  status: "published",
  name: "Filtered Event",
  ageRestriction: "all_ages",
  hashtags: ["music"],
  categories: ["Music"],
  category: "Music",
  scheduledAt: new Date("2026-07-14T13:00:00.000Z"),
  endAt: new Date("2026-07-14T15:00:00.000Z"),
  location: {
    latitude: 40,
    longitude: -73,
    venue: "Venue",
    address: "Address",
    searchLabel: "Venue",
  },
  tickets: [{
    id: "general",
    name: "General",
    type: "pay",
    price: 9.99,
    capacity: 100,
    availableCount: 100,
    salesEndAt: null,
  }],
  rewards: [],
  privacy: "public",
  memberUserIds: [],
  joinRequests: [],
  publishedAt: now,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const withMockedEventFind = async <T>(events: unknown[], run: (captured: { query?: unknown }) => Promise<T>): Promise<T> => {
  const captured: { query?: unknown } = {};
  const originalFind = EventModel.find;

  EventModel.find = ((query: unknown) => {
    captured.query = query;
    const queryResult = {
      sort: () => queryResult,
      limit: (limit: number) => Promise.resolve(events.slice(0, limit)),
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => Promise.resolve(events).then(resolve, reject),
      catch: (reject: (reason: unknown) => unknown) => Promise.resolve(events).catch(reject),
    };

    return queryResult;
  }) as typeof EventModel.find;

  try {
    return await run(captured);
  } finally {
    EventModel.find = originalFind;
  }
};

test("map validation remains compatible with geo-only requests and accepts new filters", () => {
  const geoOnly = eventValidation.mapEvents.safeParse({
    query: { latitude: "40", longitude: "-73", radiusKm: "50", limit: "100" },
  });
  assert.equal(geoOnly.success, true);

  const filtered = eventValidation.mapEvents.safeParse({
    query: {
      category: "Food & Drinks",
      latitude: "40",
      longitude: "-73",
      radiusKm: "50",
      ageRestriction: "18_plus",
      priceFilter: "lt_50",
      date: "2026-07-14",
      timePeriod: "evening",
      timezoneOffsetMinutes: "-360",
      hashtags: "#Music, summer, music",
    },
  });

  assert.equal(filtered.success, true);
  if (filtered.success) {
    assert.equal(filtered.data.query.category, "Food & Drinks");
    assert.deepEqual(filtered.data.query.hashtags, ["music", "summer"]);
    assert.equal(filtered.data.query.timezoneOffsetMinutes, -360);
  }

  const invalidCategory = eventValidation.mapEvents.safeParse({
    query: { category: "Drinks", latitude: "40", longitude: "-73" },
  });
  assert.equal(invalidCategory.success, false);

  const viewport = eventValidation.mapEvents.safeParse({
    query: { north: "45", south: "40", west: "170", east: "-170", limit: "100" },
  });
  assert.equal(viewport.success, true);

  const partialViewport = eventValidation.mapEvents.safeParse({
    query: { north: "45", south: "40", west: "170" },
  });
  assert.equal(partialViewport.success, false);

  const invertedLatitude = eventValidation.mapEvents.safeParse({
    query: { north: "39", south: "40", west: "-75", east: "-70" },
  });
  assert.equal(invertedLatitude.success, false);
});

test("date and late-night filters build an inclusive-start exclusive-end UTC range", async () => {
  const repository = new EventRepository();

  await withMockedEventFind([], async (captured) => {
    await repository.findMapEvents({
      activeSince: new Date("2026-07-01T00:00:00.000Z"),
      date: "2026-07-14",
      timePeriod: "late_night",
      timezoneOffsetMinutes: -360,
      limit: 100,
    });

    const queryText = JSON.stringify(captured.query);
    assert.match(queryText, /2026-07-14T15:00:00.000Z/);
    assert.match(queryText, /2026-07-14T23:00:00.000Z/);
  });
});

test("map filtering applies exact radius after bounding-box candidate query", async () => {
  const repository = new EventRepository();
  const inside = makeEvent({
    location: { latitude: 40, longitude: -73.01 },
  });
  const outside = makeEvent({
    location: { latitude: 40, longitude: -73.5 },
  });

  await withMockedEventFind([inside, outside], async () => {
    const events = await repository.findMapEvents({
      activeSince: new Date("2026-07-01T00:00:00.000Z"),
      latitude: 40,
      longitude: -73,
      radiusKm: 2,
      limit: 100,
    });

    assert.deepEqual(events.map((event) => event._id.toString()), [inside._id.toString()]);
  });
});

test("price filters use available ticket prices and strict boundaries", async () => {
  const repository = new EventRepository();
  const belowTen = makeEvent({
    tickets: [{ id: "below", name: "Below", type: "pay", price: 9.99, capacity: 10, availableCount: 10 }],
  });
  const exactlyTen = makeEvent({
    tickets: [{ id: "ten", name: "Ten", type: "pay", price: 10, capacity: 10, availableCount: 10 }],
  });
  const soldOutFree = makeEvent({
    tickets: [{ id: "free", name: "Free", type: "free", price: 0, capacity: 10, availableCount: 0 }],
  });

  await withMockedEventFind([belowTen, exactlyTen, soldOutFree], async () => {
    const events = await repository.findPublicFeedEvents([], { priceFilter: "lt_10" });

    assert.deepEqual(events.map((event) => event._id.toString()), [belowTen._id.toString()]);
  });
});

test("combined filters are added on top of existing visibility query", async () => {
  const repository = new EventRepository();

  await withMockedEventFind([], async (captured) => {
    await repository.findMapEvents({
      activeSince: new Date("2026-07-01T00:00:00.000Z"),
      category: "Food & Drinks",
      ageRestriction: "21_plus",
      priceFilter: "free",
      hashtags: ["music", "summer"],
      limit: 100,
    });

    const queryText = JSON.stringify(captured.query);
    assert.match(queryText, /published/);
    assert.match(queryText, /live/);
    assert.match(queryText, /public/);
    assert.match(queryText, /locked/);
    assert.match(queryText, /Food & Drinks/);
    assert.match(queryText, /categories/);
    assert.match(queryText, /21_plus/);
    assert.match(queryText, /music/);
    assert.match(queryText, /summer/);
    assert.match(queryText, /tickets/);
  });
});

test("map viewport bounds are added when nearby coordinates are absent", async () => {
  const repository = new EventRepository();

  await withMockedEventFind([], async (captured) => {
    await repository.findMapEvents({
      activeSince: new Date("2026-07-01T00:00:00.000Z"),
      north: 42,
      south: 39,
      west: -75,
      east: -70,
      limit: 100,
    });

    const queryText = JSON.stringify(captured.query);
    assert.match(queryText, /location.latitude/);
    assert.match(queryText, /42/);
    assert.match(queryText, /39/);
    assert.match(queryText, /-75/);
    assert.match(queryText, /-70/);
  });
});

test("map viewport bounds support antimeridian crossing", async () => {
  const repository = new EventRepository();

  await withMockedEventFind([], async (captured) => {
    await repository.findMapEvents({
      activeSince: new Date("2026-07-01T00:00:00.000Z"),
      north: 15,
      south: -15,
      west: 170,
      east: -170,
      limit: 100,
    });

    const queryText = JSON.stringify(captured.query);
    assert.match(queryText, /170/);
    assert.match(queryText, /180/);
    assert.match(queryText, /-180/);
    assert.match(queryText, /-170/);
  });
});

test("explicit nearby coordinates take precedence over viewport bounds", async () => {
  const repository = new EventRepository();

  await withMockedEventFind([], async (captured) => {
    await repository.findMapEvents({
      activeSince: new Date("2026-07-01T00:00:00.000Z"),
      latitude: 40,
      longitude: -73,
      radiusKm: 2,
      north: 50,
      south: 20,
      west: 100,
      east: 120,
      limit: 100,
    });

    const queryText = JSON.stringify(captured.query);
    assert.match(queryText, /-73/);
    assert.doesNotMatch(queryText, /100/);
    assert.doesNotMatch(queryText, /120/);
  });
});

test("map category filtering matches categories array or legacy category without bypassing private access", async () => {
  const repository = new EventRepository();
  const userId = new Types.ObjectId().toString();

  await withMockedEventFind([], async (captured) => {
    await repository.findPrivateMapEventsForUser(userId, {
      activeSince: new Date("2026-07-01T00:00:00.000Z"),
      category: "Food Trucks",
      limit: 100,
    });

    const queryText = JSON.stringify(captured.query);
    assert.match(queryText, /private/);
    assert.match(queryText, new RegExp(userId));
    assert.match(queryText, /memberUserIds/);
    assert.match(queryText, /Food Trucks/);
    assert.match(queryText, /categories/);
    assert.match(queryText, /category/);
    assert.match(queryText, /published/);
    assert.match(queryText, /live/);
  });
});
