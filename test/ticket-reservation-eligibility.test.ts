import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

// These tests never open a real MongoDB connection: EventModel.findOneAndUpdate
// is replaced with t.mock before any repository call, so no network I/O ever
// happens. They exist to lock in the exact filter shape used by
// reserveTicketCapacity()/reserveTicketAndRewardCapacity() — the two queries
// that still rejected "live" events after the resolveLineItems() quote fix.

test("reserveTicketCapacity() accepts published and live, and no longer requires scheduledAt in the future", async (t) => {
  const { EventModel } = await import("../src/modules/events/event.model.js");
  const { EventRepository } = await import("../src/modules/events/event.repository.js");

  const calls: unknown[] = [];
  t.mock.method(EventModel, "findOneAndUpdate", (filter: unknown) => {
    calls.push(filter);
    return null;
  });

  const repository = new EventRepository();
  await repository.reserveTicketCapacity("event-1", "ticket-1", 2);

  assert.equal(calls.length, 1);
  const filter = calls[0] as Record<string, unknown>;

  assert.deepEqual(filter.status, { $in: ["published", "live"] });
  assert.equal("scheduledAt" in filter, false, "scheduledAt must no longer gate ticket reservation");
});

test("reserveTicketAndRewardCapacity() with reward accepts published and live, and drops scheduledAt", async (t) => {
  const { EventModel } = await import("../src/modules/events/event.model.js");
  const { EventRepository } = await import("../src/modules/events/event.repository.js");

  const calls: unknown[] = [];
  t.mock.method(EventModel, "findOneAndUpdate", (filter: unknown) => {
    calls.push(filter);
    return null;
  });

  const repository = new EventRepository();
  await repository.reserveTicketAndRewardCapacity("event-1", "ticket-1", 4, "reward-1", 1);

  assert.equal(calls.length, 1);
  const filter = calls[0] as Record<string, unknown>;

  assert.deepEqual(filter.status, { $in: ["published", "live"] });
  assert.equal("scheduledAt" in filter, false, "scheduledAt must no longer gate rewarded ticket reservation");
});

test("reserveTicketAndRewardCapacity() with a zero-quantity reward (BOGO edge case) also accepts published and live", async (t) => {
  const { EventModel } = await import("../src/modules/events/event.model.js");
  const { EventRepository } = await import("../src/modules/events/event.repository.js");

  const calls: unknown[] = [];
  t.mock.method(EventModel, "findOneAndUpdate", (filter: unknown) => {
    calls.push(filter);
    return null;
  });

  const repository = new EventRepository();
  await repository.reserveTicketAndRewardCapacity("event-1", "ticket-1", 2, "reward-1", 0);

  assert.equal(calls.length, 1);
  const filter = calls[0] as Record<string, unknown>;

  assert.deepEqual(filter.status, { $in: ["published", "live"] });
  assert.equal("scheduledAt" in filter, false);
});

test("reserveTicketAndRewardCapacity() without a rewardId delegates to reserveTicketCapacity()'s same eligibility filter", async (t) => {
  const { EventModel } = await import("../src/modules/events/event.model.js");
  const { EventRepository } = await import("../src/modules/events/event.repository.js");

  const calls: unknown[] = [];
  t.mock.method(EventModel, "findOneAndUpdate", (filter: unknown) => {
    calls.push(filter);
    return null;
  });

  const repository = new EventRepository();
  await repository.reserveTicketAndRewardCapacity("event-1", "ticket-1", 2, null, 0);

  assert.equal(calls.length, 1);
  const filter = calls[0] as Record<string, unknown>;

  assert.deepEqual(filter.status, { $in: ["published", "live"] });
  assert.equal("scheduledAt" in filter, false);
});
