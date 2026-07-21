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
const otherUserId = new Types.ObjectId();
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

const otherUser = {
  ...owner,
  id: otherUserId.toString(),
  username: "other",
  email: "other@example.com",
};

const createTicket = (overrides: Record<string, unknown> = {}) => ({
  id: "ticket-1",
  name: "General",
  description: "General admission",
  salesEndAt: new Date("2026-07-20T21:00:00.000Z"),
  type: "pay",
  price: 10,
  capacity: 100,
  availableCount: 100,
  ...overrides,
});

const createEvent = (overrides: Record<string, unknown> = {}) => ({
  _id: eventId,
  userId: ownerId,
  status: "published",
  name: "Ticket Event",
  description: "Ticket event",
  bannerImageKey: null,
  bannerOriginalImageKey: null,
  bannerImageDisplay: null,
  ageRestriction: "all_ages",
  category: "Music",
  categories: ["Music"],
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
}: {
  event?: ReturnType<typeof createEvent> | null;
  now?: Date;
  onAddTicket?: (ticket: ReturnType<typeof createTicket>) => void;
  onUpdateEvent?: (payload: Record<string, unknown>) => void;
  onUpdateDraft?: (payload: Record<string, unknown>) => void;
  onUpdateTicketFields?: (fields: Record<string, unknown>) => void;
} = {}) => new EventService(
  {
    findByIdForUser: async (_requestedEventId: string, requestedUserId: string) =>
      event && requestedUserId === owner.id ? event : null,
    addTicketToEvent: async (_requestedEventId: string, _requestedUserId: string, ticket: ReturnType<typeof createTicket>) => {
      onAddTicket?.(ticket);
      return event ? createEvent({ ...event, tickets: [...event.tickets, ticket] }) : null;
    },
    updateDraftByIdForUser: async (_requestedEventId: string, _requestedUserId: string, payload: Record<string, unknown>) => {
      onUpdateDraft?.(payload);
      return event ? createEvent({ ...event, tickets: payload.tickets }) : null;
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
      const tickets = event?.tickets.map((ticket) => (
        ticket.id === ticketId ? { ...ticket, ...fields } : ticket
      ));

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
  () => now,
);

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

test("draft event allows ticket creation when more than 30 minutes remain", async () => {
  const service = createService({ event: createEvent({ status: "draft", publishedAt: null }) });

  const response = await service.createDraftTicket(owner as never, eventId.toString(), createTicketPayload() as never);

  assert.equal(response.status, "draft");
  assert.equal(response.tickets.length, 1);
});

test("published event allows ticket creation when more than 30 minutes remain", async () => {
  const service = createService({ event: createEvent({ status: "published" }) });

  const response = await service.createEventTicket(owner as never, eventId.toString(), createTicketPayload() as never);

  assert.equal(response.status, "published");
  assert.equal(response.tickets.length, 1);
});

test("live event allows ticket creation when more than 30 minutes remain", async () => {
  const service = createService({ event: createEvent({ status: "live", startedAt: eventStart }) });

  const response = await service.createEventTicket(owner as never, eventId.toString(), createTicketPayload() as never);

  assert.equal(response.status, "live");
  assert.equal(response.tickets.length, 1);
});

test("ticket creation is rejected at exactly 30 minutes before event end", async () => {
  let addCalled = false;
  const service = createService({
    now: new Date("2026-07-20T21:30:00.000Z"),
    onAddTicket: () => {
      addCalled = true;
    },
  });

  await assertTicketError(
    () => service.createEventTicket(owner as never, eventId.toString(), createTicketPayload() as never),
    422,
    "TICKET_CREATION_CUTOFF",
  );
  assert.equal(addCalled, false);
});

test("ticket creation is rejected with less than 30 minutes remaining", async () => {
  const service = createService({ now: new Date("2026-07-20T21:31:00.000Z") });

  await assertTicketError(
    () => service.createEventTicket(owner as never, eventId.toString(), createTicketPayload() as never),
    422,
    "TICKET_CREATION_CUTOFF",
  );
});

test("completed and cancelled events reject ticket creation", async () => {
  for (const status of ["completed", "cancelled"]) {
    const service = createService({ event: createEvent({ status }) });

    await assertTicketError(
      () => service.createEventTicket(owner as never, eventId.toString(), createTicketPayload() as never),
      422,
    );
  }
});

test("non-owner cannot create a ticket", async () => {
  const service = createService();

  await assertTicketError(
    () => service.createEventTicket(otherUser as never, eventId.toString(), createTicketPayload() as never),
    404,
  );
});

test("salesEndAt before event end is accepted", async () => {
  const service = createService();

  const response = await service.createEventTicket(owner as never, eventId.toString(), createTicketPayload({
    salesEndAt: new Date("2026-07-20T21:29:59.000Z"),
  }) as never);

  assert.equal(response.tickets.length, 1);
});

test("salesEndAt equal to event end is rejected as a time error", async () => {
  const service = createService();

  await assertTicketError(
    () => service.createEventTicket(owner as never, eventId.toString(), createTicketPayload({
      salesEndAt: new Date("2026-07-20T22:00:00.000Z"),
    }) as never),
    422,
    "TICKET_SALES_END_TIME_NOT_BEFORE_EVENT_END",
  );
});

test("salesEndAt after the event end date is rejected as a date error", async () => {
  const service = createService();

  await assertTicketError(
    () => service.createEventTicket(owner as never, eventId.toString(), createTicketPayload({
      salesEndAt: new Date("2026-07-21T00:00:00.000Z"),
    }) as never),
    422,
    "TICKET_SALES_END_DATE_AFTER_EVENT_END",
  );
});

test("old event-start cutoff no longer blocks a valid live-event ticket", async () => {
  const service = createService({
    event: createEvent({
      status: "live",
      scheduledAt: new Date("2026-07-20T19:00:00.000Z"),
      endAt: new Date("2026-07-20T22:00:00.000Z"),
      startedAt: new Date("2026-07-20T19:00:00.000Z"),
    }),
    now: new Date("2026-07-20T20:00:00.000Z"),
  });

  const response = await service.createEventTicket(owner as never, eventId.toString(), createTicketPayload({
    salesEndAt: new Date("2026-07-20T21:00:00.000Z"),
  }) as never);

  assert.equal(response.tickets.length, 1);
});

test("price edit succeeds when more than 30 minutes remain", async () => {
  const service = createService({ event: createEvent({ tickets: [createTicket()] }) });

  const response = await service.updateEventTicket(owner as never, eventId.toString(), "ticket-1", {
    price: 12,
  } as never);

  assert.equal(response.tickets[0]?.price, 12);
});

test("price edit is rejected at exactly 30 minutes before event end", async () => {
  const service = createService({
    event: createEvent({ tickets: [createTicket()] }),
    now: new Date("2026-07-20T21:30:00.000Z"),
  });

  await assertTicketError(
    () => service.updateEventTicket(owner as never, eventId.toString(), "ticket-1", { price: 12 } as never),
    422,
    "TICKET_PRICE_EDIT_CUTOFF",
  );
});

test("price edit is rejected with less than 30 minutes remaining", async () => {
  const service = createService({
    event: createEvent({ tickets: [createTicket()] }),
    now: new Date("2026-07-20T21:31:00.000Z"),
  });

  await assertTicketError(
    () => service.updateEventTicket(owner as never, eventId.toString(), "ticket-1", { price: 12 } as never),
    422,
    "TICKET_PRICE_EDIT_CUTOFF",
  );
});

test("non-price edit keeps existing behavior when the price remains unchanged after cutoff", async () => {
  const service = createService({
    event: createEvent({ tickets: [createTicket()] }),
    now: new Date("2026-07-20T21:31:00.000Z"),
  });

  const response = await service.updateEventTicket(owner as never, eventId.toString(), "ticket-1", {
    name: "General Updated",
  } as never);

  assert.equal(response.tickets[0]?.id, "ticket-1");
  assert.equal(response.tickets[0]?.name, "General Updated");
  assert.equal(response.tickets[0]?.price, 10);
});

test("normalized unchanged price is not treated as a price change", async () => {
  const service = createService({
    event: createEvent({ tickets: [createTicket({ price: 10 })] }),
    now: new Date("2026-07-20T21:31:00.000Z"),
  });

  const response = await service.updateEventTicket(owner as never, eventId.toString(), "ticket-1", {
    price: 10.0,
    description: "Updated description",
  } as never);

  assert.equal(response.tickets[0]?.price, 10);
  assert.equal(response.tickets[0]?.description, "Updated description");
});

test("existing ticket id is preserved during edit", async () => {
  const service = createService({ event: createEvent({ tickets: [createTicket()] }) });

  const response = await service.updateEventTicket(owner as never, eventId.toString(), "ticket-1", {
    name: "Renamed",
  } as never);

  assert.equal(response.tickets[0]?.id, "ticket-1");
});

test("invalid creation does not create a duplicate ticket", async () => {
  let draftUpdatePayload: Record<string, unknown> | null = null;
  const existingTicket = createTicket();
  const service = createService({
    event: createEvent({
      status: "draft",
      tickets: [existingTicket],
      publishedAt: null,
    }),
    now: new Date("2026-07-20T21:31:00.000Z"),
    onUpdateDraft: (payload) => {
      draftUpdatePayload = payload;
    },
  });

  await assertTicketError(
    () => service.createDraftTicket(owner as never, eventId.toString(), createTicketPayload() as never),
    422,
    "TICKET_CREATION_CUTOFF",
  );
  assert.equal(draftUpdatePayload, null);
});

test("event schedule update is blocked when endAt would enter the ticket creation cutoff", async () => {
  let updatePayload: Record<string, unknown> | null = null;
  const service = createService({
    event: createEvent({
      endAt: new Date("2026-07-20T22:00:00.000Z"),
    }),
    now: new Date("2026-07-20T20:00:00.000Z"),
    onUpdateEvent: (payload) => {
      updatePayload = payload;
    },
  });

  await assertTicketError(
    () => service.updateEvent(owner as never, eventId.toString(), {
      endAt: new Date("2026-07-20T20:30:00.000Z"),
    } as never),
    422,
    "TICKET_CREATION_CUTOFF",
  );
  assert.equal(updatePayload, null);
});
