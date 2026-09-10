import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

import {
  parseBackfillOptions,
  classifyLegacyEventTimezoneCandidate,
  buildTimezoneBackfillWrite,
  runEventTimezoneBackfill,
  formatBackfillReport,
  BACKFILL_DEFAULT_BATCH_SIZE,
  BACKFILL_DEFAULT_SAMPLE_LIMIT,
} from "../src/scripts/backfill-event-timezones.js";

const asyncFrom = <T>(items: T[]): AsyncIterable<T> => ({
  async *[Symbol.asyncIterator]() {
    for (const item of items) {
      yield item;
    }
  },
});

const NY = { latitude: 40.7128, longitude: -74.006 };
const LA = { latitude: 34.0522, longitude: -118.2437 };
const DHAKA = { latitude: 23.8103, longitude: 90.4125 };
const LONDON = { latitude: 51.5074, longitude: -0.1278 };

const DRY_RUN = { apply: false, limit: null, batchSize: 50, sampleLimit: 10 };
const APPLY = { apply: true, limit: null, batchSize: 50, sampleLimit: 10 };

// ── §35 option parsing ────────────────────────────────────────────────────

test("§35 default invocation is DRY RUN", () => {
  const parsed = parseBackfillOptions([]);
  assert.ok(parsed.ok);
  assert.equal(parsed.options.apply, false);
  assert.equal(parsed.options.limit, null);
  assert.equal(parsed.options.batchSize, BACKFILL_DEFAULT_BATCH_SIZE);
  assert.equal(parsed.options.sampleLimit, BACKFILL_DEFAULT_SAMPLE_LIMIT);
});

test("§35 --apply enables writes; --dry-run forces read-only", () => {
  assert.equal(parseBackfillOptions(["--apply"]).ok && parseBackfillOptions(["--apply"]).options.apply, true);
  const both = parseBackfillOptions(["--apply", "--dry-run"]);
  assert.ok(both.ok);
  assert.equal(both.options.apply, false);
});

test("§35 --limit accepts a positive integer and rejects zero / negative / garbage", () => {
  const ok = parseBackfillOptions(["--limit=100"]);
  assert.ok(ok.ok);
  assert.equal(ok.options.limit, 100);
  for (const bad of ["--limit=0", "--limit=-5", "--limit=abc", "--limit=1.5", "--limit="]) {
    assert.equal(parseBackfillOptions([bad]).ok, false, bad);
  }
});

test("§35 --batch-size validated; --sample allows zero; unknown flags rejected", () => {
  assert.equal((parseBackfillOptions(["--batch-size=500"]) as { ok: true; options: { batchSize: number } }).options.batchSize, 500);
  assert.equal(parseBackfillOptions(["--batch-size=0"]).ok, false);
  assert.equal((parseBackfillOptions(["--sample=0"]) as { ok: true; options: { sampleLimit: number } }).options.sampleLimit, 0);
  assert.equal(parseBackfillOptions(["--sample=-1"]).ok, false);
  assert.equal(parseBackfillOptions(["--wat"]).ok, false);
});

// ── §23 / §24 classification uses the authoritative resolver ──────────────

test("§23 legacy Event (timezone null) + NYC coords → resolve America/New_York", () => {
  const result = classifyLegacyEventTimezoneCandidate({ id: "e1", timezone: null, ...NY });
  assert.deepEqual(result, {
    action: "resolve",
    timezone: "America/New_York",
    latitude: NY.latitude,
    longitude: NY.longitude,
  });
});

test("§24 Dhaka / Los Angeles / London resolve through the shared resolver", () => {
  assert.equal(
    (classifyLegacyEventTimezoneCandidate({ id: "d", timezone: undefined, ...DHAKA }) as { timezone: string }).timezone,
    "Asia/Dhaka",
  );
  assert.equal(
    (classifyLegacyEventTimezoneCandidate({ id: "l", timezone: null, ...LA }) as { timezone: string }).timezone,
    "America/Los_Angeles",
  );
  assert.equal(
    (classifyLegacyEventTimezoneCandidate({ id: "n", timezone: null, ...LONDON }) as { timezone: string }).timezone,
    "Europe/London",
  );
});

test("§24 an injected resolver is what actually gets called with the coordinates", () => {
  const calls: Array<[unknown, unknown]> = [];
  const spy = (lat: unknown, lng: unknown) => {
    calls.push([lat, lng]);
    return "America/Chicago";
  };
  const result = classifyLegacyEventTimezoneCandidate({ id: "e", timezone: null, latitude: 41.88, longitude: -87.63 }, spy);
  assert.deepEqual(calls, [[41.88, -87.63]]);
  assert.equal((result as { timezone: string }).timezone, "America/Chicago");
});

// ── §25 existing timezone wins ──────────────────────────────────────────

test("§25 an existing timezone is skipped and the resolver is never consulted", () => {
  let called = false;
  const spy = () => {
    called = true;
    return "America/Detroit";
  };
  const result = classifyLegacyEventTimezoneCandidate(
    { id: "e", timezone: "America/New_York", ...NY },
    spy,
  );
  assert.deepEqual(result, { action: "skip_existing_timezone" });
  assert.equal(called, false);
  // whitespace-only is treated as absent
  assert.equal(
    classifyLegacyEventTimezoneCandidate({ id: "e", timezone: "   ", ...NY }, spy).action,
    "resolve",
  );
});

// ── §26 invalid coordinates ────────────────────────────────────────────

test("§26 missing / out-of-range / non-finite coordinates → skip_invalid_coordinates", () => {
  const spy = () => {
    throw new Error("resolver must not run for invalid coords");
  };
  for (const bad of [
    { id: "a", timezone: null, latitude: null, longitude: null },
    { id: "b", timezone: null, latitude: 40.7, longitude: undefined },
    { id: "c", timezone: null, latitude: 99, longitude: -74 },
    { id: "d", timezone: null, latitude: 40, longitude: 190 },
    { id: "e", timezone: null, latitude: Number.NaN, longitude: -74 },
    { id: "f", timezone: null, latitude: "40" as unknown as number, longitude: -74 },
  ]) {
    assert.equal(classifyLegacyEventTimezoneCandidate(bad, spy).action, "skip_invalid_coordinates", bad.id);
  }
});

// ── §27 unresolved ────────────────────────────────────────────────────

test("§27 resolver returning null (or throwing) → skip_unresolved, no crash", () => {
  assert.equal(
    classifyLegacyEventTimezoneCandidate({ id: "e", timezone: null, ...NY }, () => null).action,
    "skip_unresolved",
  );
  assert.equal(
    classifyLegacyEventTimezoneCandidate(
      { id: "e", timezone: null, ...NY },
      () => {
        throw new Error("boom");
      },
    ).action,
    "skip_unresolved",
  );
});

// ── §29 / §32 exact write shape ──────────────────────────────────────

test("§29/§32 buildTimezoneBackfillWrite is $set:{timezone} only, with a race-safe filter", () => {
  const { filter, update } = buildTimezoneBackfillWrite("abc123", "America/New_York");
  assert.deepEqual(Object.keys(update), ["$set"]);
  assert.deepEqual(update.$set, { timezone: "America/New_York" });
  assert.deepEqual(Object.keys(update.$set), ["timezone"]);
  assert.deepEqual(filter._id, "abc123");
  assert.deepEqual(filter.$or, [{ timezone: null }, { timezone: { $exists: false } }]);
  // No schedule / location / status anywhere in the write.
  const serialized = JSON.stringify({ filter, update });
  for (const forbidden of ["scheduledAt", "endAt", "publishedAt", "location", "status", "startedAt"]) {
    assert.ok(!serialized.includes(forbidden), `write must not mention ${forbidden}`);
  }
});

// ── §28 dry run performs zero writes ────────────────────────────────

test("§28 dry run counts wouldUpdate and calls apply ZERO times", async () => {
  let applyCalls = 0;
  const result = await runEventTimezoneBackfill(
    {
      scan: () => asyncFrom([{ id: "e1", timezone: null, ...NY }]),
      apply: async () => {
        applyCalls += 1;
        return { matchedCount: 1 };
      },
    },
    DRY_RUN,
  );
  assert.equal(applyCalls, 0);
  assert.equal(result.counters.scanned, 1);
  assert.equal(result.counters.resolved, 1);
  assert.equal(result.counters.wouldUpdate, 1);
  assert.equal(result.counters.updated, 0);
  assert.equal(result.samples[0]?.action, "WOULD UPDATE");
});

// ── §29 apply performs exactly one narrow update per candidate ───────

test("§29 apply mode calls apply(id, timezone) once per resolved candidate", async () => {
  const applied: Array<[string, string]> = [];
  const result = await runEventTimezoneBackfill(
    {
      scan: () =>
        asyncFrom([
          { id: "e1", timezone: null, ...NY },
          { id: "e2", timezone: undefined, ...DHAKA },
          { id: "e3", timezone: "Europe/London", ...LONDON }, // skipped
          { id: "e4", timezone: null, latitude: 999, longitude: 0 }, // invalid
        ]),
      apply: async (id, timezone) => {
        applied.push([id, timezone]);
        return { matchedCount: 1 };
      },
    },
    APPLY,
  );
  assert.deepEqual(applied, [
    ["e1", "America/New_York"],
    ["e2", "Asia/Dhaka"],
  ]);
  assert.equal(result.counters.updated, 2);
  assert.equal(result.counters.skippedExisting, 1);
  assert.equal(result.counters.invalidCoordinates, 1);
  assert.equal(result.counters.concurrentSkipped, 0);
  assert.equal(result.counters.failed, 0);
});

// ── §30 race safety ────────────────────────────────────────────────

test("§30 matchedCount 0 → concurrentSkipped, never counted as updated", async () => {
  const result = await runEventTimezoneBackfill(
    {
      scan: () => asyncFrom([{ id: "e1", timezone: null, ...NY }]),
      apply: async () => ({ matchedCount: 0 }),
    },
    APPLY,
  );
  assert.equal(result.counters.concurrentSkipped, 1);
  assert.equal(result.counters.updated, 0);
});

// ── §31 idempotency ───────────────────────────────────────────────

test("§31 a second run over the (now-filled) dataset resolves nothing", async () => {
  const store = new Map<string, string | null>([
    ["e1", null],
    ["e2", null],
  ]);
  const scan = () =>
    asyncFrom(
      [...store.entries()]
        .filter(([, tz]) => tz == null)
        .map(([id]) => ({ id, timezone: null as string | null, ...NY })),
    );
  const apply = async (id: string, timezone: string) => {
    if (store.get(id) == null) {
      store.set(id, timezone);
      return { matchedCount: 1 };
    }
    return { matchedCount: 0 };
  };

  const first = await runEventTimezoneBackfill({ scan, apply }, APPLY);
  assert.equal(first.counters.updated, 2);

  const second = await runEventTimezoneBackfill({ scan, apply }, APPLY);
  assert.equal(second.counters.scanned, 0);
  assert.equal(second.counters.resolved, 0);
  assert.equal(second.counters.updated, 0);
});

// ── §34 partial failure isolation ────────────────────────────────

test("§34 one failing update does not stop the rest", async () => {
  const result = await runEventTimezoneBackfill(
    {
      scan: () =>
        asyncFrom([
          { id: "A", timezone: null, ...NY },
          { id: "B", timezone: null, ...DHAKA },
          { id: "C", timezone: null, ...LONDON },
        ]),
      apply: async (id) => {
        if (id === "B") {
          throw new Error("write failed");
        }
        return { matchedCount: 1 };
      },
    },
    APPLY,
  );
  assert.equal(result.counters.updated, 2);
  assert.equal(result.counters.failed, 1);
  assert.equal(result.counters.scanned, 3);
});

// ── §5 / §6 limit + batch-size are passed through to the scanner ─────

test("§5/§6 runner forwards limit + batchSize to the candidate scanner", async () => {
  let received: { batchSize: number; limit: number | null } | null = null;
  await runEventTimezoneBackfill(
    {
      scan: (input) => {
        received = input;
        return asyncFrom([]);
      },
      apply: async () => ({ matchedCount: 1 }),
    },
    { apply: true, limit: 250, batchSize: 100, sampleLimit: 3 },
  );
  assert.deepEqual(received, { batchSize: 100, limit: 250 });
});

// ── §17 bounded sample output, no sensitive fields ──────────────

test("§17 report caps samples and prints only id / coords / timezone / action", async () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ id: `e${i}`, timezone: null as string | null, ...NY }));
  const result = await runEventTimezoneBackfill(
    { scan: () => asyncFrom(many), apply: async () => ({ matchedCount: 1 }) },
    { apply: false, limit: null, batchSize: 50, sampleLimit: 3 },
  );
  assert.equal(result.samples.length, 3);
  const report = formatBackfillReport(result);
  assert.match(report, /DRY RUN \(no writes\)/);
  assert.match(report, /wouldUpdate:\s+25/);
  assert.doesNotMatch(report, /address|venue|ticket|price|host|userId|email/i);
});

// ── §33 no timestamp-reinterpretation helpers in the script ─────

test("§33 the backfill script never imports/uses reinterpret / parts→instant helpers", () => {
  const raw = readFileSync(
    fileURLToPath(new URL("../src/scripts/backfill-event-timezones.ts", import.meta.url)),
    "utf8",
  );
  // Strip comments so only executable code is scanned.
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(source, /reinterpretInstantInZone/);
  assert.doesNotMatch(source, /eventLocalPartsToInstant/);
  assert.doesNotMatch(source, /instantToEventLocalParts/);
  // The only event-timezone import it needs is the coordinate resolver.
  const tzImport = /import \{([^}]*)\} from "\.\.\/modules\/events\/event-timezone\.js"/.exec(source);
  assert.ok(tzImport, "expected an import from event-timezone.js");
  assert.equal(tzImport![1].trim(), "resolveEventTimeZoneFromCoordinates");
  // And it must not reach for another timezone dataset.
  assert.doesNotMatch(source, /@photostructure\/tz-lookup|require\(["']tz-lookup/);
  // No scheduledAt / endAt references anywhere in executable code.
  assert.doesNotMatch(source, /scheduledAt|endAt/);
});
