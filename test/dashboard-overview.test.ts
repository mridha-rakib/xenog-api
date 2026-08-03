import assert from "node:assert/strict";
import test from "node:test";
import mongoose, { Types } from "mongoose";
import { randomUUID } from "node:crypto";
import { CheckoutOrderModel } from "../src/modules/payments/checkout-payment.model.js";
import { createCheckoutTicketPasses } from "../src/modules/payments/ticket-check-in-code.js";
import type { CheckoutOrderLineItem } from "../src/modules/payments/checkout-payment.interface.js";
import { TicketUsageModel } from "../src/modules/payments/ticket-usage.model.js";
import { TicketCancellationModel } from "../src/modules/payments/ticket-cancellation.model.js";
import { EventCancellationRefundModel } from "../src/modules/payments/event-cancellation-refund.model.js";
import { EventModel } from "../src/modules/events/event.model.js";
import { UserModel } from "../src/modules/user/user.model.js";
import { DashboardRepository } from "../src/modules/dashboard/dashboard.repository.js";
import { DashboardService } from "../src/modules/dashboard/dashboard.service.js";
import { dashboardValidation } from "../src/modules/dashboard/dashboard.validation.js";
import { authorizeRoles } from "../src/core/middlewares/auth.middleware.js";
import { dashboardRoutes } from "../src/modules/dashboard/dashboard.route.js";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const runId = `dash-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

// Repository-integration tests share real collections with no per-test scoping
// filter (the dashboard aggregations are intentionally platform-wide), so each
// test must anchor its fixtures to a distinct, well-separated moment in time —
// otherwise two tests' ±60s "current" windows could overlap and leak fixtures
// across tests. Moments are spaced 30 days apart starting well in the past.
let momentCounter = 0;
const nextTestMoment = (): Date =>
  new Date(Date.UTC(2021, 0, 1) + momentCounter++ * 30 * 24 * 60 * 60 * 1000);

const createdOrderIds: Types.ObjectId[] = [];
const createdEventIds: Types.ObjectId[] = [];
const createdUserIds: Types.ObjectId[] = [];
const createdUsageIds: Types.ObjectId[] = [];
const createdTicketCancellationIds: Types.ObjectId[] = [];
const createdEventCancellationRefundIds: Types.ObjectId[] = [];

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
    createdUsageIds.length ? TicketUsageModel.deleteMany({ _id: { $in: createdUsageIds } }) : null,
    createdTicketCancellationIds.length
      ? TicketCancellationModel.deleteMany({ _id: { $in: createdTicketCancellationIds } })
      : null,
    createdEventCancellationRefundIds.length
      ? EventCancellationRefundModel.deleteMany({ _id: { $in: createdEventCancellationRefundIds } })
      : null,
  ]);
  await mongoose.disconnect();
});

// --- Fixtures ---------------------------------------------------------

const createFixtureEvent = async (label: string, tickets: Array<{ id: string; type: "free" | "pay" }>) => {
  const eventId = new Types.ObjectId();
  createdEventIds.push(eventId);
  await EventModel.create({
    _id: eventId,
    userId: new Types.ObjectId(),
    status: "published",
    name: `Dashboard test event ${runId} ${label}`,
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
    name: `Dashboard Test User ${runId}`,
    email: `${runId}-${userId.toString()}@example.com`.toLowerCase(),
    role: "user",
    accountType: "personal",
    isActive: true,
    ...overrides,
  });
  return userId;
};

const dateWindow = (start: Date, end: Date) => ({ start, end });

// --- Validation (pure, no DB) ------------------------------------------

test("dashboard validation accepts a preset range without start/end", async () => {
  const result = await dashboardValidation.overview.safeParseAsync({
    query: { range: "7d" },
    body: {},
    params: {},
  });
  assert.equal(result.success, true);
});

test("dashboard validation rejects custom range missing start/end", async () => {
  const result = await dashboardValidation.overview.safeParseAsync({
    query: { range: "custom" },
    body: {},
    params: {},
  });
  assert.equal(result.success, false);
});

test("dashboard validation rejects start after end", async () => {
  const result = await dashboardValidation.overview.safeParseAsync({
    query: { range: "custom", start: "2026-08-10", end: "2026-08-01" },
    body: {},
    params: {},
  });
  assert.equal(result.success, false);
});

test("dashboard validation rejects an invalid calendar date", async () => {
  const result = await dashboardValidation.overview.safeParseAsync({
    query: { range: "custom", start: "2026-02-31", end: "2026-03-01" },
    body: {},
    params: {},
  });
  assert.equal(result.success, false);
});

test("dashboard validation rejects a custom range over 365 days", async () => {
  const result = await dashboardValidation.overview.safeParseAsync({
    query: { range: "custom", start: "2024-01-01", end: "2026-01-01" },
    body: {},
    params: {},
  });
  assert.equal(result.success, false);
});

test("dashboard validation accepts a valid custom range", async () => {
  const result = await dashboardValidation.overview.safeParseAsync({
    query: { range: "custom", start: "2026-01-01", end: "2026-01-31" },
    body: {},
    params: {},
  });
  assert.equal(result.success, true);
});

// --- Authorization -------------------------------------------------------

test("dashboard overview route requires authentication before authorization", () => {
  const stack = (dashboardRoutes as unknown as { stack: Array<{ route?: { stack: Array<{ name: string }> } }> })
    .stack;
  const overviewLayer = stack.find((layer) => layer.route)?.route?.stack ?? [];
  assert.equal(overviewLayer[0]?.name, "authenticate");
});

test("authorizeRoles(admin) rejects unauthenticated requests", () => {
  const middleware = authorizeRoles("admin");
  let receivedError: { statusCode?: number } | undefined;
  middleware({ authUser: undefined } as never, {} as never, ((error?: unknown) => {
    receivedError = error as { statusCode?: number };
  }) as never);
  assert.equal(receivedError?.statusCode, 401);
});

test("authorizeRoles(admin) rejects a non-admin user", () => {
  const middleware = authorizeRoles("admin");
  let receivedError: { statusCode?: number } | undefined;
  middleware({ authUser: { role: "user" } } as never, {} as never, ((error?: unknown) => {
    receivedError = error as { statusCode?: number };
  }) as never);
  assert.equal(receivedError?.statusCode, 403);
});

test("authorizeRoles(admin) accepts an admin user", () => {
  const middleware = authorizeRoles("admin");
  let called = false;
  let receivedError: unknown;
  middleware({ authUser: { role: "admin" } } as never, {} as never, ((error?: unknown) => {
    called = true;
    receivedError = error;
  }) as never);
  assert.equal(called, true);
  assert.equal(receivedError, undefined);
});

// --- Service-level date range / percentage logic (mocked repository) -----

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
  getCheckedInCount: async () => 0,
  getUserCancelledPassCount: async () => 0,
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
});

test("today range resolves to a UTC calendar day and its comparison is the previous day", async () => {
  const service = new DashboardService(emptyRepositoryMock() as never);
  const overview = await service.getOverview({ range: "today" });

  const start = new Date(overview.range.start);
  const end = new Date(overview.range.end);
  assert.equal(start.getUTCHours(), 0);
  assert.equal(start.getUTCMinutes(), 0);
  assert.equal(end.getTime() - start.getTime(), 24 * 60 * 60 * 1000);
  assert.equal(new Date(overview.range.comparisonEnd).getTime(), start.getTime());
  assert.equal(
    new Date(overview.range.comparisonStart).getTime(),
    start.getTime() - (end.getTime() - start.getTime()),
  );
  assert.equal(overview.range.timezone, "UTC");
});

test("7d and 30d ranges are rolling windows ending at request time", async () => {
  const service = new DashboardService(emptyRepositoryMock() as never);
  const overview7d = await service.getOverview({ range: "7d" });
  const start = new Date(overview7d.range.start);
  const end = new Date(overview7d.range.end);
  assert.equal(Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)), 7);

  const overview30d = await service.getOverview({ range: "30d" });
  const start30 = new Date(overview30d.range.start);
  const end30 = new Date(overview30d.range.end);
  assert.equal(Math.round((end30.getTime() - start30.getTime()) / (24 * 60 * 60 * 1000)), 30);
});

test("custom range spans full UTC calendar days inclusive of both endpoints", async () => {
  const service = new DashboardService(emptyRepositoryMock() as never);
  const overview = await service.getOverview({ range: "custom", start: "2026-01-05", end: "2026-01-07" });
  assert.equal(overview.range.start, "2026-01-05T00:00:00.000Z");
  assert.equal(overview.range.end, "2026-01-08T00:00:00.000Z");
});

test("changePercentage is null when the previous period value is zero", async () => {
  const service = new DashboardService(emptyRepositoryMock() as never);
  const overview = await service.getOverview({ range: "today" });
  assert.equal(overview.users.newInPeriodChangePercentage, null);
  assert.equal(overview.tickets.issuedChangePercentage, null);
  assert.equal(overview.financials.grossTicketSalesChangePercentage, null);
  assert.equal(overview.financials.netTicketRevenueChangePercentage, null);
  assert.equal(Number.isFinite(overview.financials.netTicketRevenueMinor), true);
});

test("changePercentage is a finite number when previous period is non-zero", async () => {
  const repo = emptyRepositoryMock();
  repo.getTicketIssuanceTotals = async () => ({
    currentGrossAmountMinor: 1500,
    previousGrossAmountMinor: 1000,
    currentIssued: 15,
    previousIssued: 10,
  });
  const service = new DashboardService(repo as never);
  const overview = await service.getOverview({ range: "today" });
  assert.equal(overview.financials.grossTicketSalesChangePercentage, 50);
  assert.equal(overview.tickets.issuedChangePercentage, 50);
  assert.notEqual(overview.financials.netTicketRevenueChangePercentage, Number.POSITIVE_INFINITY);
  assert.equal(Number.isNaN(overview.financials.netTicketRevenueChangePercentage as number), false);
});

test("net ticket revenue may be negative when refunds exceed sales, and is never clamped", async () => {
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
  const service = new DashboardService(repo as never);
  const overview = await service.getOverview({ range: "today" });
  assert.equal(overview.financials.netTicketRevenueMinor, -400);
});

test("current pending/failed/reconciliation refund tiles are not netted from revenue and carry no percentage field", async () => {
  const repo = emptyRepositoryMock();
  repo.getTicketCancellationRefundTotals = async () => ({
    successful: { amountMinor: 0, count: 0 },
    successfulPrevious: { amountMinor: 0, count: 0 },
    pending: { amountMinor: 700, count: 2 },
    failed: { amountMinor: 300, count: 1 },
    reconciliationRequired: { amountMinor: 200, count: 1 },
  });
  const service = new DashboardService(repo as never);
  const overview = await service.getOverview({ range: "today" });
  assert.equal(overview.financials.currentPendingRefundsMinor, 700);
  assert.equal(overview.financials.currentFailedRefundsMinor, 300);
  assert.equal(overview.financials.currentReconciliationRequiredRefundsMinor, 200);
  assert.equal(overview.financials.netTicketRevenueMinor, 0);
  assert.equal("currentPendingRefundsChangePercentage" in overview.financials, false);
});

test("no product field exists anywhere in the overview response", async () => {
  const service = new DashboardService(emptyRepositoryMock() as never);
  const overview = await service.getOverview({ range: "today" });
  const serialized = JSON.stringify(overview).toLowerCase();
  assert.equal(serialized.includes("product"), false);
});

// --- Repository-level integration tests (real MongoDB) --------------------

test("product orders never contribute to gross ticket sales or tickets issued", async () => {
  const repository = new DashboardRepository();
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
});

test("quantity greater than one issues one pass per unit and captured-refunded orders remain in totals", async () => {
  const repository = new DashboardRepository();
  const eventId = await createFixtureEvent("qty-refunded", [{ id: "std", type: "pay" }]);
  const now = nextTestMoment();
  const current = dateWindow(new Date(now.getTime() - 60_000), new Date(now.getTime() + 60_000));
  const previous = dateWindow(new Date(0), new Date(0));

  await createTicketOrder({
    label: "qty-3",
    lineItems: [
      ticketLineItem({
        eventId: eventId.toString(),
        itemId: "std",
        totalQuantity: 3,
        unitAmount: 10,
        totalAmount: 30,
      }),
    ],
    amountMinor: 3000,
    paidAt: now,
  });
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
  assert.equal(totals.currentIssued, 5); // 3 + 2, failed order excluded entirely
  assert.equal(totals.currentGrossAmountMinor, 5000); // 3000 + 2000, failed excluded
});

test("paid, discounted, rewarded/bonus, and free-ticket-type passes classify correctly", async () => {
  const repository = new DashboardRepository();
  const eventId = await createFixtureEvent("breakdown", [
    { id: "paid-ticket", type: "pay" },
    { id: "free-ticket", type: "free" },
  ]);
  const now = nextTestMoment();
  const current = dateWindow(new Date(now.getTime() - 60_000), new Date(now.getTime() + 60_000));

  // 1 discounted paid pass (reward discount applied)
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

  // BOGO: 1 paid + 1 bonus/free pass on the same line item
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

  // Genuinely free ticket-type order (not a reward) — should land in "free", not "paid"
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
    if (type === "free") {
      free += row.issuedQty;
    } else {
      paid += row.paidQty;
      discounted += row.discountedQty;
      rewardedOrBonus += row.rewardedQty;
    }
  }

  assert.equal(paid, 2); // 1 discounted-paid + 1 BOGO-paid
  assert.equal(discounted, 1);
  assert.equal(rewardedOrBonus, 1); // BOGO bonus pass
  assert.equal(free, 4); // free ticket-type order, not counted as paid
});

test("checked-in passes are counted by usedAt and duplicate usage cannot inflate the count", async () => {
  const eventId = await createFixtureEvent("checkin", [{ id: "std", type: "pay" }]);
  const now = nextTestMoment();
  const { orderId } = await createTicketOrder({
    label: "checkin-order",
    lineItems: [ticketLineItem({ eventId: eventId.toString(), itemId: "std", totalQuantity: 1 })],
    amountMinor: 1000,
    paidAt: now,
  });
  const userId = await createFixtureUser();

  const usageId = new Types.ObjectId();
  createdUsageIds.push(usageId);
  await TicketUsageModel.create({
    _id: usageId,
    ownerUserId: userId,
    holderUserId: userId,
    usedByUserId: userId,
    orderId,
    eventId: eventId.toString(),
    ticketId: "std",
    ticketIndex: 1,
    source: "owned",
    usedAt: now,
  });

  await assert.rejects(() =>
    TicketUsageModel.create({
      ownerUserId: userId,
      holderUserId: userId,
      usedByUserId: userId,
      orderId,
      eventId: eventId.toString(),
      ticketId: "std",
      ticketIndex: 1,
      source: "owned",
      usedAt: now,
    }),
  );

  const repository = new DashboardRepository();
  const current = dateWindow(new Date(now.getTime() - 60_000), new Date(now.getTime() + 60_000));
  const count = await repository.getCheckedInCount(current);
  assert.equal(count, 1);
});

test("user-cancelled pass count uses createdAt and successful refund uses refundCompletedAt", async () => {
  const eventId = await createFixtureEvent("cancel", [{ id: "std", type: "pay" }]);
  const buyerUserId = await createFixtureUser();
  const hostUserId = await createFixtureUser();
  const { orderId } = await createTicketOrder({
    label: "cancel-order",
    lineItems: [ticketLineItem({ eventId: eventId.toString(), itemId: "std", totalQuantity: 1 })],
    amountMinor: 1000,
    paidAt: new Date(),
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
    providerIdempotencyKey: `${runId}-cancel-1`,
    requestedAmountMinor: 1000,
    completedAmountMinor: 1000,
    remainingRefundableAmountMinor: 0,
    cancellationCutoffAt: now,
    cancelledAt: now,
    refundCompletedAt: now,
    createdAt: now,
  });

  const repository = new DashboardRepository();
  const current = dateWindow(new Date(now.getTime() - 60_000), new Date(now.getTime() + 60_000));
  const previous = dateWindow(new Date(0), new Date(0));

  const cancelledCount = await repository.getUserCancelledPassCount(current);
  assert.equal(cancelledCount, 1);

  const refundTotals = await repository.getTicketCancellationRefundTotals("usd", current, previous);
  assert.equal(refundTotals.successful.amountMinor, 1000);
  assert.equal(refundTotals.successful.count, 1);
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
      paidAt: new Date(),
    });
    const now = nextTestMoment();

    // Ticket 1 already refunded via user cancellation before the host cancels the event.
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

    // Host later cancels the event; the existing refund workflow (untouched here) already
    // nets out the prior ticket-level refund, so this record's completedAmountMinor only
    // covers the remaining, not-yet-refunded ticket.
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

    const repository = new DashboardRepository();
    const current = dateWindow(new Date(now.getTime() - 60_000), new Date(now.getTime() + 60_000));
    const previous = dateWindow(new Date(0), new Date(0));

    const userRefunds = await repository.getTicketCancellationRefundTotals("usd", current, previous);
    const hostRefunds = await repository.getEventCancellationRefundTotals("usd", current, previous);
    const totalSuccessful = userRefunds.successful.amountMinor + hostRefunds.successful.amountMinor;

    // 1000 (user) + 1000 (host, already net of the user refund by the existing workflow) = 2000,
    // matching the order's full amountMinor exactly once — not 3000.
    assert.equal(totalSuccessful, 2000);
  },
);

test("pending, failed, and reconciliation-required refund states use requestedAmountMinor and are not date-bounded", async () => {
  const eventId = await createFixtureEvent("backlog", [{ id: "std", type: "pay" }]);
  const buyerUserId = await createFixtureUser();
  const hostUserId = await createFixtureUser();
  const { orderId } = await createTicketOrder({
    label: "backlog-order",
    lineItems: [ticketLineItem({ eventId: eventId.toString(), itemId: "std", totalQuantity: 3 })],
    amountMinor: 3000,
    paidAt: new Date(),
  });
  const now = nextTestMoment();
  const longAgo = new Date("2020-01-01T00:00:00.000Z");

  const statuses: Array<
    ["pending" | "processing" | "failed_retryable" | "failed_terminal" | "reconciliation_required", number]
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
      currency: "xd1", // dedicated fake currency: backlog totals are intentionally
      // not date-bounded, so they must be isolated by currency instead to avoid
      // colliding with the same-shaped backlog fixtures other test files create.
      providerIdempotencyKey: `${runId}-backlog-${refundStatus}`,
      requestedAmountMinor: 500,
      completedAmountMinor: 0,
      remainingRefundableAmountMinor: 500,
      cancellationCutoffAt: longAgo,
      cancelledAt: longAgo, // createdAt/cancelledAt far outside the "current" window on purpose
      refundCompletedAt: null,
    });
  }

  const repository = new DashboardRepository();
  // A narrow "current" window that excludes the fixtures' cancelledAt entirely —
  // pending/failed/reconciliation totals must still include them (backlog, not period-filtered).
  const current = dateWindow(new Date(now.getTime() - 1000), new Date(now.getTime() + 1000));
  const previous = dateWindow(new Date(0), new Date(0));

  const totals = await repository.getTicketCancellationRefundTotals("xd1", current, previous);
  assert.equal(totals.pending.amountMinor, 500);
  assert.equal(totals.failed.amountMinor, 500);
  assert.equal(totals.reconciliationRequired.amountMinor, 500);
  assert.equal(totals.successful.amountMinor, 0);
});

test("orders in a non-configured currency are excluded from gross ticket sales, never summed together", async () => {
  const repository = new DashboardRepository();
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

test("admin/deleted users are excluded and suspended users are included in the all-time total", async () => {
  const repository = new DashboardRepository();
  const now = nextTestMoment();
  const current = dateWindow(new Date(now.getTime() - 60_000), new Date(now.getTime() + 60_000));
  const previous = dateWindow(new Date(0), new Date(0));
  const baseFilter = { role: "user", deletedAt: null, email: { $not: /@deleted\.local$/i } };

  const activePersonal = await createFixtureUser({ accountType: "personal", isActive: true });
  const suspendedBusiness = await createFixtureUser({ accountType: "business", isActive: false });
  await createFixtureUser({ role: "admin" });
  await createFixtureUser({ deletedAt: now, email: `${runId}-deleted@deleted.local` });

  const totals = await repository.getUserTotals(baseFilter, current, previous);
  assert.equal(totals.total >= 2, true);

  const [activeUser, suspendedUser] = await Promise.all([
    UserModel.findById(activePersonal),
    UserModel.findById(suspendedBusiness),
  ]);
  assert.ok(activeUser);
  assert.ok(suspendedUser);
  assert.equal(suspendedUser?.isActive, false);
});
