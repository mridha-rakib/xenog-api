import { CheckoutOrderModel } from "../payments/checkout-payment.model.js";
import { TicketCancellationModel } from "../payments/ticket-cancellation.model.js";
import { EventCancellationRefundModel } from "../payments/event-cancellation-refund.model.js";
import { UserModel } from "../user/user.model.js";
import { DashboardRepository } from "../dashboard/dashboard.repository.js";
import type {
  DashboardUserTotals,
  RefundStatusTotals,
  TicketBreakdownRow,
  TicketIssuanceTotals,
} from "../dashboard/dashboard.interface.js";
import type { AnalyticsSeriesRow, AnalyticsUserSeriesRow } from "./analytics.interface.js";

interface DateWindow {
  start: Date;
  end: Date;
}

type SeriesGranularity = "hour" | "day";

const CAPTURED_TICKET_PAYMENT_STATUSES = ["paid", "refunded"] as const;

/**
 * The Analytics repository composes the existing, already-tested
 * `DashboardRepository` for every non-time-series number (Total Users,
 * Tickets Issued, Gross Ticket Sales, Successful Refunds, ticket
 * classification) rather than re-implementing those aggregations — this is
 * the read-only reuse the Analytics/Dashboard parity requirement calls for:
 * literally the same query logic runs for both surfaces, so they can never
 * silently drift apart. `src/modules/dashboard/**` itself is never modified.
 *
 * Only the bucketed time-series aggregations (revenue/refunds/user-growth
 * over time) are new here, since the Dashboard Overview has no time-series
 * concept at all.
 */
export class AnalyticsRepository {
  private readonly dashboardRepository = new DashboardRepository();

  public async getUserTotals(
    baseFilter: Record<string, unknown>,
    current: DateWindow,
    previous: DateWindow,
  ): Promise<DashboardUserTotals> {
    return this.dashboardRepository.getUserTotals(baseFilter, current, previous);
  }

  public async getTicketIssuanceTotals(
    currency: string,
    current: DateWindow,
    previous: DateWindow,
  ): Promise<TicketIssuanceTotals> {
    return this.dashboardRepository.getTicketIssuanceTotals(currency, current, previous);
  }

  public async getTicketBreakdownRows(currency: string, current: DateWindow): Promise<TicketBreakdownRow[]> {
    return this.dashboardRepository.getTicketBreakdownRows(currency, current);
  }

  public async resolveEventTicketTypes(
    pairs: Array<{ eventId: string; ticketId: string }>,
  ): Promise<Map<string, "free" | "pay">> {
    return this.dashboardRepository.resolveEventTicketTypes(pairs);
  }

  public async getTicketCancellationRefundTotals(
    currency: string,
    current: DateWindow,
    previous: DateWindow,
  ): Promise<RefundStatusTotals> {
    return this.dashboardRepository.getTicketCancellationRefundTotals(currency, current, previous);
  }

  public async getEventCancellationRefundTotals(
    currency: string,
    current: DateWindow,
    previous: DateWindow,
  ): Promise<RefundStatusTotals> {
    return this.dashboardRepository.getEventCancellationRefundTotals(currency, current, previous);
  }

  /** Gross ticket sales, grouped at the finest bucket granularity actually
   *  needed (hour for "today", day for everything else). The service merges
   *  these rows into the final (possibly coarser, week/month) buckets. */
  public async getGrossSalesSeriesRows(
    currency: string,
    start: Date,
    end: Date,
    granularity: SeriesGranularity,
  ): Promise<AnalyticsSeriesRow[]> {
    const rows = await CheckoutOrderModel.aggregate<{ bucketStart: Date; amountMinor: number }>([
      {
        $match: {
          kind: "ticket",
          paymentStatus: { $in: CAPTURED_TICKET_PAYMENT_STATUSES },
          currency,
          paidAt: { $gte: start, $lt: end },
        },
      },
      {
        $group: {
          _id: { $dateTrunc: { date: "$paidAt", unit: granularity, timezone: "UTC" } },
          amountMinor: { $sum: "$amountMinor" },
        },
      },
      { $project: { _id: 0, bucketStart: "$_id", amountMinor: 1 } },
    ]);

    return rows;
  }

  public async getUserTicketRefundSeriesRows(
    currency: string,
    start: Date,
    end: Date,
    granularity: SeriesGranularity,
  ): Promise<AnalyticsSeriesRow[]> {
    const rows = await TicketCancellationModel.aggregate<{ bucketStart: Date; amountMinor: number }>([
      {
        $match: {
          refundStatus: "succeeded",
          currency,
          refundCompletedAt: { $gte: start, $lt: end },
        },
      },
      {
        $group: {
          _id: { $dateTrunc: { date: "$refundCompletedAt", unit: granularity, timezone: "UTC" } },
          amountMinor: { $sum: "$completedAmountMinor" },
        },
      },
      { $project: { _id: 0, bucketStart: "$_id", amountMinor: 1 } },
    ]);

    return rows;
  }

  public async getHostEventRefundSeriesRows(
    currency: string,
    start: Date,
    end: Date,
    granularity: SeriesGranularity,
  ): Promise<AnalyticsSeriesRow[]> {
    const rows = await EventCancellationRefundModel.aggregate<{ bucketStart: Date; amountMinor: number }>([
      {
        $match: {
          status: "succeeded",
          currency,
          completedAt: { $gte: start, $lt: end },
        },
      },
      {
        $group: {
          _id: { $dateTrunc: { date: "$completedAt", unit: granularity, timezone: "UTC" } },
          amountMinor: { $sum: "$completedAmountMinor" },
        },
      },
      { $project: { _id: 0, bucketStart: "$_id", amountMinor: 1 } },
    ]);

    return rows;
  }

  public async getUserGrowthSeriesRows(
    baseFilter: Record<string, unknown>,
    start: Date,
    end: Date,
    granularity: SeriesGranularity,
  ): Promise<AnalyticsUserSeriesRow[]> {
    const rows = await UserModel.aggregate<{ bucketStart: Date; count: number }>([
      { $match: { ...baseFilter, createdAt: { $gte: start, $lt: end } } },
      {
        $group: {
          _id: { $dateTrunc: { date: "$createdAt", unit: granularity, timezone: "UTC" } },
          count: { $sum: 1 },
        },
      },
      { $project: { _id: 0, bucketStart: "$_id", count: 1 } },
    ]);

    return rows;
  }
}
