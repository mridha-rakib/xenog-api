import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { EventService } from "../src/modules/events/event.service.js";
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

const viewerId = new Types.ObjectId();
const user = { id: viewerId.toString(), role: "user" } as never;
const activeHost = new Types.ObjectId();
const inactiveHost = new Types.ObjectId();

const mk = (host: Types.ObjectId, name: string, over: Partial<IEvent> = {}): IEvent =>
  ({
    _id: new Types.ObjectId(),
    userId: host,
    status: "published",
    name,
    description: null,
    hashtags: ["party"],
    categories: [],
    tickets: [],
    rewards: [],
    privacy: "public",
    memberUserIds: [],
    joinRequests: [],
    scheduledAt: new Date("2026-06-01T00:00:00.000Z"),
    publishedAt: new Date("2026-05-01T00:00:00.000Z"),
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    updatedAt: new Date("2026-05-01T00:00:00.000Z"),
    location: {},
    ...over,
  }) as IEvent;

const buildService = (overrides: {
  eventRepository?: Record<string, unknown>;
  userRepository?: Record<string, unknown>;
  userBlockRepository?: Record<string, unknown>;
}) => {
  const unusedStub = new Proxy({}, { get: () => () => { throw new Error("Unexpected dependency call"); } });
  return new EventService(
    (overrides.eventRepository ?? unusedStub) as never,
    (overrides.userRepository ?? { findMany: async () => [] }) as never,
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    {} as never,
    (overrides.userBlockRepository ?? {
      findBlockedIds: async () => [],
      findBlockerIds: async () => [],
    }) as never,
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    {} as never, {} as never,
    unusedStub as never,
    {} as never,
  );
};

const activeAndInactiveHosts = async () => [
  { _id: activeHost, name: "Active Host", username: "active", isActive: true },
  { _id: inactiveHost, name: "Inactive Host", username: "inactive", isActive: false },
];

// --- /events/hashtags/:tag -------------------------------------------------

test("listHashtagEvents: blocker-direction hosts are excluded via a unioned $nin list", async () => {
  let captured: string[] = [];
  const service = buildService({
    eventRepository: {
      findPublicByHashtag: async (_h: string, excludeUserIds: string[] = []) => {
        captured = excludeUserIds;
        return [mk(activeHost, "Party A")];
      },
    },
    userRepository: { findMany: activeAndInactiveHosts },
    userBlockRepository: {
      findBlockedIds: async () => ["viewer-blocked-host"],
      findBlockerIds: async () => ["host-blocked-viewer"],
    },
  });

  await service.listHashtagEvents("party", user, {});
  assert.deepEqual([...captured].sort(), ["host-blocked-viewer", "viewer-blocked-host"].sort());
});

test("listHashtagEvents: an event whose resolved host is inactive is dropped", async () => {
  const service = buildService({
    eventRepository: {
      findPublicByHashtag: async () => [mk(activeHost, "Party A"), mk(inactiveHost, "Party B")],
    },
    userRepository: { findMany: activeAndInactiveHosts },
  });

  const results = await service.listHashtagEvents("party", user, {});
  assert.deepEqual(results.map((e) => e.name), ["Party A"]);
});

// --- /events/search ------------------------------------------------------

test("listEventSearch: blocker-direction hosts are excluded via a unioned $nin list", async () => {
  let captured: unknown;
  const service = buildService({
    eventRepository: {
      findEventSearchCandidates: async (params: Record<string, unknown>) => {
        captured = params.excludeUserIds;
        return [mk(activeHost, "Party")];
      },
    },
    userRepository: { findMany: activeAndInactiveHosts },
    userBlockRepository: {
      findBlockedIds: async () => ["viewer-blocked-host"],
      findBlockerIds: async () => ["host-blocked-viewer"],
    },
  });

  await service.listEventSearch("party", user, {});
  assert.deepEqual(
    [...(captured as string[])].sort(),
    ["host-blocked-viewer", "viewer-blocked-host"].sort(),
  );
});

test("listEventSearch: candidates whose resolved host is inactive are dropped before ranking", async () => {
  const service = buildService({
    eventRepository: {
      findEventSearchCandidates: async () => [mk(activeHost, "Party"), mk(inactiveHost, "Party Two")],
    },
    userRepository: { findMany: activeAndInactiveHosts },
  });

  const results = await service.listEventSearch("party", user, {});
  assert.deepEqual(results.map((e) => e.name), ["Party"]);
});
