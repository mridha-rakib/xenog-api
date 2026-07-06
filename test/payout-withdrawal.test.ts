import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const creatorId = new Types.ObjectId();
const sourceEarningId = new Types.ObjectId();
const splitEarningId = new Types.ObjectId();
const payoutId = new Types.ObjectId();

const user = {
  id: creatorId.toString(),
  name: "Creator",
  username: "creator",
  email: "creator@example.com",
  accountType: "business",
  role: "user",
};

const createEarning = (id: Types.ObjectId, netAmount: number) => ({
  _id: id,
  creatorUserId: creatorId,
  orderId: new Types.ObjectId(),
  eventId: new Types.ObjectId(),
  itemType: "ticket",
  grossAmount: netAmount,
  platformFeePercent: 0,
  platformFeeAmount: 0,
  netAmount,
  status: "eligible",
  eligibleAt: new Date("2026-07-01T00:00:00.000Z"),
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  updatedAt: new Date("2026-07-01T00:00:00.000Z"),
});

test("manual withdrawal can reserve an exact partial dollar amount", async () => {
  const { CreatorEarningService } = await import("../src/modules/payments/creator-earning.service.js");
  const sourceEarning = createEarning(sourceEarningId, 25);
  const splitEarning = createEarning(splitEarningId, 10);
  let payoutPayload: { totalAmount: number; earningIds: string[] } | null = null;
  let markedWithdrawn: { earningIds: string[]; payoutId: string } | null = null;

  const service = new CreatorEarningService(
    {
      releaseEligibleEarnings: async () => undefined,
      findEligibleByCreatorUserId: async () => [sourceEarning],
      splitEligibleEarningForAmount: async (_earning: unknown, amount: number) => {
        assert.equal(amount, 10);
        return splitEarning;
      },
      markWithdrawn: async (earningIds: string[], nextPayoutId: string) => {
        markedWithdrawn = { earningIds, payoutId: nextPayoutId };
      },
    } as never,
    {
      findPendingOrProcessingByCreatorUserId: async () => [],
      create: async (payload: { totalAmount: number; earningIds: string[] }) => {
        payoutPayload = payload;
        return {
          _id: payoutId,
          creatorUserId: creatorId,
          earningIds: payload.earningIds.map((id) => new Types.ObjectId(id)),
          totalAmount: payload.totalAmount,
          currency: "usd",
          payoutType: "bank_transfer",
          status: "pending",
          scheduledDate: new Date("2026-07-07T00:00:00.000Z"),
          createdAt: new Date("2026-07-07T00:00:00.000Z"),
          updatedAt: new Date("2026-07-07T00:00:00.000Z"),
        };
      },
    } as never,
    { validateReadyForPayout: async () => "acct_test" } as never,
    { findById: async () => ({ businessProfile: { withdrawalMethod: "bank_transfer" } }) } as never,
    { sendSystemNotification: async () => undefined } as never,
  );

  const payout = await service.requestWithdrawal(user as never, { amount: 10 });

  assert.equal(payout.totalAmount, 10);
  assert.deepEqual(payoutPayload?.earningIds, [splitEarningId.toString()]);
  assert.deepEqual(markedWithdrawn?.earningIds, [splitEarningId.toString()]);
});

test("manual withdrawal duplicate create returns a clean in-progress error", async () => {
  const { CreatorEarningService } = await import("../src/modules/payments/creator-earning.service.js");
  const service = new CreatorEarningService(
    {
      releaseEligibleEarnings: async () => undefined,
      findEligibleByCreatorUserId: async () => [createEarning(sourceEarningId, 10)],
    } as never,
    {
      findPendingOrProcessingByCreatorUserId: async () => [],
      create: async () => {
        throw { code: 11000 };
      },
    } as never,
    { validateReadyForPayout: async () => "acct_test" } as never,
    { findById: async () => ({ businessProfile: { withdrawalMethod: "bank_transfer" } }) } as never,
    { sendSystemNotification: async () => undefined } as never,
  );

  await assert.rejects(
    () => service.requestWithdrawal(user as never, { amount: 10 }),
    /withdrawal is already in progress/i,
  );
});
