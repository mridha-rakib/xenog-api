import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { createCheckoutTicketPasses } from "../src/modules/payments/ticket-check-in-code.js";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const now = new Date("2026-07-06T00:00:00.000Z");
const eventId = new Types.ObjectId();
const orderId = new Types.ObjectId();
const hostId = new Types.ObjectId();
const ownerId = new Types.ObjectId();
const recipientId = new Types.ObjectId();
const ticketId = "ticket-standard";

const lineItem = (quantity: number) => ({
  itemType: "ticket" as const,
  itemId: ticketId,
  eventId: eventId.toString(),
  name: "Standard",
  quantity,
  paidQuantity: quantity,
  freeQuantity: 0,
  totalQuantity: quantity,
  unitAmount: 10,
  totalAmount: quantity * 10,
});

test("one purchased ticket receives one formatted check-in code", () => {
  const passes = createCheckoutTicketPasses([lineItem(1)], now);

  assert.equal(passes.length, 1);
  assert.match(passes[0]!.checkInCode, /^MOM-26-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
});

test("five purchased tickets receive five different check-in codes", () => {
  const passes = createCheckoutTicketPasses([lineItem(5)], now);

  assert.equal(passes.length, 5);
  assert.equal(new Set(passes.map((pass) => pass.checkInCode)).size, 5);
  assert.deepEqual(passes.map((pass) => pass.ticketIndex), [1, 2, 3, 4, 5]);
});

type ServiceOverrides = {
  concurrentCreate?: boolean;
  eventStatus?: string;
  hostUserId?: string;
  paymentStatus?: string;
  selectedEventId?: string;
  shared?: boolean;
};

const createCheckInService = async (overrides: ServiceOverrides = {}) => {
  const { CheckoutPaymentService } = await import("../src/modules/payments/checkout-payment.service.js");
  const [pass] = createCheckoutTicketPasses([lineItem(1)], now);
  let usage: Record<string, unknown> | null = null;
  let successfulUsageCreates = 0;

  const order = {
    _id: orderId,
    userId: ownerId,
    kind: "ticket",
    paymentStatus: overrides.paymentStatus ?? "paid",
    lineItems: [lineItem(1)],
    ticketPasses: [pass],
  };
  const event = {
    _id: eventId,
    userId: new Types.ObjectId(overrides.hostUserId ?? hostId.toString()),
    status: overrides.eventStatus ?? "published",
    name: "Launch Night",
    tickets: [{ id: ticketId, name: "Standard", type: "pay", price: 10, capacity: 100 }],
    rewards: [],
  };
  const repository = {
    findByCheckInCode: async (code: string) => code === pass!.checkInCode ? order : null,
  };
  const eventRepository = { findById: async () => event };
  const ticketShareRepository = {
    findActiveByTicketPass: async () => overrides.shared
      ? { _id: new Types.ObjectId(), recipientUserId: recipientId }
      : null,
  };
  const ticketUsageRepository = {
    findByTicketPass: async () => overrides.concurrentCreate ? null : usage,
    create: async (payload: Record<string, unknown>) => {
      if (usage) {
        throw Object.assign(new Error("duplicate ticket usage"), { code: 11000 });
      }

      usage = { _id: new Types.ObjectId(), ...payload, usedAt: now };
      successfulUsageCreates += 1;
      return usage;
    },
  };
  const userRepository = {
    findById: async (id: string) => ({ _id: new Types.ObjectId(id), name: id === recipientId.toString() ? "Recipient" : "Owner" }),
  };
  const service = new CheckoutPaymentService(
    repository as never,
    eventRepository as never,
    {} as never,
    {} as never,
    userRepository as never,
    {} as never,
    ticketShareRepository as never,
    ticketUsageRepository as never,
    {} as never,
  );
  const host = {
    id: hostId.toString(),
    name: "Host",
    email: "host@example.com",
    accountType: "business",
    currentLocationSharingEnabled: false,
    notificationsEnabled: true,
    role: "user",
    isActive: true,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  };

  return {
    checkInCode: pass!.checkInCode,
    getUsage: () => usage,
    getSuccessfulUsageCreates: () => successfulUsageCreates,
    host,
    selectedEventId: overrides.selectedEventId ?? eventId.toString(),
    service,
  };
};

test("QR and manual code check-in create the existing TicketUsage identity", async () => {
  const fixture = await createCheckInService();
  const result = await fixture.service.scanTicket(fixture.host as never, { checkInCode: fixture.checkInCode });
  const usage = fixture.getUsage();

  assert.equal(result.ticketNo, fixture.checkInCode);
  assert.equal(usage?.eventId, eventId.toString());
  assert.equal(usage?.ticketId, ticketId);
  assert.equal(usage?.ticketIndex, 1);
  assert.equal(usage?.holderUserId, ownerId.toString());
});

test("the same code cannot be checked in twice", async () => {
  const fixture = await createCheckInService();
  await fixture.service.scanTicket(fixture.host as never, { checkInCode: fixture.checkInCode });

  await assert.rejects(
    () => fixture.service.scanTicket(fixture.host as never, { checkInCode: fixture.checkInCode }),
    { message: "This ticket has already been checked in", statusCode: 409 },
  );
});

test("simultaneous scans create exactly one TicketUsage and return a clean duplicate error", async () => {
  const fixture = await createCheckInService({ concurrentCreate: true });
  const results = await Promise.allSettled([
    fixture.service.scanTicket(fixture.host as never, { checkInCode: fixture.checkInCode }),
    fixture.service.scanTicket(fixture.host as never, { checkInCode: fixture.checkInCode }),
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(fixture.getSuccessfulUsageCreates(), 1);
  assert.equal(
    (rejected[0] as PromiseRejectedResult).reason.message,
    "This ticket has already been checked in",
  );
  assert.equal((rejected[0] as PromiseRejectedResult).reason.statusCode, 409);
});

test("checkout schema rejects pass arrays that are not one-to-one with ticket quantity", async () => {
  const { CheckoutOrderModel } = await import("../src/modules/payments/checkout-payment.model.js");
  const [pass] = createCheckoutTicketPasses([lineItem(2)], now);
  const order = new CheckoutOrderModel({
    userId: ownerId,
    kind: "ticket",
    paymentMethod: "card",
    paymentStatus: "paid",
    payoutStatus: "not_ready",
    currency: "usd",
    subtotalAmount: 20,
    platformFeeAmount: 2,
    taxAmount: 0,
    totalAmount: 22,
    amountMinor: 2200,
    lineItems: [lineItem(2)],
    ticketPasses: [pass],
    anonymous: false,
  });

  await assert.rejects(() => order.validate(), /Ticket passes must map one-to-one/);
  const indexes = CheckoutOrderModel.schema.indexes();
  const checkInIndex = indexes.find(([fields]) => fields["ticketPasses.checkInCode"] === 1);
  assert.equal(checkInIndex?.[1]?.unique, true);
});

test("a non-existent code returns Invalid ticket", async () => {
  const fixture = await createCheckInService();

  await assert.rejects(
    () => fixture.service.scanTicket(fixture.host as never, { checkInCode: "MOM-26-AAAA-BBBB" }),
    { message: "Invalid ticket", statusCode: 404 },
  );
});

test("an active shared ticket checks in the current recipient", async () => {
  const fixture = await createCheckInService({ shared: true });
  const result = await fixture.service.scanTicket(fixture.host as never, {
    checkInCode: fixture.checkInCode,
    eventId: fixture.selectedEventId,
  });

  assert.equal(result.source, "shared");
  assert.equal(result.holderUserId, recipientId.toString());
  assert.equal(fixture.getUsage()?.holderUserId, recipientId.toString());
});

test("wrong event, wrong host, cancelled event, and refunded order are rejected", async () => {
  const wrongEvent = await createCheckInService();
  await assert.rejects(
    () => wrongEvent.service.scanTicket(wrongEvent.host as never, {
      checkInCode: wrongEvent.checkInCode,
      eventId: new Types.ObjectId().toString(),
    }),
    { message: "Invalid ticket", statusCode: 400 },
  );

  const wrongHost = await createCheckInService({ hostUserId: new Types.ObjectId().toString() });
  await assert.rejects(
    () => wrongHost.service.scanTicket(wrongHost.host as never, { checkInCode: wrongHost.checkInCode }),
    { statusCode: 403 },
  );

  const cancelled = await createCheckInService({ eventStatus: "cancelled" });
  await assert.rejects(
    () => cancelled.service.scanTicket(cancelled.host as never, { checkInCode: cancelled.checkInCode }),
    { message: "This ticket has been cancelled or refunded", statusCode: 409 },
  );

  const refunded = await createCheckInService({ paymentStatus: "refunded" });
  await assert.rejects(
    () => refunded.service.scanTicket(refunded.host as never, { checkInCode: refunded.checkInCode }),
    { message: "This ticket has been cancelled or refunded", statusCode: 409 },
  );
});
