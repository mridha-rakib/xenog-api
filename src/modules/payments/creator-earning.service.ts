import httpStatus from "http-status";
import { AppError } from "../../core/errors/app-error.js";
import { env } from "../../config/env.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { EventRepository } from "../events/event.repository.js";
import { NotificationService } from "../notifications/notification.service.js";
import { UserRepository } from "../user/user.repository.js";
import { CreatorEarningRepository } from "./creator-earning.repository.js";
import { CreatorPayoutRepository } from "./creator-payout.repository.js";
import { StripeConnectService } from "./stripe-connect.service.js";
import type {
  CreatorEarningResponse,
  CreatorEarningsSummaryResponse,
  EventEarningsSummaryResponse,
  ICreatorEarning,
} from "./creator-earning.interface.js";
import type { CreatorPayoutResponse, ICreatorPayout, RequestWithdrawalDto } from "./creator-payout.interface.js";

const round2 = (n: number) => Math.round(n * 100) / 100;

export class CreatorEarningService {
  public constructor(
    private readonly earningRepository = new CreatorEarningRepository(),
    private readonly payoutRepository = new CreatorPayoutRepository(),
    private readonly stripeConnectService = new StripeConnectService(),
    private readonly userRepository = new UserRepository(),
    private readonly notificationService = new NotificationService(),
    private readonly eventRepository = new EventRepository(),
  ) {}

  public async getMyEarnings(user: AuthUser): Promise<CreatorEarningsSummaryResponse> {
    await this.earningRepository.releaseEligibleEarnings(user.id);

    const [earnings, pendingPayouts] = await Promise.all([
      this.earningRepository.findByCreatorUserId(user.id),
      this.payoutRepository.findPendingOrProcessingByCreatorUserId(user.id),
    ]);

    let heldAmount = 0;
    let eligibleAmount = 0;
    let withdrawnAmount = 0;
    let totalEarnedAmount = 0;

    for (const earning of earnings) {
      if (earning.status === "refunded") continue;

      totalEarnedAmount += earning.netAmount;

      if (earning.status === "held") {
        heldAmount += earning.netAmount;
      } else if (earning.status === "eligible") {
        eligibleAmount += earning.netAmount;
      } else if (earning.status === "withdrawn") {
        withdrawnAmount += earning.netAmount;
      }
    }

    const pendingWithdrawalAmount = round2(
      pendingPayouts.reduce((sum, p) => sum + p.totalAmount, 0),
    );

    return {
      heldAmount: round2(heldAmount),
      eligibleAmount: round2(eligibleAmount),
      pendingWithdrawalAmount,
      withdrawnAmount: round2(withdrawnAmount),
      totalEarnedAmount: round2(totalEarnedAmount),
      earnings: earnings.map((e) => this.toEarningResponse(e)),
    };
  }

  public async requestWithdrawal(user: AuthUser, dto: RequestWithdrawalDto): Promise<CreatorPayoutResponse> {
    // 1. Business-profile-only guard
    if (user.accountType !== "business") {
      throw new AppError("Only business accounts can request withdrawals", httpStatus.FORBIDDEN);
    }

    // 2. Load user's preferred withdrawal method from their business profile
    const dbUser = await this.userRepository.findById(user.id);
    const payoutType = dbUser?.businessProfile?.withdrawalMethod ?? "bank_transfer";
    const currency = env.STRIPE_CURRENCY.toLowerCase();

    // 3. Validate Stripe Connect readiness for the requested payout type — immediate feedback before reserving funds
    await this.stripeConnectService.validateReadyForPayout(user.id, payoutType);

    // 4. Duplicate prevention: block if there's already an active payout in flight
    const activePayout = await this.payoutRepository.findPendingOrProcessingByCreatorUserId(user.id);
    if (activePayout.length > 0) {
      throw new AppError(
        "A withdrawal is already in progress. Please wait for it to complete before requesting another.",
        httpStatus.CONFLICT,
        { code: "WITHDRAWAL_IN_PROGRESS" },
      );
    }

    // 5. Release any newly eligible held earnings
    await this.earningRepository.releaseEligibleEarnings(user.id);
    const eligible = await this.earningRepository.findEligibleByCreatorUserId(user.id);

    if (eligible.length === 0) {
      throw new AppError("No eligible earnings available for withdrawal", httpStatus.BAD_REQUEST);
    }

    await this.assertEarningsAreStillWithdrawable(eligible);

    const eligibleTotal = round2(eligible.reduce((s, e) => s + e.netAmount, 0));

    // 6. Select earnings — partial if amount provided, otherwise all
    let selected: ICreatorEarning[];

    if (dto.amount !== undefined) {
      const requestedAmount = round2(dto.amount);

      if (requestedAmount <= 0) {
        throw new AppError("Withdrawal amount must be greater than zero", httpStatus.BAD_REQUEST);
      }
      if (requestedAmount > eligibleTotal) {
        throw new AppError(
          `Requested amount $${requestedAmount.toFixed(2)} exceeds available balance of $${eligibleTotal.toFixed(2)}`,
          httpStatus.BAD_REQUEST,
          { code: "INSUFFICIENT_BALANCE" },
        );
      }

      // Greedy selection: smallest earnings first. Split the final earning if needed
      // so manual withdrawals can request an exact dollar amount.
      const sorted = [...eligible].sort((a, b) => a.netAmount - b.netAmount);
      selected = [];
      let remaining = requestedAmount;

      for (const earning of sorted) {
        if (remaining <= 0) break;

        if (earning.netAmount <= remaining) {
          selected.push(earning);
          remaining = round2(remaining - earning.netAmount);
          continue;
        }

        if (remaining > 0) {
          const splitEarning = await this.earningRepository.splitEligibleEarningForAmount(earning, remaining);
          selected.push(splitEarning);
          remaining = 0;
          break;
        }
      }

      if (selected.length === 0 || remaining > 0) {
        throw new AppError(
          "Unable to reserve the requested withdrawal amount. Please refresh and try again.",
          httpStatus.BAD_REQUEST,
          { code: "WITHDRAWAL_RESERVATION_FAILED" },
        );
      }
    } else {
      selected = eligible;
    }

    const totalAmount = round2(selected.reduce((s, e) => s + e.netAmount, 0));

    if (totalAmount <= 0) {
      throw new AppError("Withdrawal amount must be greater than zero", httpStatus.BAD_REQUEST);
    }

    const earningIds = selected.map((e) => e._id.toString());

    // 6. Create payout record in "pending" state — scheduler processes Stripe transfer asynchronously
    let payout: ICreatorPayout;

    try {
      payout = await this.payoutRepository.create({
        creatorUserId: user.id,
        earningIds,
        totalAmount,
        currency,
        payoutType,
        status: "pending",
        scheduledDate: new Date(),
      });
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        throw new AppError(
          "A withdrawal is already in progress. Please wait for it to complete before requesting another.",
          httpStatus.CONFLICT,
          { code: "WITHDRAWAL_IN_PROGRESS" },
        );
      }

      throw error;
    }

    // 7. Reserve earnings immediately so they can't be double-withdrawn
    await this.earningRepository.markWithdrawn(earningIds, payout._id.toString());

    // 8. Notify creator — fire-and-forget; notification failure must not fail the withdrawal
    this.notificationService.sendSystemNotification(
      user.id,
      "payout_requested",
      `Your withdrawal request of ${currency.toUpperCase()} ${totalAmount.toFixed(2)} has been submitted and will be processed shortly.`,
    ).catch(() => {/* already logged inside NotificationService */});

    return this.toPayoutResponse(payout);
  }

  private async assertEarningsAreStillWithdrawable(earnings: ICreatorEarning[]): Promise<void> {
    const eventIds = [
      ...new Set(
        earnings
          .map((earning) => earning.eventId?.toString())
          .filter((eventId): eventId is string => Boolean(eventId)),
      ),
    ];

    if (eventIds.length === 0) return;

    const events = await this.eventRepository.findManyByIds(eventIds);
    const eventStatusById = new Map(events.map((event) => [event._id.toString(), event.status]));
    const invalidEarning = earnings.find((earning) => {
      const eventId = earning.eventId?.toString();
      return eventId ? eventStatusById.get(eventId) !== "completed" : false;
    });

    if (invalidEarning) {
      throw new AppError(
        "Some earnings are no longer eligible for withdrawal because their event is not completed.",
        httpStatus.CONFLICT,
        { code: "EVENT_EARNING_NOT_WITHDRAWABLE" },
      );
    }
  }

  public async getEarningsByEvent(user: AuthUser, eventId: string): Promise<EventEarningsSummaryResponse> {
    await this.earningRepository.releaseEligibleEarnings(user.id);
    const earnings = await this.earningRepository.findByCreatorUserIdAndEventId(user.id, eventId);

    let grossAmount = 0;
    let platformFeeAmount = 0;
    let netAmount = 0;
    let refundedAmount = 0;
    let ticketNetAmount = 0;
    let productNetAmount = 0;

    for (const earning of earnings) {
      if (earning.status === "refunded") {
        refundedAmount += earning.grossAmount;
        continue;
      }
      grossAmount += earning.grossAmount;
      platformFeeAmount += earning.platformFeeAmount;
      netAmount += earning.netAmount;
      if (earning.itemType === "ticket") {
        ticketNetAmount += earning.netAmount;
      } else {
        productNetAmount += earning.netAmount;
      }
    }

    return {
      grossAmount: round2(grossAmount),
      platformFeeAmount: round2(platformFeeAmount),
      netAmount: round2(netAmount),
      refundedAmount: round2(refundedAmount),
      ticketNetAmount: round2(ticketNetAmount),
      productNetAmount: round2(productNetAmount),
      earnings: earnings.map((e) => this.toEarningResponse(e)),
    };
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

  private toPayoutResponse(payout: ICreatorPayout): CreatorPayoutResponse {
    return {
      id: payout._id.toString(),
      creatorUserId: payout.creatorUserId.toString(),
      earningIds: payout.earningIds.map((id) => id.toString()),
      totalAmount: payout.totalAmount,
      currency: payout.currency ?? "usd",
      payoutType: payout.payoutType,
      status: payout.status,
      scheduledDate: payout.scheduledDate,
      processingStartedAt: payout.processingStartedAt ?? null,
      stripeTransferId: payout.stripeTransferId ?? null,
      failureReason: payout.failureReason ?? null,
      processedAt: payout.processedAt ?? null,
      createdAt: payout.createdAt,
      updatedAt: payout.updatedAt,
    };
  }
}
