import assert from "node:assert/strict";
import test from "node:test";
import mongoose, { Types } from "mongoose";
import { randomUUID } from "node:crypto";
import { EventModel } from "../src/modules/events/event.model.js";
import { EventRepository } from "../src/modules/events/event.repository.js";
import { RewardClaimModel } from "../src/modules/events/reward-claim.model.js";
import { RewardClaimRepository } from "../src/modules/events/reward-claim.repository.js";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const repository = new RewardClaimRepository();
const eventRepository = new EventRepository();
const runId = `rtx-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const createdEventIds: Types.ObjectId[] = [];
const createdClaimIds: Types.ObjectId[] = [];

type RewardFixtureOptions = {
  rewardType?: "ticket" | "product";
  capacityLimited?: boolean;
  capacity?: number | null;
  availableCount?: number | null;
  claimStatus?: "pending" | "redeemed" | "released" | "legacy_claim";
  claimSource?: "checkout" | "manual_claim" | "legacy";
  checkoutOrderId?: Types.ObjectId | null;
  userId?: Types.ObjectId;
  ticketId?: string;
};

const getReward = async (eventId: Types.ObjectId, rewardId: string) => {
  const event = await EventModel.findById(eventId).lean();
  return event?.rewards.find((reward) => reward.id === rewardId) ?? null;
};

const createRewardFixture = async (label: string, options: RewardFixtureOptions = {}) => {
  const eventId = new Types.ObjectId();
  const userId = options.userId ?? new Types.ObjectId();
  const orderId = options.checkoutOrderId === undefined ? new Types.ObjectId() : options.checkoutOrderId;
  const ticketId = options.ticketId ?? `${runId}-${label}-ticket`;
  const rewardId = `${runId}-${label}-reward`;
  const claimId = new Types.ObjectId();

  createdEventIds.push(eventId);
  createdClaimIds.push(claimId);

  await EventModel.create({
    _id: eventId,
    userId: new Types.ObjectId(),
    status: "draft",
    name: `Codex reward release integration ${label}`,
    privacy: "public",
    tickets: [
      {
        id: ticketId,
        name: "Integration ticket",
        type: "pay",
        price: 45,
        capacity: 10,
        availableCount: 4,
      },
    ],
    rewards: [
      {
        id: rewardId,
        rewardType: options.rewardType ?? "ticket",
        ticketId: options.rewardType === "product" ? null : ticketId,
        productId: options.rewardType === "product" ? new Types.ObjectId() : null,
        name: "Integration reward",
        capacityLimited: options.capacityLimited,
        capacity: options.capacity,
        availableCount: options.availableCount,
      },
    ],
  });

  await RewardClaimModel.create({
    _id: claimId,
    userId,
    eventId,
    rewardId,
    ticketId: options.rewardType === "product" ? null : ticketId,
    checkoutOrderId: orderId,
    status: options.claimStatus ?? "redeemed",
    source: options.claimSource ?? "checkout",
    claimedAt: new Date(),
    redeemedAt: options.claimStatus === "pending" ? null : new Date(),
  });

  return { eventId, userId, orderId, ticketId, rewardId, claimId };
};

const createReservationFixture = async (
  label: string,
  options: {
    rewardCapacityLimited?: boolean;
    rewardCapacity?: number | null;
    rewardAvailableCount?: number | null;
    ticketAvailableCount?: number;
    disabledAt?: Date | null;
  } = {},
) => {
  const eventId = new Types.ObjectId();
  const ticketId = `${runId}-${label}-ticket`;
  const rewardId = `${runId}-${label}-reward`;

  createdEventIds.push(eventId);

  await EventModel.create({
    _id: eventId,
    userId: new Types.ObjectId(),
    status: "published",
    name: `Codex reward reservation integration ${label}`,
    description: "Reservation fixture",
    categories: ["Live Music & Concerts"],
    category: "Live Music & Concerts",
    scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    endAt: new Date(Date.now() + 26 * 60 * 60 * 1000),
    privacy: "public",
    tickets: [
      {
        id: ticketId,
        name: "Integration ticket",
        type: "pay",
        price: 45,
        capacity: 10,
        availableCount: options.ticketAvailableCount ?? 10,
      },
    ],
    rewards: [
      {
        id: rewardId,
        rewardType: "ticket",
        ticketId,
        name: "Integration reward",
        capacityLimited: options.rewardCapacityLimited,
        capacity: options.rewardCapacity,
        availableCount: options.rewardAvailableCount,
        disabledAt: options.disabledAt ?? null,
      },
    ],
  });

  return { eventId, ticketId, rewardId };
};

const reserveRewardedCheckoutSlot = async (
  fixture: { eventId: Types.ObjectId; ticketId: string; rewardId: string },
  userId = new Types.ObjectId(),
) => {
  const claim = await repository.reserveCheckoutReward({
    userId: userId.toString(),
    eventId: fixture.eventId.toString(),
    rewardId: fixture.rewardId,
    ticketId: fixture.ticketId,
  });

  if (!claim) {
    return "claim-conflict" as const;
  }

  createdClaimIds.push(claim._id);

  const reserved = await eventRepository.reserveTicketAndRewardCapacity(
    fixture.eventId.toString(),
    fixture.ticketId,
    1,
    fixture.rewardId,
    1,
  );

  if (!reserved) {
    await repository.releasePendingCheckoutReward({
      userId: userId.toString(),
      eventId: fixture.eventId.toString(),
      rewardId: fixture.rewardId,
    });
    return "capacity-unavailable" as const;
  }

  return "reserved" as const;
};

test.before(async () => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI!);
  }

  const admin = mongoose.connection.db.admin();
  const [buildInfo, hello] = await Promise.all([
    admin.command({ buildInfo: 1 }),
    admin.command({ hello: 1 }),
  ]);

  assert.match(buildInfo.version, /^\d+\./, "MongoDB buildInfo should be available");
  assert.equal(hello.setName, "rs0", "transaction test requires local replica set rs0");
  assert.ok(hello.logicalSessionTimeoutMinutes, "transaction test requires logical sessions");
});

test.after(async () => {
  if (createdClaimIds.length) {
    await RewardClaimModel.deleteMany({ _id: { $in: createdClaimIds } });
  }
  if (createdEventIds.length) {
    await EventModel.deleteMany({ _id: { $in: createdEventIds } });
  }
  await mongoose.disconnect();
});

test("real transaction rolls back a claim-only write before capacity restore", async () => {
  const fixture = await createRewardFixture("claim-rollback", {
    capacityLimited: true,
    capacity: 5,
    availableCount: 4,
  });

  const session = await mongoose.startSession();
  await assert.rejects(
    async () => {
      try {
        await session.withTransaction(async () => {
          await RewardClaimModel.findOneAndUpdate(
            {
              _id: fixture.claimId,
              status: "redeemed",
              source: "checkout",
            },
            { $set: { status: "released", releasedAt: new Date() } },
            { new: true, runValidators: true, session },
          );

          throw new Error("forced rollback before reward capacity restore");
        });
      } finally {
        await session.endSession();
      }
    },
    /forced rollback before reward capacity restore/,
  );

  const claim = await RewardClaimModel.findById(fixture.claimId).lean();
  const reward = await getReward(fixture.eventId, fixture.rewardId);

  assert.equal(claim?.status, "redeemed");
  assert.equal(reward?.availableCount, 4);
});

test("repository release rolls back claim and capacity writes when the outer transaction aborts", async () => {
  const fixture = await createRewardFixture("helper-rollback", {
    capacityLimited: true,
    capacity: 5,
    availableCount: 4,
  });

  const session = await mongoose.startSession();
  await assert.rejects(
    async () => {
      try {
        await session.withTransaction(async () => {
          const result = await repository.releaseCheckoutRewardRedemptionAndRestoreCapacity({
            orderId: fixture.orderId?.toString(),
            eventId: fixture.eventId.toString(),
            ticketId: fixture.ticketId,
            rewardId: fixture.rewardId,
            userId: fixture.userId.toString(),
            session,
          });

          assert.equal(result.status, "released");
          throw new Error("forced rollback after repository release");
        });
      } finally {
        await session.endSession();
      }
    },
    /forced rollback after repository release/,
  );

  let claim = await RewardClaimModel.findById(fixture.claimId).lean();
  let reward = await getReward(fixture.eventId, fixture.rewardId);
  assert.equal(claim?.status, "redeemed");
  assert.equal(reward?.availableCount, 4);

  const retry = await repository.releaseCheckoutRewardRedemptionAndRestoreCapacity({
    orderId: fixture.orderId?.toString(),
    eventId: fixture.eventId.toString(),
    ticketId: fixture.ticketId,
    rewardId: fixture.rewardId,
    userId: fixture.userId.toString(),
  });

  claim = await RewardClaimModel.findById(fixture.claimId).lean();
  reward = await getReward(fixture.eventId, fixture.rewardId);
  assert.equal(retry.status, "released");
  assert.equal(claim?.status, "released");
  assert.equal(reward?.availableCount, 5);
});

test("concurrent repository releases are idempotent and restore limited capacity once", async () => {
  const fixture = await createRewardFixture("concurrent", {
    capacityLimited: true,
    capacity: 5,
    availableCount: 4,
  });

  const releaseInput = {
    orderId: fixture.orderId?.toString(),
    eventId: fixture.eventId.toString(),
    ticketId: fixture.ticketId,
    rewardId: fixture.rewardId,
    userId: fixture.userId.toString(),
  };

  const results = await Promise.allSettled([
    repository.releaseCheckoutRewardRedemptionAndRestoreCapacity(releaseInput),
    repository.releaseCheckoutRewardRedemptionAndRestoreCapacity(releaseInput),
  ]);

  const fulfilledStatuses = results
    .filter((result): result is PromiseFulfilledResult<{ status: string }> => result.status === "fulfilled")
    .map((result) => result.value.status);
  const rejectedReasons = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);

  assert.ok(
    fulfilledStatuses.includes("released") || fulfilledStatuses.includes("alreadyReleased"),
    `expected at least one release outcome, got ${JSON.stringify(results)}`,
  );
  for (const reason of rejectedReasons) {
    const error = reason as { errorLabels?: string[]; message?: string };
    assert.ok(
      error.errorLabels?.includes("TransientTransactionError") || /write conflict|transaction/i.test(error.message ?? ""),
      `unexpected concurrent release error: ${error.message ?? String(reason)}`,
    );
  }

  const claim = await RewardClaimModel.findById(fixture.claimId).lean();
  const reward = await getReward(fixture.eventId, fixture.rewardId);
  assert.equal(claim?.status, "released");
  assert.equal(reward?.availableCount, 5);

  const retry = await repository.releaseCheckoutRewardRedemptionAndRestoreCapacity(releaseInput);
  const rewardAfterRetry = await getReward(fixture.eventId, fixture.rewardId);
  assert.equal(retry.status, "alreadyReleased");
  assert.equal(rewardAfterRetry?.availableCount, 5);
});

test("limited reward capacity is capped at configured capacity", async () => {
  const fixture = await createRewardFixture("capacity-cap", {
    capacityLimited: true,
    capacity: 10,
    availableCount: 10,
  });

  const result = await repository.releaseCheckoutRewardRedemptionAndRestoreCapacity({
    orderId: fixture.orderId?.toString(),
    eventId: fixture.eventId.toString(),
    ticketId: fixture.ticketId,
    rewardId: fixture.rewardId,
    userId: fixture.userId.toString(),
  });

  const reward = await getReward(fixture.eventId, fixture.rewardId);
  assert.equal(result.status, "released");
  assert.equal(reward?.availableCount, 10);
});

test("unlimited and legacy capacity-zero ticket rewards release without capacity mutation", async () => {
  const unlimited = await createRewardFixture("unlimited", {
    capacityLimited: false,
    capacity: null,
    availableCount: null,
  });
  const legacyZero = await createRewardFixture("legacy-zero", {
    capacity: 0,
    availableCount: null,
  });

  const unlimitedResult = await repository.releaseCheckoutRewardRedemptionAndRestoreCapacity({
    orderId: unlimited.orderId?.toString(),
    eventId: unlimited.eventId.toString(),
    ticketId: unlimited.ticketId,
    rewardId: unlimited.rewardId,
    userId: unlimited.userId.toString(),
  });
  const legacyZeroResult = await repository.releaseCheckoutRewardRedemptionAndRestoreCapacity({
    orderId: legacyZero.orderId?.toString(),
    eventId: legacyZero.eventId.toString(),
    ticketId: legacyZero.ticketId,
    rewardId: legacyZero.rewardId,
    userId: legacyZero.userId.toString(),
  });

  const unlimitedReward = await getReward(unlimited.eventId, unlimited.rewardId);
  const legacyZeroReward = await getReward(legacyZero.eventId, legacyZero.rewardId);
  assert.equal(unlimitedResult.status, "released");
  assert.equal(legacyZeroResult.status, "released");
  assert.equal(unlimitedReward?.availableCount, null);
  assert.equal(legacyZeroReward?.availableCount, null);
});

test("pending reservation release without an order works only when pending is explicitly allowed", async () => {
  const fixture = await createRewardFixture("pending-no-order", {
    checkoutOrderId: null,
    claimStatus: "pending",
    capacityLimited: true,
    capacity: 5,
    availableCount: 4,
  });

  const defaultResult = await repository.releaseCheckoutRewardRedemptionAndRestoreCapacity({
    orderId: null,
    eventId: fixture.eventId.toString(),
    ticketId: fixture.ticketId,
    rewardId: fixture.rewardId,
    userId: fixture.userId.toString(),
  });
  assert.equal(defaultResult.status, "notFound");

  const allowedResult = await repository.releaseCheckoutRewardRedemptionAndRestoreCapacity({
    orderId: null,
    eventId: fixture.eventId.toString(),
    ticketId: fixture.ticketId,
    rewardId: fixture.rewardId,
    userId: fixture.userId.toString(),
    claimStatuses: ["pending"],
  });

  const claim = await RewardClaimModel.findById(fixture.claimId).lean();
  const reward = await getReward(fixture.eventId, fixture.rewardId);
  assert.equal(allowedResult.status, "released");
  assert.equal(claim?.status, "released");
  assert.equal(reward?.availableCount, 5);
});

test("non-checkout, product, and mismatched linkage cases do not restore capacity", async () => {
  const manual = await createRewardFixture("manual-claim", {
    claimSource: "manual_claim",
    claimStatus: "legacy_claim",
    capacityLimited: true,
    capacity: 5,
    availableCount: 4,
  });
  const product = await createRewardFixture("product-reward", {
    rewardType: "product",
    capacityLimited: true,
    capacity: 5,
    availableCount: 4,
  });
  const wrongOrder = await createRewardFixture("wrong-order", {
    capacityLimited: true,
    capacity: 5,
    availableCount: 4,
  });

  const manualResult = await repository.releaseCheckoutRewardRedemptionAndRestoreCapacity({
    orderId: manual.orderId?.toString(),
    eventId: manual.eventId.toString(),
    ticketId: manual.ticketId,
    rewardId: manual.rewardId,
    userId: manual.userId.toString(),
    claimStatuses: ["redeemed"],
  });
  const productResult = await repository.releaseCheckoutRewardRedemptionAndRestoreCapacity({
    orderId: product.orderId?.toString(),
    eventId: product.eventId.toString(),
    rewardId: product.rewardId,
    userId: product.userId.toString(),
  });
  const wrongOrderResult = await repository.releaseCheckoutRewardRedemptionAndRestoreCapacity({
    orderId: new Types.ObjectId().toString(),
    eventId: wrongOrder.eventId.toString(),
    ticketId: wrongOrder.ticketId,
    rewardId: wrongOrder.rewardId,
    userId: wrongOrder.userId.toString(),
  });

  const manualReward = await getReward(manual.eventId, manual.rewardId);
  const productReward = await getReward(product.eventId, product.rewardId);
  const wrongOrderReward = await getReward(wrongOrder.eventId, wrongOrder.rewardId);

  assert.equal(manualResult.status, "notCheckoutRedemption");
  assert.equal(productResult.status, "notCheckoutRedemption");
  assert.equal(wrongOrderResult.status, "notFound");
  assert.equal(manualReward?.availableCount, 4);
  assert.equal(productReward?.availableCount, 4);
  assert.equal(wrongOrderReward?.availableCount, 4);
});

test("real checkout reservation concurrency allows one user to claim the final limited reward slot", async () => {
  const fixture = await createReservationFixture("reserve-one", {
    rewardCapacityLimited: true,
    rewardCapacity: 1,
    rewardAvailableCount: 1,
  });

  const results = await Promise.all([
    reserveRewardedCheckoutSlot(fixture),
    reserveRewardedCheckoutSlot(fixture),
  ]);

  const claims = await RewardClaimModel.find({ eventId: fixture.eventId, rewardId: fixture.rewardId }).lean();
  const reward = await getReward(fixture.eventId, fixture.rewardId);

  assert.equal(results.filter((status) => status === "reserved").length, 1);
  assert.equal(results.filter((status) => status === "capacity-unavailable").length, 1);
  assert.equal(claims.filter((claim) => claim.status === "pending").length, 1);
  assert.equal(claims.filter((claim) => claim.status === "released").length, 1);
  assert.equal(reward?.availableCount, 0);
});

test("real checkout reservation concurrency allows only two users when two limited reward slots remain", async () => {
  const fixture = await createReservationFixture("reserve-two", {
    rewardCapacityLimited: true,
    rewardCapacity: 2,
    rewardAvailableCount: 2,
  });

  const results = await Promise.all([
    reserveRewardedCheckoutSlot(fixture),
    reserveRewardedCheckoutSlot(fixture),
    reserveRewardedCheckoutSlot(fixture),
  ]);

  const claims = await RewardClaimModel.find({ eventId: fixture.eventId, rewardId: fixture.rewardId }).lean();
  const reward = await getReward(fixture.eventId, fixture.rewardId);

  assert.equal(results.filter((status) => status === "reserved").length, 2);
  assert.equal(results.filter((status) => status === "capacity-unavailable").length, 1);
  assert.equal(claims.filter((claim) => claim.status === "pending").length, 2);
  assert.equal(claims.filter((claim) => claim.status === "released").length, 1);
  assert.equal(reward?.availableCount, 0);
});

test("same-user parallel rewarded checkout creates one active claim and one reservation", async () => {
  const fixture = await createReservationFixture("same-user", {
    rewardCapacityLimited: true,
    rewardCapacity: 2,
    rewardAvailableCount: 2,
  });
  const userId = new Types.ObjectId();

  const results = await Promise.all([
    reserveRewardedCheckoutSlot(fixture, userId),
    reserveRewardedCheckoutSlot(fixture, userId),
  ]);

  const claims = await RewardClaimModel.find({ eventId: fixture.eventId, rewardId: fixture.rewardId }).lean();
  const reward = await getReward(fixture.eventId, fixture.rewardId);

  assert.equal(results.filter((status) => status === "reserved").length, 1);
  assert.equal(results.filter((status) => status === "claim-conflict").length, 1);
  assert.equal(claims.length, 1);
  assert.equal(claims[0]?.status, "pending");
  assert.equal(reward?.availableCount, 1);
});

test("failed payment release makes a limited reward slot available to another user", async () => {
  const fixture = await createReservationFixture("released-slot-reuse", {
    rewardCapacityLimited: true,
    rewardCapacity: 1,
    rewardAvailableCount: 1,
  });
  const firstUserId = new Types.ObjectId();

  assert.equal(await reserveRewardedCheckoutSlot(fixture, firstUserId), "reserved");

  const releaseResult = await repository.releaseCheckoutRewardRedemptionAndRestoreCapacity({
    eventId: fixture.eventId.toString(),
    ticketId: fixture.ticketId,
    rewardId: fixture.rewardId,
    userId: firstUserId.toString(),
    claimStatuses: ["pending"],
  });
  assert.equal(releaseResult.status, "released");

  assert.equal(await reserveRewardedCheckoutSlot(fixture), "reserved");

  const reward = await getReward(fixture.eventId, fixture.rewardId);
  const claims = await RewardClaimModel.find({ eventId: fixture.eventId, rewardId: fixture.rewardId }).lean();
  assert.equal(reward?.availableCount, 0);
  assert.equal(claims.filter((claim) => claim.status === "pending").length, 1);
  assert.equal(claims.filter((claim) => claim.status === "released").length, 1);
});

test("unlimited and disabled rewards do not consume or reserve limited reward capacity", async () => {
  const unlimited = await createReservationFixture("reserve-unlimited", {
    rewardCapacityLimited: false,
    rewardCapacity: null,
    rewardAvailableCount: null,
  });
  const disabled = await createReservationFixture("reserve-disabled", {
    rewardCapacityLimited: true,
    rewardCapacity: 1,
    rewardAvailableCount: 1,
    disabledAt: new Date(),
  });

  const unlimitedReserved = await eventRepository.reserveTicketAndRewardCapacity(
    unlimited.eventId.toString(),
    unlimited.ticketId,
    1,
    unlimited.rewardId,
    0,
  );
  const disabledReserved = await eventRepository.reserveTicketAndRewardCapacity(
    disabled.eventId.toString(),
    disabled.ticketId,
    1,
    disabled.rewardId,
    1,
  );

  const unlimitedReward = await getReward(unlimited.eventId, unlimited.rewardId);
  const disabledReward = await getReward(disabled.eventId, disabled.rewardId);

  assert.ok(unlimitedReserved);
  assert.equal(disabledReserved, null);
  assert.equal(unlimitedReward?.availableCount, null);
  assert.equal(disabledReward?.availableCount, 1);
});
