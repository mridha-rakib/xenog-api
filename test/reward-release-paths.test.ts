import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { CheckoutPaymentService } from "../src/modules/payments/checkout-payment.service.js";
import { EventCancellationRefundService } from "../src/modules/payments/event-cancellation-refund.service.js";
import type { ICheckoutOrder } from "../src/modules/payments/checkout-payment.interface.js";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const orderId = new Types.ObjectId("64f000000000000000000102");
const eventId = "64f000000000000000000101";
const buyerId = new Types.ObjectId("64f000000000000000000103");
const hostId = new Types.ObjectId("64f000000000000000000104");
const rewardId = "reward-1";
const ticketId = "standard";

const createRewardedOrder = (overrides: Partial<ICheckoutOrder> = {}): ICheckoutOrder => ({
  _id: orderId,
  userId: buyerId,
  kind: "ticket",
  paymentMethod: "card",
  paymentStatus: "requires_payment",
  payoutStatus: "not_ready",
  currency: "usd",
  subtotalAmount: 90,
  platformFeeAmount: 9,
  taxAmount: 0,
  discountAmount: 0,
  totalAmount: 99,
  amountMinor: 9900,
  lineItems: [{
    itemType: "ticket",
    eventId,
    itemId: ticketId,
    sellerUserId: hostId,
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
    { eventId, ticketId, ticketIndex: 1, checkInCode: "MOM-26-ABCD-EFG1" },
    { eventId, ticketId, ticketIndex: 2, checkInCode: "MOM-26-ABCD-EFG2" },
    { eventId, ticketId, ticketIndex: 3, checkInCode: "MOM-26-ABCD-EFG3" },
  ],
  anonymous: false,
  createdAt: new Date("2026-07-30T09:00:00.000Z"),
  updatedAt: new Date("2026-07-30T09:00:00.000Z"),
  ...overrides,
});

test("full checkout order release uses transactional reward release helper", async () => {
  const order = createRewardedOrder();
  const updated = createRewardedOrder({ paymentStatus: "canceled" });
  const ticketReleaseCalls: unknown[][] = [];
  const rewardReleaseCalls: unknown[] = [];
  const service = new CheckoutPaymentService(
    {
      findById: async () => order,
      updatePaymentStatusIf: async () => updated,
    } as never,
    {
      releaseTicketAndRewardCapacity: async (...args: unknown[]) => {
        ticketReleaseCalls.push(args);
      },
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {
      releaseCheckoutRewardRedemptionAndRestoreCapacity: async (payload: unknown) => {
        rewardReleaseCalls.push(payload);
        return { status: "released", claim: null };
      },
    } as never,
  );

  await service.cancelOrder({ id: buyerId.toString(), name: "Buyer" } as never, orderId.toString());

  assert.deepEqual(ticketReleaseCalls, [[eventId, ticketId, 3, null, 0]]);
  assert.deepEqual(rewardReleaseCalls, [{
    orderId: orderId.toString(),
    eventId,
    ticketId,
    rewardId,
    claimStatuses: ["pending", "redeemed"],
  }]);
});

test("event cancellation release uses transactional reward release helper", async () => {
  const order = createRewardedOrder({ paymentStatus: "paid" });
  const ticketReleaseCalls: unknown[][] = [];
  const rewardReleaseCalls: unknown[] = [];
  const service = new EventCancellationRefundService(
    {} as never,
    {
      releaseTicketAndRewardCapacity: async (...args: unknown[]) => {
        ticketReleaseCalls.push(args);
      },
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {
      findByOrderId: async () => [],
    } as never,
    {} as never,
    {} as never,
    {
      releaseCheckoutRewardRedemptionAndRestoreCapacity: async (payload: unknown) => {
        rewardReleaseCalls.push(payload);
        return { status: "released", claim: null };
      },
    } as never,
  );

  await (service as unknown as { releaseCapacityForOrder(order: ICheckoutOrder): Promise<void> }).releaseCapacityForOrder(order);

  assert.deepEqual(ticketReleaseCalls, [[eventId, ticketId, 3, null, 0]]);
  assert.deepEqual(rewardReleaseCalls, [{
    orderId: orderId.toString(),
    eventId,
    ticketId,
    rewardId,
    claimStatuses: ["pending", "redeemed"],
  }]);
});
