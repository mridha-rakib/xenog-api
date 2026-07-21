import type { CreatorEarningStatus, ICreatorEarning } from "./creator-earning.interface.js";
import { CreatorEarningModel } from "./creator-earning.model.js";

interface CreateEarningRecord {
  creatorUserId: string;
  orderId: string;
  eventId?: string | null;
  itemType: "ticket" | "product";
  grossAmount: number;
  platformFeePercent: number;
  platformFeeAmount: number;
  netAmount: number;
  status: CreatorEarningStatus;
  eligibleAt?: Date | null;
}

export class CreatorEarningRepository {
  public async create(payload: CreateEarningRecord): Promise<ICreatorEarning> {
    return CreatorEarningModel.create(payload);
  }

  public async splitEligibleEarningForAmount(
    earning: ICreatorEarning,
    amount: number,
  ): Promise<ICreatorEarning> {
    const sourceNet = earning.netAmount;

    if (amount <= 0 || amount >= sourceNet) {
      throw new Error("Split amount must be greater than zero and less than earning amount");
    }

    const ratio = amount / sourceNet;
    const splitGross = Math.round(earning.grossAmount * ratio * 100) / 100;
    const splitPlatformFee = Math.round(earning.platformFeeAmount * ratio * 100) / 100;
    const splitNet = Math.round(amount * 100) / 100;
    const remainingGross = Math.round((earning.grossAmount - splitGross) * 100) / 100;
    const remainingPlatformFee = Math.round((earning.platformFeeAmount - splitPlatformFee) * 100) / 100;
    const remainingNet = Math.round((earning.netAmount - splitNet) * 100) / 100;

    const updatedSource = await CreatorEarningModel.findOneAndUpdate(
      { _id: earning._id, status: "eligible", netAmount: sourceNet },
      {
        $set: {
          grossAmount: remainingGross,
          platformFeeAmount: remainingPlatformFee,
          netAmount: remainingNet,
        },
      },
      { runValidators: true },
    );

    if (!updatedSource) {
      throw new Error("Eligible earning is no longer available for withdrawal");
    }

    return CreatorEarningModel.create({
      creatorUserId: earning.creatorUserId,
      orderId: earning.orderId,
      eventId: earning.eventId ?? null,
      itemType: earning.itemType,
      grossAmount: splitGross,
      platformFeePercent: earning.platformFeePercent,
      platformFeeAmount: splitPlatformFee,
      netAmount: splitNet,
      status: "eligible",
      eligibleAt: earning.eligibleAt ?? null,
    });
  }

  public async findByCreatorUserId(creatorUserId: string): Promise<ICreatorEarning[]> {
    return CreatorEarningModel.find({ creatorUserId }).sort({ createdAt: -1 });
  }

  public async findByCreatorUserIdAndEventId(creatorUserId: string, eventId: string): Promise<ICreatorEarning[]> {
    return CreatorEarningModel.find({ creatorUserId, eventId }).sort({ createdAt: -1 });
  }

  public async findByIds(ids: string[]): Promise<ICreatorEarning[]> {
    return ids.length > 0 ? CreatorEarningModel.find({ _id: { $in: ids } }) : [];
  }

  public async countWithdrawnByEventId(eventId: string): Promise<number> {
    return CreatorEarningModel.countDocuments({ eventId, status: "withdrawn" });
  }

  public async findEligibleByCreatorUserId(creatorUserId: string): Promise<ICreatorEarning[]> {
    const now = new Date();

    return CreatorEarningModel.find({
      creatorUserId,
      $or: [
        { status: "eligible" },
        { status: "held", eligibleAt: { $lte: now } },
      ],
    }).sort({ createdAt: -1 });
  }

  public async markRefundedByOrderId(orderId: string): Promise<void> {
    await CreatorEarningModel.updateMany(
      { orderId, status: { $in: ["held", "eligible"] } },
      { $set: { status: "refunded" } },
    );
  }

  public async markRefundedByEventId(eventId: string): Promise<void> {
    await CreatorEarningModel.updateMany(
      { eventId, status: { $in: ["held", "eligible"] } },
      { $set: { status: "refunded" } },
    );
  }

  public async setEligibleAtByEventId(eventId: string, eligibleAt: Date): Promise<void> {
    await CreatorEarningModel.updateMany(
      { eventId, status: "held" },
      { $set: { eligibleAt } },
    );
  }

  public async markWithdrawn(earningIds: string[], payoutId: string): Promise<void> {
    await CreatorEarningModel.updateMany(
      { _id: { $in: earningIds }, status: { $in: ["held", "eligible"] } },
      { $set: { status: "withdrawn", payoutId } },
    );
  }

  public async releaseEligibleEarnings(creatorUserId: string): Promise<void> {
    const now = new Date();

    await CreatorEarningModel.updateMany(
      { creatorUserId, status: "held", eligibleAt: { $lte: now } },
      { $set: { status: "eligible" } },
    );
  }

  public async releaseToEligible(earningIds: string[]): Promise<void> {
    await CreatorEarningModel.updateMany(
      { _id: { $in: earningIds }, status: "withdrawn" },
      { $set: { status: "eligible" }, $unset: { payoutId: "" } },
    );
  }
}
