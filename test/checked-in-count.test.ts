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
  status: "published",
  name: "Checked-In Count Test",
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

const usageForPass = (
  order: ReturnType<typeof createOrder>,
  event: IEvent,
  ticketIndex: number,
  holderUserId = order.userId,
) => ({
  _id: new Types.ObjectId(),
  ownerUserId: order.userId,
  holderUserId,
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

test("event with no TicketUsage rows receives checkedInCount 0", async () => {
  const event = createEvent(100);
  const service = createService({});

  const result = await service.getCheckedInCountsByEventId([event]);

  assert.equal(result.get(event._id.toString()), 0);
});

test("checkedInCount is available for non-live (published) events, unlike crowdStatus", async () => {
  const event = createEvent(100, { status: "published" });
  const order = createOrder(event, 1);
  const service = createService({
    orders: [order],
    usages: [usageForPass(order, event, 1)],
  });

  const counts = await service.getCheckedInCountsByEventId([event]);
  const crowdStatuses = await service.getCrowdStatusByEventId([event]);

  assert.equal(counts.get(event._id.toString()), 1);
  assert.equal(crowdStatuses.get(event._id.toString()), null);
});

test("one successful checked-in pass counts as 1", async () => {
  const event = createEvent(10);
  const order = createOrder(event, 1);
  const service = createService({
    orders: [order],
    usages: [usageForPass(order, event, 1)],
  });

  const result = await service.getCheckedInCountsByEventId([event]);

  assert.equal(result.get(event._id.toString()), 1);
});

test("multiple checked-in passes for the same holder user count separately (no dedupe by user)", async () => {
  const event = createEvent(10);
  const order = createOrder(event, 3);
  const service = createService({
    orders: [order],
    usages: [
      usageForPass(order, event, 1),
      usageForPass(order, event, 2),
      usageForPass(order, event, 3),
    ],
  });

  const result = await service.getCheckedInCountsByEventId([event]);

  assert.equal(result.get(event._id.toString()), 3);
});

test("counts are grouped correctly by event and one event never receives another event's count", async () => {
  const eventA = createEvent(10);
  const eventB = createEvent(10);
  const orderA = createOrder(eventA, 2);
  const orderB = createOrder(eventB, 1);
  const service = createService({
    orders: [orderA, orderB],
    usages: [
      usageForPass(orderA, eventA, 1),
      usageForPass(orderA, eventA, 2),
      usageForPass(orderB, eventB, 1),
    ],
  });

  const result = await service.getCheckedInCountsByEventId([eventA, eventB]);

  assert.equal(result.get(eventA._id.toString()), 2);
  assert.equal(result.get(eventB._id.toString()), 1);
});

test("duplicate usage rows for the same ticket pass are counted once (existing dedupe semantics preserved)", async () => {
  const event = createEvent(10);
  const order = createOrder(event, 1);
  const service = createService({
    orders: [order],
    usages: [
      usageForPass(order, event, 1),
      usageForPass(order, event, 1),
    ],
  });

  const result = await service.getCheckedInCountsByEventId([event]);

  assert.equal(result.get(event._id.toString()), 1);
});

test("cancelled passes are excluded from checkedInCount but other passes in the same order still count", async () => {
  const event = createEvent(10);
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

  const result = await service.getCheckedInCountsByEventId([event]);

  assert.equal(result.get(event._id.toString()), 1);
});

test("BOGO rewarded physical passes are counted like any other valid checked-in pass", async () => {
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

  const result = await service.getCheckedInCountsByEventId([event]);

  assert.equal(result.get(event._id.toString()), 2);
});

test("getCrowdStatusByEventId classification is unchanged after extracting the shared counting helper", async () => {
  const event = createEvent(1000, { status: "live" });
  const order = createOrder(event, 339);
  const service = createService({
    orders: [order],
    usages: order.ticketPasses.map((pass) => usageForPass(order, event, pass.ticketIndex)),
  });

  const crowdStatuses = await service.getCrowdStatusByEventId([event]);
  const counts = await service.getCheckedInCountsByEventId([event]);

  assert.equal(crowdStatuses.get(event._id.toString()), "not_busy");
  assert.equal(counts.get(event._id.toString()), 339);
});

test("does not issue one query per event: repository batch methods receive all event IDs together", async () => {
  const eventA = createEvent(10);
  const eventB = createEvent(10);
  const orderA = createOrder(eventA, 1);
  const orderB = createOrder(eventB, 1);
  let ordersCallCount = 0;
  let usagesCallCount = 0;
  let receivedEventIds: string[] = [];

  const service = new CrowdStatusService(
    {
      findIssuedTicketOrdersByEventIds: async (eventIds: string[]) => {
        ordersCallCount += 1;
        receivedEventIds = eventIds;
        return [orderA, orderB];
      },
    } as never,
    { findByEventIds: async () => [] } as never,
    {
      findByEventIdsAndOrderIds: async () => {
        usagesCallCount += 1;
        return [
          usageForPass(orderA, eventA, 1),
          usageForPass(orderB, eventB, 1),
        ];
      },
    } as never,
  );

  const result = await service.getCheckedInCountsByEventId([eventA, eventB]);

  assert.equal(ordersCallCount, 1, "findIssuedTicketOrdersByEventIds should be called once for the whole batch");
  assert.equal(usagesCallCount, 1, "findByEventIdsAndOrderIds should be called once for the whole batch");
  assert.equal(receivedEventIds.length, 2);
  assert.equal(result.get(eventA._id.toString()), 1);
  assert.equal(result.get(eventB._id.toString()), 1);
});

test("checkedInCount for an empty event list resolves without querying repositories", async () => {
  let called = false;
  const service = new CrowdStatusService(
    { findIssuedTicketOrdersByEventIds: async () => { called = true; return []; } } as never,
    { findByEventIds: async () => [] } as never,
    { findByEventIdsAndOrderIds: async () => [] } as never,
  );

  const result = await service.getCheckedInCountsByEventId([]);

  assert.equal(result.size, 0);
  assert.equal(called, false);
});
