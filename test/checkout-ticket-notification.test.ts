import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import type { IEvent } from "../src/modules/events/event.interface.js";
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

const buyerId = new Types.ObjectId("64f100000000000000000201");
const hostId = new Types.ObjectId("64f100000000000000000202");
const eventId = new Types.ObjectId("64f100000000000000000203");
const ticketId = "general";
const baseNow = new Date("2026-08-01T12:00:00.000Z");

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

const createEvent = (name: string): IEvent => ({
  _id: eventId,
  userId: hostId,
  status: "published",
  name,
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
} as IEvent);

const createOrder = (overrides: Partial<ICheckoutOrder> & { lineItems: CheckoutOrderLineItem[] }): ICheckoutOrder => ({
  _id: overrides._id ?? new Types.ObjectId(),
  userId: overrides.userId ?? buyerId,
  kind: "ticket",
  paymentMethod: "card",
  paymentStatus: overrides.paymentStatus ?? "requires_payment",
  payoutStatus: "not_ready",
  currency: "usd",
  subtotalAmount: overrides.lineItems.reduce((sum, item) => sum + item.totalAmount, 0),
  platformFeeAmount: 9,
  taxAmount: 0,
  discountAmount: 0,
  totalAmount: overrides.lineItems.reduce((sum, item) => sum + item.totalAmount, 0) + 9,
  amountMinor: Math.round((overrides.lineItems.reduce((sum, item) => sum + item.totalAmount, 0) + 9) * 100),
  taxSnapshot: taxZero,
  policySnapshot: { termsVersion: "terms-test", refundEscrowVersion: "refund-test", acceptedAt: baseNow },
  lineItems: overrides.lineItems,
  ticketPasses: overrides.lineItems.flatMap((item) =>
    Array.from({ length: item.totalQuantity ?? item.quantity }, (_unused, index) => ({
      eventId: item.eventId ?? eventId.toString(),
      ticketId: item.itemId ?? ticketId,
      ticketIndex: index + 1,
      checkInCode: `MOCK-${index + 1}`,
    })),
  ),
  stripePaymentIntentId: "pi_mock",
  stripeClientSecret: "pi_mock_secret",
  reservedUntil: null,
  anonymous: false,
  termsAcceptedAt: baseNow,
  paidAt: null,
  failedAt: null,
  failureMessage: null,
  createdAt: baseNow,
  updatedAt: baseNow,
});

const makeService = async ({
  event,
  order,
  notificationCreates,
}: {
  event: IEvent;
  order: ICheckoutOrder;
  notificationCreates: Array<Record<string, unknown>>;
}) => {
  const [{ CheckoutPaymentService }, { RedisClient }] = await Promise.all([
    import("../src/modules/payments/checkout-payment.service.js"),
    import("../src/config/redis.js"),
  ]);
  (RedisClient as unknown as { getClient: () => { status: string } }).getClient = () => ({ status: "end" });

  let webhookSeen = 0;

  const service = new CheckoutPaymentService(
    {
      findById: async () => order,
      findByPaymentIntentId: async () => order,
      markPaidIfFirst: async () => {
        if (order.paymentStatus !== "requires_payment") return null;
        order.paymentStatus = "paid";
        order.paidAt = baseNow;
        return order;
      },
    } as never, // 1 repository
    { findById: async () => event } as never, // 2 eventRepository
    {} as never, // 3 productRepository
    { create: async () => ({}) } as never, // 4 earningRepository
    { findById: async () => ({ _id: buyerId, name: "Buyer", username: "buyer" }) } as never, // 5 userRepository
    {} as never, // 6 userFollowRepository
    {} as never, // 7 ticketShareRepository
    {} as never, // 8 ticketUsageRepository
    {
      create: async (payload: Record<string, unknown>) => {
        notificationCreates.push(payload);
        return { _id: new Types.ObjectId(), createdAt: baseNow };
      },
    } as never, // 9 notificationRepository
    {} as never, // 10 storageService
    {
      markWebhookProcessed: async () => {
        webhookSeen += 1;
        return webhookSeen === 1;
      },
    } as never, // 11 eventCancellationRefundRepository
    { ensureLatePaymentRefund: async () => undefined } as never, // 12 eventCancellationRefundService
    { countByBuyerEventTicket: async () => 0, countByOrderEventTicket: async () => 0 } as never, // 13 ticketCancellationRepository
    { handleStripeWebhook: async () => undefined } as never, // 14 ticketCancellationService
    { calculate: async () => taxZero } as never, // 15 taxService
    { enqueueForOrder: async () => undefined } as never, // 16 invoiceService
    {} as never, // 17 ticketPassClaimRepository
    {} as never, // 18 crowdStatusService
    { markRedeemedByOrder: async () => ({}) } as never, // 19 rewardClaimRepository
  );

  (service as unknown as {
    stripe: unknown;
  }).stripe = {
    webhooks: {
      constructEvent: () => ({
        id: "evt_ticket_notification",
        type: "payment_intent.succeeded",
        data: { object: { id: "pi_mock", status: "succeeded", metadata: { orderId: order._id.toString() } } },
      }),
    },
  };

  return service;
};

const waitForFireAndForgetNotification = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

test.afterEach(async () => {
  const { RedisClient } = await import("../src/config/redis.js");
  await RedisClient.disconnect().catch(() => undefined);
});

test("buyer ticket-purchase notification uses the approved copy with the real event name", async () => {
  const event = createEvent("Neon Vibes Night");
  const order = createOrder({
    lineItems: [{
      itemType: "ticket",
      itemId: ticketId,
      eventId: eventId.toString(),
      sellerUserId: hostId,
      name: "General Admission",
      quantity: 2,
      paidQuantity: 2,
      freeQuantity: 0,
      totalQuantity: 2,
      unitAmount: 45,
      totalAmount: 90,
    }],
  });

  const notificationCreates: Array<Record<string, unknown>> = [];
  const service = await makeService({ event, order, notificationCreates });

  await service.handleStripeWebhook("sig", Buffer.from("{}"));
  await waitForFireAndForgetNotification();

  const buyerNotification = notificationCreates.find((n) => n.type === "ticket_buyer");
  assert.ok(buyerNotification, "expected a ticket_buyer notification to be created");
  assert.equal(buyerNotification?.title, "Your tickets are ready");
  assert.equal(buyerNotification?.message, "Your tickets for Neon Vibes Night are now available.");

  const creatorNotification = notificationCreates.find((n) => n.type === "ticket_creator");
  assert.ok(creatorNotification, "expected a ticket_creator notification to be created");
  assert.equal(creatorNotification?.title, undefined);
  assert.equal(creatorNotification?.message, undefined);
});

test("buyer ticket-purchase notification copy is dynamic per event name", async () => {
  const event = createEvent("Rooftop Sessions Vol. 3");
  const order = createOrder({
    lineItems: [{
      itemType: "ticket",
      itemId: ticketId,
      eventId: eventId.toString(),
      sellerUserId: null,
      name: "VIP",
      quantity: 1,
      paidQuantity: 1,
      freeQuantity: 0,
      totalQuantity: 1,
      unitAmount: 45,
      totalAmount: 45,
    }],
  });

  const notificationCreates: Array<Record<string, unknown>> = [];
  const service = await makeService({ event, order, notificationCreates });

  await service.handleStripeWebhook("sig", Buffer.from("{}"));
  await waitForFireAndForgetNotification();

  const buyerNotification = notificationCreates.find((n) => n.type === "ticket_buyer");
  assert.equal(buyerNotification?.message, "Your tickets for Rooftop Sessions Vol. 3 are now available.");
});

test("duplicate webhook delivery creates only one buyer notification", async () => {
  const event = createEvent("Neon Vibes Night");
  const order = createOrder({
    lineItems: [{
      itemType: "ticket",
      itemId: ticketId,
      eventId: eventId.toString(),
      sellerUserId: null,
      name: "General Admission",
      quantity: 2,
      paidQuantity: 2,
      freeQuantity: 0,
      totalQuantity: 2,
      unitAmount: 45,
      totalAmount: 90,
    }],
  });

  const notificationCreates: Array<Record<string, unknown>> = [];
  const service = await makeService({ event, order, notificationCreates });

  await service.handleStripeWebhook("sig", Buffer.from("{}"));
  await service.handleStripeWebhook("sig", Buffer.from("{}"));
  await waitForFireAndForgetNotification();

  const buyerNotifications = notificationCreates.filter((n) => n.type === "ticket_buyer");
  assert.equal(buyerNotifications.length, 1);
});
