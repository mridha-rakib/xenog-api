import type { Types } from "mongoose";
import type { CancellationAuditEntry } from "./event-cancellation-refund.interface.js";

export const ticketCancellationSourceTypes = ["user_ticket_cancellation"] as const;
export type TicketCancellationSourceType = (typeof ticketCancellationSourceTypes)[number];

export const ticketCancellationStatuses = ["cancelled", "needs_attention"] as const;
export type TicketCancellationStatus = (typeof ticketCancellationStatuses)[number];

export const ticketCancellationRefundStatuses = [
  "not_required",
  "pending",
  "processing",
  "succeeded",
  "failed_retryable",
  "failed_terminal",
  "reconciliation_required",
] as const;
export type TicketCancellationRefundStatus = (typeof ticketCancellationRefundStatuses)[number];

export const ticketCancellationStepStatuses = ["not_required", "pending", "completed", "failed"] as const;
export type TicketCancellationStepStatus = (typeof ticketCancellationStepStatuses)[number];

export type TicketCancellationDisabledReason =
  | "eligible"
  | "cutoff_reached"
  | "already_used"
  | "already_cancelled"
  | "refund_processing"
  | "refund_needs_attention"
  | "not_original_buyer"
  | "event_cancelled"
  | "payment_not_eligible"
  | "invalid_pass";

export interface TicketCancellationNotificationState {
  buyerAcceptedSentAt?: Date | null;
  buyerRefundProcessingSentAt?: Date | null;
  buyerRefundCompletedSentAt?: Date | null;
  buyerNeedsAttentionSentAt?: Date | null;
  recipientSentAt?: Date | null;
  hostSentAt?: Date | null;
}

export interface ITicketCancellation {
  _id: Types.ObjectId;
  sourceType: TicketCancellationSourceType;
  eventId: Types.ObjectId;
  ticketId: string;
  orderId: Types.ObjectId;
  ticketIndex: number;
  buyerUserId: Types.ObjectId;
  hostUserId: Types.ObjectId;
  sharedRecipientUserId?: Types.ObjectId | null;
  activeShareId?: Types.ObjectId | null;
  eventName?: string | null;
  ticketName?: string | null;
  ticketType?: "paid" | "free" | "rewarded" | null;
  status: TicketCancellationStatus;
  refundStatus: TicketCancellationRefundStatus;
  currency: string;
  stripePaymentIntentId?: string | null;
  stripeRefundId?: string | null;
  providerIdempotencyKey: string;
  providerStatus?: string | null;
  ticketSubtotalAmountMinor: number;
  platformFeeAmountMinor: number;
  taxAmountMinor: number;
  discountAmountMinor: number;
  requestedAmountMinor: number;
  completedAmountMinor: number;
  remainingRefundableAmountMinor: number;
  orderCapturedAmountMinor: number;
  previousCancellationAmountMinor: number;
  capacityReleaseStatus: TicketCancellationStepStatus;
  shareRevocationStatus: TicketCancellationStepStatus;
  qrInvalidationStatus: TicketCancellationStepStatus;
  creatorEarningAdjustmentStatus: TicketCancellationStepStatus;
  taxReversalStatus: TicketCancellationStepStatus;
  notificationState: TicketCancellationNotificationState;
  attemptCount: number;
  nextRetryAt?: Date | null;
  lockedBy?: string | null;
  lockedAt?: Date | null;
  lockExpiresAt?: Date | null;
  lastErrorCode?: string | null;
  safeLastErrorMessage?: string | null;
  cancellationCutoffAt: Date;
  cancelledAt: Date;
  refundCompletedAt?: Date | null;
  lastReconciledAt?: Date | null;
  auditHistory: CancellationAuditEntry[];
  createdAt: Date;
  updatedAt: Date;
}

export interface CancelTicketPassDto {
  eventId: string;
  ticketId: string;
  orderId: string;
  ticketIndex: number;
}

export interface TicketCancellationEligibilityResponse {
  canCancel: boolean;
  cancellationCutoffAt?: Date | null;
  serverNow: Date;
  disabledReason: TicketCancellationDisabledReason;
  disabledMessage?: string | null;
  cancellationStatus?: TicketCancellationStatus | null;
  refundStatus?: TicketCancellationRefundStatus | null;
  qrAvailable: boolean;
  isOriginalBuyer: boolean;
  isShared: boolean;
  isRecipientOnly: boolean;
}

export interface TicketCancellationResponse {
  id: string;
  sourceType: TicketCancellationSourceType;
  eventId: string;
  ticketId: string;
  orderId: string;
  ticketIndex: number;
  buyerUserId: string;
  buyer?: {
    id: string;
    name?: string | null;
    email?: string | null;
    username?: string | null;
  } | null;
  hostUserId: string;
  sharedRecipientUserId?: string | null;
  eventName?: string | null;
  ticketName?: string | null;
  ticketType?: "paid" | "free" | "rewarded" | null;
  status: TicketCancellationStatus;
  refundStatus: TicketCancellationRefundStatus;
  currency: string;
  stripePaymentIntentId?: string | null;
  stripeRefundId?: string | null;
  requestedAmountMinor: number;
  completedAmountMinor: number;
  remainingRefundableAmountMinor: number;
  ticketSubtotalAmountMinor: number;
  platformFeeAmountMinor: number;
  taxAmountMinor: number;
  discountAmountMinor: number;
  capacityReleaseStatus: TicketCancellationStepStatus;
  shareRevocationStatus: TicketCancellationStepStatus;
  qrInvalidationStatus: TicketCancellationStepStatus;
  attemptCount: number;
  nextRetryAt?: Date | null;
  lastErrorCode?: string | null;
  safeLastErrorMessage?: string | null;
  providerStatus?: string | null;
  cancellationCutoffAt: Date;
  cancelledAt: Date;
  refundCompletedAt?: Date | null;
  notificationState?: TicketCancellationNotificationState | null;
  auditHistory: CancellationAuditEntry[];
  canRetry?: boolean;
  canReconcile?: boolean;
  canResume?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListAdminTicketCancellationsQuery {
  page?: number;
  limit?: number;
  status?: TicketCancellationStatus;
  refundStatus?: TicketCancellationRefundStatus;
  sourceType?: TicketCancellationSourceType;
  eventId?: string;
  buyerUserId?: string;
  orderId?: string;
  ticketId?: string;
  ticketIndex?: number;
  ticketType?: "paid" | "free" | "rewarded";
  search?: string;
  monetary?: "monetary" | "non_monetary" | "all";
}
