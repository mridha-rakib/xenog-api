import assert from "node:assert/strict";
import test from "node:test";
import mongoose, { Types } from "mongoose";
import { randomUUID } from "node:crypto";
import { CheckoutOrderModel } from "../src/modules/payments/checkout-payment.model.js";
import { createCheckoutTicketPasses } from "../src/modules/payments/ticket-check-in-code.js";
import type { CheckoutOrderLineItem } from "../src/modules/payments/checkout-payment.interface.js";
import { TicketCancellationModel } from "../src/modules/payments/ticket-cancellation.model.js";
import { EventCancellationRefundModel } from "../src/modules/payments/event-cancellation-refund.model.js";
import { TicketShareModel } from "../src/modules/payments/ticket-share.model.js";
import { EventModel } from "../src/modules/events/event.model.js";
import { UserModel } from "../src/modules/user/user.model.js";
import { AnalyticsRepository } from "../src/modules/analytics/analytics.repository.js";
import { AnalyticsService } from "../src/modules/analytics/analytics.service.js";
import { analyticsValidation } from "../src/modules/analytics/analytics.validation.js";
import { authorizeRoles } from "../src/core/middlewares/auth.middleware.js";
import { analyticsRoutes } from "../src/modules/analytics/analytics.route.js";
import { DashboardService } from "../src/modules/dashboard/dashboard.service.js";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const runId = `analytics-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

const createdOrderIds: Types.ObjectId[] = [];
const createdEventIds: Types.ObjectId[] = [];
const createdUserIds: Types.ObjectId[] = [];
const createdTicketCancellationIds: Types.ObjectId[] = [];
const createdEventCancellationRefundIds: Types.ObjectId[] = [];
const createdTicketShareIds: Types.ObjectId[] = [];

test.before(async () => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI as string);
  }
});

test.after(async () => {
  await Promise.all([
    createdOrderIds.length ? CheckoutOrderModel.deleteMany({ _id: { $in: createdOrderIds } }) : null,
    createdEventIds.length ? EventModel.deleteMany({ _id: { $in: createdEventIds } }) : null,
    createdUserIds.length ? UserModel.deleteMany({ _id: { $in: createdUserIds } }) : null,
    createdTicketCancellationIds.length
      ? TicketCancellationModel.deleteMany({ _id: { $in: createdTicketCancellationIds } })
      : null,
    createdEventCancellationRefundIds.length
      ? EventCancellationRefundModel.deleteMany({ _id: { $in: createdEventCancellationRefundIds } })
      : null,
    createdTicketShareIds.length ? TicketShareModel.deleteMany({ _id: { $in: createdTicketShareIds } }) : null,
  ]);
  await mongoose.disconnect();
});

// Repository-integration tests share real collections with no per-test scoping
// filter (the aggregations are intentionally platform-wide), so each test
// anchors its fixtures to a distinct, well-separated moment in time to avoid
// two tests' windows overlapping and leaking fixtures across each other.
let momentCounter = 0;
const nextTestMoment = (): Date =>
  new Date(Date.UTC(2022, 0, 1) + momentCounter++ * 45 * 24 * 60 * 60 * 1000);

// --- Fixtures ---------------------------------------------------------

const createFixtureEvent = async (label: string, tickets: Array<{ id: string; type: "free" | "pay" }>) => {
  const eventId = new Types.ObjectId();
  createdEventIds.push(eventId);
  await EventModel.create({
    _id: eventId,
    userId: new Types.ObjectId(),
    status: "published",
    name: `Analytics test event ${runId} ${label}`,
    privacy: "public",
    categories: ["Parties & Celebrations"],
    tickets: tickets.map((ticket) => ({
      id: ticket.id,
      name: ticket.id,
      type: ticket.type,
      price: ticket.type === "free" ? 0 : 10,
      capacity: 1000,
      availableCount: 1000,
    })),
  });
  return eventId;
};

const ticketLineItem = (
  overrides: Partial<CheckoutOrderLineItem> & { eventId: string; itemId: string },
): CheckoutOrderLineItem => ({
  itemType: "ticket",
  name: "Ticket",
  quantity: overrides.totalQuantity ?? 1,
  paidQuantity: overrides.totalQuantity ?? 1,
  freeQuantity: 0,
  totalQuantity: overrides.totalQuantity ?? 1,
  unitAmount: 10,
  totalAmount: 10,
  ...overrides,
});

const createTicketOrder = async (options: {
  label: string;
  lineItems: CheckoutOrderLineItem[];
  paymentStatus?: "requires_payment" | "processing" | "paid" | "failed" | "canceled" | "refunded";
  amountMinor?: number;
  currency?: string;
  paidAt?: Date | null;
}) => {
  const orderId = new Types.ObjectId();
  createdOrderIds.push(orderId);
  const paymentStatus = options.paymentStatus ?? "paid";
  const passes = createCheckoutTicketPasses(options.lineItems, options.paidAt ?? new Date());

  await CheckoutOrderModel.create({
    _id: orderId,
    userId: new Types.ObjectId(),
    kind: "ticket",
    paymentMethod: "card",
    paymentStatus,
    currency: options.currency ?? "usd",
    subtotalAmount: 10,
    totalAmount: 10,
    amountMinor: options.amountMinor ?? 1000,
    lineItems: options.lineItems,
    ticketPasses: passes,
    paidAt: ["paid", "refunded"].includes(paymentStatus) ? (options.paidAt ?? new Date()) : null,
  });

  return { orderId, passes };
};

const createProductOrder = async (options: { amountMinor: number; paidAt: Date; currency?: string }) => {
  const orderId = new Types.ObjectId();
  createdOrderIds.push(orderId);
  await CheckoutOrderModel.create({
    _id: orderId,
    userId: new Types.ObjectId(),
    kind: "product",
    paymentMethod: "card",
    paymentStatus: "paid",
    currency: options.currency ?? "usd",
    subtotalAmount: 10,
    totalAmount: 10,
    amountMinor: options.amountMinor,
    lineItems: [
      {
        itemType: "product",
        name: "Merch",
        quantity: 1,
        unitAmount: options.amountMinor,
        totalAmount: options.amountMinor,
      },
    ],
    ticketPasses: [],
    paidAt: options.paidAt,
  });
  return orderId;
};

const createFixtureUser = async (overrides: Partial<Record<string, unknown>> = {}) => {
  const userId = new Types.ObjectId();
  createdUserIds.push(userId);
  await UserModel.create({
    _id: userId,
    name: `Analytics Test User ${runId}`,
    email: `${runId}-${userId.toString()}@example.com`.toLowerCase(),
    role: "user",
    accountType: "personal",
    isActive: true,
    ...overrides,
  });
  return userId;
};

// --- Validation (pure, no DB) -------------------------------------------

test("analytics validation reuses the dashboard schema and rejects invalid custom ranges", async () => {
  const invalidDate = await analyticsValidation.overview.safeParseAsync({
    query: { range: "custom", start: "2026-02-31", end: "2026-03-01" },
    body: {},
    params: {},
  });
  assert.equal(invalidDate.success, false);

  const inverted = await analyticsValidation.overview.safeParseAsync({
    query: { range: "custom", start: "2026-08-10", end: "2026-08-01" },
    body: {},
    params: {},
  });
  assert.equal(inverted.success, false);

  const tooLong = await analyticsValidation.overview.safeParseAsync({
    query: { range: "custom", start: "2024-01-01", end: "2026-01-01" },
    body: {},
    params: {},
  });
  assert.equal(tooLong.success, false);

  const valid = await analyticsValidation.overview.safeParseAsync({
    query: { range: "custom", start: "2026-01-01", end: "2026-01-31" },
    body: {},
    params: {},
  });
  assert.equal(valid.success, true);
});

// --- Authorization -------------------------------------------------------

test("analytics overview route requires authentication before authorization", () => {
  const stack = (analyticsRoutes as unknown as { stack: Array<{ route?: { stack: Array<{ name: string }> } }> })
    .stack;
  const overviewLayer = stack.find((layer) => layer.route)?.route?.stack ?? [];
  assert.equal(overviewLayer[0]?.name, "authenticate");
});

test("authorizeRoles(admin) rejects unauthenticated and non-admin, accepts admin", () => {
  const middleware = authorizeRoles("admin");

  let unauthenticatedError: { statusCode?: number } | undefined;
  middleware({ authUser: undefined } as never, {} as never, ((error?: unknown) => {
    unauthenticatedError = error as { statusCode?: number };
  }) as never);
  assert.equal(unauthenticatedError?.statusCode, 401);

  let nonAdminError: { statusCode?: number } | undefined;
  middleware({ authUser: { role: "user" } } as never, {} as never, ((error?: unknown) => {
    nonAdminError = error as { statusCode?: number };
  }) as never);
  assert.equal(nonAdminError?.statusCode, 403);

  let adminCalled = false;
  let adminError: unknown;
  middleware({ authUser: { role: "admin" } } as never, {} as never, ((error?: unknown) => {
    adminCalled = true;
    adminError = error;
  }) as never);
  assert.equal(adminCalled, true);
  assert.equal(adminError, undefined);
});

// --- Service-level pure logic (mocked repository, no DB) ------------------

const emptyRepositoryMock = () => ({
  getUserTotals: async () => ({ total: 0, currentNew: 0, previousNew: 0 }),
  getTicketIssuanceTotals: async () => ({
    currentGrossAmountMinor: 0,
    previousGrossAmountMinor: 0,
    currentIssued: 0,
    previousIssued: 0,
  }),
  getTicketBreakdownRows: async () => [],
  resolveEventTicketTypes: async () => new Map(),
  getTicketCancellationRefundTotals: async () => ({
    successful: { amountMinor: 0, count: 0 },
    successfulPrevious: { amountMinor: 0, count: 0 },
    pending: { amountMinor: 0, count: 0 },
    failed: { amountMinor: 0, count: 0 },
    reconciliationRequired: { amountMinor: 0, count: 0 },
  }),
  getEventCancellationRefundTotals: async () => ({
    successful: { amountMinor: 0, count: 0 },
    successfulPrevious: { amountMinor: 0, count: 0 },
    pending: { amountMinor: 0, count: 0 },
    failed: { amountMinor: 0, count: 0 },
    reconciliationRequired: { amountMinor: 0, count: 0 },
  }),
  getGrossSalesSeriesRows: async () => [],
  getUserTicketRefundSeriesRows: async () => [],
  getHostEventRefundSeriesRows: async () => [],
  getUserGrowthSeriesRows: async () => [],
});

test("today produces exactly 24 hourly buckets with correct UTC boundaries", async () => {
  const service = new AnalyticsService(emptyRepositoryMock() as never);
  const overview = await service.getOverview({ range: "today" });

  assert.equal(overview.range.bucket, "hour");
  assert.equal(overview.revenueSeries.length, 24);
  assert.equal(overview.userMetrics.series.length, 24);

  const start = new Date(overview.range.start);
  assert.equal(overview.revenueSeries[0]?.bucketStart, start.toISOString());
  assert.equal(
    new Date(overview.revenueSeries[0]?.bucketEnd as string).getTime() - start.getTime(),
    60 * 60 * 1000,
  );
  const last = overview.revenueSeries[23];
  assert.equal(last?.bucketEnd, overview.range.end);
  // every empty hour must return zero, never be omitted
  for (const bucket of overview.revenueSeries) {
    assert.equal(bucket.grossTicketSalesMinor, 0);
    assert.equal(bucket.successfulRefundsMinor, 0);
    assert.equal(bucket.netTicketRevenueMinor, 0);
  }
});

test("7d produces exactly 7 daily buckets, never 8", async () => {
  const service = new AnalyticsService(emptyRepositoryMock() as never);
  const overview = await service.getOverview({ range: "7d" });
  assert.equal(overview.range.bucket, "day");
  assert.equal(overview.revenueSeries.length, 7);
  assert.equal(overview.userMetrics.series.length, 7);
  assert.equal(overview.revenueSeries[0]?.bucketStart, overview.range.start);
  assert.equal(overview.revenueSeries[6]?.bucketEnd, overview.range.end);
});

test("30d produces exactly 30 daily buckets", async () => {
  const service = new AnalyticsService(emptyRepositoryMock() as never);
  const overview = await service.getOverview({ range: "30d" });
  assert.equal(overview.range.bucket, "day");
  assert.equal(overview.revenueSeries.length, 30);
});

test("custom 1-31 days uses daily buckets", async () => {
  const service = new AnalyticsService(emptyRepositoryMock() as never);
  const overview = await service.getOverview({ range: "custom", start: "2026-03-01", end: "2026-03-05" });
  assert.equal(overview.range.bucket, "day");
  assert.equal(overview.revenueSeries.length, 5);
  assert.equal(overview.revenueSeries[0]?.bucketStart, "2026-03-01T00:00:00.000Z");
  assert.equal(overview.revenueSeries[4]?.bucketEnd, "2026-03-06T00:00:00.000Z");
});

test("custom 32-180 days uses weekly buckets anchored to start, with a shorter final bucket", async () => {
  const service = new AnalyticsService(emptyRepositoryMock() as never);
  // 2026-01-01 .. 2026-02-10 inclusive = 41 days
  const overview = await service.getOverview({ range: "custom", start: "2026-01-01", end: "2026-02-10" });
  assert.equal(overview.range.bucket, "week");
  // 41 days / 7 = 5 full weeks (35 days) + 6-day remainder = 6 buckets
  assert.equal(overview.revenueSeries.length, 6);
  const firstBucket = overview.revenueSeries[0];
  assert.equal(firstBucket?.bucketStart, "2026-01-01T00:00:00.000Z");
  assert.equal(
    new Date(firstBucket?.bucketEnd as string).getTime() - new Date(firstBucket?.bucketStart as string).getTime(),
    7 * 24 * 60 * 60 * 1000,
  );
  const lastBucket = overview.revenueSeries[5];
  assert.equal(lastBucket?.bucketEnd, overview.range.end);
  const lastBucketDurationDays =
    (new Date(lastBucket?.bucketEnd as string).getTime() - new Date(lastBucket?.bucketStart as string).getTime())
    / (24 * 60 * 60 * 1000);
  assert.equal(lastBucketDurationDays, 6); // shorter final bucket
});

test("custom 181-365 days uses UTC calendar-month buckets with partial first/last months", async () => {
  const service = new AnalyticsService(emptyRepositoryMock() as never);
  // 2026-01-15 .. 2026-08-10 inclusive = 208 days
  const overview = await service.getOverview({ range: "custom", start: "2026-01-15", end: "2026-08-10" });
  assert.equal(overview.range.bucket, "month");
  // Jan(partial) Feb Mar Apr May Jun Jul Aug(partial) = 8 buckets
  assert.equal(overview.revenueSeries.length, 8);
  assert.equal(overview.revenueSeries[0]?.bucketStart, "2026-01-15T00:00:00.000Z");
  assert.equal(overview.revenueSeries[0]?.bucketEnd, "2026-02-01T00:00:00.000Z"); // partial first month
  assert.equal(overview.revenueSeries[7]?.bucketStart, "2026-08-01T00:00:00.000Z");
  assert.equal(overview.revenueSeries[7]?.bucketEnd, overview.range.end); // partial final month
});

test("changePercentage is null when previous period is zero, and never Infinity/NaN", async () => {
  const service = new AnalyticsService(emptyRepositoryMock() as never);
  const overview = await service.getOverview({ range: "today" });
  assert.equal(overview.comparison.usersChangePercentage, null);
  assert.equal(overview.comparison.ticketsChangePercentage, null);
  assert.equal(overview.comparison.grossSalesChangePercentage, null);
  assert.equal(overview.comparison.netRevenueChangePercentage, null);
});

test("net ticket revenue may be negative and is never clamped, in summary and in every bucket", async () => {
  const repo = emptyRepositoryMock();
  repo.getTicketIssuanceTotals = async () => ({
    currentGrossAmountMinor: 100,
    previousGrossAmountMinor: 100,
    currentIssued: 1,
    previousIssued: 1,
  });
  repo.getTicketCancellationRefundTotals = async () => ({
    successful: { amountMinor: 500, count: 1 },
    successfulPrevious: { amountMinor: 0, count: 0 },
    pending: { amountMinor: 0, count: 0 },
    failed: { amountMinor: 0, count: 0 },
    reconciliationRequired: { amountMinor: 0, count: 0 },
  });
  repo.getGrossSalesSeriesRows = async () => [{ bucketStart: new Date(0), amountMinor: 100 }];
  repo.getUserTicketRefundSeriesRows = async () => [{ bucketStart: new Date(0), amountMinor: 500 }];
  const service = new AnalyticsService(repo as never);
  const overview = await service.getOverview({ range: "today" });
  assert.equal(overview.summary.netTicketRevenueMinor, -400);
});

test("no product field exists anywhere in the analytics response", async () => {
  const service = new AnalyticsService(emptyRepositoryMock() as never);
  const overview = await service.getOverview({ range: "today" });
  const serialized = JSON.stringify(overview).toLowerCase();
  assert.equal(serialized.includes("product"), false);
});

test("no sensitive identifiers exist anywhere in the analytics response", async () => {
  const service = new AnalyticsService(emptyRepositoryMock() as never);
  const overview = await service.getOverview({ range: "30d" });
  const serialized = JSON.stringify(overview);
  assert.equal(/[0-9a-f]{24}/i.test(serialized), false); // no raw Mongo ObjectId strings
  assert.equal(serialized.toLowerCase().includes("stripe"), false);
});

// --- Repository-level integration tests (real MongoDB) --------------------

const dateWindow = (start: Date, end: Date) => ({ start, end });

test("product orders never affect summary, revenue series, or ticket distribution", async () => {
  const repository = new AnalyticsRepository();
  const eventId = await createFixtureEvent("product-exclusion", [{ id: "std", type: "pay" }]);
  const now = nextTestMoment();
  const current = dateWindow(new Date(now.getTime() - 60_000), new Date(now.getTime() + 60_000));
  const previous = dateWindow(new Date(0), new Date(0));

  await createTicketOrder({
    label: "control-ticket",
    lineItems: [ticketLineItem({ eventId: eventId.toString(), itemId: "std", totalQuantity: 1 })],
    amountMinor: 1000,
    paidAt: now,
  });
  await createProductOrder({ amountMinor: 999_999, paidAt: now });

  const totals = await repository.getTicketIssuanceTotals("usd", current, previous);
  assert.equal(totals.currentGrossAmountMinor, 1000);
  assert.equal(totals.currentIssued, 1);

  const breakdown = await repository.getTicketBreakdownRows("usd", current);
  assert.equal(breakdown.length, 1);

  const grossRows = await repository.getGrossSalesSeriesRows("usd", current.start, current.end, "hour");
  const totalGross = grossRows.reduce((sum, row) => sum + row.amountMinor, 0);
  assert.equal(totalGross, 1000);
});

test("quantity greater than one and a shared pass do not inflate tickets issued or distribution", async () => {
  const repository = new AnalyticsRepository();
  const eventId = await createFixtureEvent("qty-share", [{ id: "std", type: "pay" }]);
  const now = nextTestMoment();
  const current = dateWindow(new Date(now.getTime() - 60_000), new Date(now.getTime() + 60_000));

  const { orderId } = await createTicketOrder({
    label: "qty-3",
    lineItems: [
      ticketLineItem({ eventId: eventId.toString(), itemId: "std", totalQuantity: 3, unitAmount: 10, totalAmount: 30 }),
    ],
    amountMinor: 3000,
    paidAt: now,
  });

  // Sharing ticket index 1 must not create an additional physical pass.
  const shareId = new Types.ObjectId();
  createdTicketShareIds.push(shareId);
  await TicketShareModel.create({
    _id: shareId,
    ownerUserId: new Types.ObjectId(),
    recipientUserId: new Types.ObjectId(),
    orderId,
    eventId: eventId.toString(),
    ticketId: "std",
    ticketIndex: 1,
    status: "active",
    sharedAt: now,
  });

  const rows = await repository.getTicketBreakdownRows("usd", current);
  const totalIssued = rows.reduce((sum, row) => sum + row.issuedQty, 0);
  assert.equal(totalIssued, 3); // 3 passes from quantity, not 4
});

test("full-price paid, discounted, free, and rewarded/bonus classify correctly and sum to tickets issued", async () => {
  const repository = new AnalyticsRepository();
  const eventId = await createFixtureEvent("distribution", [
    { id: "paid-ticket", type: "pay" },
    { id: "free-ticket", type: "free" },
  ]);
  const now = nextTestMoment();
  const current = dateWindow(new Date(now.getTime() - 60_000), new Date(now.getTime() + 60_000));

  // 1 discounted paid pass
  await createTicketOrder({
    label: "discounted",
    lineItems: [
      ticketLineItem({
        eventId: eventId.toString(),
        itemId: "paid-ticket",
        totalQuantity: 1,
        paidQuantity: 1,
        rewardId: "reward-1",
        rewardSnapshot: { discountEnabled: true, bogoEnabled: false } as never,
      }),
    ],
    amountMinor: 800,
    paidAt: now,
  });

  // 1 full-price paid pass (no reward at all)
  await createTicketOrder({
    label: "full-price",
    lineItems: [ticketLineItem({ eventId: eventId.toString(), itemId: "paid-ticket", totalQuantity: 1 })],
    amountMinor: 1000,
    paidAt: now,
  });

  // BOGO: 1 paid + 1 bonus/free pass
  await createTicketOrder({
    label: "bogo",
    lineItems: [
      ticketLineItem({
        eventId: eventId.toString(),
        itemId: "paid-ticket",
        totalQuantity: 2,
        paidQuantity: 1,
        rewardId: "reward-2",
        rewardSnapshot: { discountEnabled: false, bogoEnabled: true } as never,
      }),
    ],
    amountMinor: 1000,
    paidAt: now,
  });

  // Genuinely free ticket-type order
  await createTicketOrder({
    label: "free-type",
    lineItems: [
      ticketLineItem({
        eventId: eventId.toString(),
        itemId: "free-ticket",
        totalQuantity: 4,
        unitAmount: 0,
        totalAmount: 0,
      }),
    ],
    amountMinor: 0,
    paidAt: now,
  });

  const rows = await repository.getTicketBreakdownRows("usd", current);
  const typeByKey = await repository.resolveEventTicketTypes(
    rows.map((row) => ({ eventId: row.eventId, ticketId: row.ticketId })),
  );

  let paid = 0;
  let discounted = 0;
  let free = 0;
  let rewardedOrBonus = 0;
  for (const row of rows) {
    const type = typeByKey.get(`${row.eventId}:${row.ticketId}`);
    if (type === "free") free += row.issuedQty;
    else {
      paid += row.paidQty;
      discounted += row.discountedQty;
      rewardedOrBonus += row.rewardedQty;
    }
  }
  const fullPricePaid = Math.max(0, paid - discounted);
  const ticketsIssuedTotals = await repository.getTicketIssuanceTotals("usd", current, dateWindow(new Date(0), new Date(0)));

  assert.equal(paid, 3); // discounted + full-price + BOGO-paid
  assert.equal(discounted, 1);
  assert.equal(fullPricePaid, 2); // 3 paid - 1 discounted
  assert.equal(rewardedOrBonus, 1);
  assert.equal(free, 4);
  assert.equal(fullPricePaid + discounted + free + rewardedOrBonus, ticketsIssuedTotals.currentIssued);
});

test("captured-then-refunded orders remain in totals; failed/unpaid orders are excluded", async () => {
  const repository = new AnalyticsRepository();
  const eventId = await createFixtureEvent("refunded-failed", [{ id: "std", type: "pay" }]);
  const now = nextTestMoment();
  const current = dateWindow(new Date(now.getTime() - 60_000), new Date(now.getTime() + 60_000));
  const previous = dateWindow(new Date(0), new Date(0));

  await createTicketOrder({
    label: "refunded-order",
    paymentStatus: "refunded",
    lineItems: [ticketLineItem({ eventId: eventId.toString(), itemId: "std", totalQuantity: 2 })],
    amountMinor: 2000,
    paidAt: now,
  });
  await createTicketOrder({
    label: "failed-order",
    paymentStatus: "failed",
    lineItems: [ticketLineItem({ eventId: eventId.toString(), itemId: "std", totalQuantity: 5 })],
    amountMinor: 5000,
    paidAt: null,
  });

  const totals = await repository.getTicketIssuanceTotals("usd", current, previous);
  assert.equal(totals.currentIssued, 2);
  assert.equal(totals.currentGrossAmountMinor, 2000);
});

test(
  "successful user-ticket refund and successful host event-cancellation refund on the same order are summed, never double-counted",
  async () => {
    const eventId = await createFixtureEvent("dedup", [{ id: "std", type: "pay" }]);
    const buyerUserId = await createFixtureUser();
    const hostUserId = await createFixtureUser();
    const { orderId } = await createTicketOrder({
      label: "dedup-order",
      lineItems: [
        ticketLineItem({ eventId: eventId.toString(), itemId: "std", totalQuantity: 2, totalAmount: 20 }),
      ],
      amountMinor: 2000,
      paidAt: nextTestMoment(),
    });
    const now = nextTestMoment();

    const cancellationId = new Types.ObjectId();
    createdTicketCancellationIds.push(cancellationId);
    await TicketCancellationModel.create({
      _id: cancellationId,
      eventId,
      ticketId: "std",
      orderId,
      ticketIndex: 1,
      buyerUserId,
      hostUserId,
      status: "cancelled",
      refundStatus: "succeeded",
      currency: "usd",
      providerIdempotencyKey: `${runId}-dedup-user`,
      requestedAmountMinor: 1000,
      completedAmountMinor: 1000,
      remainingRefundableAmountMinor: 0,
      cancellationCutoffAt: now,
      cancelledAt: now,
      refundCompletedAt: now,
    });

    const batchId = new Types.ObjectId();
    const refundId = new Types.ObjectId();
    createdEventCancellationRefundIds.push(refundId);
    await EventCancellationRefundModel.create({
      _id: refundId,
      eventId,
      batchId,
      checkoutOrderId: orderId,
      originalPayerUserId: buyerUserId,
      providerIdempotencyKey: `${runId}-dedup-host`,
      currency: "usd",
      originalCapturedAmountMinor: 1000,
      previouslyRefundedAmountMinor: 1000,
      requestedAmountMinor: 1000,
      completedAmountMinor: 1000,
      remainingRefundableAmountMinor: 0,
      status: "succeeded",
      completedAt: now,
    });

    const repository = new AnalyticsRepository();
    const current = dateWindow(new Date(now.getTime() - 60_000), new Date(now.getTime() + 60_000));
    const previous = dateWindow(new Date(0), new Date(0));

    const userRefunds = await repository.getTicketCancellationRefundTotals("usd", current, previous);
    const hostRefunds = await repository.getEventCancellationRefundTotals("usd", current, previous);
    const total = userRefunds.successful.amountMinor + hostRefunds.successful.amountMinor;

    assert.equal(total, 2000); // 1000 + 1000, not 3000
  },
);

test("pending, failed, and reconciliation-required refunds are never deducted from successful refunds", async () => {
  const eventId = await createFixtureEvent("backlog", [{ id: "std", type: "pay" }]);
  const buyerUserId = await createFixtureUser();
  const hostUserId = await createFixtureUser();
  const { orderId } = await createTicketOrder({
    label: "backlog-order",
    lineItems: [ticketLineItem({ eventId: eventId.toString(), itemId: "std", totalQuantity: 3 })],
    amountMinor: 3000,
    paidAt: nextTestMoment(),
  });
  const now = nextTestMoment();

  const statuses: Array<
    ["pending" | "failed_retryable" | "reconciliation_required", number]
  > = [
    ["pending", 1],
    ["failed_retryable", 2],
    ["reconciliation_required", 3],
  ];

  for (const [refundStatus, ticketIndex] of statuses) {
    const id = new Types.ObjectId();
    createdTicketCancellationIds.push(id);
    await TicketCancellationModel.create({
      _id: id,
      eventId,
      ticketId: "std",
      orderId,
      ticketIndex,
      buyerUserId,
      hostUserId,
      status: "cancelled",
      refundStatus,
      currency: "xd2", // dedicated fake currency: backlog totals are intentionally
      // not date-bounded, so they're isolated by currency instead to avoid
      // colliding with the same-shaped backlog fixtures other test files create.
      providerIdempotencyKey: `${runId}-backlog-${refundStatus}`,
      requestedAmountMinor: 500,
      completedAmountMinor: 0,
      remainingRefundableAmountMinor: 500,
      cancellationCutoffAt: now,
      cancelledAt: now,
      refundCompletedAt: null,
    });
  }

  const repository = new AnalyticsRepository();
  const current = dateWindow(new Date(now.getTime() - 60_000), new Date(now.getTime() + 60_000));
  const previous = dateWindow(new Date(0), new Date(0));
  const totals = await repository.getTicketCancellationRefundTotals("xd2", current, previous);
  assert.equal(totals.successful.amountMinor, 0);
});

test("orders in a non-configured currency are excluded, never silently combined", async () => {
  const repository = new AnalyticsRepository();
  const eventId = await createFixtureEvent("currency", [{ id: "std", type: "pay" }]);
  const now = nextTestMoment();
  const current = dateWindow(new Date(now.getTime() - 60_000), new Date(now.getTime() + 60_000));
  const previous = dateWindow(new Date(0), new Date(0));

  await createTicketOrder({
    label: "usd-order",
    lineItems: [ticketLineItem({ eventId: eventId.toString(), itemId: "std", totalQuantity: 1 })],
    amountMinor: 1000,
    currency: "usd",
    paidAt: now,
  });
  await createTicketOrder({
    label: "eur-order",
    lineItems: [ticketLineItem({ eventId: eventId.toString(), itemId: "std", totalQuantity: 1 })],
    amountMinor: 999_999,
    currency: "eur",
    paidAt: now,
  });

  const usdTotals = await repository.getTicketIssuanceTotals("usd", current, previous);
  assert.equal(usdTotals.currentGrossAmountMinor, 1000);
  const eurTotals = await repository.getTicketIssuanceTotals("eur", current, previous);
  assert.equal(eurTotals.currentGrossAmountMinor, 999_999);
});

test("revenue-series bucket sums equal the summary totals for the same period", async () => {
  const eventId = await createFixtureEvent("series-invariant", [{ id: "std", type: "pay" }]);
  const now = nextTestMoment();
  const buyerUserId = await createFixtureUser();
  const hostUserId = await createFixtureUser();

  await createTicketOrder({
    label: "series-sale",
    lineItems: [ticketLineItem({ eventId: eventId.toString(), itemId: "std", totalQuantity: 2 })],
    amountMinor: 2000,
    paidAt: now,
  });

  const { orderId } = await createTicketOrder({
    label: "series-refunded",
    lineItems: [ticketLineItem({ eventId: eventId.toString(), itemId: "std", totalQuantity: 1 })],
    amountMinor: 1000,
    paidAt: now,
  });

  const cancellationId = new Types.ObjectId();
  createdTicketCancellationIds.push(cancellationId);
  await TicketCancellationModel.create({
    _id: cancellationId,
    eventId,
    ticketId: "std",
    orderId,
    ticketIndex: 1,
    buyerUserId,
    hostUserId,
    status: "cancelled",
    refundStatus: "succeeded",
    currency: "usd",
    providerIdempotencyKey: `${runId}-series-refund`,
    requestedAmountMinor: 400,
    completedAmountMinor: 400,
    remainingRefundableAmountMinor: 0,
    cancellationCutoffAt: now,
    cancelledAt: now,
    refundCompletedAt: now,
  });

  const repository = new AnalyticsRepository();
  const current = dateWindow(new Date(now.getTime() - 60_000), new Date(now.getTime() + 60_000));
  const previous = dateWindow(new Date(0), new Date(0));

  const [issuanceTotals, userRefundTotals, grossRows, userRefundRows] = await Promise.all([
    repository.getTicketIssuanceTotals("usd", current, previous),
    repository.getTicketCancellationRefundTotals("usd", current, previous),
    repository.getGrossSalesSeriesRows("usd", current.start, current.end, "hour"),
    repository.getUserTicketRefundSeriesRows("usd", current.start, current.end, "hour"),
  ]);

  const seriesGross = grossRows.reduce((sum, row) => sum + row.amountMinor, 0);
  const seriesRefunds = userRefundRows.reduce((sum, row) => sum + row.amountMinor, 0);

  assert.equal(seriesGross, issuanceTotals.currentGrossAmountMinor);
  assert.equal(seriesRefunds, userRefundTotals.successful.amountMinor);
});

test("user-growth series sum equals the total new-users count for the same period", async () => {
  const now = nextTestMoment();
  const baseFilter = { role: "user", deletedAt: null, email: { $not: /@deleted\.local$/i } };
  await createFixtureUser({ createdAt: now });
  await createFixtureUser({ createdAt: new Date(now.getTime() + 1000) });
  await createFixtureUser({ role: "admin", createdAt: now }); // excluded

  const repository = new AnalyticsRepository();
  const current = dateWindow(new Date(now.getTime() - 60_000), new Date(now.getTime() + 60_000));
  const previous = dateWindow(new Date(0), new Date(0));

  const [userTotals, seriesRows] = await Promise.all([
    repository.getUserTotals(baseFilter, current, previous),
    repository.getUserGrowthSeriesRows(baseFilter, current.start, current.end, "hour"),
  ]);

  const seriesSum = seriesRows.reduce((sum, row) => sum + row.count, 0);
  assert.equal(seriesSum, userTotals.currentNew);
  assert.equal(userTotals.currentNew, 2); // admin excluded
});

test("analytics summary matches Dashboard Overview summary for the same fixtures and range (parity)", async () => {
  const eventId = await createFixtureEvent("parity", [{ id: "std", type: "pay" }]);
  const now = nextTestMoment();
  await createFixtureUser({ createdAt: now });
  await createTicketOrder({
    label: "parity-order",
    lineItems: [ticketLineItem({ eventId: eventId.toString(), itemId: "std", totalQuantity: 3 })],
    amountMinor: 3000,
    paidAt: now,
  });

  // Freeze "now" implicitly by using a fixed custom range covering the fixture moment,
  // so both services resolve the identical window.
  const start = new Date(now.getTime() - 60_000);
  const end = new Date(now.getTime() + 60_000);
  const startIso = start.toISOString().slice(0, 10);
  const endIso = end.toISOString().slice(0, 10);
  const query = { range: "custom" as const, start: startIso, end: endIso };

  // Run concurrently (not sequentially): `totalUsers` is an all-time, unscoped
  // count with no date filter, so it can be perturbed by unrelated fixtures
  // any other test file happening to run in parallel creates in between two
  // sequential awaits. Firing both requests together shrinks that window to
  // effectively nothing, since both services dispatch their Mongo queries
  // within the same tick.
  const [analyticsOverview, dashboardOverview] = await Promise.all([
    new AnalyticsService().getOverview(query),
    new DashboardService().getOverview(query),
  ]);

  assert.equal(analyticsOverview.summary.totalUsers, dashboardOverview.users.total);
  assert.equal(analyticsOverview.summary.ticketsIssued, dashboardOverview.tickets.issued);
  assert.equal(analyticsOverview.summary.grossTicketSalesMinor, dashboardOverview.financials.grossTicketSalesMinor);
  assert.equal(
    analyticsOverview.summary.successfulRefundsMinor,
    dashboardOverview.financials.totalSuccessfulRefundsMinor,
  );
  assert.equal(analyticsOverview.summary.netTicketRevenueMinor, dashboardOverview.financials.netTicketRevenueMinor);
});
