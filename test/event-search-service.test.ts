import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
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

const hostId = new Types.ObjectId();
const user = { id: hostId.toString(), role: "user" } as never;

const makeEvent = (over: Partial<IEvent> & { name: string }): IEvent =>
  ({
    _id: new Types.ObjectId(),
    userId: hostId,
    status: "published",
    description: null,
    hashtags: [],
    categories: [],
    tickets: [],
    rewards: [],
    privacy: "public",
    memberUserIds: [],
    joinRequests: [],
    scheduledAt: new Date("2026-10-01T00:00:00.000Z"),
    endAt: new Date("2026-10-02T00:00:00.000Z"),
    publishedAt: new Date("2026-09-01T00:00:00.000Z"),
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    location: {},
    ...over,
  }) as IEvent;

const createService = (candidates: IEvent[], capture?: (params: Record<string, unknown>) => void) =>
  new EventService(
    {
      findEventSearchCandidates: async (params: Record<string, unknown>) => {
        capture?.(params);
        return candidates;
      },
    } as never,
    { findMany: async () => [] } as never,
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    {} as never,
    { findBlockedIds: async () => [], findBlockerIds: async () => [] } as never,
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    {} as never, {} as never, {} as never, {} as never,
    (() => new Date("2026-09-08T00:00:00.000Z")) as never,
    {} as never, {} as never, {} as never, {} as never,
  );

// --- validation --------------------------------------------------------

test("searchEvents validation: q required (1..80), limit 1..50", () => {
  assert.equal(eventValidation.searchEvents.safeParse({ query: { q: "party" } }).success, true);
  assert.equal(eventValidation.searchEvents.safeParse({ query: { q: "party", limit: "10" } }).success, true);
  assert.equal(eventValidation.searchEvents.safeParse({ query: { q: "" } }).success, false);
  assert.equal(eventValidation.searchEvents.safeParse({ query: { q: "x".repeat(81) } }).success, false);
  assert.equal(eventValidation.searchEvents.safeParse({ query: { q: "party", limit: "999" } }).success, false);
});

// --- empty / punctuation-only -----------------------------------------

test("query that normalizes to empty returns [] and never calls the repository", async () => {
  let called = false;
  const service = createService([], () => { called = true; });
  for (const q of ["   ", "...", "!!!", "---", "()"]) {
    assert.deepEqual(await service.listEventSearch(q, user), []);
  }
  assert.equal(called, false);
});

// --- acceptance: "partys" -----------------------------------------

test("acceptance: 'partys' ranks literal 'Partys' > morphology party events > typo > weak, unrelated absent", async () => {
  const exact = makeEvent({ name: "Partys" });
  const morphTitle = makeEvent({ name: "Party Night" });
  const morphCategory = makeEvent({ name: "Downtown Mixer", categories: ["Party"] });
  const typo = makeEvent({ name: "Partis Festival" });
  const weak = makeEvent({ name: "Bipartys Meetup" });
  const unrelated = makeEvent({ name: "Cooking Workshop" });

  const service = createService([unrelated, weak, typo, morphCategory, morphTitle, exact]);
  const results = await service.listEventSearch("partys", user, { limit: 20 });
  const ids = results.map((event) => event.id);

  assert.equal(ids[0], exact._id.toString());
  assert.ok(ids.indexOf(morphTitle._id.toString()) > 0);
  assert.ok(ids.indexOf(morphCategory._id.toString()) > 0);
  assert.ok(ids.indexOf(typo._id.toString()) > ids.indexOf(morphTitle._id.toString()));
  assert.ok(ids.indexOf(weak._id.toString()) > ids.indexOf(typo._id.toString()));
  assert.equal(ids.includes(unrelated._id.toString()), false);
});

test("relevant party Event is returned even when it is the LAST of >50 retrieved candidates (rank-before-limit)", async () => {
  const filler = Array.from({ length: 60 }, (_, i) => makeEvent({ name: `Bipartys Filler ${i}` }));
  const relevant = makeEvent({ name: "Party Night" });
  const service = createService([...filler, relevant]);

  const results = await service.listEventSearch("partys", user, { limit: 10 });
  assert.equal(results[0]!.id, relevant._id.toString());
  assert.ok(results.length <= 10);
});

// --- no flood ---------------------------------------------------------

test("no flood: exact/prefix survive a large weakly-similar candidate set; T4 capped; page limit respected", async () => {
  const exact = Array.from({ length: 3 }, () => makeEvent({ name: "Party" }));
  const fuzzy = Array.from({ length: 40 }, (_, i) => makeEvent({ name: `Partu ${i} Fest` })); // DL1 from 'party'
  const service = createService([...fuzzy, ...exact]);

  const results = await service.listEventSearch("party", user, { limit: 50 });
  assert.equal(results.length <= 3 + 10, true); // 3 exact + at most 10 typo backfill
  for (let i = 0; i < 3; i += 1) {
    assert.ok(exact.some((event) => event._id.toString() === results[i]!.id));
  }
});

test("short queries never enable fuzzy expansion (pa / par produce no typo matches)", async () => {
  const fuzzy = makeEvent({ name: "Prta Meetup" });
  const service = createService([fuzzy]);
  assert.deepEqual(await service.listEventSearch("pa", user), []);
  assert.deepEqual(await service.listEventSearch("par", user), []);
});

// --- regex literal ---------------------------------------------------

test("regex-special queries are handled literally and pass an escaped term to the repository", async () => {
  const captured: Record<string, unknown>[] = [];
  const service = createService([], (p) => captured.push(p));
  for (const q of [".*", "(", "[a-z]", "+", "party?"]) {
    await service.listEventSearch(q, user);
  }
  for (const params of captured) {
    assert.equal(typeof params.escapedQuery, "string");
    assert.equal((params.escapedQuery as string).includes("("), false);
    assert.equal((params.escapedQuery as string).includes("*") && !(params.escapedQuery as string).includes("\\*"), false);
  }
});

test("case-insensitive: party / PARTY / Party return the same ordering", async () => {
  const events = [makeEvent({ name: "Party Night" }), makeEvent({ name: "Summer Party" })];
  const service = createService(events);
  const a = (await service.listEventSearch("party", user)).map((e) => e.id);
  const b = (await service.listEventSearch("PARTY", user)).map((e) => e.id);
  const c = (await service.listEventSearch("Party", user)).map((e) => e.id);
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
});
