import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { TicketCancellationService } from "../src/modules/payments/ticket-cancellation.service.js";
import type { ITicketCancellation } from "../src/modules/payments/ticket-cancellation.interface.js";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const eventId = new Types.ObjectId("64f000000000000000000101");
const orderId = new Types.ObjectId("64f000000000000000000102");
const buyerId = new Types.ObjectId("64f000000000000000000103");
const recipientId = new Types.ObjectId("64f000000000000000000104");
const hostId = new Types.ObjectId("64f000000000000000000105");
const ticketId = "standard";
const rewardId = "reward-1";
const payload = {
  eventId: eventId.toString(),
  ticketId,
  orderId: orderId.toString(),
  ticketIndex: 1,
};
const buyer = { id: buyerId.toString(), name: "Buyer" };

const createRewardedOrder = (overrides: Record<string, unknown> = {}) => ({
  _id: orderId,
  userId: buyerId,
  kind: "ticket",
  paymentStatus: "paid",
  currency: "usd",
  platformFeeAmount: 9,
  taxAmount: 0,
  amountMinor: 9900,
  lineItems: [{
    itemType: "ticket",
    eventId: eventId.toString(),
    itemId: ticketId,
    name: "Standard",
    quantity: 2,
    paidQuantity: 2,
    freeQuantity: 1,
    totalQuantity: 3,
    rewardId,
    rewardSnapshot: {
      rewardId,
      rewardType: "ticket",
      name: "Buy 2 get 1",
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
      appliedAt: new Date("2026-07-30T09:00:00.000Z"),
    },
    unitAmount: 45,
    totalAmount: 90,
  }],
  ticketPasses: [
    { eventId: eventId.toString(), ticketId, ticketIndex: 1, checkInCode: "MOM-26-ABCD-EFG1" },
    { eventId: eventId.toString(), ticketId, ticketIndex: 2, checkInCode: "MOM-26-ABCD-EFG2" },
    { eventId: eventId.toString(), ticketId, ticketIndex: 3, checkInCode: "MOM-26-ABCD-EFG3" },
  ],
  ...overrides,
});

const createRewardedEvent = () => ({
  _id: eventId,
  userId: hostId,
  name: "Launch Night",
  status: "published",
  scheduledAt: new Date("2026-08-01T12:00:00.000Z"),
  tickets: [{ id: ticketId, name: "Standard", type: "pay", price: 45, capacity: 10 }],
  rewards: [{ id: rewardId, name: "Buy 2 get 1", capacityLimited: true, capacity: 10, availableCount: 9 }],
});

const createRewardClaim = () => ({
  _id: new Types.ObjectId("64f000000000000000000199"),
  userId: buyerId,
  eventId,
  rewardId,
  ticketId,
  checkoutOrderId: orderId,
  status: "released",
  source: "checkout",
  claimedAt: new Date("2026-07-30T09:00:00.000Z"),
  redeemedAt: new Date("2026-07-30T09:00:00.000Z"),
  releasedAt: new Date("2026-07-30T10:00:00.000Z"),
  createdAt: new Date("2026-07-30T09:00:00.000Z"),
  updatedAt: new Date("2026-07-30T10:00:00.000Z"),
});

const createCompletedRewardedCancellation = (ticketIndex: number): ITicketCancellation => createCancellation({
  _id: new Types.ObjectId(`64f0000000000000000001${String(ticketIndex).padStart(2, "0")}`),
  ticketIndex,
  ticketType: ticketIndex === 3 ? "rewarded" : "paid",
  requestedAmountMinor: ticketIndex === 3 ? 0 : 4950,
  completedAmountMinor: 0,
  remainingRefundableAmountMinor: ticketIndex === 3 ? 0 : 4950,
  capacityReleaseStatus: "completed",
  refundStatus: ticketIndex === 3 ? "not_required" : "pending",
});

const createPassClaimRepository = (overrides: {
  claimForCancellation?: () => Promise<{ claimed: true } | { claimed: false; reason: "cancelled" | "used" | "busy" }>;
  acceptCancellation?: () => Promise<boolean>;
  abortCancellation?: () => Promise<void>;
} = {}) => ({
  claimForCancellation: overrides.claimForCancellation ?? (async () => ({ claimed: true })),
  acceptCancellation: overrides.acceptCancellation ?? (async () => true),
  abortCancellation: overrides.abortCancellation ?? (async () => undefined),
});

const createCancellation = (overrides: Partial<ITicketCancellation> = {}): ITicketCancellation => ({
  _id: new Types.ObjectId("64f000000000000000000106"),
  sourceType: "user_ticket_cancellation",
  eventId,
  ticketId,
  orderId,
  ticketIndex: 1,
  buyerUserId: buyerId,
  hostUserId: hostId,
  sharedRecipientUserId: recipientId,
  activeShareId: null,
  eventName: "Launch Night",
  ticketName: "Standard",
  status: "cancelled",
  refundStatus: "pending",
  currency: "usd",
  stripePaymentIntentId: "pi_test",
  stripeRefundId: null,
  providerIdempotencyKey: "ticket-cancellation-refund:test",
  providerStatus: null,
  ticketSubtotalAmountMinor: 4500,
  platformFeeAmountMinor: 450,
  taxAmountMinor: 225,
  discountAmountMinor: 0,
  requestedAmountMinor: 5175,
  completedAmountMinor: 0,
  remainingRefundableAmountMinor: 5175,
  orderCapturedAmountMinor: 5175,
  previousCancellationAmountMinor: 0,
  capacityReleaseStatus: "completed",
  shareRevocationStatus: "completed",
  qrInvalidationStatus: "completed",
  creatorEarningAdjustmentStatus: "completed",
  taxReversalStatus: "completed",
  notificationState: {},
  attemptCount: 0,
  nextRetryAt: null,
  lockedBy: null,
  lockedAt: null,
  lockExpiresAt: null,
  lastErrorCode: null,
  safeLastErrorMessage: null,
  cancellationCutoffAt: new Date("2026-08-01T09:00:00.000Z"),
  cancelledAt: new Date("2026-07-30T09:00:00.000Z"),
  refundCompletedAt: null,
  lastReconciledAt: null,
  auditHistory: [],
  createdAt: new Date("2026-07-30T09:00:00.000Z"),
  updatedAt: new Date("2026-07-30T09:00:00.000Z"),
  ...overrides,
});

test("existing cancellation response remains scoped to the original buyer", async () => {
  const cancellation = createCancellation();
  const service = new TicketCancellationService(
    { findByPass: async () => cancellation } as never,
    { findById: async () => null } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  const response = await service.cancelTicketPass(buyer as never, payload);
  assert.equal(response.id, cancellation._id.toString());
  assert.equal(response.requestedAmountMinor, 5175);

  await assert.rejects(
    () => service.cancelTicketPass({ id: recipientId.toString(), name: "Recipient" } as never, payload),
    { message: "Only the original buyer can cancel this ticket.", statusCode: 403 },
  );
});

test("latest scheduledAt cutoff allows one second before and rejects the exact instant", async () => {
  const scheduledAt = new Date("2026-08-01T12:00:00.000Z");
  const cutoffAt = new Date("2026-08-01T09:00:00.000Z");
  const cancellation = createCancellation({ cancellationCutoffAt: cutoffAt });
  const order = {
    _id: orderId,
    userId: buyerId,
    kind: "ticket",
    paymentStatus: "paid",
    currency: "usd",
    platformFeeAmount: 4.5,
    taxAmount: 2.25,
    amountMinor: 5175,
    lineItems: [{
      itemType: "ticket",
      eventId: eventId.toString(),
      itemId: ticketId,
      name: "Standard",
      quantity: 1,
      paidQuantity: 1,
      freeQuantity: 0,
      totalQuantity: 1,
      unitAmount: 45,
      totalAmount: 45,
    }],
    ticketPasses: [{ eventId: eventId.toString(), ticketId, ticketIndex: 1, checkInCode: "MOM-26-ABCD-EFGH" }],
  };
  const event = {
    _id: eventId,
    userId: hostId,
    status: "published",
    scheduledAt,
    tickets: [{ id: ticketId, name: "Standard", type: "pay", price: 45, capacity: 10 }],
    rewards: [],
  };
  const createOrGetCalls: unknown[] = [];
  const service = new TicketCancellationService(
    {
      findByPass: async () => null,
      sumRequestedAmountByOrderId: async () => 0,
      createOrGet: async (createPayload: unknown) => {
        createOrGetCalls.push(createPayload);
        return { cancellation, created: false };
      },
    } as never,
    { findById: async () => order } as never,
    { findById: async () => event } as never,
    { findActiveByTicketPass: async () => null } as never,
    { findByTicketPass: async () => null } as never,
    { findRefundItemsByOrderIds: async () => [] } as never,
    {} as never,
    {} as never,
    createPassClaimRepository() as never,
  );
  const originalNow = Date.now;

  try {
    Date.now = () => cutoffAt.getTime() - 1000;
    const response = await service.cancelTicketPass(buyer as never, payload);
    assert.equal(response.cancellationCutoffAt.toISOString(), cutoffAt.toISOString());
    assert.equal(createOrGetCalls.length, 1);

    Date.now = () => cutoffAt.getTime();
    await assert.rejects(
      () => service.cancelTicketPass(buyer as never, payload),
      {
        message: "Ticket cancellation is unavailable within 3 hours of the event start time.",
        statusCode: 409,
      },
    );
  } finally {
    Date.now = originalNow;
  }
});

test("check-in winning before cancellation acceptance leaves no cancellation effects", async () => {
  const scheduledAt = new Date("2026-08-01T12:00:00.000Z");
  const cutoffAt = new Date("2026-08-01T09:00:00.000Z");
  const order = {
    _id: orderId,
    userId: buyerId,
    kind: "ticket",
    paymentStatus: "paid",
    currency: "usd",
    platformFeeAmount: 4.5,
    taxAmount: 2.25,
    amountMinor: 5175,
    lineItems: [{
      itemType: "ticket",
      eventId: eventId.toString(),
      itemId: ticketId,
      name: "Standard",
      quantity: 1,
      paidQuantity: 1,
      freeQuantity: 0,
      totalQuantity: 1,
      unitAmount: 45,
      totalAmount: 45,
    }],
    ticketPasses: [{ eventId: eventId.toString(), ticketId, ticketIndex: 1, checkInCode: "MOM-26-ABCD-EFGH" }],
  };
  const event = {
    _id: eventId,
    userId: hostId,
    status: "published",
    scheduledAt,
    tickets: [{ id: ticketId, name: "Standard", type: "pay", price: 45, capacity: 10 }],
    rewards: [],
  };
  let usageChecks = 0;
  let createOrGetCalls = 0;
  let releaseCalls = 0;
  let notificationCalls = 0;
  let abortCalls = 0;
  const service = new TicketCancellationService(
    {
      findByPass: async () => null,
      sumRequestedAmountByOrderId: async () => 0,
      createOrGet: async () => {
        createOrGetCalls += 1;
        throw new Error("ledger must not be created after check-in wins");
      },
    } as never,
    { findById: async () => order } as never,
    {
      findById: async () => event,
      releaseTicketAndRewardCapacity: async () => {
        releaseCalls += 1;
      },
    } as never,
    { findActiveByTicketPass: async () => null } as never,
    { findByTicketPass: async () => (++usageChecks === 1 ? null : { _id: new Types.ObjectId() }) } as never,
    { findRefundItemsByOrderIds: async () => [] } as never,
    { sendSystemNotification: async () => { notificationCalls += 1; } } as never,
    {} as never,
    createPassClaimRepository({
      abortCancellation: async () => {
        abortCalls += 1;
      },
    }) as never,
  );
  const originalNow = Date.now;

  try {
    Date.now = () => cutoffAt.getTime() - 1000;
    await assert.rejects(
      () => service.cancelTicketPass(buyer as never, payload),
      { message: "This ticket has already been used and can no longer be cancelled.", statusCode: 409 },
    );

    assert.equal(createOrGetCalls, 0);
    assert.equal(releaseCalls, 0);
    assert.equal(notificationCalls, 0);
    assert.equal(abortCalls, 1);
  } finally {
    Date.now = originalNow;
  }
});

test("two-device cancellation returns the accepted ledger after losing the pass claim", async () => {
  const cancellation = createCancellation();
  const order = {
    _id: orderId,
    userId: buyerId,
    kind: "ticket",
    paymentStatus: "paid",
    currency: "usd",
    platformFeeAmount: 4.5,
    taxAmount: 2.25,
    amountMinor: 5175,
    lineItems: [{
      itemType: "ticket",
      eventId: eventId.toString(),
      itemId: ticketId,
      name: "Standard",
      quantity: 1,
      paidQuantity: 1,
      freeQuantity: 0,
      totalQuantity: 1,
      unitAmount: 45,
      totalAmount: 45,
    }],
    ticketPasses: [{ eventId: eventId.toString(), ticketId, ticketIndex: 1, checkInCode: "MOM-26-ABCD-EFGH" }],
  };
  const event = {
    _id: eventId,
    userId: hostId,
    status: "published",
    scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    tickets: [{ id: ticketId, name: "Standard", type: "pay", price: 45, capacity: 10 }],
    rewards: [],
  };
  let findByPassCalls = 0;
  const service = new TicketCancellationService(
    {
      findByPass: async () => {
        findByPassCalls += 1;
        return findByPassCalls === 1 ? null : cancellation;
      },
    } as never,
    { findById: async () => order } as never,
    { findById: async () => event } as never,
    { findActiveByTicketPass: async () => null } as never,
    { findByTicketPass: async () => null } as never,
    { findRefundItemsByOrderIds: async () => [] } as never,
    {} as never,
    {} as never,
    createPassClaimRepository({
      claimForCancellation: async () => ({ claimed: false, reason: "cancelled" }),
    }) as never,
  );

  const response = await service.cancelTicketPass(buyer as never, payload);

  assert.equal(response.id, cancellation._id.toString());
  assert.equal(findByPassCalls, 2);
});

test("accepted paid cancellation releases one capacity unit and adjusts creator earning", async () => {
  const scheduledAt = new Date("2026-08-01T12:00:00.000Z");
  const cutoffAt = new Date("2026-08-01T09:00:00.000Z");
  const order = {
    _id: orderId,
    userId: buyerId,
    kind: "ticket",
    paymentStatus: "paid",
    currency: "usd",
    platformFeeAmount: 4.5,
    taxAmount: 2.25,
    amountMinor: 5175,
    stripePaymentIntentId: "pi_test",
    lineItems: [{
      itemType: "ticket",
      eventId: eventId.toString(),
      itemId: ticketId,
      name: "Standard",
      quantity: 1,
      paidQuantity: 1,
      freeQuantity: 0,
      totalQuantity: 1,
      unitAmount: 45,
      totalAmount: 45,
      sellerUserId: hostId,
    }],
    ticketPasses: [{ eventId: eventId.toString(), ticketId, ticketIndex: 1, checkInCode: "MOM-26-ABCD-EFGH" }],
  };
  const event = {
    _id: eventId,
    userId: hostId,
    name: "Launch Night",
    status: "published",
    scheduledAt,
    tickets: [{ id: ticketId, name: "Standard", type: "pay", price: 45, capacity: 10 }],
    rewards: [],
  };
  let releaseCall: unknown[] | null = null;
  let earningCall: unknown[] | null = null;
  let createdPayload: ITicketCancellation | null = null;
  const repository = {
    findByPass: async () => null,
    sumRequestedAmountByOrderId: async () => 0,
    createOrGet: async (createPayload: Omit<ITicketCancellation, "_id" | "createdAt" | "updatedAt">) => {
      createdPayload = {
        _id: new Types.ObjectId("64f000000000000000000107"),
        createdAt: new Date("2026-07-30T09:00:00.000Z"),
        updatedAt: new Date("2026-07-30T09:00:00.000Z"),
        ...createPayload,
      };
      return { cancellation: createdPayload, created: true };
    },
    update: async (_id: string, update: { $set?: Partial<ITicketCancellation> }) => {
      assert.ok(createdPayload);
      createdPayload = { ...createdPayload, ...(update.$set ?? {}) };
      return createdPayload;
    },
  };
  const service = new TicketCancellationService(
    repository as never,
    { findById: async () => order } as never,
    {
      findById: async () => event,
      releaseTicketAndRewardCapacity: async (...args: unknown[]) => {
        releaseCall = args;
      },
    } as never,
    { findActiveByTicketPass: async () => null } as never,
    { findByTicketPass: async () => null } as never,
    { findRefundItemsByOrderIds: async () => [] } as never,
    { sendSystemNotification: async () => undefined } as never,
    {
      adjustTicketCancellationAmount: async (...args: unknown[]) => {
        earningCall = args;
        return "completed";
      },
    } as never,
    createPassClaimRepository() as never,
  );
  const originalNow = Date.now;

  try {
    Date.now = () => cutoffAt.getTime() - 1000;
    const response = await service.cancelTicketPass(buyer as never, payload);

    assert.equal(response.requestedAmountMinor, 5175);
    assert.deepEqual(releaseCall, [eventId.toString(), ticketId, 1, null, 0]);
    assert.deepEqual(earningCall, [orderId.toString(), `ticket:${eventId.toString()}:${ticketId}`, 45]);
  } finally {
    Date.now = originalNow;
  }
});

test("partial rewarded paid-pass cancellation keeps the reward claim redeemed", async () => {
  const order = createRewardedOrder();
  const event = createRewardedEvent();
  const cancellations: ITicketCancellation[] = [];
  const releaseCalls: unknown[][] = [];
  let rewardReleaseCalls = 0;
  const service = new TicketCancellationService(
    {
      findByPass: async () => null,
      findByOrderId: async () => cancellations,
      sumRequestedAmountByOrderId: async () => 0,
      createOrGet: async (createPayload: Omit<ITicketCancellation, "_id" | "createdAt" | "updatedAt">) => {
        const created = createCancellation({
          ...createPayload,
          _id: new Types.ObjectId("64f000000000000000000201"),
          capacityReleaseStatus: "pending",
        });
        cancellations.push(created);
        return { cancellation: created, created: true };
      },
      update: async (_id: string, update: { $set?: Partial<ITicketCancellation> }) => {
        const cancellation = cancellations.find((item) => item._id.toString() === _id);
        assert.ok(cancellation);
        Object.assign(cancellation, update.$set ?? {});
        return cancellation;
      },
    } as never,
    { findById: async () => order } as never,
    {
      findById: async () => event,
      releaseTicketAndRewardCapacity: async (...args: unknown[]) => {
        releaseCalls.push(args);
      },
    } as never,
    { findActiveByTicketPass: async () => null } as never,
    { findByTicketPass: async () => null } as never,
    { findRefundItemsByOrderIds: async () => [] } as never,
    { sendSystemNotification: async () => undefined } as never,
    {} as never,
    createPassClaimRepository() as never,
    {} as never,
    {} as never,
    {
      releaseCheckoutRewardRedemptionAndRestoreCapacity: async () => {
        rewardReleaseCalls += 1;
        return createRewardClaim();
      },
    } as never,
  );
  const originalNow = Date.now;

  try {
    Date.now = () => new Date("2026-08-01T08:59:59.000Z").getTime();
    await service.cancelTicketPass(buyer as never, { ...payload, ticketIndex: 1 });

    assert.equal(rewardReleaseCalls, 0);
    assert.deepEqual(releaseCalls, [[eventId.toString(), ticketId, 1, null, 0]]);
  } finally {
    Date.now = originalNow;
  }
});

test("rewarded purchase remains redeemed when all paid passes are cancelled but the free pass remains", async () => {
  const order = createRewardedOrder();
  const event = createRewardedEvent();
  const cancellations = [createCompletedRewardedCancellation(1)];
  let rewardReleaseCalls = 0;
  const service = new TicketCancellationService(
    {
      findByPass: async () => null,
      findByOrderId: async () => cancellations,
      sumRequestedAmountByOrderId: async () => 4950,
      createOrGet: async (createPayload: Omit<ITicketCancellation, "_id" | "createdAt" | "updatedAt">) => {
        const created = createCancellation({
          ...createPayload,
          _id: new Types.ObjectId("64f000000000000000000202"),
          ticketIndex: 2,
          capacityReleaseStatus: "pending",
        });
        cancellations.push(created);
        return { cancellation: created, created: true };
      },
      update: async (_id: string, update: { $set?: Partial<ITicketCancellation> }) => {
        const cancellation = cancellations.find((item) => item._id.toString() === _id);
        assert.ok(cancellation);
        Object.assign(cancellation, update.$set ?? {});
        return cancellation;
      },
    } as never,
    { findById: async () => order } as never,
    { findById: async () => event, releaseTicketAndRewardCapacity: async () => undefined } as never,
    { findActiveByTicketPass: async () => null } as never,
    { findByTicketPass: async () => null } as never,
    { findRefundItemsByOrderIds: async () => [] } as never,
    { sendSystemNotification: async () => undefined } as never,
    {} as never,
    createPassClaimRepository() as never,
    {} as never,
    {} as never,
    {
      releaseCheckoutRewardRedemptionAndRestoreCapacity: async () => {
        rewardReleaseCalls += 1;
        return createRewardClaim();
      },
    } as never,
  );
  const originalNow = Date.now;

  try {
    Date.now = () => new Date("2026-08-01T08:59:59.000Z").getTime();
    await service.cancelTicketPass(buyer as never, { ...payload, ticketIndex: 2 });

    assert.equal(rewardReleaseCalls, 0);
  } finally {
    Date.now = originalNow;
  }
});

test("rewarded purchase remains redeemed when the free pass is cancelled but a paid pass remains", async () => {
  const order = createRewardedOrder();
  const event = createRewardedEvent();
  const cancellations = [createCompletedRewardedCancellation(1)];
  let rewardReleaseCalls = 0;
  const service = new TicketCancellationService(
    {
      findByPass: async () => null,
      findByOrderId: async () => cancellations,
      sumRequestedAmountByOrderId: async () => 4950,
      createOrGet: async (createPayload: Omit<ITicketCancellation, "_id" | "createdAt" | "updatedAt">) => {
        const created = createCancellation({
          ...createPayload,
          _id: new Types.ObjectId("64f000000000000000000203"),
          ticketIndex: 3,
          capacityReleaseStatus: "pending",
        });
        cancellations.push(created);
        return { cancellation: created, created: true };
      },
      update: async (_id: string, update: { $set?: Partial<ITicketCancellation> }) => {
        const cancellation = cancellations.find((item) => item._id.toString() === _id);
        assert.ok(cancellation);
        Object.assign(cancellation, update.$set ?? {});
        return cancellation;
      },
    } as never,
    { findById: async () => order } as never,
    { findById: async () => event, releaseTicketAndRewardCapacity: async () => undefined } as never,
    { findActiveByTicketPass: async () => null } as never,
    { findByTicketPass: async () => null } as never,
    { findRefundItemsByOrderIds: async () => [] } as never,
    { sendSystemNotification: async () => undefined } as never,
    {} as never,
    createPassClaimRepository() as never,
    {} as never,
    {} as never,
    {
      releaseCheckoutRewardRedemptionAndRestoreCapacity: async () => {
        rewardReleaseCalls += 1;
        return createRewardClaim();
      },
    } as never,
  );
  const originalNow = Date.now;

  try {
    Date.now = () => new Date("2026-08-01T08:59:59.000Z").getTime();
    await service.cancelTicketPass(buyer as never, { ...payload, ticketIndex: 3 });

    assert.equal(rewardReleaseCalls, 0);
  } finally {
    Date.now = originalNow;
  }
});

test("full rewarded per-pass cancellation releases the claim and restores one limited reward slot", async () => {
  const order = createRewardedOrder();
  const event = createRewardedEvent();
  const cancellations = [createCompletedRewardedCancellation(1), createCompletedRewardedCancellation(2)];
  const releaseCalls: unknown[][] = [];
  let rewardReleaseCalls = 0;
  const service = new TicketCancellationService(
    {
      findByPass: async () => null,
      findByOrderId: async () => cancellations,
      sumRequestedAmountByOrderId: async () => 9900,
      createOrGet: async (createPayload: Omit<ITicketCancellation, "_id" | "createdAt" | "updatedAt">) => {
        const created = createCancellation({
          ...createPayload,
          _id: new Types.ObjectId("64f000000000000000000204"),
          ticketIndex: 3,
          capacityReleaseStatus: "pending",
        });
        cancellations.push(created);
        return { cancellation: created, created: true };
      },
      update: async (_id: string, update: { $set?: Partial<ITicketCancellation> }) => {
        const cancellation = cancellations.find((item) => item._id.toString() === _id);
        assert.ok(cancellation);
        Object.assign(cancellation, update.$set ?? {});
        return cancellation;
      },
    } as never,
    { findById: async () => order } as never,
    {
      findById: async () => event,
      releaseTicketAndRewardCapacity: async (...args: unknown[]) => {
        releaseCalls.push(args);
      },
    } as never,
    { findActiveByTicketPass: async () => null } as never,
    { findByTicketPass: async () => null } as never,
    { findRefundItemsByOrderIds: async () => [] } as never,
    { sendSystemNotification: async () => undefined } as never,
    {} as never,
    createPassClaimRepository() as never,
    {} as never,
    {} as never,
    {
      releaseCheckoutRewardRedemptionAndRestoreCapacity: async (releaseIdentity: { orderId: string; eventId: string; ticketId: string; rewardId: string }) => {
        rewardReleaseCalls += 1;
        assert.deepEqual(releaseIdentity, {
          orderId: orderId.toString(),
          eventId: eventId.toString(),
          ticketId,
          rewardId,
        });
        return createRewardClaim();
      },
    } as never,
  );
  const originalNow = Date.now;

  try {
    Date.now = () => new Date("2026-08-01T08:59:59.000Z").getTime();
    await service.cancelTicketPass(buyer as never, { ...payload, ticketIndex: 3 });

    assert.equal(rewardReleaseCalls, 1);
    assert.deepEqual(releaseCalls, [[eventId.toString(), ticketId, 1, null, 0]]);
  } finally {
    Date.now = originalNow;
  }
});

test("rewarded cancellation order is independent when the final paid pass is cancelled after the free pass", async () => {
  const order = createRewardedOrder();
  const event = createRewardedEvent();
  const cancellations = [createCompletedRewardedCancellation(1), createCompletedRewardedCancellation(3)];
  const ticketReleaseCalls: unknown[][] = [];
  let rewardReleased = false;
  const service = new TicketCancellationService(
    {
      findByPass: async () => null,
      findByOrderId: async () => cancellations,
      sumRequestedAmountByOrderId: async () => 4950,
      createOrGet: async (createPayload: Omit<ITicketCancellation, "_id" | "createdAt" | "updatedAt">) => {
        const created = createCancellation({
          ...createPayload,
          _id: new Types.ObjectId("64f000000000000000000205"),
          ticketIndex: 2,
          capacityReleaseStatus: "pending",
        });
        cancellations.push(created);
        return { cancellation: created, created: true };
      },
      update: async (_id: string, update: { $set?: Partial<ITicketCancellation> }) => {
        const cancellation = cancellations.find((item) => item._id.toString() === _id);
        assert.ok(cancellation);
        Object.assign(cancellation, update.$set ?? {});
        return cancellation;
      },
    } as never,
    { findById: async () => order } as never,
    {
      findById: async () => event,
      releaseTicketAndRewardCapacity: async (...args: unknown[]) => {
        ticketReleaseCalls.push(args);
      },
    } as never,
    { findActiveByTicketPass: async () => null } as never,
    { findByTicketPass: async () => null } as never,
    { findRefundItemsByOrderIds: async () => [] } as never,
    { sendSystemNotification: async () => undefined } as never,
    {} as never,
    createPassClaimRepository() as never,
    {} as never,
    {} as never,
    {
      releaseCheckoutRewardRedemptionAndRestoreCapacity: async () => {
        rewardReleased = true;
        return createRewardClaim();
      },
    } as never,
  );
  const originalNow = Date.now;

  try {
    Date.now = () => new Date("2026-08-01T08:59:59.000Z").getTime();
    await service.cancelTicketPass(buyer as never, { ...payload, ticketIndex: 2 });

    assert.equal(rewardReleased, true);
    assert.deepEqual(ticketReleaseCalls, [[eventId.toString(), ticketId, 1, null, 0]]);
  } finally {
    Date.now = originalNow;
  }
});

test("duplicate final cancellation retry does not restore ticket or reward capacity twice", async () => {
  const order = createRewardedOrder();
  const existing = createCompletedRewardedCancellation(3);
  const cancellations = [
    createCompletedRewardedCancellation(1),
    createCompletedRewardedCancellation(2),
    existing,
  ];
  const releaseCalls: unknown[][] = [];
  let rewardReleaseCalls = 0;
  const service = new TicketCancellationService(
    {
      findByPass: async () => existing,
      findByOrderId: async () => cancellations,
    } as never,
    { findById: async () => order } as never,
    {
      releaseTicketAndRewardCapacity: async (...args: unknown[]) => {
        releaseCalls.push(args);
      },
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    createPassClaimRepository() as never,
    {} as never,
    {} as never,
    {
      releaseCheckoutRewardRedemptionAndRestoreCapacity: async () => {
        rewardReleaseCalls += 1;
        return rewardReleaseCalls === 1
          ? { status: "released", claim: createRewardClaim() }
          : { status: "alreadyReleased", claim: createRewardClaim() };
      },
    } as never,
  );

  await service.cancelTicketPass(buyer as never, { ...payload, ticketIndex: 3 });
  await service.cancelTicketPass(buyer as never, { ...payload, ticketIndex: 3 });

  assert.equal(rewardReleaseCalls, 2);
  assert.deepEqual(releaseCalls, []);
});

test("concurrent final rewarded cancellations release the reward slot once", async () => {
  const order = createRewardedOrder();
  const event = createRewardedEvent();
  const cancellations = [createCompletedRewardedCancellation(1)];
  const releaseCalls: unknown[][] = [];
  let rewardReleaseCalls = 0;
  let completedCapacityUpdates = 0;
  let releaseBarrier: (() => void) | null = null;
  const bothCapacityUpdatesCompleted = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  const service = new TicketCancellationService(
    {
      findByPass: async () => null,
      findByOrderId: async () => cancellations,
      sumRequestedAmountByOrderId: async () => 4950,
      createOrGet: async (createPayload: Omit<ITicketCancellation, "_id" | "createdAt" | "updatedAt">) => {
        const created = createCancellation({
          ...createPayload,
          _id: new Types.ObjectId(`64f00000000000000000020${createPayload.ticketIndex}`),
          capacityReleaseStatus: "pending",
        });
        cancellations.push(created);
        return { cancellation: created, created: true };
      },
      update: async (_id: string, update: { $set?: Partial<ITicketCancellation> }) => {
        const cancellation = cancellations.find((item) => item._id.toString() === _id);
        assert.ok(cancellation);
        Object.assign(cancellation, update.$set ?? {});
        if (update.$set?.capacityReleaseStatus === "completed") {
          completedCapacityUpdates += 1;
          if (completedCapacityUpdates === 2) releaseBarrier?.();
          await bothCapacityUpdatesCompleted;
        }
        return cancellation;
      },
    } as never,
    { findById: async () => order } as never,
    {
      findById: async () => event,
      releaseTicketAndRewardCapacity: async (...args: unknown[]) => {
        releaseCalls.push(args);
      },
    } as never,
    { findActiveByTicketPass: async () => null } as never,
    { findByTicketPass: async () => null } as never,
    { findRefundItemsByOrderIds: async () => [] } as never,
    { sendSystemNotification: async () => undefined } as never,
    {} as never,
    createPassClaimRepository() as never,
    {} as never,
    {} as never,
    {
      releaseCheckoutRewardRedemptionAndRestoreCapacity: async () => {
        rewardReleaseCalls += 1;
        return rewardReleaseCalls === 1
          ? { status: "released", claim: createRewardClaim() }
          : { status: "alreadyReleased", claim: createRewardClaim() };
      },
    } as never,
  );
  const originalNow = Date.now;

  try {
    Date.now = () => new Date("2026-08-01T08:59:59.000Z").getTime();
    await Promise.all([
      service.cancelTicketPass(buyer as never, { ...payload, ticketIndex: 2 }),
      service.cancelTicketPass(buyer as never, { ...payload, ticketIndex: 3 }),
    ]);

    assert.equal(rewardReleaseCalls, 2);
    assert.equal(releaseCalls.filter((args) => args[2] === 0 && args[4] === 1).length, 0);
  } finally {
    Date.now = originalNow;
  }
});

test("unlimited rewarded purchase releases the claim without restoring reward capacity", async () => {
  const order = createRewardedOrder({
    lineItems: [{
      ...(createRewardedOrder().lineItems[0] as Record<string, unknown>),
      rewardSnapshot: {
        ...(createRewardedOrder().lineItems[0] as { rewardSnapshot: Record<string, unknown> }).rewardSnapshot,
        capacityLimited: false,
      },
    }],
  });
  const event = createRewardedEvent();
  const cancellations = [createCompletedRewardedCancellation(1), createCompletedRewardedCancellation(2)];
  const releaseCalls: unknown[][] = [];
  let rewardReleaseCalls = 0;
  const service = new TicketCancellationService(
    {
      findByPass: async () => null,
      findByOrderId: async () => cancellations,
      sumRequestedAmountByOrderId: async () => 9900,
      createOrGet: async (createPayload: Omit<ITicketCancellation, "_id" | "createdAt" | "updatedAt">) => {
        const created = createCancellation({
          ...createPayload,
          _id: new Types.ObjectId("64f000000000000000000208"),
          ticketIndex: 3,
          capacityReleaseStatus: "pending",
        });
        cancellations.push(created);
        return { cancellation: created, created: true };
      },
      update: async (_id: string, update: { $set?: Partial<ITicketCancellation> }) => {
        const cancellation = cancellations.find((item) => item._id.toString() === _id);
        assert.ok(cancellation);
        Object.assign(cancellation, update.$set ?? {});
        return cancellation;
      },
    } as never,
    { findById: async () => order } as never,
    {
      findById: async () => event,
      releaseTicketAndRewardCapacity: async (...args: unknown[]) => {
        releaseCalls.push(args);
      },
    } as never,
    { findActiveByTicketPass: async () => null } as never,
    { findByTicketPass: async () => null } as never,
    { findRefundItemsByOrderIds: async () => [] } as never,
    { sendSystemNotification: async () => undefined } as never,
    {} as never,
    createPassClaimRepository() as never,
    {} as never,
    {} as never,
    {
      releaseCheckoutRewardRedemptionAndRestoreCapacity: async () => {
        rewardReleaseCalls += 1;
        return createRewardClaim();
      },
    } as never,
  );
  const originalNow = Date.now;

  try {
    Date.now = () => new Date("2026-08-01T08:59:59.000Z").getTime();
    await service.cancelTicketPass(buyer as never, { ...payload, ticketIndex: 3 });

    assert.equal(rewardReleaseCalls, 1);
    assert.deepEqual(releaseCalls, [[eventId.toString(), ticketId, 1, null, 0]]);
  } finally {
    Date.now = originalNow;
  }
});

test("already released reward claim is idempotent and does not restore reward capacity again", async () => {
  const order = createRewardedOrder();
  const event = createRewardedEvent();
  const cancellations = [createCompletedRewardedCancellation(1), createCompletedRewardedCancellation(2)];
  const releaseCalls: unknown[][] = [];
  const service = new TicketCancellationService(
    {
      findByPass: async () => null,
      findByOrderId: async () => cancellations,
      sumRequestedAmountByOrderId: async () => 9900,
      createOrGet: async (createPayload: Omit<ITicketCancellation, "_id" | "createdAt" | "updatedAt">) => {
        const created = createCancellation({
          ...createPayload,
          _id: new Types.ObjectId("64f000000000000000000209"),
          ticketIndex: 3,
          capacityReleaseStatus: "pending",
        });
        cancellations.push(created);
        return { cancellation: created, created: true };
      },
      update: async (_id: string, update: { $set?: Partial<ITicketCancellation> }) => {
        const cancellation = cancellations.find((item) => item._id.toString() === _id);
        assert.ok(cancellation);
        Object.assign(cancellation, update.$set ?? {});
        return cancellation;
      },
    } as never,
    { findById: async () => order } as never,
    {
      findById: async () => event,
      releaseTicketAndRewardCapacity: async (...args: unknown[]) => {
        releaseCalls.push(args);
      },
    } as never,
    { findActiveByTicketPass: async () => null } as never,
    { findByTicketPass: async () => null } as never,
    { findRefundItemsByOrderIds: async () => [] } as never,
    { sendSystemNotification: async () => undefined } as never,
    {} as never,
    createPassClaimRepository() as never,
    {} as never,
    {} as never,
    { releaseCheckoutRewardRedemptionAndRestoreCapacity: async () => null } as never,
  );
  const originalNow = Date.now;

  try {
    Date.now = () => new Date("2026-08-01T08:59:59.000Z").getTime();
    await service.cancelTicketPass(buyer as never, { ...payload, ticketIndex: 3 });

    assert.deepEqual(releaseCalls, [[eventId.toString(), ticketId, 1, null, 0]]);
  } finally {
    Date.now = originalNow;
  }
});

test("normal non-rewarded cancellation has no reward claim side effects", async () => {
  const scheduledAt = new Date("2026-08-01T12:00:00.000Z");
  const order = {
    _id: orderId,
    userId: buyerId,
    kind: "ticket",
    paymentStatus: "paid",
    currency: "usd",
    platformFeeAmount: 4.5,
    taxAmount: 2.25,
    amountMinor: 5175,
    lineItems: [{
      itemType: "ticket",
      eventId: eventId.toString(),
      itemId: ticketId,
      name: "Standard",
      quantity: 1,
      paidQuantity: 1,
      freeQuantity: 0,
      totalQuantity: 1,
      unitAmount: 45,
      totalAmount: 45,
    }],
    ticketPasses: [{ eventId: eventId.toString(), ticketId, ticketIndex: 1, checkInCode: "MOM-26-ABCD-EFGH" }],
  };
  const event = {
    _id: eventId,
    userId: hostId,
    name: "Launch Night",
    status: "published",
    scheduledAt,
    tickets: [{ id: ticketId, name: "Standard", type: "pay", price: 45, capacity: 10 }],
    rewards: [],
  };
  const cancellations: ITicketCancellation[] = [];
  let rewardReleaseCalls = 0;
  const service = new TicketCancellationService(
    {
      findByPass: async () => null,
      findByOrderId: async () => cancellations,
      sumRequestedAmountByOrderId: async () => 0,
      createOrGet: async (createPayload: Omit<ITicketCancellation, "_id" | "createdAt" | "updatedAt">) => {
        const created = createCancellation({
          ...createPayload,
          _id: new Types.ObjectId("64f000000000000000000210"),
          capacityReleaseStatus: "pending",
        });
        cancellations.push(created);
        return { cancellation: created, created: true };
      },
      update: async (_id: string, update: { $set?: Partial<ITicketCancellation> }) => {
        const cancellation = cancellations.find((item) => item._id.toString() === _id);
        assert.ok(cancellation);
        Object.assign(cancellation, update.$set ?? {});
        return cancellation;
      },
    } as never,
    { findById: async () => order } as never,
    { findById: async () => event, releaseTicketAndRewardCapacity: async () => undefined } as never,
    { findActiveByTicketPass: async () => null } as never,
    { findByTicketPass: async () => null } as never,
    { findRefundItemsByOrderIds: async () => [] } as never,
    { sendSystemNotification: async () => undefined } as never,
    {} as never,
    createPassClaimRepository() as never,
    {} as never,
    {} as never,
    {
      releaseCheckoutRewardRedemptionAndRestoreCapacity: async () => {
        rewardReleaseCalls += 1;
        return createRewardClaim();
      },
    } as never,
  );
  const originalNow = Date.now;

  try {
    Date.now = () => new Date("2026-08-01T08:59:59.000Z").getTime();
    await service.cancelTicketPass(buyer as never, payload);

    assert.equal(rewardReleaseCalls, 0);
  } finally {
    Date.now = originalNow;
  }
});

test("legacy rewarded order without a checkout reward snapshot is not guessed as releasable", async () => {
  const legacyLineItem = { ...(createRewardedOrder().lineItems[0] as Record<string, unknown>) };
  delete legacyLineItem.rewardSnapshot;
  const order = createRewardedOrder({ lineItems: [legacyLineItem] });
  const event = createRewardedEvent();
  const cancellations = [createCompletedRewardedCancellation(1), createCompletedRewardedCancellation(2)];
  let rewardReleaseCalls = 0;
  const service = new TicketCancellationService(
    {
      findByPass: async () => null,
      findByOrderId: async () => cancellations,
      sumRequestedAmountByOrderId: async () => 9900,
      createOrGet: async (createPayload: Omit<ITicketCancellation, "_id" | "createdAt" | "updatedAt">) => {
        const created = createCancellation({
          ...createPayload,
          _id: new Types.ObjectId("64f000000000000000000211"),
          ticketIndex: 3,
          capacityReleaseStatus: "pending",
        });
        cancellations.push(created);
        return { cancellation: created, created: true };
      },
      update: async (_id: string, update: { $set?: Partial<ITicketCancellation> }) => {
        const cancellation = cancellations.find((item) => item._id.toString() === _id);
        assert.ok(cancellation);
        Object.assign(cancellation, update.$set ?? {});
        return cancellation;
      },
    } as never,
    { findById: async () => order } as never,
    { findById: async () => event, releaseTicketAndRewardCapacity: async () => undefined } as never,
    { findActiveByTicketPass: async () => null } as never,
    { findByTicketPass: async () => null } as never,
    { findRefundItemsByOrderIds: async () => [] } as never,
    { sendSystemNotification: async () => undefined } as never,
    {} as never,
    createPassClaimRepository() as never,
    {} as never,
    {} as never,
    {
      releaseCheckoutRewardRedemptionAndRestoreCapacity: async () => {
        rewardReleaseCalls += 1;
        return createRewardClaim();
      },
    } as never,
  );
  const originalNow = Date.now;

  try {
    Date.now = () => new Date("2026-08-01T08:59:59.000Z").getTime();
    await service.cancelTicketPass(buyer as never, { ...payload, ticketIndex: 3 });

    assert.equal(rewardReleaseCalls, 0);
  } finally {
    Date.now = originalNow;
  }
});

test("admin ticket cancellation list includes buyer fallback and action capabilities", async () => {
  const succeeded = createCancellation({
    _id: new Types.ObjectId("64f000000000000000000108"),
    refundStatus: "succeeded",
    completedAmountMinor: 5175,
    remainingRefundableAmountMinor: 0,
  });
  const retryable = createCancellation({
    _id: new Types.ObjectId("64f000000000000000000109"),
    refundStatus: "failed_retryable",
    lastErrorCode: "STRIPE_TIMEOUT",
    safeLastErrorMessage: "Provider timeout",
  });
  const free = createCancellation({
    _id: new Types.ObjectId("64f000000000000000000110"),
    refundStatus: "not_required",
    requestedAmountMinor: 0,
    remainingRefundableAmountMinor: 0,
  });
  const service = new TicketCancellationService(
    {
      listAdmin: async (_query: unknown, skip: number, limit: number) => {
        assert.equal(skip, 0);
        assert.equal(limit, 20);
        return { cancellations: [succeeded, retryable, free], total: 3 };
      },
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    createPassClaimRepository() as never,
    {
      findByIds: async () => [{
        _id: buyerId,
        name: "Buyer Name",
        email: "buyer@example.com",
        username: "buyer",
      }],
    } as never,
  );

  const result = await service.listAdminCancellations({ page: 1 });

  assert.equal(result.pagination.total, 3);
  assert.equal(result.cancellations[0]!.buyer?.email, "buyer@example.com");
  assert.equal(result.cancellations[0]!.canRetry, false);
  assert.equal(result.cancellations[0]!.canReconcile, false);
  assert.equal(result.cancellations[0]!.canResume, false);
  assert.equal(result.cancellations[1]!.canRetry, true);
  assert.equal(result.cancellations[1]!.canReconcile, true);
  assert.equal(result.cancellations[2]!.canRetry, false);
  assert.equal(result.cancellations[2]!.canReconcile, false);
});

test("admin ticket cancellation detail uses safe buyer fallback", async () => {
  const cancellation = createCancellation();
  const service = new TicketCancellationService(
    { findById: async () => cancellation } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    createPassClaimRepository() as never,
    { findById: async () => null } as never,
  );

  const response = await service.getAdminCancellation(cancellation._id.toString());

  assert.equal(response.buyer?.id, buyerId.toString());
  assert.equal(response.buyer?.name, "Unknown user");
  assert.equal(response.buyer?.email, null);
});

test("admin retry rejects non-actionable succeeded refunds", async () => {
  const cancellation = createCancellation({ refundStatus: "succeeded" });
  const service = new TicketCancellationService(
    { findById: async () => cancellation } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    createPassClaimRepository() as never,
  );

  await assert.rejects(
    () => service.retryCancellation(cancellation._id.toString(), buyerId.toString()),
    { message: "Ticket cancellation refund is not retryable.", statusCode: 409 },
  );
});
