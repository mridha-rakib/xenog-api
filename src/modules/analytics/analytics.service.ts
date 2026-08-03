import { env } from "../../config/env.js";
import { AnalyticsRepository } from "./analytics.repository.js";
import type {
  AnalyticsBucket,
  AnalyticsBucketUnit,
  AnalyticsOverviewQuery,
  AnalyticsOverviewResponse,
  AnalyticsRangePreset,
  AnalyticsSeriesRow,
  AnalyticsUserSeriesRow,
  ResolvedAnalyticsRange,
} from "./analytics.interface.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

const CUSTOM_DAILY_MAX_DAYS = 31;
const CUSTOM_WEEKLY_MAX_DAYS = 180;

/** Same non-admin, non-deleted/anonymized base filter as the Dashboard
 *  Overview's `DASHBOARD_USER_BASE_FILTER` (a private constant there, so
 *  duplicated here rather than imported — the shape must stay identical for
 *  Analytics/Dashboard parity, verified by the parity tests). */
const ANALYTICS_USER_BASE_FILTER = {
  role: "user",
  deletedAt: null,
  email: { $not: /@deleted\.local$/i },
};

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const startOfUtcDay = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

const changePercentage = (current: number, previous: number): number | null => {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 10000) / 100;
};

const formatHourLabel = (date: Date): string => `${String(date.getUTCHours()).padStart(2, "0")}:00`;

const formatDayLabel = (date: Date): string => `${MONTH_ABBR[date.getUTCMonth()]} ${date.getUTCDate()}`;

const formatMonthLabel = (date: Date): string => `${MONTH_ABBR[date.getUTCMonth()]} ${date.getUTCFullYear()}`;

const formatWeekLabel = (start: Date, end: Date): string => {
  const inclusiveEnd = new Date(end.getTime() - DAY_MS);
  return `${formatDayLabel(start)} - ${formatDayLabel(inclusiveEnd)}`;
};

/** Fixed-length buckets (hour/day/week) tiling `[start, end)` with no gaps;
 *  the final bucket is clipped to `end`, so it may be shorter than a full
 *  interval (used for the weekly case's "final bucket may be shorter" rule). */
const generateFixedIntervalBuckets = (
  start: Date,
  end: Date,
  intervalMs: number,
  labelFor: (bucketStart: Date, bucketEnd: Date) => string,
): AnalyticsBucket[] => {
  const buckets: AnalyticsBucket[] = [];
  let cursor = start;

  while (cursor.getTime() < end.getTime()) {
    const bucketEnd = new Date(Math.min(cursor.getTime() + intervalMs, end.getTime()));
    buckets.push({ start: cursor, end: bucketEnd, label: labelFor(cursor, bucketEnd) });
    cursor = bucketEnd;
  }

  return buckets;
};

/** UTC calendar-month buckets intersecting `[start, end)`; the first and
 *  last buckets may be partial months when `start`/`end` don't fall on a
 *  month boundary. */
const generateCalendarMonthBuckets = (start: Date, end: Date): AnalyticsBucket[] => {
  const buckets: AnalyticsBucket[] = [];
  let cursor = start;

  while (cursor.getTime() < end.getTime()) {
    const nextMonthStart = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    const bucketEnd = new Date(Math.min(nextMonthStart.getTime(), end.getTime()));
    buckets.push({ start: cursor, end: bucketEnd, label: formatMonthLabel(cursor) });
    cursor = bucketEnd;
  }

  return buckets;
};

const sumAmountInRange = (rows: AnalyticsSeriesRow[], start: Date, end: Date): number => {
  let total = 0;
  for (const row of rows) {
    if (row.bucketStart.getTime() >= start.getTime() && row.bucketStart.getTime() < end.getTime()) {
      total += row.amountMinor;
    }
  }
  return total;
};

const sumCountInRange = (rows: AnalyticsUserSeriesRow[], start: Date, end: Date): number => {
  let total = 0;
  for (const row of rows) {
    if (row.bucketStart.getTime() >= start.getTime() && row.bucketStart.getTime() < end.getTime()) {
      total += row.count;
    }
  }
  return total;
};

export class AnalyticsService {
  public constructor(private readonly repository = new AnalyticsRepository()) {}

  public async getOverview(query: AnalyticsOverviewQuery): Promise<AnalyticsOverviewResponse> {
    const range = this.resolveRange(query);
    const currency = env.STRIPE_CURRENCY.toLowerCase();
    const current = { start: range.start, end: range.end };
    const previous = { start: range.comparisonStart, end: range.comparisonEnd };
    const seriesGranularity: "hour" | "day" = range.bucket === "hour" ? "hour" : "day";
    const buckets = this.generateBuckets(range);

    const [
      userTotals,
      issuanceTotals,
      breakdownRows,
      ticketCancellationRefunds,
      eventCancellationRefunds,
      grossRows,
      userRefundRows,
      hostRefundRows,
      userGrowthRows,
    ] = await Promise.all([
      this.repository.getUserTotals(ANALYTICS_USER_BASE_FILTER, current, previous),
      this.repository.getTicketIssuanceTotals(currency, current, previous),
      this.repository.getTicketBreakdownRows(currency, current),
      this.repository.getTicketCancellationRefundTotals(currency, current, previous),
      this.repository.getEventCancellationRefundTotals(currency, current, previous),
      this.repository.getGrossSalesSeriesRows(currency, current.start, current.end, seriesGranularity),
      this.repository.getUserTicketRefundSeriesRows(currency, current.start, current.end, seriesGranularity),
      this.repository.getHostEventRefundSeriesRows(currency, current.start, current.end, seriesGranularity),
      this.repository.getUserGrowthSeriesRows(ANALYTICS_USER_BASE_FILTER, current.start, current.end, seriesGranularity),
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

    const fullPricePaid = Math.max(0, paid - discounted);

    const totalSuccessfulRefundsMinor =
      ticketCancellationRefunds.successful.amountMinor + eventCancellationRefunds.successful.amountMinor;
    const previousSuccessfulRefundsMinor =
      ticketCancellationRefunds.successfulPrevious.amountMinor
      + eventCancellationRefunds.successfulPrevious.amountMinor;

    const netTicketRevenueMinor = issuanceTotals.currentGrossAmountMinor - totalSuccessfulRefundsMinor;
    const previousNetTicketRevenueMinor =
      issuanceTotals.previousGrossAmountMinor - previousSuccessfulRefundsMinor;

    const revenueSeries = buckets.map((bucket) => {
      const grossTicketSalesMinor = sumAmountInRange(grossRows, bucket.start, bucket.end);
      const successfulRefundsMinor =
        sumAmountInRange(userRefundRows, bucket.start, bucket.end)
        + sumAmountInRange(hostRefundRows, bucket.start, bucket.end);

      return {
        bucketStart: bucket.start.toISOString(),
        bucketEnd: bucket.end.toISOString(),
        label: bucket.label,
        grossTicketSalesMinor,
        successfulRefundsMinor,
        netTicketRevenueMinor: grossTicketSalesMinor - successfulRefundsMinor,
      };
    });

    const userSeries = buckets.map((bucket) => ({
      bucketStart: bucket.start.toISOString(),
      bucketEnd: bucket.end.toISOString(),
      label: bucket.label,
      newUsers: sumCountInRange(userGrowthRows, bucket.start, bucket.end),
    }));

    return {
      range: {
        preset: range.preset,
        start: range.start.toISOString(),
        end: range.end.toISOString(),
        comparisonStart: range.comparisonStart.toISOString(),
        comparisonEnd: range.comparisonEnd.toISOString(),
        timezone: range.timezone,
        bucket: range.bucket,
      },
      summary: {
        totalUsers: userTotals.total,
        ticketsIssued: issuanceTotals.currentIssued,
        grossTicketSalesMinor: issuanceTotals.currentGrossAmountMinor,
        successfulRefundsMinor: totalSuccessfulRefundsMinor,
        netTicketRevenueMinor,
        currency,
      },
      comparison: {
        usersChangePercentage: changePercentage(userTotals.currentNew, userTotals.previousNew),
        ticketsChangePercentage: changePercentage(issuanceTotals.currentIssued, issuanceTotals.previousIssued),
        grossSalesChangePercentage: changePercentage(
          issuanceTotals.currentGrossAmountMinor,
          issuanceTotals.previousGrossAmountMinor,
        ),
        netRevenueChangePercentage: changePercentage(netTicketRevenueMinor, previousNetTicketRevenueMinor),
      },
      revenueSeries,
      ticketDistribution: { fullPricePaid, discounted, free, rewardedOrBonus },
      userMetrics: { newUsers: userTotals.currentNew, series: userSeries },
    };
  }

  private resolveRange(query: AnalyticsOverviewQuery): ResolvedAnalyticsRange {
    const preset: AnalyticsRangePreset = query.range ?? "today";
    const now = new Date();
    let start: Date;
    let end: Date;
    let bucket: AnalyticsBucketUnit;

    if (preset === "today") {
      start = startOfUtcDay(now);
      end = new Date(start.getTime() + DAY_MS);
      bucket = "hour";
    } else if (preset === "7d") {
      end = now;
      start = new Date(end.getTime() - 7 * DAY_MS);
      bucket = "day";
    } else if (preset === "30d") {
      end = now;
      start = new Date(end.getTime() - 30 * DAY_MS);
      bucket = "day";
    } else {
      // "custom" — analytics.validation.ts (reusing dashboard.validation.ts)
      // guarantees start/end are present, valid YYYY-MM-DD dates, start <=
      // end, and within the max 365-day range.
      start = startOfUtcDay(new Date(`${query.start}T00:00:00.000Z`));
      const customEndDay = startOfUtcDay(new Date(`${query.end}T00:00:00.000Z`));
      end = new Date(customEndDay.getTime() + DAY_MS);

      const totalDays = Math.round((end.getTime() - start.getTime()) / DAY_MS);
      if (totalDays <= CUSTOM_DAILY_MAX_DAYS) {
        bucket = "day";
      } else if (totalDays <= CUSTOM_WEEKLY_MAX_DAYS) {
        bucket = "week";
      } else {
        bucket = "month";
      }
    }

    const durationMs = end.getTime() - start.getTime();
    const comparisonEnd = start;
    const comparisonStart = new Date(start.getTime() - durationMs);

    return { preset, start, end, comparisonStart, comparisonEnd, bucket, timezone: "UTC" };
  }

  private generateBuckets(range: ResolvedAnalyticsRange): AnalyticsBucket[] {
    switch (range.bucket) {
      case "hour":
        return generateFixedIntervalBuckets(range.start, range.end, HOUR_MS, (bucketStart) =>
          formatHourLabel(bucketStart));
      case "day":
        return generateFixedIntervalBuckets(range.start, range.end, DAY_MS, (bucketStart) =>
          formatDayLabel(bucketStart));
      case "week":
        return generateFixedIntervalBuckets(range.start, range.end, WEEK_MS, (bucketStart, bucketEnd) =>
          formatWeekLabel(bucketStart, bucketEnd));
      case "month":
        return generateCalendarMonthBuckets(range.start, range.end);
      default:
        return [];
    }
  }
}
