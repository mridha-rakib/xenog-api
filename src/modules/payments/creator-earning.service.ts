import httpStatus from "http-status";
import { AppError } from "../../core/errors/app-error.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { MoomentCreditPaymentRepository } from "./mooment-credit-payment.repository.js";
import { CreatorEarningRepository } from "./creator-earning.repository.js";
import { CreatorPayoutRepository } from "./creator-payout.repository.js";
import type {
  CreatorEarningResponse,
  CreatorEarningsSummaryResponse,
  ICreatorEarning,
} from "./creator-earning.interface.js";
import type { CreatorPayoutResponse, RequestWithdrawalDto } from "./creator-payout.interface.js";

const getNextPayoutDate = (): Date => {
  const now = new Date();
  const day = now.getDay();
  let daysToAdd: number;

  if (day === 0) daysToAdd = 1;
  else if (day === 1) daysToAdd = 0;
  else if (day <= 4) daysToAdd = 5 - day;
  else if (day === 5) daysToAdd = 0;
  else daysToAdd = 2;

  const date = new Date(now);
  date.setDate(date.getDate() + daysToAdd);
  date.setHours(0, 0, 0, 0);

  return date;
};

export class CreatorEarningService {
  public constructor(
    private readonly earningRepository = new CreatorEarningRepository(),
    private readonly payoutRepository = new CreatorPayoutRepository(),
    private readonly creditRepository = new MoomentCreditPaymentRepository(),
  ) {}

  public async getMyEarnings(user: AuthUser): Promise<CreatorEarningsSummaryResponse> {
    await this.earningRepository.releaseEligibleEarnings(user.id);
    const earnings = await this.earningRepository.findByCreatorUserId(user.id);

    let heldAmount = 0;
    let eligibleAmount = 0;
    let withdrawnAmount = 0;
    let convertedToCreditsAmount = 0;
    let totalEarnedAmount = 0;

    for (const earning of earnings) {
      if (earning.status === "refunded") {
        continue;
      }

      totalEarnedAmount += earning.netAmount;

      if (earning.status === "held") {
        heldAmount += earning.netAmount;
      } else if (earning.status === "eligible") {
        eligibleAmount += earning.netAmount;
      } else if (earning.status === "withdrawn") {
        withdrawnAmount += earning.netAmount;
      } else if (earning.status === "converted_to_credits") {
        convertedToCreditsAmount += earning.netAmount;
      }
    }

    return {
      heldAmount: Math.round(heldAmount * 100) / 100,
      eligibleAmount: Math.round(eligibleAmount * 100) / 100,
      withdrawnAmount: Math.round(withdrawnAmount * 100) / 100,
      convertedToCreditsAmount: Math.round(convertedToCreditsAmount * 100) / 100,
      totalEarnedAmount: Math.round(totalEarnedAmount * 100) / 100,
      earnings: earnings.map((e) => this.toEarningResponse(e)),
    };
  }

  public async requestWithdrawal(user: AuthUser, dto: RequestWithdrawalDto): Promise<CreatorPayoutResponse> {
    await this.earningRepository.releaseEligibleEarnings(user.id);
    const eligible = await this.earningRepository.findEligibleByCreatorUserId(user.id);

    if (eligible.length === 0) {
      throw new AppError("No eligible earnings available for withdrawal", httpStatus.BAD_REQUEST);
    }

    const totalAmount = Math.round(eligible.reduce((sum, e) => sum + e.netAmount, 0) * 100) / 100;

    if (totalAmount <= 0) {
      throw new AppError("No eligible earnings available for withdrawal", httpStatus.BAD_REQUEST);
    }

    const scheduledDate = getNextPayoutDate();
    const earningIds = eligible.map((e) => e._id.toString());

    if (dto.payoutType === "mooment_credits") {
      const creditsToAward = Math.floor(totalAmount);

      const payout = await this.payoutRepository.create({
        creatorUserId: user.id,
        earningIds,
        totalAmount,
        payoutType: "mooment_credits",
        status: "completed",
        scheduledDate,
        moomentCreditsAwarded: creditsToAward,
      });

      await this.creditRepository.incrementWallet(user.id, creditsToAward);
      await this.earningRepository.markConvertedToCredits(earningIds, payout._id.toString());

      return this.toPayoutResponse(payout);
    }

    const payout = await this.payoutRepository.create({
      creatorUserId: user.id,
      earningIds,
      totalAmount,
      payoutType: "bank_transfer",
      status: "pending",
      scheduledDate,
    });

    await this.earningRepository.markWithdrawn(earningIds, payout._id.toString());

    return this.toPayoutResponse(payout);
  }

  public async getMyPayouts(user: AuthUser): Promise<CreatorPayoutResponse[]> {
    const payouts = await this.payoutRepository.findByCreatorUserId(user.id);

    return payouts.map((p) => this.toPayoutResponse(p));
  }

  private toEarningResponse(earning: ICreatorEarning): CreatorEarningResponse {
    return {
      id: earning._id.toString(),
      creatorUserId: earning.creatorUserId.toString(),
      orderId: earning.orderId.toString(),
      eventId: earning.eventId?.toString() ?? null,
      itemType: earning.itemType,
      grossAmount: earning.grossAmount,
      platformFeePercent: earning.platformFeePercent,
      platformFeeAmount: earning.platformFeeAmount,
      netAmount: earning.netAmount,
      status: earning.status,
      eligibleAt: earning.eligibleAt ?? null,
      payoutId: earning.payoutId?.toString() ?? null,
      createdAt: earning.createdAt,
      updatedAt: earning.updatedAt,
    };
  }

  private toPayoutResponse(payout: import("./creator-payout.interface.js").ICreatorPayout): CreatorPayoutResponse {
    return {
      id: payout._id.toString(),
      creatorUserId: payout.creatorUserId.toString(),
      earningIds: payout.earningIds.map((id) => id.toString()),
      totalAmount: payout.totalAmount,
      payoutType: payout.payoutType,
      status: payout.status,
      scheduledDate: payout.scheduledDate,
      moomentCreditsAwarded: payout.moomentCreditsAwarded ?? null,
      stripeTransferId: payout.stripeTransferId ?? null,
      failureReason: payout.failureReason ?? null,
      processedAt: payout.processedAt ?? null,
      createdAt: payout.createdAt,
      updatedAt: payout.updatedAt,
    };
  }
}
