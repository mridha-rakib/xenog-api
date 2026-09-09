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

const oidFromIndex = (n: number): Types.ObjectId =>
  new Types.ObjectId(n.toString(16).padStart(24, "0"));

type Opts = {
  scheduledAt?: Date | null;
  publishedAt?: Date | null;
  createdAt?: Date | null;
  location?: { latitude: number; longitude: number } | null;
  userId?: Types.ObjectId;
  status?: string;
  privacy?: string;
};

const mkEvent = (index: number, o: Opts = {}): IEvent =>
  ({
    _id: oidFromIndex(index),
    userId: o.userId ?? hostId,
    status: o.status ?? "published",
    name: `Event ${index}`,
    description: null,
    hashtags: ["party"],
    categories: [],
    tickets: [],
    rewards: [],
    privacy: o.privacy ?? "public",
    memberUserIds: [],
    joinRequests: [],
    scheduledAt: o.scheduledAt === undefined ? null : o.scheduledAt,
    publishedAt: o.publishedAt === undefined ? new Date(2_000_000_000_000 - index * 60_000) : o.publishedAt,
    createdAt: o.createdAt === undefined ? new Date(2_000_000_000_000 - index * 60_000) : o.createdAt,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    location: o.location === undefined ? null : o.location,
  }) as IEvent;

const ms = (d?: Date | null) => (d ? d.getTime() : -1);

// --- in-memory repo faithfully honouring the keyset contract ----------------

type RecencyKey = [number, number, string];
type NearbyKey = [number, number, string];

const afterRecency = (e: IEvent, k: RecencyKey): boolean => {
  const a: RecencyKey = [ms(e.publishedAt), ms(e.createdAt), e._id.toString()];
  if (a[0] !== k[0]) return a[0] < k[0];
  if (a[1] !== k[1]) return a[1] < k[1];
  return a[2].localeCompare(k[2]) < 0;
};
const afterNearby = (e: IEvent, k: NearbyKey): boolean => {
  const a: NearbyKey = [ms(e.scheduledAt), ms(e.publishedAt), e._id.toString()];
  if (a[0] !== k[0]) return a[0] > k[0]; // scheduledAt ASC
  if (a[1] !== k[1]) return a[1] < k[1]; // publishedAt DESC
  return a[2].localeCompare(k[2]) < 0; // _id DESC
};
const sortRecency = (rows: IEvent[]) =>
  [...rows].sort(
    (l, r) =>
      ms(r.publishedAt) - ms(l.publishedAt) ||
      ms(r.createdAt) - ms(l.createdAt) ||
      r._id.toString().localeCompare(l._id.toString()),
  );
const sortNearby = (rows: IEvent[]) =>
  [...rows].sort(
    (l, r) =>
      ms(l.scheduledAt) - ms(r.scheduledAt) ||
      ms(r.publishedAt) - ms(l.publishedAt) ||
      r._id.toString().localeCompare(l._id.toString()),
  );

const isEligible = (e: IEvent, excludeUserIds: string[], requesterId: string): boolean => {
  if (!["published", "live"].includes(e.status)) return false;
  const pub = e.privacy === "public" || e.privacy === "locked";
  const ownPrivate = e.privacy === "private" && e.userId.toString() === requesterId;
  if (!pub && !ownPrivate) return false;
  if (excludeUserIds.includes(e.userId.toString())) return false;
  return true;
};

const makeRepo = (corpus: IEvent[]) => ({
  findPublicByHashtag: async (
    _hashtag: string,
    excludeUserIds: string[] = [],
    limit = 200,
    requesterUserId = "",
    after?: RecencyKey,
  ): Promise<IEvent[]> => {
    let rows = sortRecency(corpus.filter((e) => isEligible(e, excludeUserIds, requesterUserId)));
    if (after) rows = rows.filter((e) => afterRecency(e, after));
    return rows.slice(0, limit);
  },
  findHashtagEventsNearbyPage: async (params: {
    hashtag: string;
    excludeUserIds?: string[];
    requesterUserId?: string;
    box: { minLat: number; maxLat: number; minLng: number; maxLng: number };
    after?: NearbyKey;
    limit: number;
  }): Promise<IEvent[]> => {
    const ex = params.excludeUserIds ?? [];
    const req = params.requesterUserId ?? "";
    let rows = corpus.filter((e) => {
      if (!isEligible(e, ex, req)) return false;
      const la = e.location?.latitude;
      const lo = e.location?.longitude;
      if (typeof la !== "number" || typeof lo !== "number") return false;
      return (
        la >= params.box.minLat &&
        la <= params.box.maxLat &&
        lo >= params.box.minLng &&
        lo <= params.box.maxLng
      );
    });
    rows = sortNearby(rows);
    if (params.after) rows = rows.filter((e) => afterNearby(e, params.after!));
    return rows.slice(0, params.limit);
  },
});

const makeService = (opts: {
  corpus: IEvent[];
  hosts?: { _id: Types.ObjectId; isActive: boolean }[];
  blockedIds?: string[];
  blockerIds?: string[];
}) => {
  const unusedStub = new Proxy({}, { get: () => () => { throw new Error("Unexpected dependency call"); } });
  const hosts = opts.hosts ?? [{ _id: hostId, isActive: true }];
  const userRepository = {
    findMany: async (filter: { _id: { $in: string[] } }) => {
      const ids = new Set((filter._id.$in ?? []).map(String));
      return hosts
        .filter((h) => ids.has(h._id.toString()))
        .map((h) => ({ _id: h._id, name: "Host", username: "host", isActive: h.isActive }));
    },
  };
  return new EventService(
    makeRepo(opts.corpus) as never,
    userRepository as never,
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    {} as never,
    {
      findBlockedIds: async () => opts.blockedIds ?? [],
      findBlockerIds: async () => opts.blockerIds ?? [],
    } as never,
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    {} as never, {} as never,
    unusedStub as never,
    {} as never,
  );
};

const drainAllPages = async (
  service: EventService,
  reqOpts: { latitude?: number; longitude?: number; radiusKm?: number } = {},
  pageSize = 20,
): Promise<string[]> => {
  const ids: string[] = [];
  let cursor: string | null = null;
  let guard = 0;
  do {
    const page: { events: { id: string }[]; nextCursor: string | null } =
      await service.listHashtagEventsPage("party", user as never, {
        limit: pageSize,
        cursor,
        ...reqOpts,
      });
    ids.push(...page.events.map((e) => e.id));
    cursor = page.nextCursor;
    guard += 1;
    assert.ok(guard < 500, "pagination did not terminate");
  } while (cursor !== null);
  return ids;
};

// ==========================================================================

test("250 eligible exact-tag events are ALL reachable exactly once (page size 20)", async () => {
  const corpus = Array.from({ length: 250 }, (_, i) => mkEvent(i + 1));
  const service = makeService({ corpus });

  const ids = await drainAllPages(service);

  assert.equal(ids.length, 250, "every eligible event returned");
  assert.equal(new Set(ids).size, 250, "no duplicates");
  // deterministic recency order, no skips
  const expected = corpus.map((e) => e._id.toString());
  assert.deepEqual(ids, expected);
});

test("500 eligible exact-tag events are ALL reachable exactly once (stress)", async () => {
  const corpus = Array.from({ length: 500 }, (_, i) => mkEvent(i + 1));
  const service = makeService({ corpus });

  const ids = await drainAllPages(service);

  assert.equal(ids.length, 500);
  assert.equal(new Set(ids).size, 500);
});

test("tie boundary: 60 events sharing publishedAt AND createdAt are each returned once, stable _id order", async () => {
  const shared = new Date("2026-02-02T00:00:00.000Z");
  const corpus = Array.from({ length: 60 }, (_, i) =>
    mkEvent(i + 1, { publishedAt: shared, createdAt: shared }),
  );
  const service = makeService({ corpus });

  const ids = await drainAllPages(service);

  assert.equal(ids.length, 60);
  assert.equal(new Set(ids).size, 60);
  assert.deepEqual(ids, sortRecency(corpus).map((e) => e._id.toString()));
});

test("moderation across the 200 boundary: only eligible events count, all reachable past #200", async () => {
  const otherHost = new Types.ObjectId();
  const blockedHost = new Types.ObjectId();
  const blockerHost = new Types.ObjectId();
  const inactiveHost = new Types.ObjectId();

  // 260 events; sprinkle ineligible ones throughout, including well past index 200.
  const corpus: IEvent[] = [];
  for (let i = 1; i <= 260; i += 1) {
    if (i === 50) corpus.push(mkEvent(i, { status: "cancelled" }));
    else if (i === 120) corpus.push(mkEvent(i, { privacy: "private", userId: otherHost }));
    else if (i === 205) corpus.push(mkEvent(i, { userId: blockedHost }));
    else if (i === 225) corpus.push(mkEvent(i, { userId: blockerHost }));
    else if (i === 245) corpus.push(mkEvent(i, { userId: inactiveHost }));
    else corpus.push(mkEvent(i));
  }

  const service = makeService({
    corpus,
    hosts: [
      { _id: hostId, isActive: true },
      { _id: otherHost, isActive: true },
      { _id: blockedHost, isActive: true },
      { _id: blockerHost, isActive: true },
      { _id: inactiveHost, isActive: false },
    ],
    blockedIds: [blockedHost.toString()],
    blockerIds: [blockerHost.toString()],
  });

  const ids = await drainAllPages(service);

  const excluded = new Set(
    [50, 120, 205, 225, 245].map((i) => oidFromIndex(i).toString()),
  );
  assert.equal(ids.length, 255, "260 minus 5 ineligible");
  assert.equal(new Set(ids).size, 255, "no duplicates");
  for (const id of ids) assert.ok(!excluded.has(id), "no ineligible event surfaced");
  // events after the old 200 ceiling ARE present
  assert.ok(ids.includes(oidFromIndex(240).toString()), "event #240 reachable");
  assert.ok(ids.includes(oidFromIndex(260).toString()), "last event reachable");
});

test("nearby-first ordering preserved: nearby events (by scheduledAt) precede the recency stream, all reachable", async () => {
  // Viewer at (0,0). 40 nearby events with staggered scheduledAt, 220 far events.
  const near = (i: number) =>
    mkEvent(1000 + i, {
      location: { latitude: 0.01, longitude: 0.01 },
      scheduledAt: new Date(1_900_000_000_000 + i * 3_600_000),
    });
  const far = (i: number) =>
    mkEvent(2000 + i, { location: { latitude: 80, longitude: 80 } });

  const corpus = [
    ...Array.from({ length: 40 }, (_, i) => near(i + 1)),
    ...Array.from({ length: 220 }, (_, i) => far(i + 1)),
  ];
  const service = makeService({ corpus });

  const ids = await drainAllPages(service, { latitude: 0, longitude: 0 }, 20);

  assert.equal(ids.length, 260, "all nearby + far reachable");
  assert.equal(new Set(ids).size, 260);

  const nearIds = Array.from({ length: 40 }, (_, i) => oidFromIndex(1001 + i).toString());
  const nearInResult = ids.filter((id) => nearIds.includes(id));
  assert.equal(nearInResult.length, 40, "every nearby event reachable");
  // nearby block comes first, ordered by scheduledAt ASC
  assert.deepEqual(nearInResult, nearIds);
  const firstFarPos = ids.findIndex((id) => !nearIds.includes(id));
  assert.equal(firstFarPos, 40, "recency stream starts only after the whole nearby block");
});

test("content changing between pages: newly ineligible events drop out, later events stay reachable, no dup/crash", async () => {
  const flipHost = new Types.ObjectId();
  const corpus = Array.from({ length: 90 }, (_, i) =>
    mkEvent(i + 1, i + 1 === 70 ? { userId: flipHost } : {}),
  );
  const hosts = [
    { _id: hostId, isActive: true },
    { _id: flipHost, isActive: true },
  ];
  const service = makeService({ corpus, hosts });

  // page 1
  const p1 = await service.listHashtagEventsPage("party", user as never, { limit: 20 });
  const ids: string[] = p1.events.map((e) => e.id);

  // between pages: event #40 is cancelled, event #70's host goes inactive.
  corpus[39]!.status = "cancelled" as never;
  hosts[1]!.isActive = false;

  let cursor = p1.nextCursor;
  let guard = 0;
  while (cursor) {
    const page: { events: { id: string }[]; nextCursor: string | null } =
      await service.listHashtagEventsPage("party", user as never, { limit: 20, cursor });
    ids.push(...page.events.map((e) => e.id));
    cursor = page.nextCursor;
    guard += 1;
    assert.ok(guard < 50);
  }

  assert.equal(new Set(ids).size, ids.length, "no duplicates despite mid-stream changes");
  assert.ok(!ids.includes(oidFromIndex(40).toString()), "cancelled-between-pages event absent");
  assert.ok(!ids.includes(oidFromIndex(70).toString()), "now-inactive host's event absent");
  assert.ok(ids.includes(oidFromIndex(90).toString()), "later events still reachable");
  assert.equal(ids.length, 88, "90 minus the 2 that became ineligible");
});

test("a hand-crafted / stale cursor is ignored (starts fresh, no throw, no skip)", async () => {
  const corpus = Array.from({ length: 25 }, (_, i) => mkEvent(i + 1));
  const service = makeService({ corpus });

  const page = await service.listHashtagEventsPage("party", user as never, {
    limit: 20,
    cursor: "%%%not-base64%%%",
  });
  assert.equal(page.events.length, 20);
  assert.equal(page.events[0].id, oidFromIndex(1).toString());
});
