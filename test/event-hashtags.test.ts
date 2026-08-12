import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { EventModel } from "../src/modules/events/event.model.js";
import { EventService } from "../src/modules/events/event.service.js";
import { eventValidation } from "../src/modules/events/event.validation.js";
import type { IEvent } from "../src/modules/events/event.interface.js";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

test.afterEach(async () => {
  const { RedisClient } = await import("../src/config/redis.js");
  await RedisClient.disconnect().catch(() => undefined);
});

const now = new Date("2026-08-10T12:00:00.000Z");
const hostId = new Types.ObjectId();
const user = { id: hostId.toString(), role: "user" } as never;

const makeExistingEvent = (overrides: Partial<IEvent> = {}): IEvent =>
  ({
    _id: new Types.ObjectId(),
    userId: hostId,
    status: "draft",
    name: "Existing Event",
    description: null,
    hashtags: [],
    categories: [],
    tickets: [],
    rewards: [],
    privacy: "public",
    memberUserIds: [],
    joinRequests: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }) as IEvent;

// EventService takes ~28 constructor-injected dependencies; only the ones a given
// test path actually touches are provided, matching the mocking style already used
// in test/admin-event-details.test.ts. Everything else is a stub that throws if hit.
const createService = (overrides: {
  eventRepository?: Record<string, unknown>;
  userRepository?: Record<string, unknown>;
  userBlockRepository?: Record<string, unknown>;
  eventWindowRepository?: Record<string, unknown>;
} = {}) => {
  const unusedStub = new Proxy(
    {},
    {
      get: () => () => {
        throw new Error("Unexpected dependency call in this test");
      },
    },
  );

  return new EventService(
    (overrides.eventRepository ?? unusedStub) as never,
    (overrides.userRepository ?? unusedStub) as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    (overrides.userBlockRepository ?? unusedStub) as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    (overrides.eventWindowRepository ?? unusedStub) as never,
    {} as never,
  );
};

test("hashtagEvents validation accepts a bare hashtag and requires lat/lng together", () => {
  const bare = eventValidation.hashtagEvents.safeParse({ params: { hashtag: "music" }, query: {} });
  assert.equal(bare.success, true);

  const withLocation = eventValidation.hashtagEvents.safeParse({
    params: { hashtag: "music" },
    query: { latitude: "40", longitude: "-73", radiusKm: "50", limit: "20" },
  });
  assert.equal(withLocation.success, true);

  const missingLongitude = eventValidation.hashtagEvents.safeParse({
    params: { hashtag: "music" },
    query: { latitude: "40" },
  });
  assert.equal(missingLongitude.success, false);
});

test("saving a new draft derives hashtags from description and merges them with manually supplied ones", async () => {
  let created: Record<string, unknown> | undefined;
  const service = createService({
    eventRepository: {
      create: async (payload: Record<string, unknown>) => {
        created = payload;
        return makeExistingEvent({ ...payload, hashtags: payload.hashtags as string[] });
      },
    },
  });

  await service.saveDraft(user, {
    description: "Join our #Music event in #Dhaka!",
    hashtags: ["concert"],
  });

  assert.deepEqual(created?.hashtags, ["concert", "music", "dhaka"]);
});

test("duplicate hashtags (case-insensitive) collapse to one entry", async () => {
  let created: Record<string, unknown> | undefined;
  const service = createService({
    eventRepository: {
      create: async (payload: Record<string, unknown>) => {
        created = payload;
        return makeExistingEvent({ ...payload, hashtags: payload.hashtags as string[] });
      },
    },
  });

  await service.saveDraft(user, {
    description: "Big #music night",
    hashtags: ["music", "Music", "MUSIC"],
  });

  assert.deepEqual(created?.hashtags, ["music"]);
});

test("updating description preserves prior manual hashtags and adds newly typed ones (spec example)", async () => {
  const existing = makeExistingEvent({ description: null, hashtags: ["concert", "night"] });
  let updatePayload: Record<string, unknown> | undefined;
  const service = createService({
    eventRepository: {
      findByIdForUser: async () => existing,
      updateDraftByIdForUser: async (_id: string, _userId: string, payload: Record<string, unknown>) => {
        updatePayload = payload;
        return { ...existing, ...payload };
      },
    },
  });

  await service.saveDraft(user, { description: "Big #music event in #dhaka" }, existing._id.toString());

  assert.deepEqual(updatePayload?.hashtags, ["concert", "night", "music", "dhaka"]);
});

test("removing a hashtag word from the description drops the stale derived tag but keeps manual ones", async () => {
  const existing = makeExistingEvent({
    description: "Come to our #music show",
    hashtags: ["music", "vip"],
  });
  let updatePayload: Record<string, unknown> | undefined;
  const service = createService({
    eventRepository: {
      findByIdForUser: async () => existing,
      updateDraftByIdForUser: async (_id: string, _userId: string, payload: Record<string, unknown>) => {
        updatePayload = payload;
        return { ...existing, ...payload };
      },
    },
  });

  await service.saveDraft(user, { description: "Come to our show" }, existing._id.toString());

  assert.deepEqual(updatePayload?.hashtags, ["vip"]);
});

test("saving a draft without touching description or hashtags leaves stored hashtags untouched", async () => {
  const existing = makeExistingEvent({ description: "text #keep", hashtags: ["keep"] });
  let updatePayload: Record<string, unknown> | undefined;
  const service = createService({
    eventRepository: {
      findByIdForUser: async () => existing,
      updateDraftByIdForUser: async (_id: string, _userId: string, payload: Record<string, unknown>) => {
        updatePayload = payload;
        return { ...existing, ...payload };
      },
    },
  });

  await service.saveDraft(user, { location: { venue: "New Venue" } }, existing._id.toString());

  assert.equal(Object.prototype.hasOwnProperty.call(updatePayload ?? {}, "hashtags"), false);
});

test("publishing a draft without resending hashtags preserves the existing merged set instead of wiping it", async () => {
  const existing = makeExistingEvent({
    status: "draft",
    description: "desc #music",
    hashtags: ["music", "vip"],
    categories: ["Live Music & Concerts"],
    scheduledAt: new Date("2026-09-01T18:00:00.000Z"),
    endAt: new Date("2026-09-01T20:00:00.000Z"),
    tickets: [],
  });
  let publishPayload: Record<string, unknown> | undefined;
  const service = createService({
    eventRepository: {
      findByIdForUser: async () => existing,
      publishDraftByIdForUser: async (_id: string, _userId: string, payload: Record<string, unknown>) => {
        publishPayload = payload;
        return { ...existing, ...payload, status: "published" };
      },
    },
    eventWindowRepository: {
      findConflictingForEventSchedule: async () => [],
    },
  });

  await service.publish(
    user,
    {
      name: "Test Event",
      description: "desc #music",
      ageRestriction: "all_ages",
      categories: ["Live Music & Concerts"],
      scheduledAt: existing.scheduledAt as Date,
      endAt: existing.endAt as Date,
      location: { venue: "Venue" },
      tickets: [],
      privacy: "public",
    } as never,
    existing._id.toString(),
  );

  assert.deepEqual([...(publishPayload?.hashtags as string[])].sort(), ["music", "vip"]);
});

test("listHashtagEvents returns nearby matches before remaining matches, ordering unaffected by publish recency", async () => {
  const nearOrigin = { latitude: 40, longitude: -73 };
  const farAway = { latitude: 10, longitude: 10 };

  const far = makeExistingEvent({
    _id: new Types.ObjectId(),
    status: "published",
    hashtags: ["music"],
    location: farAway as never,
    publishedAt: new Date("2026-08-05T00:00:00.000Z"),
    scheduledAt: new Date("2026-08-06T00:00:00.000Z"),
  });
  const nearbySoon = makeExistingEvent({
    _id: new Types.ObjectId(),
    status: "published",
    hashtags: ["music"],
    location: nearOrigin as never,
    publishedAt: new Date("2026-08-01T00:00:00.000Z"),
    scheduledAt: new Date("2026-08-02T00:00:00.000Z"),
  });
  const nearbyLater = makeExistingEvent({
    _id: new Types.ObjectId(),
    status: "published",
    hashtags: ["music"],
    location: nearOrigin as never,
    publishedAt: new Date("2026-08-03T00:00:00.000Z"),
    scheduledAt: new Date("2026-08-09T00:00:00.000Z"),
  });

  let capturedExcludeUserIds: string[] | undefined;
  const service = createService({
    eventRepository: {
      findPublicByHashtag: async (_hashtag: string, excludeUserIds: string[]) => {
        capturedExcludeUserIds = excludeUserIds;
        return [far, nearbyLater, nearbySoon];
      },
    },
    userRepository: {
      findMany: async () => [],
    },
    userBlockRepository: {
      findBlockedIds: async () => ["blocked-user-id"],
    },
  });

  const results = await service.listHashtagEvents("#Music", user, {
    latitude: 40,
    longitude: -73,
    radiusKm: 50,
  });

  assert.deepEqual(
    results.map((event) => event.id),
    [nearbySoon._id.toString(), nearbyLater._id.toString(), far._id.toString()],
  );
  assert.deepEqual(capturedExcludeUserIds, ["blocked-user-id"]);
});

test("listHashtagEvents falls back to recency ordering when no location is available", async () => {
  const older = makeExistingEvent({
    _id: new Types.ObjectId(),
    status: "published",
    hashtags: ["music"],
    publishedAt: new Date("2026-08-01T00:00:00.000Z"),
  });
  const newer = makeExistingEvent({
    _id: new Types.ObjectId(),
    status: "published",
    hashtags: ["music"],
    publishedAt: new Date("2026-08-05T00:00:00.000Z"),
  });

  const service = createService({
    eventRepository: {
      findPublicByHashtag: async () => [older, newer],
    },
    userRepository: {
      findMany: async () => [],
    },
    userBlockRepository: {
      findBlockedIds: async () => [],
    },
  });

  const results = await service.listHashtagEvents("music", user, {});

  assert.deepEqual(
    results.map((event) => event.id),
    [newer._id.toString(), older._id.toString()],
  );
});

test("hashtag event lookup queries the exact indexed hashtags field, never a description regex", async () => {
  const originalFind = EventModel.find;
  let capturedQuery: Record<string, unknown> | undefined;

  EventModel.find = ((query: Record<string, unknown>) => {
    capturedQuery = query;
    const queryResult = {
      sort: () => queryResult,
      limit: () => Promise.resolve([]),
    };
    return queryResult;
  }) as typeof EventModel.find;

  try {
    const { EventRepository } = await import("../src/modules/events/event.repository.js");
    const repository = new EventRepository();
    await repository.findPublicByHashtag("music", ["blocked-id"], 200);
  } finally {
    EventModel.find = originalFind;
  }

  assert.equal(capturedQuery?.hashtags, "music");
  assert.deepEqual(capturedQuery?.userId, { $nin: ["blocked-id"] });
  assert.equal(JSON.stringify(capturedQuery).includes("$regex"), false);
  assert.equal(JSON.stringify(capturedQuery).includes("description"), false);
});

// --- Owner-exception visibility for private events (findPublicByHashtag) ---
//
// EventRepository.findPublicByHashtag now accepts an optional requesterUserId
// so a requester can also see their own private eligible event. These tests
// capture the real filter document the repository builds (same technique as
// the test above) and evaluate it against fixture documents with a minimal,
// operator-accurate matcher, so the assertions exercise the actual production
// query shape rather than a hand-reimplemented visibility rule.

const captureHashtagFilter = async (
  hashtag: string,
  excludeUserIds: string[],
  requesterUserId?: string,
): Promise<Record<string, unknown>> => {
  const originalFind = EventModel.find;
  let capturedQuery: Record<string, unknown> | undefined;

  EventModel.find = ((query: Record<string, unknown>) => {
    capturedQuery = query;
    const queryResult = {
      sort: () => queryResult,
      limit: () => Promise.resolve([]),
    };
    return queryResult;
  }) as typeof EventModel.find;

  try {
    const { EventRepository } = await import("../src/modules/events/event.repository.js");
    const repository = new EventRepository();
    await repository.findPublicByHashtag(hashtag, excludeUserIds, 200, requesterUserId);
  } finally {
    EventModel.find = originalFind;
  }

  if (!capturedQuery) {
    throw new Error("findPublicByHashtag did not call EventModel.find");
  }

  return capturedQuery;
};

// Mirrors MongoDB's array-field matching: a condition against an array field
// (e.g. `hashtags: "music"` or `hashtags: { $in: [...] }`) matches when any
// element of the array satisfies the condition, not the array as a whole.
const matchesField = (docValue: unknown, condition: unknown): boolean => {
  if (condition && typeof condition === "object" && !Array.isArray(condition)) {
    const cond = condition as { $in?: unknown[]; $nin?: unknown[] };
    if (cond.$in) {
      return Array.isArray(docValue) ? docValue.some((v) => cond.$in!.includes(v)) : cond.$in.includes(docValue);
    }
    if (cond.$nin) {
      return Array.isArray(docValue) ? !docValue.some((v) => cond.$nin!.includes(v)) : !cond.$nin.includes(docValue);
    }
  }

  return Array.isArray(docValue) ? docValue.includes(condition) : docValue === condition;
};

const matchesFilter = (doc: Record<string, unknown>, filter: Record<string, unknown>): boolean =>
  Object.entries(filter).every(([key, condition]) => {
    if (key === "$or") {
      return (condition as Record<string, unknown>[]).some((sub) => matchesFilter(doc, sub));
    }
    return matchesField(doc[key], condition);
  });

test("owner + private + published: event matches the hashtag filter for its owner", async () => {
  const ownerId = new Types.ObjectId().toString();
  const filter = await captureHashtagFilter("music", [], ownerId);

  const ownEvent = { status: "published", privacy: "private", userId: ownerId, hashtags: ["music"] };
  assert.equal(matchesFilter(ownEvent, filter), true);
});

test("non-owner + private + published: event does not match the hashtag filter for another user", async () => {
  const ownerId = new Types.ObjectId().toString();
  const otherUserId = new Types.ObjectId().toString();
  const filter = await captureHashtagFilter("music", [], otherUserId);

  const ownersEvent = { status: "published", privacy: "private", userId: ownerId, hashtags: ["music"] };
  assert.equal(matchesFilter(ownersEvent, filter), false);
});

test("owner + private + draft: the owner exception does not bypass status eligibility", async () => {
  const ownerId = new Types.ObjectId().toString();
  const filter = await captureHashtagFilter("music", [], ownerId);

  const draftEvent = { status: "draft", privacy: "private", userId: ownerId, hashtags: ["music"] };
  assert.equal(matchesFilter(draftEvent, filter), false);
});

test("public + published: existing searchable behavior is unchanged for any requester", async () => {
  const ownerId = new Types.ObjectId().toString();
  const otherUserId = new Types.ObjectId().toString();
  const filter = await captureHashtagFilter("music", [], otherUserId);

  const publicEvent = { status: "published", privacy: "public", userId: ownerId, hashtags: ["music"] };
  assert.equal(matchesFilter(publicEvent, filter), true);
});

test("locked + published: existing searchable behavior is unchanged", async () => {
  const ownerId = new Types.ObjectId().toString();
  const otherUserId = new Types.ObjectId().toString();
  const filter = await captureHashtagFilter("music", [], otherUserId);

  const lockedEvent = { status: "published", privacy: "locked", userId: ownerId, hashtags: ["music"] };
  assert.equal(matchesFilter(lockedEvent, filter), true);
});

test("owner searching a different hashtag does not match their own private event", async () => {
  const ownerId = new Types.ObjectId().toString();
  const filter = await captureHashtagFilter("music", [], ownerId);

  const ownEventWithOtherTag = { status: "published", privacy: "private", userId: ownerId, hashtags: ["sports"] };
  assert.equal(matchesFilter(ownEventWithOtherTag, filter), false);
});

test("cancelled private event stays excluded even for its owner", async () => {
  const ownerId = new Types.ObjectId().toString();
  const filter = await captureHashtagFilter("music", [], ownerId);

  const cancelledEvent = { status: "cancelled", privacy: "private", userId: ownerId, hashtags: ["music"] };
  assert.equal(matchesFilter(cancelledEvent, filter), false);
});

test("requester sees their own private event but not another user's private event with the same hashtag", async () => {
  const ownerId = new Types.ObjectId().toString();
  const otherOwnerId = new Types.ObjectId().toString();
  const filter = await captureHashtagFilter("music", [], ownerId);

  const ownPrivateEvent = { status: "published", privacy: "private", userId: ownerId, hashtags: ["music"] };
  const othersPrivateEvent = { status: "published", privacy: "private", userId: otherOwnerId, hashtags: ["music"] };

  assert.equal(matchesFilter(ownPrivateEvent, filter), true);
  assert.equal(matchesFilter(othersPrivateEvent, filter), false);
});

test("listHashtagEvents forwards the authenticated requester's id to the repository", async () => {
  let capturedArgs: unknown[] | undefined;
  const service = createService({
    eventRepository: {
      findPublicByHashtag: async (...args: unknown[]) => {
        capturedArgs = args;
        return [];
      },
    },
    userRepository: {
      findMany: async () => [],
    },
    userBlockRepository: {
      findBlockedIds: async () => [],
    },
  });

  await service.listHashtagEvents("music", user, {});

  assert.equal(capturedArgs?.[3], user.id);
});

test("listHashtagEvents keeps the existing nearby-first ordering once the owner's private event is included", async () => {
  const nearOrigin = { latitude: 40, longitude: -73 };
  const farAway = { latitude: 10, longitude: 10 };

  const ownPrivateNearby = makeExistingEvent({
    _id: new Types.ObjectId(),
    status: "published",
    privacy: "private",
    hashtags: ["music"],
    location: nearOrigin as never,
    publishedAt: new Date("2026-08-01T00:00:00.000Z"),
    scheduledAt: new Date("2026-08-02T00:00:00.000Z"),
  });
  const otherPublicFarAway = makeExistingEvent({
    _id: new Types.ObjectId(),
    status: "published",
    hashtags: ["music"],
    location: farAway as never,
    publishedAt: new Date("2026-08-05T00:00:00.000Z"),
    scheduledAt: new Date("2026-08-06T00:00:00.000Z"),
  });

  const service = createService({
    eventRepository: {
      findPublicByHashtag: async () => [otherPublicFarAway, ownPrivateNearby],
    },
    userRepository: {
      findMany: async () => [],
    },
    userBlockRepository: {
      findBlockedIds: async () => [],
    },
  });

  const results = await service.listHashtagEvents("music", user, {
    latitude: 40,
    longitude: -73,
    radiusKm: 50,
  });

  assert.deepEqual(
    results.map((event) => event.id),
    [ownPrivateNearby._id.toString(), otherPublicFarAway._id.toString()],
  );
});
