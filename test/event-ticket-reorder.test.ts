import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { EventService } from "../src/modules/events/event.service.js";

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

// EVT-014 — Batch 5: dedicated ticket reorder endpoint. This is the FALLBACK
// strategy (per the batch instructions) because the audit found the general
// EventService.updateEvent()/saveDraft() whole-ticket-array-replace path does
// NOT merge by ID and does NOT preserve availableCount — SaveEventDraftDto's
// `tickets` field is typed EventTicketInput[], which structurally excludes
// availableCount/salesEnded, and EventRepository.toUpdate() does a raw
// `update.tickets = payload.tickets` with no per-ticket merge (unlike
// publish()'s re-publish branch, which explicitly rebuilds availableCount by
// ID). Reusing that path for reorder would risk wiping inventory on
// published events with sold tickets, so this dedicated, IDs-only operation
// (EventService.reorderEventTickets / EventRepository.reorderTickets) reorders
// the EXISTING persisted ticket objects in place instead.

const ownerId = new Types.ObjectId();
const otherUserId = new Types.ObjectId();
const eventId = new Types.ObjectId();
const baseNow = new Date("2026-07-20T20:00:00.000Z");
const eventStart = new Date("2026-07-20T19:00:00.000Z");
const eventEnd = new Date("2026-07-20T23:00:00.000Z");

const owner = {
  id: ownerId.toString(),
  name: "Owner",
  username: "owner",
  email: "owner@example.com",
  accountType: "business",
  currentLocationSharingEnabled: false,
  notificationsEnabled: true,
  role: "user",
  isActive: true,
  emailVerified: true,
  createdAt: baseNow,
  updatedAt: baseNow,
};

const otherUser = {
  ...owner,
  id: otherUserId.toString(),
  username: "other",
  email: "other@example.com",
};

const ticketA = {
  id: "ticket-a",
  name: "General",
  description: "General admission",
  salesEndAt: new Date("2026-07-20T20:00:00.000Z"),
  type: "pay",
  price: 10,
  capacity: 100,
  availableCount: 60, // 40 already sold
};

const ticketB = {
  id: "ticket-b",
  name: "VIP",
  description: "VIP admission",
  salesEndAt: new Date("2026-07-20T21:00:00.000Z"),
  type: "pay",
  price: 50,
  capacity: 20,
  availableCount: 5, // 15 already sold
};

const ticketC = {
  id: "ticket-c",
  name: "Early Bird",
  description: "Early bird admission",
  salesEndAt: null,
  type: "free",
  price: 0,
  capacity: 30,
  availableCount: 30,
};

const createEvent = (overrides: Record<string, unknown> = {}) => ({
  _id: eventId,
  userId: ownerId,
  status: "published",
  name: "Reorder Event",
  description: "desc",
  bannerImageKey: "events/banners/fixture-banner.jpg",
  bannerOriginalImageKey: null,
  bannerImageDisplay: null,
  ageRestriction: "all_ages",
  category: "Live Music & Concerts",
  categories: ["Live Music & Concerts"],
  hashtags: [],
  scheduledAt: eventStart,
  endAt: eventEnd,
  location: null,
  tickets: [ticketA, ticketB, ticketC],
  rewards: [],
  eventMedia: [],
  privacy: "public",
  memberUserIds: [],
  joinRequests: [],
  publishedAt: baseNow,
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
  createdAt: baseNow,
  updatedAt: baseNow,
  ...overrides,
});

const createService = ({
  event = createEvent(),
  onReorder,
}: {
  event?: ReturnType<typeof createEvent> | null;
  onReorder?: (tickets: unknown[]) => void;
} = {}) => new EventService(
  {
    findByIdForUser: async (_requestedEventId: string, requestedUserId: string) =>
      event && requestedUserId === owner.id ? event : null,
    reorderTickets: async (_requestedEventId: string, _requestedUserId: string, tickets: unknown[]) => {
      onReorder?.(tickets);
      return event ? createEvent({ ...event, tickets }) : null;
    },
  } as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {
    findConflictingForEventSchedule: async () => [],
  } as never,
  {} as never,
  () => baseNow,
);

const assertReorderError = async (
  action: () => Promise<unknown>,
  statusCode: number,
) => {
  await assert.rejects(
    action,
    (error: unknown) => {
      assert.equal((error as { statusCode?: number }).statusCode, statusCode);
      return true;
    },
  );
};

// ── 14/20: valid ordered ID set succeeds ────────────────────────────────────

test("reorder: a valid permutation of the current ticket IDs succeeds", async () => {
  let capturedTickets: unknown[] | null = null;
  const service = createService({ onReorder: (tickets) => { capturedTickets = tickets; } });

  const response = await service.reorderEventTickets(
    owner as never,
    eventId.toString(),
    ["ticket-c", "ticket-a", "ticket-b"],
  );

  assert.equal(response.tickets.map((t) => t.id).join(","), "ticket-c,ticket-a,ticket-b");
  assert.ok(capturedTickets);
  assert.equal((capturedTickets as { id: string }[]).map((t) => t.id).join(","), "ticket-c,ticket-a,ticket-b");
});

// ── 15: unknown ID rejected ──────────────────────────────────────────────────

test("reorder: an unknown ticket ID is rejected", async () => {
  let called = false;
  const service = createService({ onReorder: () => { called = true; } });

  await assertReorderError(
    () => service.reorderEventTickets(owner as never, eventId.toString(), ["ticket-a", "ticket-b", "ticket-x"]),
    422,
  );
  assert.equal(called, false);
});

// ── 16: duplicate ID rejected ────────────────────────────────────────────────

test("reorder: a duplicate ticket ID is rejected", async () => {
  let called = false;
  const service = createService({ onReorder: () => { called = true; } });

  await assertReorderError(
    () => service.reorderEventTickets(owner as never, eventId.toString(), ["ticket-a", "ticket-a", "ticket-b"]),
    422,
  );
  assert.equal(called, false);
});

// ── 17: missing an existing ID rejected ─────────────────────────────────────

test("reorder: omitting an existing ticket ID is rejected", async () => {
  let called = false;
  const service = createService({ onReorder: () => { called = true; } });

  await assertReorderError(
    () => service.reorderEventTickets(owner as never, eventId.toString(), ["ticket-a", "ticket-b"]),
    422,
  );
  assert.equal(called, false);
});

// ── 18: extra (unknown) ID rejected ─────────────────────────────────────────

test("reorder: an extra ID beyond the current ticket set is rejected", async () => {
  let called = false;
  const service = createService({ onReorder: () => { called = true; } });

  await assertReorderError(
    () => service.reorderEventTickets(owner as never, eventId.toString(), ["ticket-a", "ticket-b", "ticket-c", "ticket-d"]),
    422,
  );
  assert.equal(called, false);
});

// ── 19: non-owner rejected ───────────────────────────────────────────────────

test("reorder: a non-owner cannot reorder the event's tickets", async () => {
  let called = false;
  const service = createService({ onReorder: () => { called = true; } });

  await assertReorderError(
    () => service.reorderEventTickets(otherUser as never, eventId.toString(), ["ticket-c", "ticket-a", "ticket-b"]),
    404,
  );
  assert.equal(called, false);
});

// ── 21-27: inventory immutability — every field except array position ──────

test("reorder: every ticket field is preserved exactly — only array position changes", async () => {
  const service = createService();

  const response = await service.reorderEventTickets(
    owner as never,
    eventId.toString(),
    ["ticket-b", "ticket-c", "ticket-a"],
  );

  const byId = new Map(response.tickets.map((t) => [t.id, t]));
  const before = new Map([ticketA, ticketB, ticketC].map((t) => [t.id, t]));

  for (const id of ["ticket-a", "ticket-b", "ticket-c"]) {
    const beforeTicket = before.get(id)!;
    const afterTicket = byId.get(id)! as unknown as typeof beforeTicket;

    assert.equal(afterTicket.capacity, beforeTicket.capacity, `${id} capacity must be unchanged`);
    assert.equal(afterTicket.availableCount, beforeTicket.availableCount, `${id} availableCount (sold count) must be unchanged`);
    assert.equal(afterTicket.price, beforeTicket.price, `${id} price must be unchanged`);
    assert.equal(afterTicket.type, beforeTicket.type, `${id} type (paid/free) must be unchanged`);
    assert.deepEqual(afterTicket.salesEndAt, beforeTicket.salesEndAt, `${id} salesEndAt must be unchanged`);
    assert.equal(afterTicket.name, beforeTicket.name);
    assert.equal(afterTicket.description, beforeTicket.description);
  }

  assert.equal(response.tickets.map((t) => t.id).join(","), "ticket-b,ticket-c,ticket-a");
});

test("reorder: no ticket is created or removed by a reorder", async () => {
  const service = createService();

  const response = await service.reorderEventTickets(
    owner as never,
    eventId.toString(),
    ["ticket-c", "ticket-b", "ticket-a"],
  );

  assert.equal(response.tickets.length, 3);
  assert.deepEqual(
    new Set(response.tickets.map((t) => t.id)),
    new Set(["ticket-a", "ticket-b", "ticket-c"]),
  );
});

test("reorder: reordering the SAME order (identity permutation) succeeds and changes nothing observable", async () => {
  const service = createService();

  const response = await service.reorderEventTickets(
    owner as never,
    eventId.toString(),
    ["ticket-a", "ticket-b", "ticket-c"],
  );

  assert.equal(response.tickets.map((t) => t.id).join(","), "ticket-a,ticket-b,ticket-c");
});

// ── Zod schema boundary (defense-in-depth ahead of the service check) ──────

test("reorder validation schema: a non-empty ticketIds array of strings is accepted", async () => {
  const { eventValidation } = await import("../src/modules/events/event.validation.js");

  const result = eventValidation.reorderEventTickets.safeParse({
    params: { id: eventId.toString() },
    body: { ticketIds: ["ticket-c", "ticket-a", "ticket-b"] },
  });

  assert.equal(result.success, true);
});

test("reorder validation schema: an empty ticketIds array is rejected", async () => {
  const { eventValidation } = await import("../src/modules/events/event.validation.js");

  const result = eventValidation.reorderEventTickets.safeParse({
    params: { id: eventId.toString() },
    body: { ticketIds: [] },
  });

  assert.equal(result.success, false);
});

test("reorder validation schema: a payload with extra fields (e.g. a mutable ticket object) is rejected", async () => {
  const { eventValidation } = await import("../src/modules/events/event.validation.js");

  const result = eventValidation.reorderEventTickets.safeParse({
    params: { id: eventId.toString() },
    body: {
      ticketIds: ["ticket-a"],
      tickets: [{ id: "ticket-a", price: 0, availableCount: 999 }],
    },
  });

  assert.equal(result.success, false, "the schema must reject anything beyond ticketIds (strict object)");
});
