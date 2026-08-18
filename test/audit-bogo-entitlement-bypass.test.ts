import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { TicketCancellationService } from "../src/modules/payments/ticket-cancellation.service.js";
import type { ITicketCancellation } from "../src/modules/payments/ticket-cancellation.interface.js";

// AUDIT-ONLY test file. Read-only investigation of a suspected Buy-2-Get-1
// entitlement bypass: cancel both paid passes in a BOGO order, keep the free
// pass, and check whether it remains refund-free AND fully usable (wallet +
// check-in) against the real, non-mocked TicketCancellationService and
// CheckoutPaymentService classes. Only repository/notification/Stripe-adjacent
// dependencies are mocked with in-memory state shared between the two
// services, mirroring the pattern already used in
// test/ticket-cancellation-service.test.ts and test/ticket-check-in.test.ts.
// This file does not modify any production source file.

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const eventId = new Types.ObjectId("64f000000000000000000301");
const orderId = new Types.ObjectId("64f000000000000000000302");
const buyerId = new Types.ObjectId("64f000000000000000000303");
const hostId = new Types.ObjectId("64f000000000000000000304");
const ticketId = "standard";
const rewardId = "reward-bogo-1";
const buyer = { id: buyerId.toString(), name: "Buyer" };

const checkInCodes = ["MOM-26-AUD1-PASS", "MOM-26-AUD2-PASS", "MOM-26-AUD3-FREE"];

// paidQuantity=2, freeQuantity=1, totalQuantity=3 — Buy 2 Get 1 Free.
// Subtotal 90 (2 x $45) + platform fee 9 (10% buyer fee) + tax 0 = captured 99.00 -> amountMinor 9900.
const buildOrder = () => ({
  _id: orderId,
  userId: buyerId,
  kind: "ticket",
  paymentStatus: "paid",
  currency: "usd",
  subtotalAmount: 90,
  platformFeeAmount: 9,
  taxAmount: 0,
  discountAmount: 0,
  totalAmount: 99,
  amountMinor: 9900,
  stripePaymentIntentId: "pi_audit_test",
  paidAt: new Date("2026-07-30T09:00:00.000Z"),
  createdAt: new Date("2026-07-30T09:00:00.000Z"),
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
    sellerUserId: hostId,
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
  ticketPasses: checkInCodes.map((checkInCode, index) => ({
    eventId: eventId.toString(),
    ticketId,
    ticketIndex: index + 1,
    checkInCode,
  })),
});

const buildEvent = () => ({
  _id: eventId,
  userId: hostId,
  name: "Launch Night",
  status: "published",
  scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h out, well outside the 3h cutoff
  tickets: [{ id: ticketId, name: "Standard", type: "pay", price: 45, capacity: 100 }],
  rewards: [{ id: rewardId, name: "Buy 2 get 1", capacityLimited: true, capacity: 10, availableCount: 9 }],
});

const createPassClaimRepository = () => ({
  claimForCancellation: async () => ({ claimed: true as const }),
  acceptCancellation: async () => true,
  abortCancellation: async () => undefined,
});

test("BOGO bypass audit: cancelling both paid passes refunds the full captured amount while the free pass stays wallet-visible and check-in eligible", async () => {
  const { CheckoutPaymentService } = await import("../src/modules/payments/checkout-payment.service.js");

  const order = buildOrder();
  const event = buildEvent();

  // Shared in-memory ledgers — the same state the two real production
  // services (cancellation + wallet/check-in) would read/write via Mongo.
  const cancellations: ITicketCancellation[] = [];
  const usages: Array<{ eventId: string; ticketId: string; orderId: string; ticketIndex: number; holderUserId: string }> = [];
  let rewardClaimStatus: "redeemed" | "released" = "redeemed";
  let rewardReleaseCalls = 0;
  let rewardAvailableCount = 9;
  const capacityReleaseCalls: unknown[][] = [];
  const earningAdjustCalls: unknown[][] = [];

  const ticketCancellationRepository = {
    findByPass: async (payload: { eventId: string; ticketId: string; orderId: string; ticketIndex: number }) =>
      cancellations.find((item) =>
        item.eventId.toString() === payload.eventId &&
        item.ticketId === payload.ticketId &&
        item.orderId.toString() === payload.orderId &&
        item.ticketIndex === payload.ticketIndex) ?? null,
    findByOrderId: async () => cancellations,
    findByOrderIds: async () => cancellations,
    findByEventIds: async () => cancellations,
    existsByPass: async (payload: { eventId: string; ticketId: string; orderId: string; ticketIndex: number }) =>
      cancellations.some((item) =>
        item.eventId.toString() === payload.eventId &&
        item.ticketId === payload.ticketId &&
        item.orderId.toString() === payload.orderId &&
        item.ticketIndex === payload.ticketIndex),
    sumRequestedAmountByOrderId: async (id: string) =>
      cancellations
        .filter((item) => item.orderId.toString() === id)
        .reduce((sum, item) => sum + item.requestedAmountMinor, 0),
    createOrGet: async (createPayload: Omit<ITicketCancellation, "_id" | "createdAt" | "updatedAt">) => {
      const created: ITicketCancellation = {
        _id: new Types.ObjectId(),
        createdAt: new Date(),
        updatedAt: new Date(),
        ...createPayload,
      };
      cancellations.push(created);
      return { cancellation: created, created: true };
    },
    update: async (id: string, update: { $set?: Partial<ITicketCancellation> }) => {
      const cancellation = cancellations.find((item) => item._id.toString() === id);
      assert.ok(cancellation);
      Object.assign(cancellation, update.$set ?? {});
      return cancellation;
    },
  };

  const eventRepository = {
    findById: async () => event,
    findManyByIds: async () => [event],
    releaseTicketAndRewardCapacity: async (...args: unknown[]) => {
      capacityReleaseCalls.push(args);
    },
  };

  const cancellationService = new TicketCancellationService(
    ticketCancellationRepository as never,
    { findById: async () => order } as never,
    eventRepository as never,
    { findActiveByTicketPass: async () => null } as never,
    { findByTicketPass: async () => null } as never,
    { findRefundItemsByOrderIds: async () => [] } as never,
    { sendSystemNotification: async () => undefined } as never,
    {
      adjustTicketCancellationAmount: async (...args: unknown[]) => {
        earningAdjustCalls.push(args);
        return "completed";
      },
    } as never,
    createPassClaimRepository() as never,
    {} as never,
    {} as never,
    {
      releaseCheckoutRewardRedemptionAndRestoreCapacity: async (identity: { rewardId: string }) => {
        rewardReleaseCalls += 1;
        rewardClaimStatus = "released";
        rewardAvailableCount = Math.min(10, rewardAvailableCount + 1);
        return { status: "released", rewardId: identity.rewardId };
      },
    } as never,
  );

  // ---------- Initial state ----------
  assert.equal(order.lineItems[0]!.paidQuantity, 2);
  assert.equal(order.lineItems[0]!.freeQuantity, 1);
  assert.equal(order.lineItems[0]!.totalQuantity, 3);
  assert.equal(order.amountMinor, 9900);
  assert.equal(rewardClaimStatus, "redeemed");

  // ---------- Cancel paid pass 1 (ticketIndex 1) ----------
  const originalNow = Date.now;
  Date.now = () => new Date().getTime();
  const response1 = await cancellationService.cancelTicketPass(buyer as never, {
    eventId: eventId.toString(),
    ticketId,
    orderId: orderId.toString(),
    ticketIndex: 1,
  });

  assert.equal(response1.ticketIndex, 1);
  assert.ok(response1.requestedAmountMinor > 0, "paid pass 1 must produce a nonzero refund request");
  assert.equal(rewardReleaseCalls, 0, "reward claim must NOT be released after only 1 of 3 passes is cancelled");
  assert.equal(rewardClaimStatus, "redeemed");
  assert.equal(capacityReleaseCalls.length, 1);

  // ---------- Cancel paid pass 2 (ticketIndex 2) ----------
  const response2 = await cancellationService.cancelTicketPass(buyer as never, {
    eventId: eventId.toString(),
    ticketId,
    orderId: orderId.toString(),
    ticketIndex: 2,
  });
  Date.now = originalNow;

  assert.equal(response2.ticketIndex, 2);
  assert.ok(response2.requestedAmountMinor > 0, "paid pass 2 must produce a nonzero refund request");

  // ---------- Section 7/8: refund math ----------
  const totalRequested = response1.requestedAmountMinor + response2.requestedAmountMinor;
  assert.equal(totalRequested, 9900, "the two paid-pass refunds must sum to exactly the full captured amount");
  assert.ok(totalRequested <= order.amountMinor, "refunds must never exceed the originally captured amount");
  assert.equal(earningAdjustCalls.length, 2, "creator earnings are adjusted once per monetary (paid) cancellation");

  // ---------- Section 10: RewardClaim / reward-capacity state after BOTH paid passes are cancelled ----------
  assert.equal(rewardReleaseCalls, 0, "reward claim release must NOT fire while the free/reward pass (index 3) is still active");
  assert.equal(rewardClaimStatus, "redeemed", "RewardClaim remains redeemed even though the user has been refunded for every paid pass");
  assert.equal(rewardAvailableCount, 9, "reward capacity is not restored while the bonus pass remains active");

  // ---------- Section 9: real entitlement check — wallet ----------
  const repository = {
    findTicketWalletOrdersByUserId: async () => [order],
    findByIds: async () => [],
    findByCheckInCode: async (code: string) => (order.ticketPasses.some((pass) => pass.checkInCode === code) ? order : null),
    findIssuedTicketOrdersByEventIds: async () => [order],
  };
  const userRepository = {
    findMany: async () => [{ _id: buyerId, name: "Buyer", username: "buyer", avatarKey: null }, { _id: hostId, name: "Host", username: "host", avatarKey: null }],
    findByIds: async () => [{ _id: buyerId, name: "Buyer", username: "buyer", avatarKey: null }, { _id: hostId, name: "Host", username: "host", avatarKey: null }],
    findById: async (id: string) => ({ _id: new Types.ObjectId(id), name: "User" }),
  };
  const userFollowRepository = { findFollowingIds: async () => [] };
  const ticketShareRepository = {
    findActiveByOwnerId: async () => [],
    findActiveByRecipientId: async () => [],
    findCancelledByRecipientId: async () => [],
    findActiveByEventIds: async () => [],
    findActiveByTicketPass: async () => null,
  };
  const ticketUsageRepository = {
    findByEventIdsAndOrderIds: async () => usages,
    findByTicketPass: async (evId: string, tId: string, oId: string, ticketIndex: number) =>
      usages.find((u) => u.eventId === evId && u.ticketId === tId && u.orderId === oId && u.ticketIndex === ticketIndex) ?? null,
    create: async (payload: { eventId: string; ticketId: string; orderId: string; ticketIndex: number; holderUserId: string }) => {
      const usage = { ...payload };
      usages.push(usage);
      return { _id: new Types.ObjectId(), ...usage, usedAt: new Date() };
    },
  };
  const ticketPassClaimRepository = {
    claimForCheckIn: async () => ({ claimed: true as const }),
    abortCheckIn: async () => undefined,
  };

  const walletService = new CheckoutPaymentService(
    repository as never,
    eventRepository as never,
    {} as never,
    {} as never,
    userRepository as never,
    userFollowRepository as never,
    ticketShareRepository as never,
    ticketUsageRepository as never,
    {} as never,
    {} as never,
    { findRefundItemsByOrderIds: async () => [] } as never,
    undefined as never,
    ticketCancellationRepository as never,
    undefined as never,
    undefined as never,
    undefined as never,
    ticketPassClaimRepository as never,
    undefined as never, // crowdStatusService
    undefined as never, // rewardClaimRepository
    { buildForEvents: async () => new Map() } as never, // eventInteractionSummaryService
  );

  const wallet = await walletService.getMyTicketWallet({ id: buyerId.toString() } as never);
  assert.equal(wallet.length, 1);
  const walletItem = wallet[0]!;
  assert.equal(walletItem.ticketPasses.length, 3);

  const pass1 = walletItem.ticketPasses.find((p) => p.ticketIndex === 1)!;
  const pass2 = walletItem.ticketPasses.find((p) => p.ticketIndex === 2)!;
  const freePass = walletItem.ticketPasses.find((p) => p.ticketIndex === 3)!;

  assert.equal(pass1.status, "cancelled");
  assert.equal(pass2.status, "cancelled");
  assert.equal(freePass.status, "active", "the free/bonus pass (index 3) remains active in the wallet after both paid passes are cancelled");
  assert.equal(freePass.qrCode, checkInCodes[2], "the free pass keeps a live, displayable QR/check-in code");
  assert.equal(freePass.ticketNo, checkInCodes[2]);
  assert.equal(walletItem.walletStatus, "active", "the line-item level wallet status is still 'active' because one pass (the free one) is still active");

  // ---------- Section 9: real entitlement check — actual check-in (scanTicket) ----------
  const result = await walletService.scanTicket(
    { id: hostId.toString(), name: "Host" } as never,
    { checkInCode: checkInCodes[2]! },
  );

  assert.equal(result.ticketNo, checkInCodes[2]);
  assert.equal(usages.length, 1, "check-in against the surviving free pass succeeds and creates exactly one TicketUsage record");
  assert.equal(usages[0]!.holderUserId, buyerId.toString());
  assert.equal(usages[0]!.ticketIndex, 3);

  // ---------- Final verdict assembled from the above evidence ----------
  const userReceivedFullRefundForAllPaidPasses = totalRequested === order.amountMinor;
  const freePassStillCheckable = usages.length === 1;
  assert.equal(
    userReceivedFullRefundForAllPaidPasses && freePassStillCheckable,
    true,
    "CONFIRMED BYPASS: user recovered 100% of the money paid (both paid passes) and still successfully checked in with the free reward pass",
  );
});
