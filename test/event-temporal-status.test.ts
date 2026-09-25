import assert from "node:assert/strict";
import test from "node:test";
import { getEventLifecycle, STARTING_SOON_MS } from "../src/modules/events/event-temporal-status.js";

const start = Date.UTC(2026, 0, 1, 12, 0, 0);
const end = Date.UTC(2026, 0, 1, 18, 0, 0);
const event = { scheduledAt: new Date(start), endAt: new Date(end) };

const lifecycleAt = (now: number) => getEventLifecycle(event.scheduledAt, event.endAt, now);

test("canonical display lifecycle honors every start and end boundary", () => {
  assert.equal(lifecycleAt(start - STARTING_SOON_MS - 1), "upcoming");
  assert.equal(lifecycleAt(start - STARTING_SOON_MS), "upcoming");
  assert.equal(lifecycleAt(start - STARTING_SOON_MS + 1), "starting_soon");
  assert.equal(lifecycleAt(start - 1), "starting_soon");
  assert.equal(lifecycleAt(start), "live");
  assert.equal(lifecycleAt(start + 1), "live");
  assert.equal(lifecycleAt(end - 1), "live");
  assert.equal(lifecycleAt(end), "ended");
  assert.equal(lifecycleAt(end + 1), "ended");
});

test("canonical lifecycle is deterministic and based only on absolute instants", () => {
  assert.equal(lifecycleAt(start - 3 * 60 * 60 * 1000), "upcoming");
  assert.equal(lifecycleAt(start - 60 * 60 * 1000), "starting_soon");
  assert.equal(lifecycleAt(start), "live");
  assert.equal(lifecycleAt(end), "ended");
  assert.equal(
    getEventLifecycle(new Date("2026-01-01T12:00:00.000Z"), new Date("2026-01-01T18:00:00.000Z"), start - 60 * 60 * 1000),
    lifecycleAt(start - 60 * 60 * 1000),
  );
  assert.equal(getEventLifecycle(new Date(start), null, start), null);
});
