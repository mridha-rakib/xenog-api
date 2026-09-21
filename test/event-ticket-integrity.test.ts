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

const ownerId = new Types.ObjectId();
const eventId = new Types.ObjectId();
const baseNow = new Date("2026-07-20T20:00:00.000Z");
const eventStart = new Date("2026-07-20T19:00:00.000Z");
const eventEnd = new Date("2026-07-20T22:00:00.000Z");

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

const createTicket = (overrides: Record<string, unknown> = {}) => ({
  id: "ticket-1",
  name: "General",
  description: "General admission",
  salesEndAt: new Date("2026-07-20T21:00:00.000Z"),
  type: "pay",
  price: 10,
  capacity: 100,
  availableCount: 60,
  ...overrides,
});

const createEvent = (overrides: Record<string, unknown> = {}) => ({
  _id: eventId,
  userId: ownerId,
  status: "published",
  name: "Ticket Event",
  description: "Ticket event",
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
  tickets: [],
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

const createTicketPayload = (overrides: Record<string, unknown> = {}) => ({
  name: "VIP",
  description: "VIP ticket",
  salesEndAt: new Date("2026-07-20T21:00:00.000Z"),
  type: "pay",
  price: 25,
  capacity: 10,
  ...overrides,
});

const createService = ({
  event = createEvent(),
  now = baseNow,
  onAddTicket,
  onUpdateEvent,
  onUpdateDraft,
  onUpdateTicketFields,
  onAdjustCapacity,
  adjustCapacityResult,
  onRemoveTicket,
  ticketSales = {},
}: {
  event?: ReturnType<typeof createEvent> | null;
  now?: Date;
  onAddTicket?: (ticket: ReturnType<typeof createTicket>) => void;
  onUpdateEvent?: (payload: Record<string, unknown>) => void;
  onUpdateDraft?: (payload: Record<string, unknown>) => void;
  onUpdateTicketFields?: (fields: Record<string, unknown>) => void;
  onAdjustCapacity?: (args: { ticketId: string; newCapacity: number; delta: number }) => void;
  adjustCapacityResult?: "succeed" | "fail";
  onRemoveTicket?: (ticketId: string) => void;
  ticketSales?: Record<string, number>;
} = {}) => {
  // Mutable ticket state shared across mock repository methods, so a
  // capacity adjustment made by adjustTicketCapacityAndCount() is visible to
  // the updateTicketFields() call that follows it in the same service
  // method — mirroring how both calls hit the same live Mongo document.
  let currentTickets = event ? [...event.tickets] : [];

  return new EventService(
  {
    findByIdForUser: async (_requestedEventId: string, requestedUserId: string) =>
      event && requestedUserId === owner.id ? createEvent({ ...event, tickets: currentTickets }) : null,
    addTicketToEvent: async (_requestedEventId: string, _requestedUserId: string, ticket: ReturnType<typeof createTicket>) => {
      onAddTicket?.(ticket);
      currentTickets = [...currentTickets, ticket];
      return event ? createEvent({ ...event, tickets: currentTickets }) : null;
    },
    updateDraftByIdForUser: async (_requestedEventId: string, _requestedUserId: string, payload: Record<string, unknown>) => {
      onUpdateDraft?.(payload);
      currentTickets = (payload.tickets as typeof currentTickets) ?? currentTickets;
      return event ? createEvent({ ...event, tickets: currentTickets }) : null;
    },
    updateByIdForUser: async (_requestedEventId: string, _requestedUserId: string, payload: Record<string, unknown>) => {
      onUpdateEvent?.(payload);
      return event ? createEvent({ ...event, ...payload }) : null;
    },
    updateTicketFields: async (
      _requestedEventId: string,
      _requestedUserId: string,
      ticketId: string,
      fields: Record<string, unknown>,
    ) => {
      onUpdateTicketFields?.(fields);
      currentTickets = currentTickets.map((ticket: Record<string, unknown>) => (
        ticket.id === ticketId ? { ...ticket, ...fields } : ticket
      ));

      return event ? createEvent({ ...event, tickets: currentTickets }) : null;
    },
    adjustTicketCapacityAndCount: async (
      _requestedEventId: string,
      ticketId: string,
      newCapacity: number,
      delta: number,
    ) => {
      onAdjustCapacity?.({ ticketId, newCapacity, delta });

      // Mirrors the repository's own atomic guard: a decrease that would push
      // availableCount below zero fails (returns null) exactly as the real
      // conditional Mongo filter (`availableCount: { $gte: -delta }`) would.
      const existingTicket = currentTickets.find((t: Record<string, unknown>) => t.id === ticketId);
      const currentAvailable = (existingTicket?.availableCount as number) ?? 0;

      if (adjustCapacityResult === "fail" || (delta < 0 && currentAvailable < -delta)) {
        return null;
      }

      currentTickets = currentTickets.map((ticket: Record<string, unknown>) => (
        ticket.id === ticketId
          ? { ...ticket, capacity: newCapacity, availableCount: currentAvailable + delta }
          : ticket
      ));

      return event ? createEvent({ ...event, tickets: currentTickets }) : null;
    },
    removeTicketFromEvent: async (_requestedEventId: string, _requestedUserId: string, ticketId: string) => {
      onRemoveTicket?.(ticketId);
      currentTickets = currentTickets.filter((ticket: Record<string, unknown>) => ticket.id !== ticketId);

      return event ? createEvent({ ...event, tickets: currentTickets }) : null;
    },
  } as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {
    getEventTicketSales: async (_requestedEventId: string) => ticketSales,
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
  {
    findConflictingForEventSchedule: async () => [],
  } as never,
  {} as never,
  () => now,
  );
};

const assertTicketError = async (
  action: () => Promise<unknown>,
  statusCode: number,
  code?: string,
) => {
  await assert.rejects(
    action,
    (error: unknown) => {
      assert.equal((error as { statusCode?: number }).statusCode, statusCode);

      if (code) {
        assert.equal((error as { details?: { code?: string } }).details?.code, code);
      }

      return true;
    },
  );
};

// ---------------------------------------------------------------------------
// CONFIRMED GAP #1 — paid ticket price floor (EVT-014)
// ---------------------------------------------------------------------------

test("paid price: free ticket with price omitted is accepted and stored as 0", async () => {
  const service = createService();

  const response = await service.createEventTicket(owner as never, eventId.toString(), createTicketPayload({
    type: "free",
    price: undefined,
  }) as never);

  assert.equal(response.tickets[0]?.price, 0);
  assert.equal(response.tickets[0]?.type, "free");
});

test("paid price: free ticket with a positive submitted price is normalized to 0", async () => {
  const service = createService();

  const response = await service.createEventTicket(owner as never, eventId.toString(), createTicketPayload({
    type: "free",
    price: 15,
  }) as never);

  assert.equal(response.tickets[0]?.price, 0);
});

test("paid price: a positive price is accepted for a paid ticket", async () => {
  const service = createService();

  const response = await service.createEventTicket(owner as never, eventId.toString(), createTicketPayload({
    type: "pay",
    price: 25,
  }) as never);

  assert.equal(response.tickets[0]?.price, 25);
});

test("paid price: price = 0 is rejected for a paid ticket", async () => {
  const service = createService();

  await assertTicketError(
    () => service.createEventTicket(owner as never, eventId.toString(), createTicketPayload({
      type: "pay",
      price: 0,
    }) as never),
    422,
    "TICKET_PAID_PRICE_MUST_BE_POSITIVE",
  );
});

test("paid price: a negative price is rejected for a paid ticket", async () => {
  const service = createService();

  await assertTicketError(
    () => service.createEventTicket(owner as never, eventId.toString(), createTicketPayload({
      type: "pay",
      price: -5,
    }) as never),
    422,
    "TICKET_PAID_PRICE_MUST_BE_POSITIVE",
  );
});

test("paid price: a direct-service bypass creating a paid ticket at price 0 is rejected (draft path)", async () => {
  const service = createService({ event: createEvent({ status: "draft", publishedAt: null }) });

  await assertTicketError(
    () => service.createDraftTicket(owner as never, eventId.toString(), createTicketPayload({
      type: "pay",
      price: 0,
    }) as never),
    422,
    "TICKET_PAID_PRICE_MUST_BE_POSITIVE",
  );
});

test("paid price: updating an existing paid tier to price 0 is rejected", async () => {
  const service = createService({ event: createEvent({ tickets: [createTicket({ price: 10 })] }) });

  await assertTicketError(
    () => service.updateEventTicket(owner as never, eventId.toString(), "ticket-1", {
      price: 0,
    } as never),
    422,
    "TICKET_PAID_PRICE_MUST_BE_POSITIVE",
  );
});

test("paid price: switching an existing free ticket to paid without a positive price is rejected", async () => {
  const service = createService({
    event: createEvent({ tickets: [createTicket({ type: "free", price: 0 })] }),
  });

  await assertTicketError(
    () => service.updateEventTicket(owner as never, eventId.toString(), "ticket-1", {
      type: "pay",
    } as never),
    422,
    "TICKET_PAID_PRICE_MUST_BE_POSITIVE",
  );
});

test("paid price: switching an existing paid ticket to free is accepted and price is normalized to 0", async () => {
  const service = createService({ event: createEvent({ tickets: [createTicket({ type: "pay", price: 10 })] }) });

  const response = await service.updateEventTicket(owner as never, eventId.toString(), "ticket-1", {
    type: "free",
  } as never);

  assert.equal(response.tickets[0]?.type, "free");
  assert.equal(response.tickets[0]?.price, 0);
});

// Same ambiguous-partial-update coverage on the draft ticket endpoint.
test("paid price: draft ticket update to price 0 on an existing paid tier is rejected", async () => {
  const service = createService({
    event: createEvent({ status: "draft", publishedAt: null, tickets: [createTicket({ price: 10 })] }),
  });

  await assertTicketError(
    () => service.updateDraftTicket(owner as never, eventId.toString(), "ticket-1", {
      price: 0,
    } as never),
    422,
    "TICKET_PAID_PRICE_MUST_BE_POSITIVE",
  );
});

// ---------------------------------------------------------------------------
// A — capacity reduction regression tests
// ---------------------------------------------------------------------------

test("capacity reduction: reducing capacity above the sold count succeeds (100 -> 80, sold 40)", async () => {
  // capacity 100, sold 40 => availableCount 60
  const service = createService({
    event: createEvent({ tickets: [createTicket({ capacity: 100, availableCount: 60 })] }),
  });

  const response = await service.updateEventTicket(owner as never, eventId.toString(), "ticket-1", {
    capacity: 80,
  } as never);

  const updatedTicket = response.tickets[0] as unknown as { capacity: number; availableCount: number };
  assert.equal(updatedTicket.capacity, 80);
  // delta = 80 - 100 = -20 -> availableCount 60 - 20 = 40, never negative.
  assert.equal(updatedTicket.availableCount, 40);
  assert.ok(updatedTicket.availableCount >= 0);
});

test("capacity reduction: reducing capacity below the sold count is rejected (100 -> 30, sold 40)", async () => {
  // capacity 100, sold 40 => availableCount 60. Reducing to 30 would require
  // availableCount to drop by 70, which is more than the 60 currently available
  // (i.e. it would take capacity below the 40 already sold) and must fail.
  const service = createService({
    event: createEvent({ tickets: [createTicket({ capacity: 100, availableCount: 60 })] }),
  });

  await assertTicketError(
    () => service.updateEventTicket(owner as never, eventId.toString(), "ticket-1", {
      capacity: 30,
    } as never),
    409,
  );
});

test("capacity reduction: availableCount can never become negative", async () => {
  const service = createService({
    event: createEvent({ tickets: [createTicket({ capacity: 100, availableCount: 60 })] }),
    adjustCapacityResult: "fail",
  });

  await assertTicketError(
    () => service.updateEventTicket(owner as never, eventId.toString(), "ticket-1", {
      capacity: 10,
    } as never),
    409,
  );
});

// ---------------------------------------------------------------------------
// B — sold-tier deletion tests
// ---------------------------------------------------------------------------

test("deletion: a tier with zero completed sales can be deleted", async () => {
  let removedTicketId: string | null = null;
  const service = createService({
    event: createEvent({ tickets: [createTicket()] }),
    ticketSales: { "ticket-1": 0 },
    onRemoveTicket: (ticketId) => {
      removedTicketId = ticketId;
    },
  });

  const response = await service.deleteEventTicket(owner as never, eventId.toString(), "ticket-1");

  assert.equal(removedTicketId, "ticket-1");
  assert.equal(response.tickets.length, 0);
});

test("deletion: a tier with completed sales is rejected", async () => {
  let removedTicketId: string | null = null;
  const service = createService({
    event: createEvent({ tickets: [createTicket()] }),
    ticketSales: { "ticket-1": 5 },
    onRemoveTicket: (ticketId) => {
      removedTicketId = ticketId;
    },
  });

  await assertTicketError(
    () => service.deleteEventTicket(owner as never, eventId.toString(), "ticket-1"),
    409,
  );
  assert.equal(removedTicketId, null, "the repository must never be called once sales exist");
});

// ---------------------------------------------------------------------------
// EVT-013 — Event end shortened below an existing ticket's sales deadline
// ---------------------------------------------------------------------------

test("event end shortening: reducing endAt below an existing ticket's salesEndAt is rejected", async () => {
  // Existing event ends at 23:00, existing ticket's salesEndAt is 22:00.
  const existingEnd = new Date("2026-07-20T23:00:00.000Z");
  const ticketSalesEndAt = new Date("2026-07-20T22:00:00.000Z");
  let updatePayload: Record<string, unknown> | null = null;

  const service = createService({
    event: createEvent({
      endAt: existingEnd,
      tickets: [createTicket({ salesEndAt: ticketSalesEndAt })],
    }),
    now: baseNow,
    onUpdateEvent: (payload) => {
      updatePayload = payload;
    },
  });

  // Host shortens the event end to 21:00 — now before the ticket's 22:00
  // deadline. Both times fall on the same UTC calendar date, so the service
  // classifies this as a same-day "time" violation, not a "date" violation
  // (see EventService.assertTicketDatesFitEventSchedule's calendar-key check).
  await assertTicketError(
    () => service.updateEvent(owner as never, eventId.toString(), {
      endAt: new Date("2026-07-20T21:00:00.000Z"),
    } as never),
    422,
    "TICKET_SALES_END_TIME_NOT_BEFORE_EVENT_END",
  );
  assert.equal(updatePayload, null, "the repository must never be called when a ticket deadline would become invalid");
});

test("event end shortening: with two tiers, only the second (now-invalid) tier still blocks the update", async () => {
  const existingEnd = new Date("2026-07-20T23:00:00.000Z");
  let updatePayload: Record<string, unknown> | null = null;

  const service = createService({
    event: createEvent({
      endAt: existingEnd,
      tickets: [
        // Tier A: deadline is well before the new end — remains valid.
        createTicket({ id: "ticket-a", salesEndAt: new Date("2026-07-20T20:00:00.000Z") }),
        // Tier B: deadline would fall after the new (shortened) end — invalid.
        createTicket({ id: "ticket-b", salesEndAt: new Date("2026-07-20T22:00:00.000Z") }),
      ],
    }),
    now: baseNow,
    onUpdateEvent: (payload) => {
      updatePayload = payload;
    },
  });

  await assertTicketError(
    () => service.updateEvent(owner as never, eventId.toString(), {
      endAt: new Date("2026-07-20T21:00:00.000Z"),
    } as never),
    422,
    "TICKET_SALES_END_TIME_NOT_BEFORE_EVENT_END",
  );
  assert.equal(updatePayload, null, "all tiers must be validated, not just the first");
});

test("event end shortening: shortening endAt while every ticket deadline still fits succeeds", async () => {
  const existingEnd = new Date("2026-07-20T23:00:00.000Z");
  let updatePayload: Record<string, unknown> | null = null;

  const service = createService({
    event: createEvent({
      endAt: existingEnd,
      tickets: [createTicket({ salesEndAt: new Date("2026-07-20T20:00:00.000Z") })],
    }),
    now: baseNow,
    onUpdateEvent: (payload) => {
      updatePayload = payload;
    },
  });

  const response = await service.updateEvent(owner as never, eventId.toString(), {
    endAt: new Date("2026-07-20T21:00:00.000Z"),
  } as never);

  assert.equal(response.endAt?.getTime(), new Date("2026-07-20T21:00:00.000Z").getTime());
  assert.ok(updatePayload, "expected the repository to have been called for a valid shortening");
});
