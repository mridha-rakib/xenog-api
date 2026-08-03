export const analyticsRangePresets = ["today", "7d", "30d", "custom"] as const;
export type AnalyticsRangePreset = (typeof analyticsRangePresets)[number];

export const analyticsBucketUnits = ["hour", "day", "week", "month"] as const;
export type AnalyticsBucketUnit = (typeof analyticsBucketUnits)[number];

export interface AnalyticsOverviewQuery {
  range?: AnalyticsRangePreset;
  start?: string;
  end?: string;
}

export interface ResolvedAnalyticsRange {
  preset: AnalyticsRangePreset;
  start: Date;
  end: Date;
  comparisonStart: Date;
  comparisonEnd: Date;
  bucket: AnalyticsBucketUnit;
  timezone: "UTC";
}

export interface AnalyticsRangeResponse {
  preset: AnalyticsRangePreset;
  start: string;
  end: string;
  comparisonStart: string;
  comparisonEnd: string;
  timezone: "UTC";
  bucket: AnalyticsBucketUnit;
}

export interface AnalyticsSummaryResponse {
  totalUsers: number;
  ticketsIssued: number;
  grossTicketSalesMinor: number;
  successfulRefundsMinor: number;
  netTicketRevenueMinor: number;
  currency: string;
}

export interface AnalyticsComparisonResponse {
  usersChangePercentage: number | null;
  ticketsChangePercentage: number | null;
  grossSalesChangePercentage: number | null;
  netRevenueChangePercentage: number | null;
}

export interface AnalyticsRevenueBucketResponse {
  bucketStart: string;
  bucketEnd: string;
  label: string;
  grossTicketSalesMinor: number;
  successfulRefundsMinor: number;
  netTicketRevenueMinor: number;
}

export interface AnalyticsTicketDistributionResponse {
  fullPricePaid: number;
  discounted: number;
  free: number;
  rewardedOrBonus: number;
}

export interface AnalyticsUserBucketResponse {
  bucketStart: string;
  bucketEnd: string;
  label: string;
  newUsers: number;
}

export interface AnalyticsUserMetricsResponse {
  newUsers: number;
  series: AnalyticsUserBucketResponse[];
}

export interface AnalyticsOverviewResponse {
  range: AnalyticsRangeResponse;
  summary: AnalyticsSummaryResponse;
  comparison: AnalyticsComparisonResponse;
  revenueSeries: AnalyticsRevenueBucketResponse[];
  ticketDistribution: AnalyticsTicketDistributionResponse;
  userMetrics: AnalyticsUserMetricsResponse;
}

/** A time bucket resolved server-side before any data is queried, so every
 *  bucket — even one with no matching data — always appears in the response. */
export interface AnalyticsBucket {
  start: Date;
  end: Date;
  label: string;
}

/** A single aggregated row at the finest granularity actually queried
 *  (`hour` for the "today" preset, `day` for everything else); the service
 *  merges these into the coarser `AnalyticsBucket`s (week/month) by summing
 *  rows whose `bucketStart` falls inside each final bucket's range. */
export interface AnalyticsSeriesRow {
  bucketStart: Date;
  amountMinor: number;
}

export interface AnalyticsUserSeriesRow {
  bucketStart: Date;
  count: number;
}
