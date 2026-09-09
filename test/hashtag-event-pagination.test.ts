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
const hostId = new Types.ObjectId();

const mk = (iso: string, idHex: string, over: Partial<IEvent> = {}): IEvent =>
  ({
    _id: new Types.ObjectId(idHex),
    userId: hostId,
    status: "published",
    name: `Event ${idHex.slice(-2)}`,
    description: null,
    hashtags: ["music"],
    categories: [],
    tickets: [],
    rewards: [],
    privacy: "public",
    memberUserIds: [],
    joinRequests: [],
    scheduledAt: new Date(iso),
    publishedAt: new Date(iso),
    createdAt: new Date(iso),
    updatedAt: new Date(iso),
    location: {},
    ...over,
  }) as IEvent;

// Newest publishedAt first is the deterministic order (no viewer location here).
const CORPUS: IEvent[] = [
  mk("2026-05-01T00:00:00.000Z", "aaaaaaaaaaaaaaaaaaaaaa05"),
  mk("2026-04-01T00:00:00.000Z", "aaaaaaaaaaaaaaaaaaaaaa04"),
  mk("2026-03-01T00:00:00.000Z", "aaaaaaaaaaaaaaaaaaaaaa03"),
  mk("2026-02-01T00:00:00.000Z", "aaaaaaaaaaaaaaaaaaaaaa02"),
  mk("2026-01-01T00:00:00.000Z", "aaaaaaaaaaaaaaaaaaaaaa01"),
];

const createService = (overrides: {
  eventRepository?: Record<string, unknown>;
  userRepository?: Record<string, unknown>;
  userBlockRepository?: Record<string, unknown>;
} = {}) => {
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

const ms = (d?: Date | null) => (d ? d.getTime() : -1);

// Honours the recency keyset contract: rows sorted publishedAt DESC, createdAt
// DESC, _id DESC, and (when `after` is supplied) starting strictly after it.
const repoFrom = (corpus: IEvent[], capture?: (ids: string[]) => void) => ({
  findPublicByHashtag: async (
    _hashtag: string,
    excludeUserIds: string[] = [],
    limit = 200,
    _requesterUserId = "",
    after?: [number, number, string],
  ) => {
    capture?.(excludeUserIds);
    let rows = [...corpus]
      .filter((e) => !excludeUserIds.includes(e.userId.toString()))
      .sort(
        (l, r) =>
          ms(r.publishedAt) - ms(l.publishedAt) ||
          ms(r.createdAt) - ms(l.createdAt) ||
          r._id.toString().localeCompare(l._id.toString()),
      );
    if (after) {
      rows = rows.filter((e) => {
        const a: [number, number, string] = [ms(e.publishedAt), ms(e.createdAt), e._id.toString()];
        if (a[0] !== after[0]) return a[0] < after[0];
        if (a[1] !== after[1]) return a[1] < after[1];
        return a[2].localeCompare(after[2]) < 0;
      });
    }
    return rows.slice(0, limit);
  },
});

test("pages the exact-tag events deterministically with a cursor, no duplicates, all reachable", async () => {
  const service = createService({ eventRepository: repoFrom(CORPUS), userRepository: { findMany: async () => [] } });

  const p1 = await service.listHashtagEventsPage("music", user, { limit: 2 });
  const p2 = await service.listHashtagEventsPage("music", user, { limit: 2, cursor: p1.nextCursor });
  const p3 = await service.listHashtagEventsPage("music", user, { limit: 2, cursor: p2.nextCursor });

  assert.deepEqual(p1.events.map((e) => e.id), ["aaaaaaaaaaaaaaaaaaaaaa05", "aaaaaaaaaaaaaaaaaaaaaa04"]);
  assert.deepEqual(p2.events.map((e) => e.id), ["aaaaaaaaaaaaaaaaaaaaaa03", "aaaaaaaaaaaaaaaaaaaaaa02"]);
  assert.deepEqual(p3.events.map((e) => e.id), ["aaaaaaaaaaaaaaaaaaaaaa01"]);
  assert.equal(p3.nextCursor, null);

  const seen = [...p1.events, ...p2.events, ...p3.events].map((e) => e.id);
  assert.equal(new Set(seen).size, 5);
});

test("a bad / hand-crafted cursor is treated as offset 0 (no throw, no skip)", async () => {
  const service = createService({ eventRepository: repoFrom(CORPUS), userRepository: { findMany: async () => [] } });
  const page = await service.listHashtagEventsPage("music", user, { limit: 2, cursor: "not-a-real-cursor" });
  assert.deepEqual(page.events.map((e) => e.id), ["aaaaaaaaaaaaaaaaaaaaaa05", "aaaaaaaaaaaaaaaaaaaaaa04"]);
});

test("both block directions are unioned into the host exclusion list", async () => {
  let captured: string[] = [];
  const service = createService({
    eventRepository: repoFrom(CORPUS, (ids) => { captured = ids; }),
    userRepository: { findMany: async () => [] },
    userBlockRepository: {
      findBlockedIds: async () => ["viewer-blocked-host"],
      findBlockerIds: async () => ["host-blocked-viewer"],
    },
  });
  await service.listHashtagEventsPage("music", user, { limit: 2 });
  assert.deepEqual([...captured].sort(), ["host-blocked-viewer", "viewer-blocked-host"].sort());
});

test("an event whose resolved host is inactive is excluded from the page", async () => {
  const service = createService({
    eventRepository: repoFrom(CORPUS),
    userRepository: {
      // Host resolves as inactive => every music event drops out.
      findMany: async () => [{ _id: hostId, name: "Host", username: "host", isActive: false }],
    },
  });
  const page = await service.listHashtagEventsPage("music", user, { limit: 3 });
  assert.deepEqual(page.events, []);
});

test("empty hashtag short-circuits to an empty page", async () => {
  const service = createService({ eventRepository: repoFrom(CORPUS) });
  const page = await service.listHashtagEventsPage("   ", user, { limit: 2 });
  assert.deepEqual(page, { events: [], nextCursor: null });
});
