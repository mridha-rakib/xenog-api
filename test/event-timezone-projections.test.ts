import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { PostTagEventResponse } from "../src/modules/events/event.interface.js";
import type { TicketWalletEvent } from "../src/modules/payments/checkout-payment.interface.js";
import type { ParticipatedEventSummary } from "../src/modules/event-windows/event-window.interface.js";

const readSrc = (relPath: string) =>
  readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), "utf8");

// Batch 3C.2 — the three previously-narrow Event projections that omitted the
// venue timezone now propagate the already-persisted `event.timezone`. This is a
// metadata copy only: no coordinate resolution, no tz-lookup, no derivation.

test("§14/§29 PostTagEventResponse carries an additive optional timezone", () => {
  const value: PostTagEventResponse = {
    id: "e1",
    name: "Event",
    scheduledAt: new Date("2026-09-20T23:00:00.000Z"),
    timezone: "America/New_York",
    postTagStatus: "upcoming",
  };
  assert.equal(value.timezone, "America/New_York");
  // still valid without it (old clients / legacy Events)
  const legacy: PostTagEventResponse = {
    id: "e2",
    name: "Event",
    scheduledAt: new Date(),
    postTagStatus: "live",
  };
  assert.equal(legacy.timezone, undefined);
});

test("§13/§18 listMyPostTagEvents copies event.timezone (?? null) — no re-derivation", () => {
  const src = readSrc("../src/modules/events/event.service.ts");
  const mapper = src.slice(
    src.indexOf("public async listMyPostTagEvents"),
    src.indexOf("public async getTicketAccess"),
  );
  assert.match(mapper, /timezone: event\.timezone \?\? null,/);
  assert.doesNotMatch(mapper, /tzLookup|resolveEventTimeZoneFromCoordinates|@photostructure/);
});

test("§2 TicketWalletEvent carries an additive optional timezone", () => {
  const value: Pick<TicketWalletEvent, "id" | "categories" | "timezone"> = {
    id: "e1",
    categories: [],
    timezone: null,
  };
  assert.equal(value.timezone, null);
});

test("§1/§18 both wallet Event projections copy event.timezone (?? null)", () => {
  const src = readSrc("../src/modules/payments/checkout-payment.service.ts");
  const matches = src.match(/timezone: event\.timezone \?\? null,/g) ?? [];
  assert.ok(matches.length >= 2, `expected both wallet projections patched, found ${matches.length}`);
  // adjacent to the schedule fields, never near a coordinate lookup
  assert.match(src, /endAt: event\.endAt \?\? null,\s*\n\s*timezone: event\.timezone \?\? null,/);
});

test("§10 ParticipatedEventSummary carries an additive optional timezone", () => {
  const value: Pick<ParticipatedEventSummary, "id" | "name" | "timezone"> = {
    id: "e1",
    name: "E",
    timezone: "Asia/Dhaka",
  };
  assert.equal(value.timezone, "Asia/Dhaka");
});

test("§9/§18 the participated-events projection copies event.timezone (?? null)", () => {
  const src = readSrc("../src/modules/event-windows/event-window.service.ts");
  assert.match(src, /scheduledAt: event\.scheduledAt \?\? null,\s*\n\s*endAt: event\.endAt \?\? null,\s*\n\s*timezone: event\.timezone \?\? null,/);
  assert.doesNotMatch(src, /tzLookup|resolveEventTimeZoneFromCoordinates/);
});
