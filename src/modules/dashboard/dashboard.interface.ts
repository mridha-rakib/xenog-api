export const dashboardRangePresets = ["today", "7d", "30d", "custom"] as const;
export type DashboardRangePreset = (typeof dashboardRangePresets)[number];

export interface DashboardOverviewQuery {
  range?: DashboardRangePreset;
  start?: string;
  end?: string;
}

export interface ResolvedDashboardRange {
  preset: DashboardRangePreset;
  start: Date;
  end: Date;
  comparisonStart: Date;
  comparisonEnd: Date;
  timezone: "UTC";
}

export interface DashboardRangeResponse {
  preset: DashboardRangePreset;
  start: string;
  end: string;
  comparisonStart: string;
  comparisonEnd: string;
  timezone: "UTC";
}

export interface DashboardUsersResponse {
  total: number;
  newInPeriod: number;
  newInPeriodChangePercentage: number | null;
}

export interface DashboardTicketsResponse {
  issued: number;
  issuedChangePercentage: number | null;
  paid: number;
  discounted: number;
  free: number;
  rewardedOrBonus: number;
  checkedIn: number;
  userCancelled: number;
}

export interface DashboardFinancialsResponse {
  currency: string;

  grossTicketSalesMinor: number;
  grossTicketSalesChangePercentage: number | null;

  userTicketRefundsMinor: number;
  userTicketRefundCount: number;

  hostEventCancellationRefundsMinor: number;
  hostEventCancellationRefundCount: number;

  totalSuccessfulRefundsMinor: number;
  totalSuccessfulRefundCount: number;

  currentPendingRefundsMinor: number;
  currentPendingRefundCount: number;

  currentFailedRefundsMinor: number;
  currentFailedRefundCount: number;

  currentReconciliationRequiredRefundsMinor: number;
  currentReconciliationRequiredRefundCount: number;

  netTicketRevenueMinor: number;
  netTicketRevenueChangePercentage: number | null;
}

export interface DashboardOverviewResponse {
  range: DashboardRangeResponse;
  users: DashboardUsersResponse;
  tickets: DashboardTicketsResponse;
  financials: DashboardFinancialsResponse;
}

export interface MonetaryPeriodTotal {
  amountMinor: number;
  count: number;
}

export interface TicketIssuanceTotals {
  currentIssued: number;
  previousIssued: number;
  currentGrossAmountMinor: number;
  previousGrossAmountMinor: number;
}

export interface TicketBreakdownRow {
  eventId: string;
  ticketId: string;
  issuedQty: number;
  paidQty: number;
  discountedQty: number;
  rewardedQty: number;
}

export interface RefundStatusTotals {
  successful: MonetaryPeriodTotal;
  successfulPrevious: MonetaryPeriodTotal;
  pending: MonetaryPeriodTotal;
  failed: MonetaryPeriodTotal;
  reconciliationRequired: MonetaryPeriodTotal;
}

export interface DashboardUserTotals {
  total: number;
  currentNew: number;
  previousNew: number;
}
