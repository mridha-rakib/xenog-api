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

const now = new Date("2026-07-08T19:30:00.000Z");
const eventId = new Types.ObjectId();
const paidUserId = new Types.ObjectId();
const sharedUserId = new Types.ObjectId();
const unrelatedUserId = new Types.ObjectId();

const createUser = (id: Types.ObjectId) => ({
  id: id.toString(),
  name: "Ticket User",
  username: "ticketuser",
  email: "ticket@example.com",
  accountType: "personal",
  currentLocationSharingEnabled: false,
  notificationsEnabled: true,
  role: "user",
  isActive: true,
  emailVerified: true,
  createdAt: now,
  updatedAt: now,
});

const createEvent = (overrides: Record<string, unknown> = {}) => ({
  _id: eventId,
  userId: new Types.ObjectId(),
  status: "published",
  name: "Ticketed Event",
  scheduledAt: new Date("2026-07-08T20:00:00.000Z"),
  endAt: new Date("2026-07-08T22:00:00.000Z"),
  ...overrides,
});

const createEventService = (
  overrides: {
    event?: unknown;
    paidUserIds?: string[];
    sharedUserIds?: string[];
  } = {},
) => {
  const event = Object.prototype.hasOwnProperty.call(overrides, "event")
    ? overrides.event
    : createEvent();
  const paidUserIds = new Set(overrides.paidUserIds ?? []);
  const sharedUserIds = new Set(overrides.sharedUserIds ?? []);

  return new EventService(
    { findById: async () => event },
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {
      hasUserPaidTicketForEvent: async (userId: string, requestedEventId: string) =>
        requestedEventId === eventId.toString() && paidUserIds.has(userId),
    },
    {} as never,
    {} as never,
    {
      hasActiveShareForRecipientAtEvent: async (userId: string, requestedEventId: string) =>
        requestedEventId === eventId.toString() && sharedUserIds.has(userId),
    },
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
      findByEventIdAndHolderUserId: async () => {
        throw new Error("generic ticket access must not require check-in");
      },
    },
    {} as never,
  );
};

test("paid ticket holder gets generic ticket access before check-in", async () => {
  const service = createEventService({ paidUserIds: [paidUserId.toString()] });

  const access = await service.getTicketAccess(
    createUser(paidUserId) as never,
    eventId.toString(),
  );

  assert.deepEqual(access, { hasAccess: true });
});

test("active shared ticket recipient gets generic ticket access before check-in", async () => {
  const service = createEventService({ sharedUserIds: [sharedUserId.toString()] });

  const access = await service.getTicketAccess(
    createUser(sharedUserId) as never,
    eventId.toString(),
  );

  assert.deepEqual(access, { hasAccess: true });
});

test("unrelated authenticated user does not get generic ticket access", async () => {
  const service = createEventService();

  const access = await service.getTicketAccess(
    createUser(unrelatedUserId) as never,
    eventId.toString(),
  );

  assert.deepEqual(access, { hasAccess: false });
});

test("generic ticket access is still ownership based after event end or completion", async () => {
  const endedEventService = createEventService({
    event: createEvent({
      status: "completed",
      endAt: new Date("2026-07-08T19:00:00.000Z"),
      completedAt: new Date("2026-07-08T19:05:00.000Z"),
    }),
    paidUserIds: [paidUserId.toString()],
  });

  const access = await endedEventService.getTicketAccess(
    createUser(paidUserId) as never,
    eventId.toString(),
  );

  assert.deepEqual(access, { hasAccess: true });
});

test("missing event still returns not found for generic ticket access", async () => {
  const service = createEventService({ event: null, paidUserIds: [paidUserId.toString()] });

  await assert.rejects(
    () => service.getTicketAccess(createUser(paidUserId) as never, eventId.toString()),
    { statusCode: 404 },
  );
});
