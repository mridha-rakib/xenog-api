import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { EventModel } from "../src/modules/events/event.model.js";
import { EventService } from "../src/modules/events/event.service.js";
import { MomentModel } from "../src/modules/moments/moment.model.js";
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

const hostId = new Types.ObjectId();
const user = { id: hostId.toString(), role: "user" } as never;

const makeEvent = (over: Partial<IEvent> = {}): IEvent =>
  ({
    _id: new Types.ObjectId(),
    userId: hostId,
    status: "published",
    name: "Event",
    description: null,
    hashtags: [],
    categories: [],
    tickets: [],
    rewards: [],
    privacy: "public",
    memberUserIds: [],
    joinRequests: [],
    scheduledAt: new Date("2026-10-01T00:00:00.000Z"),
    publishedAt: new Date("2026-09-01T00:00:00.000Z"),
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    location: {},
    ...over,
  }) as IEvent;

const createService = (overrides: {
  eventRepository?: Record<string, unknown>;
  userRepository?: Record<string, unknown>;
  userBlockRepository?: Record<string, unknown>;
}) =>
  new EventService(
    (overrides.eventRepository ?? {}) as never,
    (overrides.userRepository ?? { findMany: async () => [] }) as never,
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    {} as never,
    (overrides.userBlockRepository ?? {
      findBlockedIds: async () => [],
      findBlockerIds: async () => [],
    }) as never,
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    {} as never, {} as never, {} as never, {} as never,
    (() => new Date("2026-09-08T00:00:00.000Z")) as never,
    {} as never, {} as never, {} as never, {} as never,
  );

// --- Events: expand is opt-in and additive ---------------------------

test("listHashtagEvents without expand never calls the expansion repository method", async () => {
  const exact = makeEvent({ name: "Party A", hashtags: ["party"] });
  let expansionCalled = false;
  const service = createService({
    eventRepository: {
      findPublicByHashtag: async () => [exact],
      findPublicByHashtagExpansion: async () => {
        expansionCalled = true;
        return [];
      },
    },
    userRepository: { findMany: async () => [] },
  });

  const results = await service.listHashtagEvents("party", user, {});
  assert.deepEqual(results.map((e) => e.id), [exact._id.toString()]);
  assert.equal(expansionCalled, false);
});

test("listHashtagEvents with expand appends prefix/variant rows AFTER the exact-tag rows, deduped", async () => {
  const exact = makeEvent({ name: "Exact Party", hashtags: ["party"] });
  const prefix = makeEvent({ name: "Party Night", hashtags: ["partynight"] });
  const variant = makeEvent({ name: "Old Party", hashtags: ["parties"] });

  let capturedExpansionParams: Record<string, unknown> | undefined;
  const service = createService({
    eventRepository: {
      findPublicByHashtag: async () => [exact],
      findPublicByHashtagExpansion: async (params: Record<string, unknown>) => {
        capturedExpansionParams = params;
        return [prefix, variant, exact /* duplicate — must be dropped */];
      },
    },
    userRepository: { findMany: async () => [] },
  });

  const results = await service.listHashtagEvents("party", user, { expand: true });
  assert.deepEqual(results.map((e) => e.id), [
    exact._id.toString(),
    prefix._id.toString(),
    variant._id.toString(),
  ]);
  assert.equal(capturedExpansionParams?.escapedPrefix, "party");
  assert.deepEqual(capturedExpansionParams?.variantTags, ["parties"]);
  assert.equal(
    (capturedExpansionParams?.excludeEventIds as string[]).includes(exact._id.toString()),
    true,
  );
});

test("listHashtagEvents with expand: '#partys' reaches '#party' rows via the morphology variant", async () => {
  const variantRow = makeEvent({ name: "Party Time", hashtags: ["party"] });
  let capturedVariants: string[] | undefined;
  const service = createService({
    eventRepository: {
      findPublicByHashtag: async () => [], // no exact "#partys" events
      findPublicByHashtagExpansion: async (params: Record<string, unknown>) => {
        capturedVariants = params.variantTags as string[];
        return [variantRow];
      },
    },
    userRepository: { findMany: async () => [] },
  });

  const results = await service.listHashtagEvents("#partys", user, { expand: true });
  assert.deepEqual(capturedVariants, ["party"]);
  assert.deepEqual(results.map((e) => e.id), [variantRow._id.toString()]);
});

// --- Repository: escaped + anchored, $or, exclusions, no corpus scan ----

test("findPublicByHashtagExpansion builds an escaped anchored-prefix + $in query and honours exclusions", async () => {
  const originalFind = EventModel.find;
  let capturedQuery: Record<string, unknown> | undefined;
  EventModel.find = ((query: Record<string, unknown>) => {
    capturedQuery = query;
    const chain = { sort: () => chain, limit: () => Promise.resolve([]) };
    return chain;
  }) as typeof EventModel.find;

  try {
    const { EventRepository } = await import("../src/modules/events/event.repository.js");
    await new EventRepository().findPublicByHashtagExpansion({
      escapedPrefix: "par.ty",
      variantTags: ["party"],
      excludeUserIds: ["blocked"],
      excludeEventIds: ["evt1"],
      requesterUserId: hostId.toString(),
      limit: 10,
    });
  } finally {
    EventModel.find = originalFind;
  }

  const asJson = JSON.stringify(capturedQuery);
  assert.match(asJson, /\$and/);
  assert.match(asJson, /\^par\.ty/); // prefix is anchored and passed through verbatim (caller escapes)
  assert.match(asJson, /"\$in":\["party"\]/);
  assert.deepEqual(capturedQuery?.userId, { $nin: ["blocked"] });
  assert.deepEqual(capturedQuery?._id, { $nin: ["evt1"] });
});

test("findPublicByHashtagExpansion returns [] (no query) when there is nothing to expand", async () => {
  const originalFind = EventModel.find;
  let called = false;
  EventModel.find = (() => {
    called = true;
    const chain = { sort: () => chain, limit: () => Promise.resolve([]) };
    return chain;
  }) as typeof EventModel.find;

  try {
    const { EventRepository } = await import("../src/modules/events/event.repository.js");
    const rows = await new EventRepository().findPublicByHashtagExpansion({
      escapedPrefix: "",
      variantTags: [],
    });
    assert.deepEqual(rows, []);
  } finally {
    EventModel.find = originalFind;
  }
  assert.equal(called, false);
});

test("moment findPublicByHashtagExpansion escapes + anchors and excludes collected ids", async () => {
  const originalFind = MomentModel.find;
  let capturedQuery: Record<string, unknown> | undefined;
  MomentModel.find = ((query: Record<string, unknown>) => {
    capturedQuery = query;
    const chain = { sort: () => chain, limit: () => Promise.resolve([]) };
    return chain;
  }) as typeof MomentModel.find;

  try {
    const { MomentRepository } = await import("../src/modules/moments/moment.repository.js");
    await new MomentRepository().findPublicByHashtagExpansion({
      escapedPrefix: "part",
      variantTags: ["party"],
      excludeMomentIds: ["m1"],
      limit: 10,
    });
  } finally {
    MomentModel.find = originalFind;
  }

  const asJson = JSON.stringify(capturedQuery);
  assert.equal(capturedQuery?.audience, "public");
  assert.match(asJson, /\^part/);
  assert.match(asJson, /"\$in":\["party"\]/);
  assert.deepEqual(capturedQuery?._id, { $nin: ["m1"] });
});
