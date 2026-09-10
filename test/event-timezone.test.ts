import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  EVENT_TIME_ZONE_MAX_LENGTH,
  eventLocalPartsToInstant,
  instantToEventLocalParts,
  isValidIanaTimeZone,
  parseEventLocalDateTime,
  parseOptionalEventLocalDateTime,
  reinterpretInstantInZone,
  resolveEventTimeZoneFromCoordinates,
  type EventLocalDateTimeParts,
} from "../src/modules/events/event-timezone.js";

const NY = "America/New_York";
const LA = "America/Los_Angeles";
const DHAKA = "Asia/Dhaka";
const LONDON = "Europe/London";

const parts = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): EventLocalDateTimeParts => ({ year, month, day, hour, minute });

// ── §36 IANA validation ─────────────────────────────────────────────────────

test("§36 isValidIanaTimeZone accepts real zones", () => {
  for (const zone of [NY, LA, LONDON, DHAKA, "UTC", "Etc/UTC", "Europe/Paris"]) {
    assert.equal(isValidIanaTimeZone(zone), true, zone);
  }
});

test("§36 isValidIanaTimeZone rejects empty / fake / malformed / oversized / non-string", () => {
  assert.equal(isValidIanaTimeZone(""), false);
  assert.equal(isValidIanaTimeZone("   "), false);
  assert.equal(isValidIanaTimeZone("Random/FakeZone"), false);
  assert.equal(isValidIanaTimeZone("Not A Zone!"), false);
  assert.equal(isValidIanaTimeZone("../../etc/passwd"), false);
  assert.equal(isValidIanaTimeZone("A".repeat(EVENT_TIME_ZONE_MAX_LENGTH + 1)), false);
  assert.equal(isValidIanaTimeZone(null), false);
  assert.equal(isValidIanaTimeZone(undefined), false);
  assert.equal(isValidIanaTimeZone(42), false);
  assert.equal(isValidIanaTimeZone({}), false);
});

// ── §37 coordinate → IANA ───────────────────────────────────────────────────

test("§37 resolveEventTimeZoneFromCoordinates maps stable city coordinates", () => {
  assert.equal(resolveEventTimeZoneFromCoordinates(40.7128, -74.006), NY);
  assert.equal(resolveEventTimeZoneFromCoordinates(34.0522, -118.2437), LA);
  assert.equal(resolveEventTimeZoneFromCoordinates(23.8103, 90.4125), DHAKA);
  assert.equal(resolveEventTimeZoneFromCoordinates(51.5074, -0.1278), LONDON);
});

test("§37 resolveEventTimeZoneFromCoordinates returns null for invalid / missing coordinates", () => {
  assert.equal(resolveEventTimeZoneFromCoordinates(91, 0), null);
  assert.equal(resolveEventTimeZoneFromCoordinates(-91, 0), null);
  assert.equal(resolveEventTimeZoneFromCoordinates(0, 181), null);
  assert.equal(resolveEventTimeZoneFromCoordinates(0, -181), null);
  assert.equal(resolveEventTimeZoneFromCoordinates(Number.NaN, 0), null);
  assert.equal(resolveEventTimeZoneFromCoordinates(0, Number.POSITIVE_INFINITY), null);
  assert.equal(resolveEventTimeZoneFromCoordinates(undefined, undefined), null);
  assert.equal(resolveEventTimeZoneFromCoordinates(null, null), null);
  assert.equal(resolveEventTimeZoneFromCoordinates("40" as unknown, "-74" as unknown), null);
});

// ── §38 wall-clock → instant (DST-aware, not a fixed offset) ─────────────────

test("§38 New York 19:00 is EDT (-4) in summer and EST (-5) in winter", () => {
  const summer = eventLocalPartsToInstant(parts(2026, 9, 20, 19, 0), NY);
  const winter = eventLocalPartsToInstant(parts(2026, 1, 20, 19, 0), NY);
  assert.equal(summer.toISOString(), "2026-09-20T23:00:00.000Z");
  assert.equal(winter.toISOString(), "2026-01-21T00:00:00.000Z");
  // The offset must differ between the two dates — no single hard-coded offset.
  const summerOffset = summer.getTime() - Date.UTC(2026, 8, 20, 19, 0);
  const winterOffset = winter.getTime() - Date.UTC(2026, 0, 20, 19, 0);
  assert.equal(summerOffset, 4 * 3_600_000);
  assert.equal(winterOffset, 5 * 3_600_000);
  assert.notEqual(summerOffset, winterOffset);
});

test("§38 Dhaka 19:00 (no DST) and Los Angeles 19:00 (PDT)", () => {
  assert.equal(
    eventLocalPartsToInstant(parts(2026, 9, 20, 19, 0), DHAKA).toISOString(),
    "2026-09-20T13:00:00.000Z",
  );
  assert.equal(
    eventLocalPartsToInstant(parts(2026, 9, 20, 19, 0), LA).toISOString(),
    "2026-09-21T02:00:00.000Z",
  );
});

// ── §39 instant → parts, round-trip ────────────────────────────────────────

test("§39 round-trip parts → instant → parts is stable for ordinary times", () => {
  const cases: Array<[EventLocalDateTimeParts, string]> = [
    [parts(2026, 9, 20, 19, 0), NY],
    [parts(2026, 1, 20, 19, 0), NY],
    [parts(2026, 7, 4, 8, 30), LA],
    [parts(2026, 12, 31, 23, 45), DHAKA],
    [parts(2026, 6, 1, 0, 15), LONDON],
  ];
  for (const [p, zone] of cases) {
    const roundTripped = instantToEventLocalParts(eventLocalPartsToInstant(p, zone), zone);
    assert.deepEqual(roundTripped, p, `${zone} ${JSON.stringify(p)}`);
  }
});

test("§39 instantToEventLocalParts renders the venue wall-clock, not UTC", () => {
  // 2026-09-20T23:00:00Z is 19:00 in New York, 05:00 (+1 day) in Dhaka.
  const instant = new Date("2026-09-20T23:00:00.000Z");
  assert.deepEqual(instantToEventLocalParts(instant, NY), parts(2026, 9, 20, 19, 0));
  assert.deepEqual(instantToEventLocalParts(instant, DHAKA), parts(2026, 9, 21, 5, 0));
});

// ── §45 DST spring-forward gap ─────────────────────────────────────────────

test("§45 spring-forward gap → first valid local instant after the gap", () => {
  // 2026-03-08: America/New_York jumps 02:00 → 03:00. 02:30 does not exist.
  const resolved = eventLocalPartsToInstant(parts(2026, 3, 8, 2, 30), NY);
  // Deterministic: the transition boundary itself (03:00 EDT = 07:00Z).
  assert.equal(resolved.toISOString(), "2026-03-08T07:00:00.000Z");
  // And it renders as the first existing local time after the gap.
  assert.deepEqual(instantToEventLocalParts(resolved, NY), parts(2026, 3, 8, 3, 0));
});

test("§45 a valid time just after the gap is unaffected", () => {
  const resolved = eventLocalPartsToInstant(parts(2026, 3, 8, 3, 0), NY);
  assert.equal(resolved.toISOString(), "2026-03-08T07:00:00.000Z");
});

// ── §46 DST fall-back fold ─────────────────────────────────────────────────

test("§46 fall-back fold → EARLIER occurrence, asserted by absolute instant", () => {
  // 2026-11-01: America/New_York falls back 02:00 → 01:00. 01:30 occurs twice:
  //   01:30 EDT (-4) = 05:30Z  ← earlier, APPROVED choice
  //   01:30 EST (-5) = 06:30Z  ← later
  const resolved = eventLocalPartsToInstant(parts(2026, 11, 1, 1, 30), NY);
  assert.equal(resolved.toISOString(), "2026-11-01T05:30:00.000Z");
  assert.equal(resolved.getTime(), Date.parse("2026-11-01T05:30:00.000Z"));
  assert.notEqual(resolved.toISOString(), "2026-11-01T06:30:00.000Z");
});

// ── §40 venue change preserves wall-clock ──────────────────────────────────

test("§40 reinterpretInstantInZone keeps the local hour and moves the instant", () => {
  const original = new Date("2026-09-20T23:00:00.000Z"); // 19:00 New York
  const moved = reinterpretInstantInZone(original, NY, LA);
  assert.ok(moved);
  assert.equal(moved!.toISOString(), "2026-09-21T02:00:00.000Z"); // 19:00 Los Angeles
  assert.notEqual(moved!.getTime(), original.getTime());
  assert.equal(instantToEventLocalParts(moved!, LA).hour, 19);
});

test("§40 reinterpretInstantInZone returns null for an invalid instant", () => {
  assert.equal(reinterpretInstantInZone(null, NY, LA), null);
  assert.equal(reinterpretInstantInZone(undefined, NY, LA), null);
  assert.equal(reinterpretInstantInZone(new Date("nope"), NY, LA), null);
});

// ── §47 no device-timezone dependency ─────────────────────────────────────

test("§47 conversion does not depend on process.env.TZ (device timezone)", () => {
  const originalTz = process.env.TZ;
  try {
    const target = parts(2026, 9, 20, 19, 0);
    process.env.TZ = "Asia/Dhaka";
    const fromDhaka = eventLocalPartsToInstant(target, NY).toISOString();
    process.env.TZ = "America/Los_Angeles";
    const fromLa = eventLocalPartsToInstant(target, NY).toISOString();
    process.env.TZ = "UTC";
    const fromUtc = eventLocalPartsToInstant(target, NY).toISOString();
    assert.equal(fromDhaka, "2026-09-20T23:00:00.000Z");
    assert.equal(fromLa, "2026-09-20T23:00:00.000Z");
    assert.equal(fromUtc, "2026-09-20T23:00:00.000Z");
  } finally {
    if (originalTz === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTz;
    }
  }
});

test("§47 the module never interprets a venue wall-clock via the local Date constructor", () => {
  const raw = readFileSync(
    fileURLToPath(new URL("../src/modules/events/event-timezone.ts", import.meta.url)),
    "utf8",
  );
  // Strip block + line comments so only real code is scanned.
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  // `Date.UTC(...)` and `new Date(<ms>)` / `new Date(<iso>)` are fine; a
  // multi-arg local `new Date(year, month, ...)` would read the process timezone.
  assert.doesNotMatch(code, /new Date\(\s*[A-Za-z_$][\w.$]*\s*,/);
});

// ── parseEventLocalDateTime ───────────────────────────────────────────────

test("parseEventLocalDateTime accepts well-formed pairs and rejects impossible ones", () => {
  assert.deepEqual(parseEventLocalDateTime("2026-09-20", "19:00"), parts(2026, 9, 20, 19, 0));
  assert.deepEqual(parseEventLocalDateTime("2026-02-28", "00:00"), parts(2026, 2, 28, 0, 0));
  assert.equal(parseEventLocalDateTime("2026-02-30", "19:00"), null);
  assert.equal(parseEventLocalDateTime("2026-13-01", "19:00"), null);
  assert.equal(parseEventLocalDateTime("2026-09-20", "24:00"), null);
  assert.equal(parseEventLocalDateTime("2026-09-20", "19:60"), null);
  assert.equal(parseEventLocalDateTime("26-09-20", "19:00"), null);
  assert.equal(parseEventLocalDateTime("2026/09/20", "19:00"), null);
});

test("parseOptionalEventLocalDateTime is null when either half is missing", () => {
  assert.equal(parseOptionalEventLocalDateTime(undefined, "19:00"), null);
  assert.equal(parseOptionalEventLocalDateTime("2026-09-20", null), null);
  assert.equal(parseOptionalEventLocalDateTime("", ""), null);
  assert.deepEqual(
    parseOptionalEventLocalDateTime("2026-09-20", "19:00"),
    parts(2026, 9, 20, 19, 0),
  );
});
