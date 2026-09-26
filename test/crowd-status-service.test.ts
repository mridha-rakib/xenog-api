import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { CrowdStatusService } from "../src/modules/payments/crowd-status.service.js";
import type { IEvent } from "../src/modules/events/event.interface.js";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const ticketId = "general";

const createEvent = (capacity: number, overrides: Partial<IEvent> = {}): IEvent => ({
  _id: new Types.ObjectId(),
  userId: new Types.ObjectId(),
  status: "live",
  name: "Crowd Test",
  tickets: [{ id: ticketId, name: "General", type: "pay", price: 10, capacity, availableCount: capacity }],
  rewards: [],
  categories: [],
  privacy: "public",
  memberUserIds: [],
  joinRequests: [],
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
} as IEvent);

const createOrder = (event: IEvent, totalQuantity: number) => {
  const orderId = new Types.ObjectId();

  return {
    _id: orderId,
    userId: new Types.ObjectId(),
    kind: "ticket",
    paymentStatus: "paid",
    lineItems: [{
      itemType: "ticket",
      itemId: ticketId,
      eventId: event._id.toString(),
      name: "General",
      quantity: totalQuantity,
      paidQuantity: totalQuantity,
      freeQuantity: 0,
      totalQuantity,
      unitAmount: 10,
      totalAmount: totalQuantity * 10,
    }],
    ticketPasses: Array.from({ length: totalQuantity }, (_, index) => ({
      eventId: event._id.toString(),
      ticketId,
      ticketIndex: index + 1,
      checkInCode: `MOM-26-TEST-${String(index + 1).padStart(4, "0")}`,
    })),
  };
};

const createService = ({
  orders = [],
  cancellations = [],
  usages = [],
}: {
  orders?: unknown[];
  cancellations?: unknown[];
  usages?: unknown[];
}) => new CrowdStatusService(
  { findIssuedTicketOrdersByEventIds: async () => orders } as never,
  { findByEventIds: async () => cancellations } as never,
  { findByEventIdsAndOrderIds: async () => usages } as never,
);

const usageForPass = (order: ReturnType<typeof createOrder>, event: IEvent, ticketIndex: number) => ({
  _id: new Types.ObjectId(),
  ownerUserId: order.userId,
  holderUserId: order.userId,
  usedByUserId: new Types.ObjectId(),
  orderId: order._id,
  eventId: event._id.toString(),
  ticketId,
  ticketIndex,
  source: "owned",
  usedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
});

test("classifies unrounded crowd percentage boundaries", async () => {
  const cases = [
    { validAdmissions: 1000, checkedIn: 299, expected: "not_busy" },
    { validAdmissions: 100, checkedIn: 30, expected: "busy" },
    { validAdmissions: 1000, checkedIn: 699, expected: "busy" },
    { validAdmissions: 100, checkedIn: 70, expected: "very_busy" },
    { validAdmissions: 100, checkedIn: 100, expected: "very_busy" },
  ] as const;

  for (const item of cases) {
    const event = createEvent(10_000);
    const order = createOrder(event, item.validAdmissions);
    const service = createService({
      orders: [order],
      usages: order.ticketPasses
        .slice(0, item.checkedIn)
        .map((pass) => usageForPass(order, event, pass.ticketIndex)),
    });

    const result = await service.getCrowdStatusByEventId([event]);

    assert.equal(result.get(event._id.toString()), item.expected);
  }
});

test("uses checked-in valid admissions divided by all valid admissions", async () => {
  const cases = [
    { validAdmissions: 100, checkedIn: 76, expected: "very_busy" },
    { validAdmissions: 300, checkedIn: 130, expected: "busy" },
    { validAdmissions: 50, checkedIn: 8, expected: "not_busy" },
  ] as const;

  for (const item of cases) {
    const event = createEvent(1_000);
    const order = createOrder(event, item.validAdmissions);
    const service = createService({
      orders: [order],
      usages: order.ticketPasses
        .slice(0, item.checkedIn)
        .map((pass) => usageForPass(order, event, pass.ticketIndex)),
    });

    const result = await service.getCrowdStatusByEventId([event]);

    assert.equal(result.get(event._id.toString()), item.expected, `${item.checkedIn}/${item.validAdmissions}`);
  }
});

test("returns null for a live event with positive capacity but zero valid admissions", async () => {
  const event = createEvent(100);
  const service = createService({});
  const result = await service.getCrowdStatusByEventId([event]);

  assert.equal(result.get(event._id.toString()), null);
});

test("returns null for non-live and zero-capacity events", async () => {
  const published = createEvent(100, { status: "published" });
  const zeroCapacity = createEvent(0);
  const service = createService({});
  const result = await service.getCrowdStatusByEventId([published, zeroCapacity]);

  assert.equal(result.get(published._id.toString()), null);
  assert.equal(result.get(zeroCapacity._id.toString()), null);
});

test("excludes cancelled passes but preserves other passes in the same order", async () => {
  const event = createEvent(2);
  const order = createOrder(event, 2);
  const service = createService({
    orders: [order],
    usages: [
      usageForPass(order, event, 1),
      usageForPass(order, event, 2),
    ],
    cancellations: [{
      eventId: event._id.toString(),
      ticketId,
      orderId: order._id,
      ticketIndex: 1,
    }],
  });
  const result = await service.getCrowdStatusByEventId([event]);

  assert.equal(result.get(event._id.toString()), "very_busy");
});

test("excludes refunded and unpaid orders from both valid admissions and check-ins", async () => {
  const event = createEvent(1_000);
  const paidOrder = createOrder(event, 10);
  const refundedOrder = { ...createOrder(event, 90), paymentStatus: "refunded" };
  const unpaidOrder = { ...createOrder(event, 90), paymentStatus: "requires_payment" };
  const service = createService({
    orders: [paidOrder, refundedOrder, unpaidOrder],
    usages: [
      ...paidOrder.ticketPasses.map((pass) => usageForPass(paidOrder, event, pass.ticketIndex)),
      ...refundedOrder.ticketPasses.map((pass) => usageForPass(refundedOrder, event, pass.ticketIndex)),
      ...unpaidOrder.ticketPasses.map((pass) => usageForPass(unpaidOrder, event, pass.ticketIndex)),
    ],
  });

  const result = await service.getCrowdStatusByEventId([event]);

  assert.equal(result.get(event._id.toString()), "very_busy");
});

test("counts BOGO rewarded physical passes in both valid admissions and checked-in admissions", async () => {
  const event = createEvent(100, {
    rewards: [{
      id: "reward-1",
      rewardType: "ticket",
      ticketId,
      productId: null,
      targetName: null,
      imageKeys: [],
      name: "BOGO",
      description: null,
      expiresAt: null,
      discountPercent: 0,
      buyQuantity: 1,
      freeQuantity: 1,
      capacity: 50,
      availableCount: 49,
    }],
  });
  const order = createOrder(event, 2);
  order.lineItems[0]!.quantity = 1;
  order.lineItems[0]!.paidQuantity = 1;
  order.lineItems[0]!.freeQuantity = 1;
  order.lineItems[0]!.totalQuantity = 2;
  const service = createService({
    orders: [order],
    usages: [
      usageForPass(order, event, 1),
      usageForPass(order, event, 2),
    ],
  });
  const result = await service.getCrowdStatusByEventId([event]);

  assert.equal(result.get(event._id.toString()), "very_busy");
});

test("uses issued admission passes rather than configured capacity", async () => {
  const event = createEvent(100);
  const order = createOrder(event, 10);
  const service = createService({
    orders: [order],
    usages: order.ticketPasses.slice(0, 8).map((pass) => usageForPass(order, event, pass.ticketIndex)),
  });

  const result = await service.getCrowdStatusByEventId([event]);

  assert.equal(result.get(event._id.toString()), "very_busy");
});

test("counts admission units, not unique owners", async () => {
  const event = createEvent(100);
  const order = createOrder(event, 3);
  const service = createService({
    orders: [order],
    usages: [usageForPass(order, event, 1)],
  });

  const result = await service.getCrowdStatusByEventId([event]);

  assert.equal(result.get(event._id.toString()), "busy");
});
