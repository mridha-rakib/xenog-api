import { env } from "../../config/env.js";
import { DashboardRepository } from "./dashboard.repository.js";
import type {
  DashboardOverviewQuery,
  DashboardOverviewResponse,
  DashboardRangePreset,
  ResolvedDashboardRange,
} from "./dashboard.interface.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Non-admin, non-deleted/anonymized users — mirrors the base filter already
 *  used by Admin User Management stats (user.service.ts `activeUserFilter`),
 *  kept independent here since the existing endpoint's contract is not touched. */
const DASHBOARD_USER_BASE_FILTER = {
  role: "user",
  deletedAt: null,
  email: { $not: /@deleted\.local$/i },
};

const startOfUtcDay = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

const changePercentage = (current: number, previous: number): number | null => {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 10000) / 100;
};

export class DashboardService {
  public constructor(private readonly repository = new DashboardRepository()) {}

  public async getOverview(query: DashboardOverviewQuery): Promise<DashboardOverviewResponse> {
    const range = this.resolveRange(query);
    const currency = env.STRIPE_CURRENCY.toLowerCase();
    const current = { start: range.start, end: range.end };
    const previous = { start: range.comparisonStart, end: range.comparisonEnd };

    const [
      userTotals,
      issuanceTotals,
      breakdownRows,
      checkedIn,
      userCancelled,
      ticketCancellationRefunds,
      eventCancellationRefunds,
    ] = await Promise.all([
      this.repository.getUserTotals(DASHBOARD_USER_BASE_FILTER, current, previous),
      this.repository.getTicketIssuanceTotals(currency, current, previous),
      this.repository.getTicketBreakdownRows(currency, current),
      this.repository.getCheckedInCount(current),
      this.repository.getUserCancelledPassCount(current),
      this.repository.getTicketCancellationRefundTotals(currency, current, previous),
      this.repository.getEventCancellationRefundTotals(currency, current, previous),
    ]);

    const ticketTypeByKey = await this.repository.resolveEventTicketTypes(
      breakdownRows.map((row) => ({ eventId: row.eventId, ticketId: row.ticketId })),
    );

    let paid = 0;
    let discounted = 0;
    let free = 0;
    let rewardedOrBonus = 0;

    for (const row of breakdownRows) {
      const ticketType = ticketTypeByKey.get(`${row.eventId}:${row.ticketId}`);
      if (ticketType === "free") {
        free += row.issuedQty;
      } else {
        paid += row.paidQty;
        discounted += row.discountedQty;
        rewardedOrBonus += row.rewardedQty;
      }
    }

    const totalSuccessfulRefundsMinor =
      ticketCancellationRefunds.successful.amountMinor + eventCancellationRefunds.successful.amountMinor;
    const totalSuccessfulRefundCount =
      ticketCancellationRefunds.successful.count + eventCancellationRefunds.successful.count;
    const previousSuccessfulRefundsMinor =
      ticketCancellationRefunds.successfulPrevious.amountMinor
      + eventCancellationRefunds.successfulPrevious.amountMinor;

    const netTicketRevenueMinor = issuanceTotals.currentGrossAmountMinor - totalSuccessfulRefundsMinor;
    const previousNetTicketRevenueMinor =
      issuanceTotals.previousGrossAmountMinor - previousSuccessfulRefundsMinor;

    return {
      range: {
        preset: range.preset,
        start: range.start.toISOString(),
        end: range.end.toISOString(),
        comparisonStart: range.comparisonStart.toISOString(),
        comparisonEnd: range.comparisonEnd.toISOString(),
        timezone: range.timezone,
      },
      users: {
        total: userTotals.total,
        newInPeriod: userTotals.currentNew,
        newInPeriodChangePercentage: changePercentage(userTotals.currentNew, userTotals.previousNew),
      },
      tickets: {
        issued: issuanceTotals.currentIssued,
        issuedChangePercentage: changePercentage(issuanceTotals.currentIssued, issuanceTotals.previousIssued),
        paid,
        discounted,
        free,
        rewardedOrBonus,
        checkedIn,
        userCancelled,
      },
      financials: {
        currency,
        grossTicketSalesMinor: issuanceTotals.currentGrossAmountMinor,
        grossTicketSalesChangePercentage: changePercentage(
          issuanceTotals.currentGrossAmountMinor,
          issuanceTotals.previousGrossAmountMinor,
        ),
        userTicketRefundsMinor: ticketCancellationRefunds.successful.amountMinor,
        userTicketRefundCount: ticketCancellationRefunds.successful.count,
        hostEventCancellationRefundsMinor: eventCancellationRefunds.successful.amountMinor,
        hostEventCancellationRefundCount: eventCancellationRefunds.successful.count,
        totalSuccessfulRefundsMinor,
        totalSuccessfulRefundCount,
        currentPendingRefundsMinor:
          ticketCancellationRefunds.pending.amountMinor + eventCancellationRefunds.pending.amountMinor,
        currentPendingRefundCount:
          ticketCancellationRefunds.pending.count + eventCancellationRefunds.pending.count,
        currentFailedRefundsMinor:
          ticketCancellationRefunds.failed.amountMinor + eventCancellationRefunds.failed.amountMinor,
        currentFailedRefundCount:
          ticketCancellationRefunds.failed.count + eventCancellationRefunds.failed.count,
        currentReconciliationRequiredRefundsMinor:
          ticketCancellationRefunds.reconciliationRequired.amountMinor
          + eventCancellationRefunds.reconciliationRequired.amountMinor,
        currentReconciliationRequiredRefundCount:
          ticketCancellationRefunds.reconciliationRequired.count
          + eventCancellationRefunds.reconciliationRequired.count,
        netTicketRevenueMinor,
        netTicketRevenueChangePercentage: changePercentage(netTicketRevenueMinor, previousNetTicketRevenueMinor),
      },
    };
  }

  private resolveRange(query: DashboardOverviewQuery): ResolvedDashboardRange {
    const preset: DashboardRangePreset = query.range ?? "today";
    const now = new Date();
    let start: Date;
    let end: Date;

    if (preset === "today") {
      start = startOfUtcDay(now);
      end = new Date(start.getTime() + DAY_MS);
    } else if (preset === "7d") {
      end = now;
      start = new Date(end.getTime() - 7 * DAY_MS);
    } else if (preset === "30d") {
      end = now;
      start = new Date(end.getTime() - 30 * DAY_MS);
    } else {
      // "custom" — dashboard.validation.ts guarantees start/end are present,
      // valid YYYY-MM-DD dates, start <= end, and within the max range.
      start = startOfUtcDay(new Date(`${query.start}T00:00:00.000Z`));
      const customEndDay = startOfUtcDay(new Date(`${query.end}T00:00:00.000Z`));
      end = new Date(customEndDay.getTime() + DAY_MS);
    }

    const durationMs = end.getTime() - start.getTime();
    const comparisonEnd = start;
    const comparisonStart = new Date(start.getTime() - durationMs);

    return { preset, start, end, comparisonStart, comparisonEnd, timezone: "UTC" };
  }
}
