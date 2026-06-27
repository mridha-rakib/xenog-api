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
}

export class CreatorEarningRepository {
  public async create(payload: CreateEarningRecord): Promise<ICreatorEarning> {
    return CreatorEarningModel.create(payload);
  }

  public async findByCreatorUserId(creatorUserId: string): Promise<ICreatorEarning[]> {
    return CreatorEarningModel.find({ creatorUserId }).sort({ createdAt: -1 });
  }

  public async findByCreatorUserIdAndEventId(creatorUserId: string, eventId: string): Promise<ICreatorEarning[]> {
    return CreatorEarningModel.find({ creatorUserId, eventId }).sort({ createdAt: -1 });
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
