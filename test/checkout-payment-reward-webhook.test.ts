import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import type { EventReward, IEvent } from "../src/modules/events/event.interface.js";
import type { CheckoutOrderLineItem, ICheckoutOrder } from "../src/modules/payments/checkout-payment.interface.js";
import type { ITicketCancellation } from "../src/modules/payments/ticket-cancellation.interface.js";

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

const buyerId = new Types.ObjectId("64f000000000000000000201");
const hostId = new Types.ObjectId("64f000000000000000000202");
const eventId = new Types.ObjectId("64f000000000000000000203");
const ticketId = "general";
const baseNow = new Date("2026-08-01T12:00:00.000Z");

const buyer = {
  id: buyerId.toString(),
  name: "Buyer",
  username: "buyer",
  email: "buyer@example.com",
  accountType: "personal",
  role: "user",
};

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

const createReward = (overrides: Partial<EventReward> = {}): EventReward => ({
  id: "reward-1",
  rewardType: "ticket",
  ticketId,
  productId: null,
  targetName: "General",
  imageKeys: [],
  name: "Ticket offer",
  description: "Ticket offer",
  expiresAt: new Date("2026-08-02T12:00:00.000Z"),
  discountEnabled: false,
  discountPercent: null,
  bogoEnabled: false,
  buyQuantity: null,
  freeQuantity: null,
  capacityLimited: true,
  capacity: 10,
  availableCount: 10,
  disabledAt: null,
  ...overrides,
});

const createEvent = (rewards: EventReward[] = []): IEvent => ({
  _id: eventId,
  userId: hostId,
  status: "published",
  name: "Checkout Event",
  description: "Checkout event",
  bannerImageKey: null,
  bannerOriginalImageKey: null,
  bannerImageDisplay: null,
  ageRestriction: "all_ages",
  category: "Live Music & Concerts",
  categories: ["Live Music & Concerts"],
  hashtags: [],
  scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  endAt: new Date(Date.now() + 27 * 60 * 60 * 1000),
  location: null,
  tickets: [{
    id: ticketId,
    name: "General Admission",
    description: "Entry",
    salesEndAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
    type: "pay",
    price: 45,
    capacity: 100,
    availableCount: 100,
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
      checkInCode: `MOCK-${index + 1}`,
    })),
  );

  return {
    _id: payload._id ?? new Types.ObjectId(),
    userId: payload.userId ?? buyerId,
    kind: payload.kind ?? "ticket",
    paymentMethod: payload.paymentMethod ?? "card",
    paymentStatus: payload.paymentStatus ?? "requires_payment",
    payoutStatus: payload.payoutStatus ?? "not_ready",
    currency: payload.currency ?? "usd",
    subtotalAmount: payload.subtotalAmount ?? payload.lineItems.reduce((sum, item) => sum + item.totalAmount, 0),
    platformFeeAmount: payload.platformFeeAmount ?? 0,
    taxAmount: payload.taxAmount ?? 0,
    discountAmount: payload.discountAmount ?? 0,
    totalAmount: payload.totalAmount ?? 0,
    amountMinor: payload.amountMinor ?? Math.round((payload.totalAmount ?? 0) * 100),
    taxSnapshot: payload.taxSnapshot ?? taxZero,
    policySnapshot: payload.policySnapshot ?? {
      termsVersion: "terms-test",
      refundEscrowVersion: "refund-test",
      acceptedAt: baseNow,
    },
    lineItems: payload.lineItems,
    ticketPasses,
    stripePaymentIntentId: payload.stripePaymentIntentId ?? "pi_mock",
    stripeClientSecret: payload.stripeClientSecret ?? "pi_mock_secret",
    reservedUntil: payload.reservedUntil ?? null,
    anonymous: payload.anonymous ?? false,
    termsAcceptedAt: payload.termsAcceptedAt ?? baseNow,
    paidAt: payload.paidAt ?? null,
    failedAt: payload.failedAt ?? null,
    failureMessage: payload.failureMessage ?? null,
    createdAt,
    updatedAt: payload.updatedAt ?? createdAt,
  };
};

const loadServices = async () => {
  const [{ CheckoutPaymentService }, { TicketCancellationService }, { checkoutPaymentValidation }, { RedisClient }] = await Promise.all([
    import("../src/modules/payments/checkout-payment.service.js"),
    import("../src/modules/payments/ticket-cancellation.service.js"),
    import("../src/modules/payments/checkout-payment.validation.js"),
    import("../src/config/redis.js"),
  ]);
  (RedisClient as unknown as { getClient: () => { status: string } }).getClient = () => ({ status: "end" });

  return { CheckoutPaymentService, TicketCancellationService, checkoutPaymentValidation };
};

const makeStripeMock = (events: unknown[] = []) => {
  const paymentIntentCreates: Array<{ payload: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const refundsCreates: unknown[] = [];
  let eventIndex = 0;

  return {
    paymentIntentCreates,
    refundsCreates,
    stripe: {
      paymentIntents: {
        create: async (payload: Record<string, unknown>, options: Record<string, unknown>) => {
          paymentIntentCreates.push({ payload, options });
          return {
            id: `pi_mock_${paymentIntentCreates.length}`,
            client_secret: `pi_mock_${paymentIntentCreates.length}_secret`,
          };
        },
        cancel: async () => ({}),
        retrieve: async () => ({ id: "pi_mock", status: "requires_payment", metadata: {} }),
      },
      refunds: {
        create: async (payload: unknown) => {
          refundsCreates.push(payload);
          return { id: "re_mock" };
        },
      },
      webhooks: {
        constructEvent: () => events[eventIndex++],
      },
    },
  };
};

const makeCheckoutService = async ({
  event = createEvent(),
  repository = {},
  eventRepository = {},
  rewardClaimRepository = {},
  stripeEvents = [],
}: {
  event?: IEvent;
  repository?: Record<string, unknown>;
  eventRepository?: Record<string, unknown>;
  rewardClaimRepository?: Record<string, unknown>;
  stripeEvents?: unknown[];
} = {}) => {
  const { CheckoutPaymentService } = await loadServices();
  const stripeMock = makeStripeMock(stripeEvents);
  const createdOrders: ICheckoutOrder[] = [];

  const repo = {
    getActivePurchasedCountForTicket: async () => 0,
    findExistingPendingTicketOrder: async () => null,
    findExistingPaidFreeOrder: async () => null,
    findById: async (id: string) => createdOrders.find((order) => order._id.toString() === id) ?? null,
    findByPaymentIntentId: async () => null,
    create: async (payload: Omit<ICheckoutOrder, "ticketPasses"> & { lineItems: CheckoutOrderLineItem[] }) => {
      const order = createOrder({
        ...payload,
        stripePaymentIntentId: payload.stripePaymentIntentId,
        stripeClientSecret: payload.stripeClientSecret,
        totalAmount: payload.totalAmount,
        platformFeeAmount: payload.platformFeeAmount,
        subtotalAmount: payload.subtotalAmount,
        discountAmount: payload.discountAmount,
        amountMinor: payload.amountMinor,
        lineItems: payload.lineItems,
      });
      createdOrders.push(order);
      return order;
    },
    markPaidIfFirst: async (id: string, paidAt: Date) => {
      const order = createdOrders.find((item) => item._id.toString() === id);
      if (!order || order.paymentStatus !== "requires_payment") return null;
      order.paymentStatus = "paid";
      order.paidAt = paidAt;
      return order;
    },
    updatePaymentStatusIf: async (id: string, statuses: string[], update: Partial<ICheckoutOrder>) => {
      const order = createdOrders.find((item) => item._id.toString() === id);
      if (!order || !statuses.includes(order.paymentStatus)) return null;
      Object.assign(order, update);
      return order;
    },
    updatePaymentStatus: async (id: string, update: Partial<ICheckoutOrder>) => {
      const order = createdOrders.find((item) => item._id.toString() === id);
      if (!order) return null;
      Object.assign(order, update);
      return order;
    },
    ...repository,
  };

  const service = new CheckoutPaymentService(
    repo as never,
    {
      findById: async () => event,
      reserveTicketAndRewardCapacity: async () => event,
      releaseTicketAndRewardCapacity: async () => undefined,
      ...eventRepository,
    } as never,
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
      countByBuyerEventTicket: async () => 0,
      countByOrderEventTicket: async () => 0,
    } as never,
    { handleStripeWebhook: async () => undefined } as never,
    { calculate: async () => taxZero } as never,
    { enqueueForOrder: async () => undefined } as never,
    {} as never,
    {} as never,
    {
      findByUserAndReward: async () => null,
      reserveCheckoutReward: async () => ({ _id: new Types.ObjectId() }),
      attachCheckoutOrder: async () => ({}),
      markRedeemedByOrder: async () => ({}),
      releaseCheckoutRewardRedemptionAndRestoreCapacity: async () => ({ status: "released", claim: null }),
      ...rewardClaimRepository,
    } as never,
  );

  (service as unknown as { stripe: unknown }).stripe = stripeMock.stripe;

  return { service, createdOrders, stripeMock, repository: repo };
};

test("rewarded checkout pricing and PaymentIntent amounts stay server-authoritative", async () => {
  const cases = [
    {
      name: "normal",
      quantity: 2,
      applyReward: false,
      reward: null,
      expected: { subtotal: 90, fee: 9, discount: 0, total: 99, free: 0, issued: 2, amountMinor: 9900 },
    },
    {
      name: "discount only",
      quantity: 2,
      applyReward: true,
      reward: createReward({ discountEnabled: true, discountPercent: 20 }),
      expected: { subtotal: 72, fee: 9, discount: 18, total: 81, free: 0, issued: 2, amountMinor: 8100 },
    },
    {
      name: "BOGO only",
      quantity: 2,
      applyReward: true,
      reward: createReward({ bogoEnabled: true, buyQuantity: 2, freeQuantity: 1 }),
      expected: { subtotal: 90, fee: 9, discount: 0, total: 99, free: 1, issued: 3, amountMinor: 9900 },
    },
    {
      name: "discount plus BOGO",
      quantity: 2,
      applyReward: true,
      reward: createReward({
        discountEnabled: true,
        discountPercent: 20,
        bogoEnabled: true,
        buyQuantity: 2,
        freeQuantity: 1,
      }),
      expected: { subtotal: 72, fee: 9, discount: 18, total: 81, free: 1, issued: 3, amountMinor: 8100 },
    },
    {
      name: "100% discount still pays platform fee",
      quantity: 1,
      applyReward: true,
      reward: createReward({ discountEnabled: true, discountPercent: 100 }),
      expected: { subtotal: 0, fee: 4.5, discount: 45, total: 4.5, free: 0, issued: 1, amountMinor: 450 },
    },
  ];

  for (const item of cases) {
    const event = createEvent(item.reward ? [item.reward] : []);
    const { service, createdOrders, stripeMock } = await makeCheckoutService({ event });
    const checkout = await service.createIntent(buyer as never, {
      kind: "ticket",
      paymentMethod: "card",
      eventId: eventId.toString(),
      ticketId,
      quantity: item.quantity,
      applyReward: item.applyReward,
      rewardId: item.applyReward ? "reward-1" : null,
      acceptedTerms: true,
    });

    const order = createdOrders[0]!;
    const lineItem = order.lineItems[0]!;
    const rewardSnapshot = lineItem.rewardSnapshot;

    assert.equal(checkout.order.subtotalAmount, item.expected.subtotal, item.name);
    assert.equal(checkout.order.platformFeeAmount, item.expected.fee, item.name);
    assert.equal(checkout.order.discountAmount, item.expected.discount, item.name);
    assert.equal(checkout.order.totalAmount, item.expected.total, item.name);
    assert.equal(order.amountMinor, item.expected.amountMinor, item.name);
    assert.equal(stripeMock.paymentIntentCreates[0]?.payload.amount, item.expected.amountMinor, item.name);
    assert.equal(stripeMock.paymentIntentCreates[0]?.payload.currency, "usd", item.name);
    assert.equal((stripeMock.paymentIntentCreates[0]?.payload.metadata as Record<string, string>).orderId, checkout.order.id, item.name);
    assert.equal(stripeMock.paymentIntentCreates[0]?.options.idempotencyKey, `pi-${checkout.order.id}`, item.name);
    assert.equal(lineItem.totalQuantity, item.expected.issued, item.name);
    assert.equal(lineItem.freeQuantity, item.expected.free, item.name);
    assert.equal(order.ticketPasses.length, item.expected.issued, item.name);

    if (item.applyReward) {
      assert.equal(rewardSnapshot?.originalUnitAmount, 45, item.name);
      assert.equal(rewardSnapshot?.discountAmount, item.expected.discount, item.name);
      assert.equal(rewardSnapshot?.platformFeeAmount, item.expected.fee, item.name);
      assert.equal(rewardSnapshot?.finalAmount, item.expected.total, item.name);
      assert.equal(rewardSnapshot?.freeQuantityIssued, item.expected.free, item.name);
      assert.equal(rewardSnapshot?.totalQuantityIssued, item.expected.issued, item.name);
    } else {
      assert.equal(rewardSnapshot, null, item.name);
    }
  }
});

test("PaymentIntent creation failure releases ticket inventory and pending reward atomically through cleanup helper", async () => {
  const event = createEvent([createReward({ discountEnabled: true, discountPercent: 20 })]);
  const ticketReleaseCalls: unknown[][] = [];
  const rewardReleaseCalls: unknown[] = [];
  const { service, stripeMock } = await makeCheckoutService({
    event,
    eventRepository: {
      releaseTicketAndRewardCapacity: async (...args: unknown[]) => {
        ticketReleaseCalls.push(args);
      },
    },
    rewardClaimRepository: {
      releaseCheckoutRewardRedemptionAndRestoreCapacity: async (payload: unknown) => {
        rewardReleaseCalls.push(payload);
        return { status: "released", claim: null };
      },
    },
  });

  stripeMock.stripe.paymentIntents.create = async () => {
    throw new Error("mock PaymentIntent creation failure");
  };

  await assert.rejects(
    () => service.createIntent(buyer as never, {
      kind: "ticket",
      paymentMethod: "card",
      eventId: eventId.toString(),
      ticketId,
      quantity: 2,
      applyReward: true,
      rewardId: "reward-1",
      acceptedTerms: true,
    }),
    /mock PaymentIntent creation failure/,
  );

  assert.deepEqual(ticketReleaseCalls, [[eventId.toString(), ticketId, 2, null, 0]]);
  assert.deepEqual(rewardReleaseCalls, [{
    userId: buyer.id,
    eventId: eventId.toString(),
    ticketId,
    rewardId: "reward-1",
    claimStatuses: ["pending"],
  }]);
});

test("payment success webhook is idempotent and finalizes reward claim once", async () => {
  const orderId = new Types.ObjectId();
  const event = createEvent([createReward({ bogoEnabled: true, buyQuantity: 2, freeQuantity: 1 })]);
  const order = createOrder({
    _id: orderId,
    lineItems: [{
      itemType: "ticket",
      itemId: ticketId,
      eventId: eventId.toString(),
      sellerUserId: hostId,
      name: "General Admission",
      quantity: 2,
      paidQuantity: 2,
      freeQuantity: 1,
      totalQuantity: 3,
      rewardId: "reward-1",
      rewardSnapshot: {
        rewardId: "reward-1",
        rewardType: "ticket",
        name: "Ticket offer",
        discountEnabled: false,
        discountPercent: null,
        bogoEnabled: true,
        buyQuantity: 2,
        freeQuantity: 1,
        capacityLimited: true,
        originalUnitAmount: 45,
        discountedUnitAmount: 45,
        discountAmount: 0,
        paidQuantity: 2,
        freeQuantityIssued: 1,
        totalQuantityIssued: 3,
        platformFeeAmount: 9,
        finalAmount: 99,
        currency: "usd",
        appliedAt: baseNow,
      },
      unitAmount: 45,
      totalAmount: 90,
    }],
    totalAmount: 99,
    amountMinor: 9900,
  });
  const webhookEvents = [
    {
      id: "evt_success_once",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_success", status: "succeeded", metadata: { orderId: orderId.toString() } } },
    },
    {
      id: "evt_success_once",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_success", status: "succeeded", metadata: { orderId: orderId.toString() } } },
    },
  ];
  let webhookSeen = 0;
  let markRedeemedCount = 0;
  let earningCount = 0;
  let invoiceCount = 0;
  const { service, createdOrders } = await makeCheckoutService({
    event,
    stripeEvents: webhookEvents,
    repository: {
      findById: async () => order,
      markPaidIfFirst: async () => {
        if (order.paymentStatus !== "requires_payment") return null;
        order.paymentStatus = "paid";
        order.paidAt = baseNow;
        return order;
      },
    },
    rewardClaimRepository: {
      markRedeemedByOrder: async () => {
        markRedeemedCount += 1;
        return {};
      },
    },
  });
  createdOrders.push(order);
  (service as unknown as {
    eventCancellationRefundRepository: { markWebhookProcessed: () => Promise<boolean> };
    earningRepository: { create: () => Promise<unknown> };
    invoiceService: { enqueueForOrder: () => Promise<void> };
  }).eventCancellationRefundRepository = {
    markWebhookProcessed: async () => {
      webhookSeen += 1;
      return webhookSeen === 1;
    },
  };
  (service as unknown as { earningRepository: { create: () => Promise<unknown> } }).earningRepository = {
    create: async () => {
      earningCount += 1;
      return {};
    },
  };
  (service as unknown as { invoiceService: { enqueueForOrder: () => Promise<void> } }).invoiceService = {
    enqueueForOrder: async () => {
      invoiceCount += 1;
    },
  };

  await service.handleStripeWebhook("sig", Buffer.from("{}"));
  await service.handleStripeWebhook("sig", Buffer.from("{}"));

  assert.equal(order.paymentStatus, "paid");
  assert.equal(order.ticketPasses.length, 3);
  assert.equal(markRedeemedCount, 1);
  assert.equal(earningCount, 1);
  assert.equal(invoiceCount, 1);
});

test("payment failure webhook cleanup is idempotent and releases reward capacity once", async () => {
  const orderId = new Types.ObjectId();
  const order = createOrder({
    _id: orderId,
    lineItems: [{
      itemType: "ticket",
      itemId: ticketId,
      eventId: eventId.toString(),
      sellerUserId: hostId,
      name: "General Admission",
      quantity: 2,
      paidQuantity: 2,
      freeQuantity: 1,
      totalQuantity: 3,
      rewardId: "reward-1",
      rewardSnapshot: {
        rewardId: "reward-1",
        rewardType: "ticket",
        name: "Ticket offer",
        discountEnabled: false,
        discountPercent: null,
        bogoEnabled: true,
        buyQuantity: 2,
        freeQuantity: 1,
        capacityLimited: true,
        originalUnitAmount: 45,
        discountedUnitAmount: 45,
        discountAmount: 0,
        paidQuantity: 2,
        freeQuantityIssued: 1,
        totalQuantityIssued: 3,
        platformFeeAmount: 9,
        finalAmount: 99,
        currency: "usd",
        appliedAt: baseNow,
      },
      unitAmount: 45,
      totalAmount: 90,
    }],
    totalAmount: 99,
    amountMinor: 9900,
  });
  const webhookEvents = [
    {
      id: "evt_failed_once",
      type: "payment_intent.payment_failed",
      data: {
        object: {
          id: "pi_failed",
          status: "requires_payment_method",
          metadata: { orderId: orderId.toString() },
          last_payment_error: { message: "Card declined" },
        },
      },
    },
    {
      id: "evt_failed_once",
      type: "payment_intent.payment_failed",
      data: {
        object: {
          id: "pi_failed",
          status: "requires_payment_method",
          metadata: { orderId: orderId.toString() },
          last_payment_error: { message: "Card declined" },
        },
      },
    },
  ];
  const ticketReleaseCalls: unknown[][] = [];
  const rewardReleaseCalls: unknown[] = [];
  let webhookSeen = 0;
  const { service, createdOrders } = await makeCheckoutService({
    stripeEvents: webhookEvents,
    repository: {
      findById: async () => order,
      updatePaymentStatusIf: async (_id: string, statuses: string[], update: Partial<ICheckoutOrder>) => {
        if (!statuses.includes(order.paymentStatus)) return null;
        Object.assign(order, update);
        return order;
      },
    },
    eventRepository: {
      releaseTicketAndRewardCapacity: async (...args: unknown[]) => {
        ticketReleaseCalls.push(args);
      },
    },
    rewardClaimRepository: {
      releaseCheckoutRewardRedemptionAndRestoreCapacity: async (payload: unknown) => {
        rewardReleaseCalls.push(payload);
        return { status: "released", claim: null };
      },
    },
  });
  createdOrders.push(order);
  (service as unknown as { eventCancellationRefundRepository: { markWebhookProcessed: () => Promise<boolean> } }).eventCancellationRefundRepository = {
    markWebhookProcessed: async () => {
      webhookSeen += 1;
      return webhookSeen === 1;
    },
  };

  await service.handleStripeWebhook("sig", Buffer.from("{}"));
  await service.handleStripeWebhook("sig", Buffer.from("{}"));

  assert.equal(order.paymentStatus, "failed");
  assert.equal(ticketReleaseCalls.length, 1);
  assert.deepEqual(ticketReleaseCalls[0], [eventId.toString(), ticketId, 3, null, 0]);
  assert.deepEqual(rewardReleaseCalls, [{
    orderId: orderId.toString(),
    eventId: eventId.toString(),
    ticketId,
    rewardId: "reward-1",
    claimStatuses: ["pending", "redeemed"],
  }]);
});

test("stale payment expiration releases pending ticket and reward reservation once", async () => {
  const orderId = new Types.ObjectId();
  const order = createOrder({
    _id: orderId,
    lineItems: [{
      itemType: "ticket",
      itemId: ticketId,
      eventId: eventId.toString(),
      sellerUserId: hostId,
      name: "General Admission",
      quantity: 2,
      paidQuantity: 2,
      freeQuantity: 1,
      totalQuantity: 3,
      rewardId: "reward-1",
      rewardSnapshot: {
        rewardId: "reward-1",
        rewardType: "ticket",
        name: "Ticket offer",
        discountEnabled: false,
        discountPercent: null,
        bogoEnabled: true,
        buyQuantity: 2,
        freeQuantity: 1,
        capacityLimited: true,
        originalUnitAmount: 45,
        discountedUnitAmount: 45,
        discountAmount: 0,
        paidQuantity: 2,
        freeQuantityIssued: 1,
        totalQuantityIssued: 3,
        platformFeeAmount: 9,
        finalAmount: 99,
        currency: "usd",
        appliedAt: baseNow,
      },
      unitAmount: 45,
      totalAmount: 90,
    }],
    totalAmount: 99,
    amountMinor: 9900,
  });
  const ticketReleaseCalls: unknown[][] = [];
  const rewardReleaseCalls: unknown[] = [];
  const { service } = await makeCheckoutService({
    repository: {
      findStaleReservedOrders: async () => [order],
      updatePaymentStatusIf: async (_id: string, statuses: string[], update: Partial<ICheckoutOrder>) => {
        if (!statuses.includes(order.paymentStatus)) return null;
        Object.assign(order, update);
        return order;
      },
    },
    eventRepository: {
      releaseTicketAndRewardCapacity: async (...args: unknown[]) => {
        ticketReleaseCalls.push(args);
      },
    },
    rewardClaimRepository: {
      releaseCheckoutRewardRedemptionAndRestoreCapacity: async (payload: unknown) => {
        rewardReleaseCalls.push(payload);
        return { status: "released", claim: null };
      },
    },
  });

  await service.expireStaleReservations();
  await service.expireStaleReservations();

  assert.equal(order.paymentStatus, "canceled");
  assert.equal(ticketReleaseCalls.length, 1);
  assert.deepEqual(ticketReleaseCalls[0], [eventId.toString(), ticketId, 3, null, 0]);
  assert.deepEqual(rewardReleaseCalls, [{
    orderId: orderId.toString(),
    eventId: eventId.toString(),
    ticketId,
    rewardId: "reward-1",
    claimStatuses: ["pending", "redeemed"],
  }]);
});

test("ticket refund webhook dedupe prevents duplicate cancellation updates", async () => {
  const { TicketCancellationService } = await loadServices();
  const cancellationId = new Types.ObjectId();
  const orderId = new Types.ObjectId();
  const cancellation = {
    _id: cancellationId,
    sourceType: "user_request",
    eventId,
    ticketId,
    orderId,
    ticketIndex: 1,
    buyerUserId: buyerId,
    hostUserId: hostId,
    sharedRecipientUserId: null,
    status: "accepted",
    refundStatus: "processing",
    currency: "usd",
    requestedAmountMinor: 4500,
    completedAmountMinor: 0,
    remainingRefundableAmountMinor: 4500,
    stripePaymentIntentId: "pi_refund",
    stripeRefundId: "re_refund",
    providerStatus: null,
    refundCompletedAt: null,
    notificationState: { buyerRefundCompletedSentAt: baseNow },
    auditHistory: [],
    createdAt: baseNow,
    updatedAt: baseNow,
  } as unknown as ITicketCancellation;
  let webhookSeen = 0;
  const updateCalls: unknown[] = [];
  const service = new TicketCancellationService(
    {
      findById: async () => cancellation,
      findByStripeRefundId: async () => cancellation,
      update: async (_id: string, update: unknown) => {
        updateCalls.push(update);
        return { ...cancellation, completedAmountMinor: 4500, remainingRefundableAmountMinor: 0, refundStatus: "succeeded" };
      },
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {
      markWebhookProcessed: async () => {
        webhookSeen += 1;
        return webhookSeen === 1;
      },
    } as never,
    { sendSystemNotification: async () => undefined } as never,
    {} as never,
    {} as never,
    {} as never,
    { enqueueForTicketCancellation: async () => undefined } as never,
    {} as never,
  );
  const event = {
    id: "evt_refund_once",
    type: "refund.updated",
    data: {
      object: {
        id: "re_refund",
        status: "succeeded",
        amount: 4500,
        metadata: { ticketCancellationId: cancellationId.toString() },
      },
    },
  };

  await service.handleStripeWebhook(event as never);
  await service.handleStripeWebhook(event as never);

  assert.equal(updateCalls.length, 1);
});

test("checkout validation and reward security reject manipulated or invalid reward requests", async () => {
  const { service } = await makeCheckoutService({
    event: createEvent([
      createReward({ id: "disabled", disabledAt: baseNow, discountEnabled: true, discountPercent: 10 }),
      createReward({ id: "expired", expiresAt: new Date("2020-01-01T00:00:00.000Z"), discountEnabled: true, discountPercent: 10 }),
      createReward({ id: "wrong-ticket", ticketId: "vip", discountEnabled: true, discountPercent: 10 }),
      createReward({ id: "bogo-min", bogoEnabled: true, buyQuantity: 2, freeQuantity: 1 }),
      createReward({ id: "used", discountEnabled: true, discountPercent: 10 }),
    ]),
    rewardClaimRepository: {
      findByUserAndReward: async (_userId: string, _eventId: string, rewardId: string) =>
        rewardId === "used" ? { source: "checkout", status: "redeemed" } : null,
    },
  });
  const { checkoutPaymentValidation } = await loadServices();

  assert.throws(
    () => checkoutPaymentValidation.createIntent.parse({
      body: {
        kind: "ticket",
        paymentMethod: "card",
        eventId: eventId.toString(),
        ticketId,
        quantity: 1,
        applyReward: true,
        rewardId: "disabled",
        acceptedTerms: true,
        finalAmount: 0,
        discountPercent: 100,
        freeQuantity: 99,
        platformFeeAmount: 0,
      },
    }),
    /Unrecognized key/,
  );

  await assert.rejects(
    () => service.quoteCheckout(buyer as never, {
      kind: "ticket",
      paymentMethod: "card",
      eventId: eventId.toString(),
      ticketId,
      quantity: 1,
      applyReward: true,
      rewardId: null,
      acceptedTerms: true,
    }),
    /Select an offer/,
  );

  const normalQuote = await service.quoteCheckout(buyer as never, {
    kind: "ticket",
    paymentMethod: "card",
    eventId: eventId.toString(),
    ticketId,
    quantity: 1,
    applyReward: false,
    rewardId: "disabled",
    acceptedTerms: true,
  });
  assert.equal(normalQuote.lineItems[0]?.rewardId, null);
  assert.equal(normalQuote.totalAmount, 49.5);

  await assert.rejects(
    () => service.quoteCheckout(buyer as never, {
      kind: "ticket",
      paymentMethod: "card",
      eventId: eventId.toString(),
      ticketId,
      quantity: 1,
      applyReward: true,
      rewardId: "wrong-ticket",
      acceptedTerms: true,
    }),
    /not available for the selected ticket/,
  );

  await assert.rejects(
    () => service.quoteCheckout(buyer as never, {
      kind: "ticket",
      paymentMethod: "card",
      eventId: eventId.toString(),
      ticketId,
      quantity: 1,
      applyReward: true,
      rewardId: "disabled",
      acceptedTerms: true,
    }),
    /disabled/,
  );

  await assert.rejects(
    () => service.quoteCheckout(buyer as never, {
      kind: "ticket",
      paymentMethod: "card",
      eventId: eventId.toString(),
      ticketId,
      quantity: 1,
      applyReward: true,
      rewardId: "expired",
      acceptedTerms: true,
    }),
    /expired/,
  );

  await assert.rejects(
    () => service.quoteCheckout(buyer as never, {
      kind: "ticket",
      paymentMethod: "card",
      eventId: eventId.toString(),
      ticketId,
      quantity: 1,
      applyReward: true,
      rewardId: "bogo-min",
      acceptedTerms: true,
    }),
    /Select at least 2 paid tickets/,
  );

  await assert.rejects(
    () => service.quoteCheckout(buyer as never, {
      kind: "ticket",
      paymentMethod: "card",
      eventId: eventId.toString(),
      ticketId,
      quantity: 1,
      applyReward: true,
      rewardId: "used",
      acceptedTerms: true,
    }),
    /already used this offer/,
  );
});

test("exhausted reward capacity rejects checkout and releases the pending claim", async () => {
  const pendingReleaseCalls: unknown[] = [];
  const { service } = await makeCheckoutService({
    event: createEvent([createReward({ discountEnabled: true, discountPercent: 10, availableCount: 0 })]),
    eventRepository: {
      reserveTicketAndRewardCapacity: async () => null,
    },
    rewardClaimRepository: {
      releasePendingCheckoutReward: async (payload: unknown) => {
        pendingReleaseCalls.push(payload);
        return {};
      },
    },
  });

  await assert.rejects(
    () => service.createIntent(buyer as never, {
      kind: "ticket",
      paymentMethod: "card",
      eventId: eventId.toString(),
      ticketId,
      quantity: 1,
      applyReward: true,
      rewardId: "reward-1",
      acceptedTerms: true,
    }),
    /offer is no longer available/,
  );

  assert.deepEqual(pendingReleaseCalls, [{
    userId: buyer.id,
    eventId: eventId.toString(),
    rewardId: "reward-1",
  }]);
});

// --- Live-event reservation eligibility regression coverage -----------------
//
// resolveLineItems() previously accepted only status === "published". That was
// fixed to accept "published" and "live". A second, independent bug remained
// downstream in event.repository.ts's reserveTicketCapacity()/
// reserveTicketAndRewardCapacity(), which still filtered on
// status === "published" (see ticket-reservation-eligibility.test.ts for the
// exact Mongo-filter-level regression coverage of that fix). These tests lock
// in the service-level behavior end-to-end: a live event must be able to
// complete createIntent(), with or without a BOGO reward, while the paid
// 2-ticket purchase cap keeps counting only paid quantity — never the
// reward-expanded total.

test("live event allows ticket checkout intent creation without an offer", async () => {
  const liveEvent = { ...createEvent(), status: "live" as const };
  const { service } = await makeCheckoutService({ event: liveEvent });

  const checkout = await service.createIntent(buyer as never, {
    kind: "ticket",
    paymentMethod: "card",
    eventId: eventId.toString(),
    ticketId,
    quantity: 2,
    applyReward: false,
    rewardId: null,
    acceptedTerms: true,
  });

  const lineItem = checkout.order.lineItems.find((item) => item.itemId === ticketId);
  assert.equal(lineItem?.quantity, 2);
  assert.equal(lineItem?.freeQuantity ?? 0, 0);
});

test("live event with a BOGO reward reserves the full issued quantity while the purchase cap only ever sees paid quantity", async () => {
  const reward = createReward({
    id: "reward-1",
    bogoEnabled: true,
    buyQuantity: 1,
    freeQuantity: 1,
    discountEnabled: false,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  const liveEvent = { ...createEvent([reward]), status: "live" as const };
  const reservationCalls: { ticketQuantity: number; rewardId: string | null; rewardQuantity: number }[] = [];

  const { service } = await makeCheckoutService({
    event: liveEvent,
    eventRepository: {
      reserveTicketAndRewardCapacity: async (
        _eventId: string,
        _ticketId: string,
        ticketQuantity: number,
        rewardId: string | null,
        rewardQuantity: number,
      ) => {
        reservationCalls.push({ ticketQuantity, rewardId, rewardQuantity });
        return liveEvent;
      },
    },
  });

  const checkout = await service.createIntent(buyer as never, {
    kind: "ticket",
    paymentMethod: "card",
    eventId: eventId.toString(),
    ticketId,
    quantity: 2,
    applyReward: true,
    rewardId: "reward-1",
    acceptedTerms: true,
  });

  const lineItem = checkout.order.lineItems.find((item) => item.itemId === ticketId);
  assert.equal(lineItem?.quantity, 2, "paid quantity stays 2");
  assert.equal(lineItem?.freeQuantity, 2, "BOGO(buy 1 get 1) on 2 paid tickets issues 2 free tickets");
  assert.equal(lineItem?.totalQuantity, 4, "4 tickets are actually issued");

  assert.equal(reservationCalls.length, 1);
  assert.equal(reservationCalls[0]?.ticketQuantity, 4, "inventory reservation must cover all 4 issued tickets, not just the 2 paid ones");
});

test("purchase-limit cap counts only paid quantity, never the BOGO-expanded total, even for a live event", async () => {
  const reward = createReward({
    id: "reward-1",
    bogoEnabled: true,
    buyQuantity: 1,
    freeQuantity: 1,
    discountEnabled: false,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  const liveEvent = { ...createEvent([reward]), status: "live" as const };

  // This user already has 1 paid ticket of this type. Requesting 2 more paid
  // tickets (which would issue 2 additional free BOGO tickets, i.e. 4 more
  // tickets total) must be evaluated against the PAID cap only: 1 + 2 = 3 > 2,
  // so it is correctly rejected — not because 1 + 4 would also exceed 2.
  const { service } = await makeCheckoutService({
    event: liveEvent,
    repository: { getActivePurchasedCountForTicket: async () => 1 },
  });

  await assert.rejects(
    () => service.createIntent(buyer as never, {
      kind: "ticket",
      paymentMethod: "card",
      eventId: eventId.toString(),
      ticketId,
      quantity: 2,
      applyReward: true,
      rewardId: "reward-1",
      acceptedTerms: true,
    }),
    /You can only purchase 1 more ticket of this type/,
  );
});

test("a user who already purchased the maximum 2 paid tickets is rejected from buying more during a live event", async () => {
  const liveEvent = { ...createEvent(), status: "live" as const };
  const { service } = await makeCheckoutService({
    event: liveEvent,
    repository: { getActivePurchasedCountForTicket: async () => 2 },
  });

  await assert.rejects(
    () => service.createIntent(buyer as never, {
      kind: "ticket",
      paymentMethod: "card",
      eventId: eventId.toString(),
      ticketId,
      quantity: 2,
      applyReward: false,
      rewardId: null,
      acceptedTerms: true,
    }),
    /You have already purchased the maximum of 2 tickets of this type/,
  );
});

test("draft and cancelled events remain blocked from ticket checkout intent creation", async () => {
  for (const status of ["draft", "cancelled"] as const) {
    const blockedEvent = { ...createEvent(), status };
    const { service } = await makeCheckoutService({ event: blockedEvent });

    await assert.rejects(
      () => service.createIntent(buyer as never, {
        kind: "ticket",
        paymentMethod: "card",
        eventId: eventId.toString(),
        ticketId,
        quantity: 1,
        applyReward: false,
        rewardId: null,
        acceptedTerms: true,
      }),
      /Event not found/,
      `status "${status}" must still be rejected`,
    );
  }
});

test("insufficient ticket inventory without an offer is still rejected for a live event", async () => {
  const liveEvent = { ...createEvent(), status: "live" as const };
  const { service } = await makeCheckoutService({
    event: liveEvent,
    eventRepository: { reserveTicketAndRewardCapacity: async () => null },
  });

  await assert.rejects(
    () => service.createIntent(buyer as never, {
      kind: "ticket",
      paymentMethod: "card",
      eventId: eventId.toString(),
      ticketId,
      quantity: 2,
      applyReward: false,
      rewardId: null,
      acceptedTerms: true,
    }),
    /Not enough tickets are available/,
  );
});

test("terms must be accepted before a live-event checkout intent is created", async () => {
  const liveEvent = { ...createEvent(), status: "live" as const };
  const { service } = await makeCheckoutService({ event: liveEvent });

  await assert.rejects(
    () => service.createIntent(buyer as never, {
      kind: "ticket",
      paymentMethod: "card",
      eventId: eventId.toString(),
      ticketId,
      quantity: 1,
      applyReward: false,
      rewardId: null,
      acceptedTerms: false,
    } as never),
    /Terms must be accepted/,
  );
});
