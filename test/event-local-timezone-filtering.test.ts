import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { EventModel } from "../src/modules/events/event.model.js";
import { EventRepository } from "../src/modules/events/event.repository.js";
import { eventLocalPartsToInstant } from "../src/modules/events/event-timezone.js";

// ───────────────────────────────────────────────────────────────────────────
// A tiny, generic Mongo query + $expr evaluator. It is NOT a re-implementation
// of the date/time logic — it just executes whatever query the repository
// actually built, the way MongoDB would, against fixture Event docs. This gives
// true behavioural (match / no-match) coverage without a live DB.
// ───────────────────────────────────────────────────────────────────────────

const zoneParts = (instant: Date, zone: string) => {
  const offsetMatch = /^([+-])(\d{2}):(\d{2})$/.exec(zone);
  if (offsetMatch) {
    const sign = offsetMatch[1] === "+" ? 1 : -1;
    const minutes = sign * (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3]));
    const shifted = new Date(instant.getTime() + minutes * 60_000);
    return {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
    };
  }
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const map: Record<string, number> = {};
  for (const part of fmt.formatToParts(instant)) {
    if (part.type !== "literal") map[part.type] = Number(part.value);
  }
  return {
    year: map.year!,
    month: map.month!,
    day: map.day!,
    hour: map.hour === 24 ? 0 : map.hour!,
    minute: map.minute!,
  };
};

const evalExpr = (node: unknown, doc: Record<string, unknown>): unknown => {
  if (typeof node === "number" || typeof node === "boolean") return node;
  if (typeof node === "string") return node.startsWith("$") ? doc[node.slice(1)] : node;
  if (node == null || typeof node !== "object") return node;

  const obj = node as Record<string, unknown>;
  const [op] = Object.keys(obj);

  const datePart = (which: "year" | "month" | "day" | "hour" | "minute") => {
    const spec = obj[op!] as { date: unknown; timezone: unknown };
    const instant = evalExpr(spec.date, doc) as Date;
    const zone = evalExpr(spec.timezone, doc) as string;
    return zoneParts(instant, zone)[which];
  };

  switch (op) {
    case "$ifNull": {
      const [a, b] = obj.$ifNull as [unknown, unknown];
      const value = evalExpr(a, doc);
      return value == null ? evalExpr(b, doc) : value;
    }
    case "$year":
      return datePart("year");
    case "$month":
      return datePart("month");
    case "$dayOfMonth":
      return datePart("day");
    case "$hour":
      return datePart("hour");
    case "$minute":
      return datePart("minute");
    case "$add":
      return (obj.$add as unknown[]).reduce<number>((sum, x) => sum + (evalExpr(x, doc) as number), 0);
    case "$multiply":
      return (obj.$multiply as unknown[]).reduce<number>((p, x) => p * (evalExpr(x, doc) as number), 1);
    case "$gte":
      return (evalExpr((obj.$gte as unknown[])[0], doc) as number) >= (evalExpr((obj.$gte as unknown[])[1], doc) as number);
    case "$lt":
      return (evalExpr((obj.$lt as unknown[])[0], doc) as number) < (evalExpr((obj.$lt as unknown[])[1], doc) as number);
    case "$eq":
      return evalExpr((obj.$eq as unknown[])[0], doc) === evalExpr((obj.$eq as unknown[])[1], doc);
    case "$and":
      return (obj.$and as unknown[]).every((c) => evalExpr(c, doc));
    case "$or":
      return (obj.$or as unknown[]).some((c) => evalExpr(c, doc));
    default:
      throw new Error(`evalExpr: unsupported operator ${op}`);
  }
};

const matchesLeaf = (value: unknown, condition: unknown): boolean => {
  if (condition != null && typeof condition === "object" && !(condition instanceof Date)) {
    const c = condition as Record<string, unknown>;
    return Object.entries(c).every(([op, operand]) => {
      const time = value instanceof Date ? value.getTime() : (value as number);
      const other = operand instanceof Date ? operand.getTime() : (operand as number);
      switch (op) {
        case "$gte":
          return value != null && time >= other;
        case "$lt":
          return value != null && time < other;
        case "$lte":
          return value != null && time <= other;
        case "$gt":
          return value != null && time > other;
        case "$in":
          return (operand as unknown[]).includes(value);
        case "$nin":
          return !(operand as unknown[]).includes(value);
        case "$ne":
          return value !== operand;
        case "$exists":
          return (value !== undefined) === operand;
        default:
          throw new Error(`matchesLeaf: unsupported operator ${op}`);
      }
    });
  }
  return value === condition;
};

const matchesQuery = (doc: Record<string, unknown>, query: unknown): boolean => {
  if (query == null || typeof query !== "object") return true;
  const q = query as Record<string, unknown>;
  return Object.entries(q).every(([key, condition]) => {
    if (key === "$and") return (condition as unknown[]).every((sub) => matchesQuery(doc, sub));
    if (key === "$or") return (condition as unknown[]).some((sub) => matchesQuery(doc, sub));
    if (key === "$expr") return Boolean(evalExpr(condition, doc));
    if (key.includes(".")) {
      const [head, tail] = key.split(".") as [string, string];
      const nested = (doc[head] as Record<string, unknown> | undefined)?.[tail];
      return matchesLeaf(nested, condition);
    }
    return matchesLeaf(doc[key], condition);
  });
};

// ── fixtures ──────────────────────────────────────────────────────────────

const NY = "America/New_York";
const LA = "America/Los_Angeles";
const DHAKA = "Asia/Dhaka";
const TOKYO = "Asia/Tokyo";
const hostId = new Types.ObjectId();

const localInstant = (
  zone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
): Date => eventLocalPartsToInstant({ year, month, day, hour, minute }, zone);

const makeEvent = (timezone: string | null, scheduledAt: Date, extra: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  userId: hostId,
  status: "published",
  privacy: "public",
  name: "TZ Filter Event",
  ageRestriction: "all_ages",
  hashtags: [],
  categories: ["Live Music & Concerts"],
  category: "Live Music & Concerts",
  timezone,
  scheduledAt,
  endAt: new Date(scheduledAt.getTime() + 2 * 60 * 60 * 1000),
  location: { latitude: 40, longitude: -73, venue: "V", address: "A", searchLabel: "V" },
  tickets: [{ id: "g", name: "G", type: "free", price: 0, capacity: 100, availableCount: 100, salesEndAt: null }],
  rewards: [],
  memberUserIds: [],
  joinRequests: [],
  publishedAt: scheduledAt,
  createdAt: scheduledAt,
  updatedAt: scheduledAt,
  ...extra,
});

/** Build the real feed query for the given filters and hand it back for evaluation. */
const captureFeedQuery = async (filters: {
  date?: string;
  timePeriod?: string;
  timezoneOffsetMinutes?: number;
}): Promise<Record<string, unknown>> => {
  const repository = new EventRepository();
  const originalFind = EventModel.find;
  let captured: Record<string, unknown> = {};
  EventModel.find = ((query: unknown) => {
    captured = query as Record<string, unknown>;
    const result = {
      sort: () => result,
      then: (resolve: (v: unknown[]) => unknown, reject?: (r: unknown) => unknown) =>
        Promise.resolve([]).then(resolve, reject),
      catch: (reject: (r: unknown) => unknown) => Promise.resolve([]).catch(reject),
    };
    return result;
  }) as typeof EventModel.find;
  try {
    await repository.findPublicFeedEvents([], filters as never);
    return captured;
  } finally {
    EventModel.find = originalFind;
  }
};

const evaluate = async (
  filters: { date?: string; timePeriod?: string; timezoneOffsetMinutes?: number },
  event: ReturnType<typeof makeEvent>,
): Promise<boolean> => {
  const query = await captureFeedQuery(filters);
  return matchesQuery(event as unknown as Record<string, unknown>, query);
};

const REQ_DHAKA = -360; // getTimezoneOffset() for UTC+6
const REQ_UTC = 0;
const REQ_LA = 480; // getTimezoneOffset() for UTC-8

// ── §8–§11 time-period boundaries, evaluated in the EVENT timezone ─────────

test("§8 morning = [05:00, 12:00) in the Event's own timezone", async () => {
  const f = { timePeriod: "morning", timezoneOffsetMinutes: REQ_DHAKA };
  assert.equal(await evaluate(f, makeEvent(NY, localInstant(NY, 2026, 9, 20, 4, 59))), false);
  assert.equal(await evaluate(f, makeEvent(NY, localInstant(NY, 2026, 9, 20, 5, 0))), true);
  assert.equal(await evaluate(f, makeEvent(NY, localInstant(NY, 2026, 9, 20, 11, 59))), true);
  assert.equal(await evaluate(f, makeEvent(NY, localInstant(NY, 2026, 9, 20, 12, 0))), false);
});

test("§9 noon = [12:00, 17:00)", async () => {
  const f = { timePeriod: "noon", timezoneOffsetMinutes: REQ_DHAKA };
  assert.equal(await evaluate(f, makeEvent(NY, localInstant(NY, 2026, 9, 20, 11, 59))), false);
  assert.equal(await evaluate(f, makeEvent(NY, localInstant(NY, 2026, 9, 20, 12, 0))), true);
  assert.equal(await evaluate(f, makeEvent(NY, localInstant(NY, 2026, 9, 20, 16, 59))), true);
  assert.equal(await evaluate(f, makeEvent(NY, localInstant(NY, 2026, 9, 20, 17, 0))), false);
});

test("§10 evening = [17:00, 21:00)", async () => {
  const f = { timePeriod: "evening", timezoneOffsetMinutes: REQ_DHAKA };
  assert.equal(await evaluate(f, makeEvent(NY, localInstant(NY, 2026, 9, 20, 16, 59))), false);
  assert.equal(await evaluate(f, makeEvent(NY, localInstant(NY, 2026, 9, 20, 17, 0))), true);
  assert.equal(await evaluate(f, makeEvent(NY, localInstant(NY, 2026, 9, 20, 20, 59))), true);
  assert.equal(await evaluate(f, makeEvent(NY, localInstant(NY, 2026, 9, 20, 21, 0))), false);
});

test("§11 late_night wraps midnight: >=21:00 OR <05:00", async () => {
  const f = { timePeriod: "late_night", timezoneOffsetMinutes: REQ_DHAKA };
  assert.equal(await evaluate(f, makeEvent(NY, localInstant(NY, 2026, 9, 20, 20, 59))), false);
  assert.equal(await evaluate(f, makeEvent(NY, localInstant(NY, 2026, 9, 20, 21, 0))), true);
  assert.equal(await evaluate(f, makeEvent(NY, localInstant(NY, 2026, 9, 20, 23, 59))), true);
  assert.equal(await evaluate(f, makeEvent(NY, localInstant(NY, 2026, 9, 20, 0, 0))), true);
  assert.equal(await evaluate(f, makeEvent(NY, localInstant(NY, 2026, 9, 20, 4, 59))), true);
  assert.equal(await evaluate(f, makeEvent(NY, localInstant(NY, 2026, 9, 20, 5, 0))), false);
});

// ── §18 DST: summer & winter 19:00 NY both classify as evening ───────────

test("§18 DST-independent: NY 19:00 in July and in January are both evening", async () => {
  const f = { timePeriod: "evening", timezoneOffsetMinutes: REQ_DHAKA };
  const summer = makeEvent(NY, localInstant(NY, 2026, 7, 15, 19, 0));
  const winter = makeEvent(NY, localInstant(NY, 2026, 1, 15, 19, 0));
  assert.notEqual(summer.scheduledAt.getUTCHours(), winter.scheduledAt.getUTCHours()); // different UTC instants
  assert.equal(await evaluate(f, summer), true);
  assert.equal(await evaluate(f, winter), true);
});

// ── §19 viewer timezone independence for a known-timezone Event ──────────

test("§19 a known-timezone Event's classification does not vary with the requester offset", async () => {
  const nyEvening = makeEvent(NY, localInstant(NY, 2026, 9, 20, 19, 0));
  for (const req of [REQ_DHAKA, REQ_UTC, REQ_LA]) {
    assert.equal(await evaluate({ timePeriod: "evening", timezoneOffsetMinutes: req }, nyEvening), true);
    assert.equal(
      await evaluate({ date: "2026-09-20", timePeriod: "evening", timezoneOffsetMinutes: req }, nyEvening),
      true,
    );
    assert.equal(
      await evaluate({ date: "2026-09-21", timePeriod: "morning", timezoneOffsetMinutes: req }, nyEvening),
      false,
    );
  }
});

// ── §20 cross-date remote Event ────────────────────────────────────────

test("§20 NY Sep 20 19:00 matches (Sep 20, evening), never (Sep 21, morning)", async () => {
  const event = makeEvent(NY, localInstant(NY, 2026, 9, 20, 19, 0));
  // The equivalent UTC instant is on Sep 21 for a UTC+6 viewer — irrelevant now.
  assert.equal(event.scheduledAt.toISOString(), "2026-09-20T23:00:00.000Z");
  assert.equal(await evaluate({ date: "2026-09-20", timePeriod: "evening", timezoneOffsetMinutes: REQ_DHAKA }, event), true);
  assert.equal(await evaluate({ date: "2026-09-21", timePeriod: "morning", timezoneOffsetMinutes: REQ_DHAKA }, event), false);
  assert.equal(await evaluate({ date: "2026-09-20", timezoneOffsetMinutes: REQ_DHAKA }, event), true);
  assert.equal(await evaluate({ date: "2026-09-21", timezoneOffsetMinutes: REQ_DHAKA }, event), false);
});

// ── §21 / §22 Dhaka & Los Angeles Events ──────────────────────────────

test("§21 Asia/Dhaka Event local Sep 20 19:00 → Sep 20 + evening, any requester", async () => {
  const event = makeEvent(DHAKA, localInstant(DHAKA, 2026, 9, 20, 19, 0));
  for (const req of [REQ_DHAKA, REQ_UTC, REQ_LA]) {
    assert.equal(await evaluate({ date: "2026-09-20", timePeriod: "evening", timezoneOffsetMinutes: req }, event), true);
  }
});

test("§22 America/Los_Angeles Event local Sep 20 19:00 → Sep 20 + evening, any requester", async () => {
  const event = makeEvent(LA, localInstant(LA, 2026, 9, 20, 19, 0));
  for (const req of [REQ_DHAKA, REQ_UTC, REQ_LA]) {
    assert.equal(await evaluate({ date: "2026-09-20", timePeriod: "evening", timezoneOffsetMinutes: req }, event), true);
  }
});

// ── §13 late_night + selectedDate: calendar date stays authoritative ────

test("§13 late_night + date pins the local calendar date; it does not roll onto the next day", async () => {
  const f = { date: "2026-09-20", timePeriod: "late_night", timezoneOffsetMinutes: REQ_DHAKA };
  assert.equal(await evaluate(f, makeEvent(NY, localInstant(NY, 2026, 9, 20, 23, 30))), true); // Sep 20 23:30 NY
  assert.equal(await evaluate(f, makeEvent(NY, localInstant(NY, 2026, 9, 20, 2, 0))), true); // Sep 20 02:00 NY (<05:00)
  assert.equal(await evaluate(f, makeEvent(NY, localInstant(NY, 2026, 9, 21, 2, 0))), false); // Sep 21 02:00 NY — wrong date
  assert.equal(await evaluate(f, makeEvent(NY, localInstant(NY, 2026, 9, 20, 12, 0))), false); // Sep 20 noon — not late night
});

// ── §14 time-period without a date, mixed timezones ───────────────────

test("§14 evening (no date): NY 19:00 and Dhaka 19:00 both match despite different UTC instants", async () => {
  const ny = makeEvent(NY, localInstant(NY, 2026, 9, 20, 19, 0));
  const dhaka = makeEvent(DHAKA, localInstant(DHAKA, 2026, 9, 20, 19, 0));
  assert.notEqual(ny.scheduledAt.getTime(), dhaka.scheduledAt.getTime());
  assert.equal(await evaluate({ timePeriod: "evening", timezoneOffsetMinutes: REQ_UTC }, ny), true);
  assert.equal(await evaluate({ timePeriod: "evening", timezoneOffsetMinutes: REQ_UTC }, dhaka), true);
});

// ── §15 / §16 / §50 mixed null + known timezone in one query ─────────

test("§50 same query classifies a known-timezone Event by its zone and a null one by the requester fallback", async () => {
  const instant = localInstant(NY, 2026, 9, 20, 19, 0); // 2026-09-20T23:00:00Z
  const known = makeEvent(NY, instant); // NY → Sep 20 19:00 → evening
  const legacy = makeEvent(null, instant); // +06:00 → Sep 21 05:00 → not evening, not Sep 20
  const f = { date: "2026-09-20", timePeriod: "evening", timezoneOffsetMinutes: REQ_DHAKA };
  assert.equal(await evaluate(f, known), true);
  assert.equal(await evaluate(f, legacy), false);
  // And the legacy Event IS correctly classified for the requester-local day it falls on.
  assert.equal(
    await evaluate({ date: "2026-09-21", timePeriod: "morning", timezoneOffsetMinutes: REQ_DHAKA }, legacy),
    true,
  );
});

test("§15 a null-timezone Event is never excluded merely for lacking a timezone", async () => {
  const legacyEvening = makeEvent(null, localInstant("+06:00", 2026, 9, 20, 19, 0));
  assert.equal(
    await evaluate({ date: "2026-09-20", timePeriod: "evening", timezoneOffsetMinutes: REQ_DHAKA }, legacyEvening),
    true,
  );
});

// ── §23 same UTC instant, different timezone fields → different buckets ──

test("§23 two Events at the SAME instant classify per their own timezone", async () => {
  const instant = new Date("2026-09-20T23:00:00.000Z");
  const nyEvent = makeEvent(NY, instant); // NY: Sep 20 19:00
  const tokyoEvent = makeEvent(TOKYO, instant); // Tokyo: Sep 21 08:00
  const req = REQ_UTC;
  assert.equal(await evaluate({ date: "2026-09-20", timePeriod: "evening", timezoneOffsetMinutes: req }, nyEvent), true);
  assert.equal(await evaluate({ date: "2026-09-20", timePeriod: "evening", timezoneOffsetMinutes: req }, tokyoEvent), false);
  assert.equal(await evaluate({ date: "2026-09-21", timePeriod: "morning", timezoneOffsetMinutes: req }, nyEvent), false);
  assert.equal(await evaluate({ date: "2026-09-21", timePeriod: "morning", timezoneOffsetMinutes: req }, tokyoEvent), true);
});

// ── §49 loose UTC prefilter never excludes an extreme-offset Event ──────

test("§49 the loose UTC prefilter admits far +14 and far −11 timezone Events on the selected local date", async () => {
  const kiritimati = makeEvent("Pacific/Kiritimati", localInstant("Pacific/Kiritimati", 2026, 9, 20, 1, 0)); // +14 → instant Sep 19
  const pago = makeEvent("Pacific/Pago_Pago", localInstant("Pacific/Pago_Pago", 2026, 9, 20, 23, 0)); // −11 → instant Sep 21
  const f = { date: "2026-09-20", timezoneOffsetMinutes: REQ_UTC };
  // Both instants must survive the [selectedDay−1, selectedDay+2) UTC envelope
  // AND satisfy the exact per-document local-date $expr.
  assert.ok(kiritimati.scheduledAt < new Date("2026-09-20T00:00:00.000Z"));
  assert.ok(pago.scheduledAt > new Date("2026-09-21T00:00:00.000Z"));
  assert.equal(await evaluate(f, kiritimati), true);
  assert.equal(await evaluate(f, pago), true);
});

// ── §51 no special "backfilled" branch ────────────────────────────────

test("§51 an Event with timezone set behaves identically regardless of how it got there", async () => {
  const created = makeEvent(NY, localInstant(NY, 2026, 9, 20, 19, 0));
  const backfilled = makeEvent(NY, localInstant(NY, 2026, 9, 20, 19, 0)); // same shape — there is no marker
  const f = { date: "2026-09-20", timePeriod: "evening", timezoneOffsetMinutes: REQ_LA };
  assert.equal(await evaluate(f, created), true);
  assert.equal(await evaluate(f, backfilled), true);
});

// ── §24 / §29 / §30 predicates are in the base query, before any limit ──

test("§24 selectedDate + timePeriod predicates live in the base Mongo query (no post-limit refine)", async () => {
  const query = await captureFeedQuery({ date: "2026-09-20", timePeriod: "evening", timezoneOffsetMinutes: REQ_DHAKA });
  const text = JSON.stringify(query);
  assert.match(text, /"\$expr"/);
  assert.match(text, /"\$ifNull":\["\$timezone","\+06:00"\]/);
  assert.match(text, /"\$year":\{"date":"\$scheduledAt"/);
  assert.match(text, /"\$hour":\{"date":"\$scheduledAt"/);
  // loose prefilter present as its own scheduledAt range
  assert.match(text, /2026-09-19T00:00:00\.000Z/);
  assert.match(text, /2026-09-22T00:00:00\.000Z/);
});

test("§30 the repository does NOT re-filter by date/time in JS after the fetch", async () => {
  // Mock returns an Event that does NOT match the date filter; the repo must
  // still return it (it trusts Mongo for the temporal predicate — no JS refine).
  const repository = new EventRepository();
  const originalFind = EventModel.find;
  const wrongDate = makeEvent(NY, localInstant(NY, 2026, 12, 25, 9, 0));
  EventModel.find = ((_q: unknown) => {
    const result = {
      sort: () => result,
      then: (resolve: (v: unknown[]) => unknown) => Promise.resolve([wrongDate]).then(resolve),
      catch: () => undefined,
    };
    return result;
  }) as typeof EventModel.find;
  try {
    const events = await repository.findPublicFeedEvents([], {
      date: "2026-09-20",
      timePeriod: "evening",
      timezoneOffsetMinutes: REQ_DHAKA,
    } as never);
    assert.equal(events.length, 1, "no application-side temporal refinement");
  } finally {
    EventModel.find = originalFind;
  }
});
