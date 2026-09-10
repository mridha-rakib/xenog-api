import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { EventModel } from "../src/modules/events/event.model.js";
import { EventRepository } from "../src/modules/events/event.repository.js";

// ── Fixture builders ──────────────────────────────────────────────────────────
// Only the fields the viewport price-refine walk actually reads matter here
// (scheduledAt / publishedAt / _id for the keyset order, tickets for the
// authoritative min-available-price rule). The mock below stands in for the DB
// filter/sort so we can prove the walk itself.

type Ticket = { type: "free" | "pay"; price: number; capacity: number; availableCount: number | null };

type FixtureEvent = {
  _id: Types.ObjectId;
  scheduledAt: Date;
  publishedAt: Date;
  tickets: Ticket[];
  location: { latitude: number; longitude: number };
};

const BASE = new Date("2026-07-14T00:00:00.000Z").getTime();

const makeEvent = (index: number, tickets: Ticket[], opts: { sharedTie?: boolean } = {}): FixtureEvent => ({
  _id: new Types.ObjectId(),
  // Ascending scheduledAt so the natural fixture order == MAP_EVENT_SORT order.
  // `sharedTie` collapses scheduledAt+publishedAt for a run of events so the
  // `_id` tiebreak is exercised across a page boundary.
  scheduledAt: new Date(BASE + (opts.sharedTie ? 0 : index) * 60_000),
  publishedAt: new Date(BASE - (opts.sharedTie ? 0 : index) * 60_000),
  tickets,
  location: { latitude: 40, longitude: -73 },
});

const pay = (price: number, availableCount: number | null = 100): Ticket => ({
  type: "pay",
  price,
  capacity: 100,
  availableCount,
});
const free = (availableCount: number | null = 100): Ticket => ({
  type: "free",
  price: 0,
  capacity: 100,
  availableCount,
});

// Loose DB `gte_100` prefilter passes (has an available $200 ticket) but the
// authoritative minimum-available-price rule rejects it (min = $5).
const falsePositiveGte100 = (i: number) => makeEvent(i, [pay(5), pay(200)]);
// Authoritative `gte_100` match (only ticket is $150).
const trueGte100 = (i: number) => makeEvent(i, [pay(150)]);

// ── Keyset-aware EventModel.find mock ────────────────────────────────────────

const sortKey = (e: FixtureEvent) => ({
  s: e.scheduledAt.getTime(),
  p: e.publishedAt.getTime(),
  id: e._id.toString(),
});

const inMapSortOrder = (events: FixtureEvent[]) =>
  [...events].sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    return ka.s - kb.s || kb.p - ka.p || (ka.id < kb.id ? 1 : ka.id > kb.id ? -1 : 0);
  });

const findCursorOr = (node: unknown): Record<string, unknown>[] | null => {
  if (!node || typeof node !== "object") return null;
  const obj = node as Record<string, unknown>;
  const or = obj.$or as Record<string, unknown>[] | undefined;
  if (
    Array.isArray(or) &&
    or.some((b) => {
      const sched = b?.scheduledAt as { $gt?: unknown } | undefined;
      return sched?.$gt instanceof Date;
    })
  ) {
    return or;
  }
  const and = obj.$and as unknown[] | undefined;
  if (Array.isArray(and)) {
    for (const sub of and) {
      const r = findCursorOr(sub);
      if (r) return r;
    }
  }
  return null;
};

const applyKeyset = (events: FixtureEvent[], query: unknown): FixtureEvent[] => {
  const or = findCursorOr(query);
  if (!or) return events;
  const gt = or.find((b) => (b?.scheduledAt as { $gt?: Date } | undefined)?.$gt instanceof Date)!;
  const idBranch = or.find((b) => (b?._id as { $lt?: unknown } | undefined)?.$lt)!;
  const cS = ((gt.scheduledAt as { $gt: Date }).$gt).getTime();
  const cP = ((idBranch.publishedAt as Date)).getTime();
  const cId = String((idBranch._id as { $lt: unknown }).$lt);
  return events.filter((e) => {
    const { s, p, id } = sortKey(e);
    if (s > cS) return true;
    if (s === cS && p < cP) return true;
    if (s === cS && p === cP && id < cId) return true;
    return false;
  });
};

const withMockedFind = async <T>(
  events: FixtureEvent[],
  run: (captured: { queries: unknown[] }) => Promise<T>,
): Promise<T> => {
  const sorted = inMapSortOrder(events);
  const captured: { queries: unknown[] } = { queries: [] };
  const original = EventModel.find;

  EventModel.find = ((query: unknown) => {
    captured.queries.push(query);
    const rows = applyKeyset(sorted, query);
    const result: Record<string, unknown> = {
      sort: () => result,
      limit: (n: number) => Promise.resolve(rows.slice(0, n)),
      then: (resolve: (v: unknown[]) => unknown, reject?: (r: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
      catch: (reject: (r: unknown) => unknown) => Promise.resolve(rows).catch(reject),
    };
    return result;
  }) as typeof EventModel.find;

  try {
    return await run(captured);
  } finally {
    EventModel.find = original;
  }
};

const VIEWPORT = {
  north: 42,
  south: 38,
  west: -75,
  east: -70,
  activeSince: new Date("2026-07-01T00:00:00.000Z"),
};

const idsOf = (events: { _id: Types.ObjectId }[]) => events.map((e) => e._id.toString());

// ── Tests ───────────────────────────────────────────────────────────────────

test("§16 a genuine match after the old 101-row DB limit is still returned", async () => {
  // First 130 rows: loose gte_100 candidates that the authoritative rule rejects.
  // Rows 130..199: 70 real gte_100 matches.
  const events: FixtureEvent[] = [];
  for (let i = 0; i < 130; i += 1) events.push(falsePositiveGte100(i));
  for (let i = 130; i < 200; i += 1) events.push(trueGte100(i));
  const expected = idsOf(inMapSortOrder(events).filter((_, i) => i >= 130));

  await withMockedFind(events, async () => {
    const repo = new EventRepository();
    // The OLD implementation fetched only limit+1 (101) rows, all false
    // positives here, and returned 0 with no continuation cursor.
    const page = await repo.findMapEvents({ ...VIEWPORT, priceFilter: "gte_100", limit: 100 });

    assert.equal(page.events.length, 70);
    assert.deepEqual(idsOf(page.events), expected);
  });
});

test("§17 a full page is returned when >= pageSize authoritative matches exist", async () => {
  const events: FixtureEvent[] = [];
  for (let i = 0; i < 100; i += 1) events.push(falsePositiveGte100(i)); // loose-only
  for (let i = 100; i < 220; i += 1) events.push(trueGte100(i)); // 120 real matches
  const sorted = inMapSortOrder(events);

  await withMockedFind(events, async () => {
    const repo = new EventRepository();
    const page = await repo.findMapEvents({ ...VIEWPORT, priceFilter: "gte_100", limit: 100 });

    assert.equal(page.events.length, 100);
    assert.equal(page.hasMore, true);
    // Deterministic order: the first 100 real matches in MAP_EVENT_SORT order.
    assert.deepEqual(
      idsOf(page.events),
      idsOf(sorted.filter((e) => e.tickets.length === 1)).slice(0, 100),
    );
  });
});

test("§18 fewer-than-page-size matches: returns them all once, marks end of stream", async () => {
  const events: FixtureEvent[] = [];
  for (let i = 0; i < 100; i += 1) events.push(falsePositiveGte100(i));
  for (let i = 100; i < 163; i += 1) events.push(trueGte100(i)); // 63 real matches
  for (let i = 163; i < 200; i += 1) events.push(falsePositiveGte100(i));
  const expected = idsOf(inMapSortOrder(events).filter((e) => e.tickets.length === 1));

  await withMockedFind(events, async () => {
    const repo = new EventRepository();
    const page = await repo.findMapEvents({ ...VIEWPORT, priceFilter: "gte_100", limit: 100 });

    assert.equal(page.events.length, 63);
    assert.equal(new Set(idsOf(page.events)).size, 63); // no duplicates
    assert.equal(page.hasMore, false); // stream exhausted
    assert.deepEqual(idsOf(page.events), expected);
  });
});

test("§19 multi-page: every authoritative match reachable exactly once, stable order, no skips", async () => {
  const events: FixtureEvent[] = [];
  // Interleave false positives and true matches across > 3 pages worth.
  for (let i = 0; i < 400; i += 1) {
    events.push(i % 3 === 0 ? trueGte100(i) : falsePositiveGte100(i));
  }
  const allMatches = idsOf(inMapSortOrder(events).filter((e) => e.tickets.length === 1));
  const pageSize = 40;

  await withMockedFind(events, async () => {
    const repo = new EventRepository();
    const seen: string[] = [];
    let cursor: { scheduledAt: Date; publishedAt: Date; id: string } | undefined;

    for (let guard = 0; guard < 50; guard += 1) {
      const page = await repo.findMapEvents({
        ...VIEWPORT,
        priceFilter: "gte_100",
        limit: pageSize,
        paginationCursor: cursor,
      });
      seen.push(...idsOf(page.events));
      if (!page.hasMore || page.events.length === 0) break;
      const last = page.events[page.events.length - 1]!;
      cursor = {
        scheduledAt: last.scheduledAt,
        publishedAt: last.publishedAt,
        id: last._id.toString(),
      };
    }

    assert.deepEqual(seen, allMatches); // every match, once, in order
    assert.equal(new Set(seen).size, seen.length); // no duplicates
  });
});

test("§20 tie-boundary: shared scheduledAt+publishedAt paged via the _id tiebreak", async () => {
  // 90 events all sharing scheduledAt AND publishedAt, every one an authoritative
  // match, split across pages of 25.
  const events: FixtureEvent[] = [];
  for (let i = 0; i < 90; i += 1) events.push(makeEvent(i, [pay(150)], { sharedTie: true }));
  const ordered = idsOf(inMapSortOrder(events));

  await withMockedFind(events, async () => {
    const repo = new EventRepository();
    const seen: string[] = [];
    let cursor: { scheduledAt: Date; publishedAt: Date; id: string } | undefined;

    for (let guard = 0; guard < 20; guard += 1) {
      const page = await repo.findMapEvents({
        ...VIEWPORT,
        priceFilter: "gte_100",
        limit: 25,
        paginationCursor: cursor,
      });
      seen.push(...idsOf(page.events));
      if (!page.hasMore || page.events.length === 0) break;
      const last = page.events[page.events.length - 1]!;
      cursor = { scheduledAt: last.scheduledAt, publishedAt: last.publishedAt, id: last._id.toString() };
    }

    assert.deepEqual(seen, ordered);
    assert.equal(new Set(seen).size, 90);
  });
});

test("§15 multi-tier false positive: $5 + $200 tickets are NOT $100+", async () => {
  const events = [falsePositiveGte100(0), trueGte100(1)];

  await withMockedFind(events, async () => {
    const repo = new EventRepository();
    const page = await repo.findMapEvents({ ...VIEWPORT, priceFilter: "gte_100", limit: 100 });
    assert.deepEqual(idsOf(page.events), [events[1]!._id.toString()]);
  });
});

test("§21 every price bucket keeps its exact boundary through the viewport walk", async () => {
  const cases: { filter: "free" | "lt_10" | "lt_50" | "lt_100" | "gte_100"; tickets: Ticket[]; match: boolean }[] = [
    { filter: "free", tickets: [free()], match: true },
    { filter: "free", tickets: [free(0)], match: false }, // sold-out free ignored
    { filter: "free", tickets: [pay(5)], match: false },
    { filter: "lt_10", tickets: [pay(9.99)], match: true },
    { filter: "lt_10", tickets: [pay(10)], match: false }, // exact boundary excluded
    { filter: "lt_50", tickets: [pay(49.99)], match: true },
    { filter: "lt_50", tickets: [pay(50)], match: false },
    { filter: "lt_100", tickets: [pay(99.99)], match: true },
    { filter: "lt_100", tickets: [pay(100)], match: false },
    { filter: "gte_100", tickets: [pay(100)], match: true }, // exact boundary included
    { filter: "gte_100", tickets: [pay(99.99)], match: false },
    { filter: "lt_50", tickets: [], match: false }, // ticket-less excluded when a price filter is active
    { filter: "lt_50", tickets: [pay(20, 0)], match: false }, // only ticket sold out
    { filter: "lt_50", tickets: [pay(200), pay(20)], match: true }, // min available price wins
  ];

  for (const c of cases) {
    const target = makeEvent(1, c.tickets);
    await withMockedFind([target], async () => {
      const repo = new EventRepository();
      const page = await repo.findMapEvents({ ...VIEWPORT, priceFilter: c.filter, limit: 100 });
      assert.equal(
        page.events.length,
        c.match ? 1 : 0,
        `${c.filter} with ${JSON.stringify(c.tickets)} expected match=${c.match}`,
      );
    });
  }
});

test("§10/§22 shared filters are carried on EVERY batch query of the walk", async () => {
  const events: FixtureEvent[] = [];
  for (let i = 0; i < 200; i += 1) events.push(falsePositiveGte100(i));
  for (let i = 200; i < 260; i += 1) events.push(trueGte100(i));

  await withMockedFind(events, async (captured) => {
    const repo = new EventRepository();
    await repo.findMapEvents({
      ...VIEWPORT,
      priceFilter: "gte_100",
      ageRestriction: "21_plus",
      hashtags: ["music"],
      category: "Live Music & Concerts",
      timePeriod: "evening",
      timezoneOffsetMinutes: -300,
      limit: 100,
    });

    assert.ok(captured.queries.length >= 2, "walk should have needed more than one batch");
    for (const q of captured.queries) {
      const text = JSON.stringify(q);
      assert.match(text, /published/);
      assert.match(text, /"21_plus"/);
      assert.match(text, /"music"/);
      assert.match(text, /Live Music & Concerts/);
      assert.match(text, /location\.latitude/);
      assert.match(text, /\$expr/); // time-of-day predicate
    }
  });
});

test("nearby/radius mode is untouched: full refine before the limit, hasMore=false", async () => {
  const events = [trueGte100(0), falsePositiveGte100(1), trueGte100(2)];

  await withMockedFind(events, async (captured) => {
    const repo = new EventRepository();
    const page = await repo.findMapEvents({
      activeSince: VIEWPORT.activeSince,
      latitude: 40,
      longitude: -73,
      radiusKm: 5000,
      priceFilter: "gte_100",
      limit: 100,
    });

    assert.equal(page.hasMore, false);
    assert.equal(page.events.length, 2); // both real matches, false positive dropped
    assert.equal(captured.queries.length, 1); // single fetch, no walk
  });
});

test("private viewport stream refines price the same way", async () => {
  const events: FixtureEvent[] = [];
  for (let i = 0; i < 130; i += 1) events.push(falsePositiveGte100(i));
  for (let i = 130; i < 180; i += 1) events.push(trueGte100(i));

  await withMockedFind(events, async () => {
    const repo = new EventRepository();
    const page = await repo.findPrivateMapEventsForUser(new Types.ObjectId().toString(), {
      ...VIEWPORT,
      priceFilter: "gte_100",
      limit: 100,
    });
    assert.equal(page.events.length, 50);
  });
});
