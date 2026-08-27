import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import type { EventReward, IEvent } from "../src/modules/events/event.interface.js";
import type { CheckoutOrderLineItem, ICheckoutOrder } from "../src/modules/payments/checkout-payment.interface.js";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "sk_test_mocked";
process.env.STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY ?? "pk_test_mocked";
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_mocked";
process.env.STRIPE_CURRENCY = process.env.STRIPE_CURRENCY ?? "usd";

const buyerId = new Types.ObjectId("64f000000000000000000401");
const hostId = new Types.ObjectId("64f000000000000000000402");
const eventId = new Types.ObjectId("64f000000000000000000403");
const ticketId = "free-ga";
const baseNow = new Date("2026-08-01T12:00:00.000Z");
const farFuture = () => new Date(Date.now() + 24 * 60 * 60 * 1000);

const buyer = { id: buyerId.toString(), name: "Buyer", username: "buyer", email: "buyer@example.com", accountType: "personal", role: "user" };

const taxZero = {
  amount: 0,
  status: "configuration_unavailable_zero_fallback" as const,
  provider: "none" as const,
  calculationId: null,
  transactionId: null,
  failureCode: "STRIPE_TAX_DISABLED",
  failureReason: "Stripe Tax is disabled.",
  venueSnapshot: null,
  jurisdictionSummary: null,
  calculatedAt: baseNow,
};

test.afterEach(async () => {
  const { RedisClient } = await import("../src/config/redis.js");
  await RedisClient.disconnect().catch(() => undefined);
});

const createFreeEvent = (overrides: Partial<IEvent["tickets"][number]> = {}, rewards: EventReward[] = []): IEvent => ({
  _id: eventId,
  userId: hostId,
  status: "published",
  name: "Free Event",
  description: "Free event",
  bannerImageKey: null,
  bannerOriginalImageKey: null,
  bannerImageDisplay: null,
  ageRestriction: "all_ages",
  category: "Community & Movements",
  categories: ["Community & Movements"],
  hashtags: [],
  scheduledAt: farFuture(),
  endAt: new Date(Date.now() + 27 * 60 * 60 * 1000),
  location: null,
  tickets: [{
    id: ticketId,
    name: "Free GA",
    description: "Entry",
    salesEndAt: farFuture(),
    type: "free",
    price: 0,
    capacity: 100,
    availableCount: 100,
    ...overrides,
  }],
  rewards,
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
} as IEvent);

const createOrder = (payload: Partial<ICheckoutOrder> & { lineItems: CheckoutOrderLineItem[] }): ICheckoutOrder => {
  const createdAt = payload.createdAt ?? baseNow;
  const ticketPasses = payload.ticketPasses ?? payload.lineItems.flatMap((item) =>
    Array.from({ length: item.totalQuantity ?? item.quantity }, (_unused, index) => ({
      eventId: item.eventId ?? eventId.toString(),
      ticketId: item.itemId ?? ticketId,
      ticketIndex: index + 1,
      checkInCode: `MOCK-${new Types.ObjectId().toString()}-${index + 1}`,
    })),
  );

  return {
    _id: payload._id ?? new Types.ObjectId(),
    userId: payload.userId ?? buyerId,
    kind: payload.kind ?? "ticket",
    paymentMethod: payload.paymentMethod ?? "card",
    paymentStatus: payload.paymentStatus ?? "paid",
    payoutStatus: payload.payoutStatus ?? "not_ready",
    currency: payload.currency ?? "usd",
    subtotalAmount: payload.subtotalAmount ?? 0,
    platformFeeAmount: payload.platformFeeAmount ?? 0,
    taxAmount: payload.taxAmount ?? 0,
    discountAmount: payload.discountAmount ?? 0,
    totalAmount: payload.totalAmount ?? 0,
    amountMinor: payload.amountMinor ?? 0,
    taxSnapshot: payload.taxSnapshot ?? taxZero,
    policySnapshot: payload.policySnapshot ?? { termsVersion: "terms-test", refundEscrowVersion: "refund-test", acceptedAt: baseNow },
    lineItems: payload.lineItems,
    ticketPasses,
    stripePaymentIntentId: payload.stripePaymentIntentId ?? null,
    stripeClientSecret: payload.stripeClientSecret ?? null,
    reservedUntil: payload.reservedUntil ?? null,
    anonymous: payload.anonymous ?? false,
    termsAcceptedAt: payload.termsAcceptedAt ?? baseNow,
    paidAt: payload.paidAt ?? baseNow,
    failedAt: payload.failedAt ?? null,
    failureMessage: payload.failureMessage ?? null,
    createdAt,
    updatedAt: payload.updatedAt ?? createdAt,
  };
};

type RedisStub = { status: string; setnx?: (k: string, v: string) => Promise<number>; expire?: () => Promise<number>; del?: () => Promise<number> };

const makeService = async ({
  event = createFreeEvent(),
  activePurchasedCount = 0,
  cancelledByBuyer = 0,
  rewardClaim = null as unknown,
  redis = { status: "end" } as RedisStub,
}: {
  event?: IEvent;
  activePurchasedCount?: number | (() => number);
  cancelledByBuyer?: number;
  rewardClaim?: unknown;
  redis?: RedisStub;
} = {}) => {
  const [{ CheckoutPaymentService }, { RedisClient }] = await Promise.all([
    import("../src/modules/payments/checkout-payment.service.js"),
    import("../src/config/redis.js"),
  ]);
  (RedisClient as unknown as { getClient: () => RedisStub }).getClient = () => redis;

  const createdOrders: ICheckoutOrder[] = [];
  const reserveCalls: Array<{ ticketId: string; qty: number }> = [];
  const releaseCalls: Array<{ ticketId: string; qty: number }> = [];

  const repo = {
    getActivePurchasedCountForTicket: async () =>
      typeof activePurchasedCount === "function" ? activePurchasedCount() : activePurchasedCount,
    findExistingPendingTicketOrder: async () => null,
    // Intentionally returns a pre-existing paid free order to prove the fix no
    // longer short-circuits a legitimate second claim on its mere existence.
    findExistingPaidFreeOrder: async () =>
      createOrder({ _id: new Types.ObjectId("64f0000000000000000004ff"), lineItems: [freeLineItem(1)] }),
    findById: async (id: string) => createdOrders.find((o) => o._id.toString() === id) ?? null,
    create: async (payload: Omit<ICheckoutOrder, "ticketPasses"> & { lineItems: CheckoutOrderLineItem[] }) => {
      const order = createOrder({ ...payload, lineItems: payload.lineItems });
      createdOrders.push(order);
      return order;
    },
  };

  const eventRepository = {
    findById: async () => event,
    reserveTicketAndRewardCapacity: async (_eventId: string, tId: string, qty: number) => {
      reserveCalls.push({ ticketId: tId, qty });
      return event;
    },
    releaseTicketAndRewardCapacity: async (_eventId: string, tId: string, qty: number) => {
      releaseCalls.push({ ticketId: tId, qty });
    },
  };

  const service = new CheckoutPaymentService(
    repo as never,
    eventRepository as never,
    {} as never,
    { create: async () => ({}) } as never,
    { findById: async () => ({ _id: buyerId, name: "Buyer", username: "buyer" }) } as never,
    {} as never,
    {} as never,
    {} as never,
    { create: async () => ({ _id: new Types.ObjectId(), createdAt: baseNow }) } as never,
    {} as never,
    { markWebhookProcessed: async () => true } as never,
    { ensureLatePaymentRefund: async () => undefined } as never,
    {
      countByBuyerEventTicket: async () => cancelledByBuyer,
      countByOrderEventTicket: async () => 0,
    } as never,
    { handleStripeWebhook: async () => undefined } as never,
    { calculate: async () => taxZero } as never,
    { enqueueForOrder: async () => undefined } as never,
    {} as never,
    {} as never,
    {
      findByUserAndReward: async () => rewardClaim,
      reserveCheckoutReward: async () => ({ _id: new Types.ObjectId() }),
      attachCheckoutOrder: async () => ({}),
      markRedeemedByOrder: async () => ({}),
      releaseCheckoutRewardRedemptionAndRestoreCapacity: async () => ({ status: "released", claim: null }),
      releasePendingCheckoutReward: async () => ({}),
    } as never,
  );

  return { service, createdOrders, reserveCalls, releaseCalls };
};

const freeLineItem = (quantity: number): CheckoutOrderLineItem => ({
  itemType: "ticket",
  itemId: ticketId,
  eventId: eventId.toString(),
  name: "Free GA",
  quantity,
  paidQuantity: quantity,
  freeQuantity: 0,
  totalQuantity: quantity,
  unitAmount: 0,
  totalAmount: 0,
});

const claim = (quantity = 1) => ({
  kind: "ticket" as const,
  paymentMethod: "card" as const,
  eventId: eventId.toString(),
  ticketId,
  quantity,
  applyReward: false,
  rewardId: null,
  acceptedTerms: true as const,
});

test("first free claim creates one paid $0 order, one pass, decrements capacity once", async () => {
  const { service, createdOrders, reserveCalls } = await makeService({ activePurchasedCount: 0 });

  const result = await service.createIntent(buyer as never, claim(1));

  assert.equal(createdOrders.length, 1);
  assert.equal(result.order.totalAmount, 0);
  assert.equal(result.paymentIntentClientSecret, null);
  assert.equal(createdOrders[0]?.ticketPasses.length, 1);
  assert.deepEqual(reserveCalls, [{ ticketId, qty: 1 }]);
});

test("second legitimate free claim is NOT swallowed by an existing free order", async () => {
  // Prior owned = 1. findExistingPaidFreeOrder returns a real prior order.
  const { service, createdOrders, reserveCalls } = await makeService({ activePurchasedCount: 1 });

  const result = await service.createIntent(buyer as never, claim(1));

  assert.equal(createdOrders.length, 1, "a brand-new order is created");
  assert.notEqual(result.order.id, "64f0000000000000000004ff", "does not return the pre-existing free order id");
  assert.equal(createdOrders[0]?.ticketPasses.length, 1);
  assert.match(createdOrders[0]?.ticketPasses[0]?.checkInCode ?? "", /^MOM-\d{2}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.deepEqual(reserveCalls, [{ ticketId, qty: 1 }], "capacity decremented again for the second claim");
});

test("third free claim is rejected by the unchanged max-2 rule", async () => {
  const { service, createdOrders, reserveCalls } = await makeService({ activePurchasedCount: 2 });

  await assert.rejects(
    () => service.createIntent(buyer as never, claim(1)),
    /You have already purchased the maximum of 2 tickets of this type/,
  );
  assert.equal(createdOrders.length, 0);
  assert.equal(reserveCalls.length, 0);
});

test("requesting more than the remaining allowance in one free claim is rejected", async () => {
  const { service, createdOrders } = await makeService({ activePurchasedCount: 1 });

  await assert.rejects(
    () => service.createIntent(buyer as never, claim(2)),
    /You can only purchase 1 more ticket of this type/,
  );
  assert.equal(createdOrders.length, 0);
});

test("sequential retries are bounded by max-2: exactly two free orders, third rejected", async () => {
  // activePurchasedCount reflects committed orders — mirrors a lost-response retry.
  const state = { count: 0 };
  const { service, createdOrders, reserveCalls } = await makeService({
    activePurchasedCount: () => state.count,
  });

  await service.createIntent(buyer as never, claim(1));
  state.count = createdOrders.length; // 1
  await service.createIntent(buyer as never, claim(1));
  state.count = createdOrders.length; // 2

  await assert.rejects(() => service.createIntent(buyer as never, claim(1)), /maximum of 2 tickets/);

  assert.equal(createdOrders.length, 2);
  assert.equal(reserveCalls.length, 2, "capacity decremented once per legitimate claim, never for the rejected retry");
  assert.notEqual(createdOrders[0]?._id.toString(), createdOrders[1]?._id.toString());
});

test("concurrent same-attempt double submit is blocked by the Redis checkout lock", async () => {
  let held = false;
  const redis: RedisStub = {
    status: "ready",
    setnx: async () => (held ? 0 : ((held = true), 1)),
    expire: async () => 1,
    del: async () => { held = false; return 1; },
  };
  const { service, createdOrders } = await makeService({ activePurchasedCount: 0, redis });

  held = true; // simulate a lock already held by an in-flight request
  await assert.rejects(
    () => service.createIntent(buyer as never, claim(1)),
    /A checkout is already in progress for this ticket/,
  );
  assert.equal(createdOrders.length, 0);
});

test("quantity-2 free checkout produces one order with two passes and a single capacity decrement of 2", async () => {
  const { service, createdOrders, reserveCalls } = await makeService({ activePurchasedCount: 0 });

  await service.createIntent(buyer as never, claim(2));

  assert.equal(createdOrders.length, 1);
  assert.equal(createdOrders[0]?.ticketPasses.length, 2);
  const codes = createdOrders[0]?.ticketPasses.map((p) => p.checkInCode) ?? [];
  assert.equal(new Set(codes).size, 2, "each pass has a distinct check-in code");
  assert.deepEqual(reserveCalls, [{ ticketId, qty: 2 }]);
});

test("after cancelling one of two free passes the buyer can claim one replacement", async () => {
  // active paid orders still count 2, but 1 pass is cancelled -> effective 1 -> remaining 1.
  const { service, createdOrders, reserveCalls } = await makeService({
    activePurchasedCount: 2,
    cancelledByBuyer: 1,
  });

  const result = await service.createIntent(buyer as never, claim(1));

  assert.equal(createdOrders.length, 1);
  assert.equal(result.order.totalAmount, 0);
  assert.deepEqual(reserveCalls, [{ ticketId, qty: 1 }]);
});

test("a fully cancelled prior free order does not block a fresh claim", async () => {
  const { service, createdOrders } = await makeService({
    activePurchasedCount: 1,
    cancelledByBuyer: 1, // effective owned 0 -> remaining 2
  });

  const result = await service.createIntent(buyer as never, claim(1));

  assert.equal(createdOrders.length, 1);
  assert.equal(result.order.totalAmount, 0);
});

test("reward single-use protection still rejects a repeat reward-applied claim", async () => {
  const reward: EventReward = {
    id: "reward-free-1",
    rewardType: "ticket",
    ticketId,
    productId: null,
    targetName: "Free GA",
    imageKeys: [],
    name: "Free offer",
    description: "Free offer",
    expiresAt: farFuture(),
    discountEnabled: true,
    discountPercent: 100,
    bogoEnabled: false,
    buyQuantity: null,
    freeQuantity: null,
    capacityLimited: false,
    capacity: null,
    availableCount: null,
    disabledAt: null,
  };
  const event = createFreeEvent({}, [reward]);
  const { service, createdOrders } = await makeService({
    event,
    activePurchasedCount: 0,
    rewardClaim: { source: "checkout", status: "redeemed" },
  });

  await assert.rejects(
    () => service.createIntent(buyer as never, { ...claim(1), applyReward: true, rewardId: "reward-free-1" }),
    /already used this offer/,
  );
  assert.equal(createdOrders.length, 0);
});
