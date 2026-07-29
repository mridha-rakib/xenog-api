import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { buildTicketPassRefundAllocations } from "../src/modules/payments/ticket-cancellation.service.js";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const createOrder = (overrides: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId("64f000000000000000000001"),
  userId: new Types.ObjectId("64f000000000000000000002"),
  kind: "ticket",
  paymentMethod: "card",
  paymentStatus: "paid",
  payoutStatus: "held",
  currency: "usd",
  subtotalAmount: 0,
  platformFeeAmount: 0,
  taxAmount: 0,
  discountAmount: 0,
  totalAmount: 0,
  amountMinor: 0,
  lineItems: [],
  ticketPasses: [],
  anonymous: false,
  createdAt: new Date("2026-07-20T12:00:00.000Z"),
  updatedAt: new Date("2026-07-20T12:00:00.000Z"),
  ...overrides,
});

test("single paid pass receives subtotal, platform fee, and tax allocation", () => {
  const allocations = buildTicketPassRefundAllocations(createOrder({
    subtotalAmount: 45,
    platformFeeAmount: 4.5,
    taxAmount: 2.25,
    totalAmount: 51.75,
    amountMinor: 5175,
    lineItems: [{
      itemType: "ticket",
      eventId: "64f000000000000000000010",
      itemId: "standard",
      name: "Standard",
      quantity: 1,
      paidQuantity: 1,
      freeQuantity: 0,
      totalQuantity: 1,
      unitAmount: 45,
      totalAmount: 45,
    }],
  }) as never);

  assert.equal(allocations.length, 1);
  assert.equal(allocations[0]?.requestedAmountMinor, 5175);
  assert.equal(allocations[0]?.ticketSubtotalAmountMinor, 4500);
  assert.equal(allocations[0]?.platformFeeAmountMinor, 450);
  assert.equal(allocations[0]?.taxAmountMinor, 225);
});

test("quantity allocation is deterministic and sums exactly with remainders", () => {
  const allocations = buildTicketPassRefundAllocations(createOrder({
    subtotalAmount: 100,
    platformFeeAmount: 10,
    taxAmount: 1,
    totalAmount: 111,
    amountMinor: 11100,
    lineItems: [{
      itemType: "ticket",
      eventId: "64f000000000000000000010",
      itemId: "vip",
      name: "VIP",
      quantity: 3,
      paidQuantity: 3,
      freeQuantity: 0,
      totalQuantity: 3,
      unitAmount: 33.33,
      totalAmount: 100,
    }],
  }) as never);

  assert.deepEqual(
    allocations.map((allocation) => allocation.ticketSubtotalAmountMinor),
    [3334, 3333, 3333],
  );
  assert.equal(allocations.reduce((sum, allocation) => sum + allocation.requestedAmountMinor, 0), 11100);
  assert.deepEqual(
    allocations.map((allocation) => allocation.requestedAmountMinor),
    [3702, 3699, 3699],
  );
});

test("rewarded pass has no monetary refund and releases reward identity", () => {
  const allocations = buildTicketPassRefundAllocations(createOrder({
    subtotalAmount: 90,
    platformFeeAmount: 9,
    taxAmount: 0,
    totalAmount: 99,
    amountMinor: 9900,
    lineItems: [{
      itemType: "ticket",
      eventId: "64f000000000000000000010",
      itemId: "standard",
      name: "Standard",
      quantity: 2,
      paidQuantity: 2,
      freeQuantity: 1,
      totalQuantity: 3,
      rewardId: "reward-1",
      unitAmount: 45,
      totalAmount: 90,
    }],
  }) as never);

  const rewarded = allocations.find((allocation) => allocation.ticketIndex === 3);

  assert.equal(rewarded?.isRewardPass, true);
  assert.equal(rewarded?.rewardId, "reward-1");
  assert.equal(rewarded?.requestedAmountMinor, 0);
  assert.equal(allocations.reduce((sum, allocation) => sum + allocation.requestedAmountMinor, 0), 9900);
});

test("mixed ticket lines allocate order-level fee and tax by paid subtotal weight", () => {
  const allocations = buildTicketPassRefundAllocations(createOrder({
    subtotalAmount: 75,
    platformFeeAmount: 7.5,
    taxAmount: 3.75,
    totalAmount: 86.25,
    amountMinor: 8625,
    lineItems: [
      {
        itemType: "ticket",
        eventId: "64f000000000000000000010",
        itemId: "standard",
        name: "Standard",
        quantity: 1,
        paidQuantity: 1,
        freeQuantity: 0,
        totalQuantity: 1,
        unitAmount: 45,
        totalAmount: 45,
      },
      {
        itemType: "ticket",
        eventId: "64f000000000000000000010",
        itemId: "balcony",
        name: "Balcony",
        quantity: 1,
        paidQuantity: 1,
        freeQuantity: 0,
        totalQuantity: 1,
        unitAmount: 30,
        totalAmount: 30,
      },
    ],
  }) as never);

  const standard = allocations.find((allocation) => allocation.ticketId === "standard");
  const balcony = allocations.find((allocation) => allocation.ticketId === "balcony");

  assert.equal(standard?.requestedAmountMinor, 5175);
  assert.equal(balcony?.requestedAmountMinor, 3450);
  assert.equal(allocations.reduce((sum, allocation) => sum + allocation.requestedAmountMinor, 0), 8625);
});
