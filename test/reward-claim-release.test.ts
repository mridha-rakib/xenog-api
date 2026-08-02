import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { EventModel } from "../src/modules/events/event.model.js";
import { RewardClaimModel } from "../src/modules/events/reward-claim.model.js";
import { RewardClaimRepository } from "../src/modules/events/reward-claim.repository.js";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const orderId = "64f000000000000000000102";
const eventId = "64f000000000000000000101";
const rewardId = "reward-1";
const ticketId = "standard";

type ClaimState = {
  checkoutOrderId: string | null;
  userId: string;
  eventId: string;
  rewardId: string;
  ticketId: string;
  source: "checkout" | "manual_claim" | "legacy";
  status: "pending" | "redeemed" | "released" | "legacy_claim";
  releasedAt: Date | null;
};

type RewardState = {
  id: string;
  rewardType: "ticket" | "product";
  ticketId?: string | null;
  capacityLimited?: boolean;
  capacity?: number | null;
  availableCount?: number | null;
};

type FakeState = {
  claim: ClaimState | null;
  reward: RewardState | null;
  failClaimUpdate?: boolean;
  failCapacityUpdate?: boolean;
  failAfterTransactionCallback?: boolean;
};

const createClaim = (overrides: Partial<ClaimState> = {}): ClaimState => ({
  checkoutOrderId: orderId,
  userId: "64f000000000000000000103",
  eventId,
  rewardId,
  ticketId,
  source: "checkout",
  status: "redeemed",
  releasedAt: null,
  ...overrides,
});

const createReward = (overrides: Partial<RewardState> = {}): RewardState => ({
  id: rewardId,
  rewardType: "ticket",
  ticketId,
  capacityLimited: true,
  capacity: 10,
  availableCount: 4,
  ...overrides,
});

const clone = <T>(value: T): T => structuredClone(value);

const matchesClaim = (claim: ClaimState | null, query: Record<string, unknown>): boolean => {
  if (!claim) return false;
  if (query.checkoutOrderId !== undefined && query.checkoutOrderId !== claim.checkoutOrderId) return false;
  if (query.eventId !== undefined && query.eventId !== claim.eventId) return false;
  if (query.rewardId !== undefined && query.rewardId !== claim.rewardId) return false;
  if (query.userId !== undefined && query.userId !== claim.userId) return false;
  if (query.ticketId !== undefined && query.ticketId !== claim.ticketId) return false;
  if (query.source !== undefined && query.source !== claim.source) return false;
  if (query.status !== undefined) {
    const status = query.status as { $in?: string[] } | string;
    if (typeof status === "string" && status !== claim.status) return false;
    if (typeof status === "object" && status.$in && !status.$in.includes(claim.status)) return false;
  }
  return true;
};

const withFakes = async (state: FakeState, run: () => Promise<void>): Promise<void> => {
  const originalStartSession = mongoose.startSession;
  const originalEventFindOne = EventModel.findOne;
  const originalEventUpdateOne = EventModel.updateOne;
  const originalClaimFindOne = RewardClaimModel.findOne;
  const originalClaimFindOneAndUpdate = RewardClaimModel.findOneAndUpdate;
  const fakeSession = {
    withTransaction: async (callback: () => Promise<void>) => {
      const snapshot = clone(state);
      try {
        await callback();
        if (state.failAfterTransactionCallback) {
          throw new Error("commit failed");
        }
      } catch (error) {
        state.claim = snapshot.claim;
        state.reward = snapshot.reward;
        throw error;
      }
    },
    endSession: async () => undefined,
  };

  try {
    (mongoose as unknown as { startSession: unknown }).startSession = async () => fakeSession;
    (EventModel as unknown as { findOne: unknown }).findOne = () => ({
      session: () => ({
        lean: async () => state.reward ? { rewards: [clone(state.reward)] } : null,
      }),
    });
    (EventModel as unknown as { updateOne: unknown }).updateOne = async () => {
      if (state.failCapacityUpdate) {
        throw new Error("capacity update failed");
      }
      if (!state.reward) {
        return { matchedCount: 0 };
      }
      const capacity = state.reward.capacity ?? 0;
      state.reward.availableCount = Math.min((state.reward.availableCount ?? 0) + 1, capacity);
      return { matchedCount: 1 };
    };
    (RewardClaimModel as unknown as { findOneAndUpdate: unknown }).findOneAndUpdate = async (
      query: Record<string, unknown>,
      update: { $set?: Partial<ClaimState> },
    ) => {
      if (state.failClaimUpdate) {
        throw new Error("claim update failed");
      }
      if (!matchesClaim(state.claim, query)) {
        return null;
      }
      state.claim = { ...state.claim!, ...(update.$set ?? {}) };
      return clone(state.claim);
    };
    (RewardClaimModel as unknown as { findOne: unknown }).findOne = (query: Record<string, unknown>) => ({
      session: async () => matchesClaim(state.claim, query) ? clone(state.claim) : null,
    });

    await run();
  } finally {
    (mongoose as unknown as { startSession: unknown }).startSession = originalStartSession;
    (EventModel as unknown as { findOne: unknown }).findOne = originalEventFindOne;
    (EventModel as unknown as { updateOne: unknown }).updateOne = originalEventUpdateOne;
    (RewardClaimModel as unknown as { findOne: unknown }).findOne = originalClaimFindOne;
    (RewardClaimModel as unknown as { findOneAndUpdate: unknown }).findOneAndUpdate = originalClaimFindOneAndUpdate;
  }
};

const release = (repository = new RewardClaimRepository()) =>
  repository.releaseCheckoutRewardRedemptionAndRestoreCapacity({ orderId, eventId, ticketId, rewardId });

const releasePendingReservation = (repository = new RewardClaimRepository()) =>
  repository.releaseCheckoutRewardRedemptionAndRestoreCapacity({
    eventId,
    ticketId,
    rewardId,
    userId: "64f000000000000000000103",
    claimStatuses: ["pending"],
  });

test("limited reward release updates claim and restores one capacity slot transactionally", async () => {
  const state: FakeState = { claim: createClaim(), reward: createReward() };
  await withFakes(state, async () => {
    const result = await release();

    assert.equal(result.status, "released");
    assert.equal(state.claim?.status, "released");
    assert.equal(state.reward?.availableCount, 5);
  });
});

test("unlimited reward release does not increment capacity", async () => {
  const state: FakeState = {
    claim: createClaim(),
    reward: createReward({ capacityLimited: false, capacity: null, availableCount: null }),
  };
  await withFakes(state, async () => {
    const result = await release();

    assert.equal(result.status, "released");
    assert.equal(state.claim?.status, "released");
    assert.equal(state.reward?.availableCount, null);
  });
});

test("capacity update failure rolls back the released claim and can be retried", async () => {
  const state: FakeState = { claim: createClaim(), reward: createReward(), failCapacityUpdate: true };
  await withFakes(state, async () => {
    await assert.rejects(() => release(), /capacity update failed/);
    assert.equal(state.claim?.status, "redeemed");
    assert.equal(state.reward?.availableCount, 4);

    state.failCapacityUpdate = false;
    const result = await release();
    assert.equal(result.status, "released");
    assert.equal(state.claim?.status, "released");
    assert.equal(state.reward?.availableCount, 5);
  });
});

test("claim transition failure does not increment capacity", async () => {
  const state: FakeState = { claim: createClaim(), reward: createReward(), failClaimUpdate: true };
  await withFakes(state, async () => {
    await assert.rejects(() => release(), /claim update failed/);

    assert.equal(state.claim?.status, "redeemed");
    assert.equal(state.reward?.availableCount, 4);
  });
});

test("transaction failure after capacity update rolls back both operations", async () => {
  const state: FakeState = { claim: createClaim(), reward: createReward(), failAfterTransactionCallback: true };
  await withFakes(state, async () => {
    await assert.rejects(() => release(), /commit failed/);

    assert.equal(state.claim?.status, "redeemed");
    assert.equal(state.reward?.availableCount, 4);
  });
});

test("duplicate release does not restore capacity twice", async () => {
  const state: FakeState = {
    claim: createClaim({ status: "released", releasedAt: new Date("2026-07-30T10:00:00.000Z") }),
    reward: createReward({ availableCount: 5 }),
  };
  await withFakes(state, async () => {
    const result = await release();

    assert.equal(result.status, "alreadyReleased");
    assert.equal(state.reward?.availableCount, 5);
  });
});

test("concurrent release attempts restore capacity once through the claim state guard", async () => {
  const state: FakeState = { claim: createClaim(), reward: createReward() };
  await withFakes(state, async () => {
    const [first, second] = await Promise.all([release(), release()]);

    assert.deepEqual([first.status, second.status].sort(), ["alreadyReleased", "released"]);
    assert.equal(state.reward?.availableCount, 5);
  });
});

test("limited reward capacity restoration is capped at configured capacity", async () => {
  const state: FakeState = { claim: createClaim(), reward: createReward({ capacity: 10, availableCount: 10 }) };
  await withFakes(state, async () => {
    const result = await release();

    assert.equal(result.status, "released");
    assert.equal(state.reward?.availableCount, 10);
  });
});

test("legacy capacity zero is treated as unlimited", async () => {
  const state: FakeState = { claim: createClaim(), reward: createReward({ capacityLimited: undefined, capacity: 0, availableCount: null }) };
  await withFakes(state, async () => {
    const result = await release();

    assert.equal(result.status, "released");
    assert.equal(state.reward?.availableCount, null);
  });
});

test("pending checkout reservation without an order releases with capacity restoration when explicitly allowed", async () => {
  const state: FakeState = {
    claim: createClaim({
      checkoutOrderId: null,
      status: "pending",
    }),
    reward: createReward(),
  };
  await withFakes(state, async () => {
    const result = await releasePendingReservation();

    assert.equal(result.status, "released");
    assert.equal(state.claim?.status, "released");
    assert.equal(state.reward?.availableCount, 5);
  });
});

test("manual, product, pending, and wrong-linkage claims are not released by the helper", async () => {
  await withFakes({ claim: createClaim({ source: "manual_claim", status: "legacy_claim" }), reward: createReward() }, async () => {
    const result = await release();
    assert.equal(result.status, "notCheckoutRedemption");
  });

  await withFakes({ claim: createClaim(), reward: createReward({ rewardType: "product", ticketId: null }) }, async () => {
    const result = await release();
    assert.equal(result.status, "notCheckoutRedemption");
  });

  await withFakes({ claim: createClaim({ status: "pending" }), reward: createReward() }, async () => {
    const result = await release();
    assert.equal(result.status, "notFound");
  });

  await withFakes({ claim: createClaim(), reward: createReward({ ticketId: "vip" }) }, async () => {
    const result = await release();
    assert.equal(result.status, "notCheckoutRedemption");
  });
});
