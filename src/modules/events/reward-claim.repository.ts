import { RewardClaimModel, type IRewardClaim } from "./reward-claim.model.js";

export class RewardClaimRepository {
  public async create(data: { userId: string; eventId: string; rewardId: string }): Promise<IRewardClaim> {
    return RewardClaimModel.create({
      userId: data.userId,
      eventId: data.eventId,
      rewardId: data.rewardId,
      claimedAt: new Date(),
    });
  }

  public async findByUserAndEvent(userId: string, eventId: string): Promise<IRewardClaim[]> {
    return RewardClaimModel.find({ userId, eventId }).lean();
  }

  public async findByUserAndReward(userId: string, eventId: string, rewardId: string): Promise<IRewardClaim | null> {
    return RewardClaimModel.findOne({ userId, eventId, rewardId }).lean();
  }

  public async countByReward(eventId: string, rewardId: string): Promise<number> {
    return RewardClaimModel.countDocuments({ eventId, rewardId });
  }
}
