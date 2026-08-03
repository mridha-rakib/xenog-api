export const paymentManagementStatuses = ["paid", "refunded"] as const;
export type PaymentManagementStatus = (typeof paymentManagementStatuses)[number];

export type RefundSummaryStatus = "none" | "partial" | "full";

export interface PaymentManagementQuery {
  page?: number;
  limit?: number;
  search?: string;
  status?: PaymentManagementStatus;
  start?: string;
  end?: string;
}

export interface PaymentManagementUserResponse {
  name: string;
  email: string | null;
  avatarUrl: string | null;
  accountType: "personal" | "business";
}

export interface PaymentManagementRefundSummaryResponse {
  successfulRefundedMinor: number;
  status: RefundSummaryStatus;
}

export interface PaymentManagementItemResponse {
  id: string;
  user: PaymentManagementUserResponse;
  paymentStatus: PaymentManagementStatus;
  paidAt: string;
  amountMinor: number;
  currency: string;
  refundSummary: PaymentManagementRefundSummaryResponse;
}

export interface PaymentManagementPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  from: number;
  to: number;
}

export interface PaymentManagementListResponse {
  items: PaymentManagementItemResponse[];
  pagination: PaymentManagementPagination;
}

/** A captured Ticket order row, before user/refund enrichment. */
export interface CapturedTicketOrderRow {
  id: string;
  userId: string;
  paymentStatus: PaymentManagementStatus;
  paidAt: Date | null;
  amountMinor: number;
  currency: string;
}
