import mongoose, { type ClientSession, type FilterQuery } from "mongoose";
import { EventModel } from "./event.model.js";
import { RewardClaimModel, type IRewardClaim } from "./reward-claim.model.js";

export type CheckoutRewardReleaseClaimStatus = "pending" | "redeemed";

export type CheckoutRewardReleaseResultStatus =
  | "released"
  | "alreadyReleased"
  | "notFound"
  | "notCheckoutRedemption"
  | "legacyAmbiguous";

export interface CheckoutRewardReleaseResult {
  status: CheckoutRewardReleaseResultStatus;
  claim: IRewardClaim | null;
}

export class RewardClaimRepository {
  public async create(data: { userId: string; eventId: string; rewardId: string }): Promise<IRewardClaim> {
    return RewardClaimModel.create({
      userId: data.userId,
      eventId: data.eventId,
      rewardId: data.rewardId,
      status: "legacy_claim",
      source: "manual_claim",
      claimedAt: new Date(),
    });
  }

  public async reserveCheckoutReward(data: {
    userId: string;
    eventId: string;
    rewardId: string;
    ticketId: string;
  }): Promise<IRewardClaim | null> {
    const reusable = await RewardClaimModel.findOneAndUpdate(
      {
        userId: data.userId,
        eventId: data.eventId,
        rewardId: data.rewardId,
        status: { $in: ["released", "legacy_claim"] },
      },
      {
        $set: {
          ticketId: data.ticketId,
          checkoutOrderId: null,
          stripePaymentIntentId: null,
          status: "pending",
          source: "checkout",
          claimedAt: new Date(),
          redeemedAt: null,
          releasedAt: null,
        },
      },
      { new: true, runValidators: true },
    );

    if (reusable) {
      return reusable;
    }

    return RewardClaimModel.create({
      userId: data.userId,
      eventId: data.eventId,
      rewardId: data.rewardId,
      ticketId: data.ticketId,
      status: "pending",
      source: "checkout",
      claimedAt: new Date(),
    }).catch((error) => {
      if ((error as { code?: number }).code === 11000) {
        return null;
      }
      throw error;
    });
  }

  public async attachCheckoutOrder(data: {
    userId: string;
    eventId: string;
    rewardId: string;
    checkoutOrderId: string;
    stripePaymentIntentId?: string | null;
  }): Promise<IRewardClaim | null> {
    return RewardClaimModel.findOneAndUpdate(
      {
        userId: data.userId,
        eventId: data.eventId,
        rewardId: data.rewardId,
        status: "pending",
      },
      {
        $set: {
          checkoutOrderId: data.checkoutOrderId,
          stripePaymentIntentId: data.stripePaymentIntentId ?? null,
        },
      },
      { new: true, runValidators: true },
    );
  }

  public async releasePendingCheckoutReward(data: {
    userId: string;
    eventId: string;
    rewardId: string;
  }, releasedAt = new Date()): Promise<IRewardClaim | null> {
    return RewardClaimModel.findOneAndUpdate(
      {
        userId: data.userId,
        eventId: data.eventId,
        rewardId: data.rewardId,
        status: "pending",
        source: "checkout",
      },
      { $set: { status: "released", releasedAt } },
      { new: true, runValidators: true },
    );
  }

  public async markRedeemedByOrder(orderId: string, redeemedAt = new Date()): Promise<IRewardClaim | null> {
    return RewardClaimModel.findOneAndUpdate(
      { checkoutOrderId: orderId, status: "pending", source: "checkout" },
      { $set: { status: "redeemed", redeemedAt, releasedAt: null } },
      { new: true, runValidators: true },
    );
  }

  public async releaseByOrder(orderId: string, releasedAt = new Date()): Promise<IRewardClaim | null> {
    return RewardClaimModel.findOneAndUpdate(
      { checkoutOrderId: orderId, status: { $in: ["pending", "redeemed"] }, source: "checkout" },
      { $set: { status: "released", releasedAt } },
      { new: true, runValidators: true },
    );
  }

  public async releaseRedeemedCheckoutByOrder(data: {
    orderId: string;
    eventId: string;
    rewardId: string;
  }, releasedAt = new Date()): Promise<IRewardClaim | null> {
    return RewardClaimModel.findOneAndUpdate(
      {
        checkoutOrderId: data.orderId,
        eventId: data.eventId,
        rewardId: data.rewardId,
        status: "redeemed",
        source: "checkout",
      },
      { $set: { status: "released", releasedAt } },
      { new: true, runValidators: true },
    );
  }

  public async releaseCheckoutRewardRedemptionAndRestoreCapacity(data: {
    orderId?: string | null;
    eventId: string;
    ticketId?: string | null;
    rewardId: string;
    userId?: string | null;
    claimStatuses?: CheckoutRewardReleaseClaimStatus[];
    session?: ClientSession | null;
  }, releasedAt = new Date()): Promise<CheckoutRewardReleaseResult> {
    const run = async (session: ClientSession): Promise<CheckoutRewardReleaseResult> => {
      const claimStatuses = data.claimStatuses?.length ? data.claimStatuses : ["redeemed"];
      const claimQuery: FilterQuery<IRewardClaim> = {
        checkoutOrderId: data.orderId ?? null,
        eventId: data.eventId,
        rewardId: data.rewardId,
        source: "checkout",
        status: { $in: claimStatuses },
      };

      if (data.userId) {
        claimQuery.userId = data.userId;
      }

      if (data.ticketId) {
        claimQuery.ticketId = data.ticketId;
      }

      const event = await EventModel.findOne(
        { _id: data.eventId, "rewards.id": data.rewardId },
        { rewards: { $elemMatch: { id: data.rewardId } } },
      ).session(session).lean();
      const reward = event?.rewards?.[0] ?? null;

      if (!reward || reward.rewardType !== "ticket" || (data.ticketId && reward.ticketId !== data.ticketId)) {
        return { status: "notCheckoutRedemption", claim: null };
      }

      const capacity = reward.capacity ?? null;
      const capacityLimited = capacity === 0
        ? false
        : reward.capacityLimited ?? ((capacity ?? 0) > 0);

      if (capacityLimited && (!capacity || capacity <= 0 || reward.availableCount === null || reward.availableCount === undefined)) {
        return { status: "legacyAmbiguous", claim: null };
      }

      const released = await RewardClaimModel.findOneAndUpdate(
        claimQuery,
        { $set: { status: "released", releasedAt } },
        { new: true, runValidators: true, session },
      );

      if (!released) {
        const alreadyReleased = await RewardClaimModel.findOne({
          checkoutOrderId: data.orderId ?? null,
          eventId: data.eventId,
          rewardId: data.rewardId,
          source: "checkout",
          status: "released",
          ...(data.userId ? { userId: data.userId } : {}),
          ...(data.ticketId ? { ticketId: data.ticketId } : {}),
        }).session(session);

        if (alreadyReleased) {
          return { status: "alreadyReleased", claim: alreadyReleased };
        }

        const otherClaim = await RewardClaimModel.findOne({
          checkoutOrderId: data.orderId ?? null,
          eventId: data.eventId,
          rewardId: data.rewardId,
          ...(data.userId ? { userId: data.userId } : {}),
          ...(data.ticketId ? { ticketId: data.ticketId } : {}),
        }).session(session);

        if (otherClaim && otherClaim.source !== "checkout") {
          return { status: "notCheckoutRedemption", claim: otherClaim };
        }

        return { status: "notFound", claim: otherClaim };
      }

      if (!capacityLimited) {
        return { status: "released", claim: released };
      }

      const capacityUpdate = await EventModel.updateOne(
        {
          _id: data.eventId,
          rewards: {
            $elemMatch: {
              id: data.rewardId,
              rewardType: "ticket",
              ticketId: data.ticketId ?? reward.ticketId ?? null,
              availableCount: { $ne: null },
            },
          },
        },
        [
          {
            $set: {
              rewards: {
                $map: {
                  input: "$rewards",
                  as: "reward",
                  in: {
                    $cond: [
                      { $eq: ["$$reward.id", data.rewardId] },
                      {
                        $mergeObjects: [
                          "$$reward",
                          {
                            availableCount: {
                              $min: [
                                { $add: ["$$reward.availableCount", 1] },
                                "$$reward.capacity",
                              ],
                            },
                          },
                        ],
                      },
                      "$$reward",
                    ],
                  },
                },
              },
            },
          },
        ],
        { session },
      );

      if (capacityUpdate.matchedCount !== 1) {
        throw new Error("Limited ticket reward capacity could not be restored for released checkout reward");
      }

      return { status: "released", claim: released };
    };

    if (data.session) {
      return run(data.session);
    }

    const session = await mongoose.startSession();
    try {
      let result: CheckoutRewardReleaseResult = { status: "notFound", claim: null };
      await session.withTransaction(async () => {
        result = await run(session);
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  public async findByUserAndEvent(userId: string, eventId: string): Promise<IRewardClaim[]> {
    return RewardClaimModel.find({ userId, eventId }).lean();
  }

  public async findByUserAndReward(userId: string, eventId: string, rewardId: string): Promise<IRewardClaim | null> {
    return RewardClaimModel.findOne({ userId, eventId, rewardId }).lean();
  }

  public async countByReward(eventId: string, rewardId: string): Promise<number> {
    return RewardClaimModel.countDocuments({ eventId, rewardId, status: { $in: ["redeemed", "legacy_claim"] } });
  }

  public async countSuccessfulCheckoutRedemptions(eventId: string, rewardId: string): Promise<number> {
    return RewardClaimModel.countDocuments({ eventId, rewardId, source: "checkout", status: "redeemed" });
  }

  public async countActiveCheckoutSlots(eventId: string, rewardId: string): Promise<number> {
    return RewardClaimModel.countDocuments({ eventId, rewardId, source: "checkout", status: { $in: ["pending", "redeemed"] } });
  }
}
