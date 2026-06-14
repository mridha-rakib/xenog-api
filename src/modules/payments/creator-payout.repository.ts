import type { CreatorPayoutStatus, CreatorPayoutType, ICreatorPayout } from "./creator-payout.interface.js";
import { CreatorPayoutModel } from "./creator-payout.model.js";

interface CreatePayoutRecord {
  creatorUserId: string;
  earningIds: string[];
  totalAmount: number;
  payoutType: CreatorPayoutType;
  status: CreatorPayoutStatus;
  scheduledDate: Date;
  moomentCreditsAwarded?: number | null;
}

export class CreatorPayoutRepository {
  public async create(payload: CreatePayoutRecord): Promise<ICreatorPayout> {
    return CreatorPayoutModel.create(payload);
  }

  public async findByCreatorUserId(creatorUserId: string): Promise<ICreatorPayout[]> {
    return CreatorPayoutModel.find({ creatorUserId }).sort({ createdAt: -1 });
  }

  public async findById(id: string): Promise<ICreatorPayout | null> {
    return CreatorPayoutModel.findById(id);
  }

  public async markCompleted(id: string, stripeTransferId?: string | null): Promise<ICreatorPayout | null> {
    return CreatorPayoutModel.findByIdAndUpdate(
      id,
      {
        $set: {
          status: "completed",
          stripeTransferId: stripeTransferId ?? null,
          processedAt: new Date(),
        },
      },
      { new: true, runValidators: true },
    );
  }
}
