import type { Types } from "mongoose";

export const eventCancellationReasonTypes = [
  "Schedule conflict",
  "Venue unavailable",
  "Safety concern",
  "Insufficient attendance",
  "Organizer issue",
  "Other",
] as const;
export type EventCancellationReasonType = (typeof eventCancellationReasonTypes)[number];

export const cancellationBatchStatuses = [
  "initializing",
  "pending",
  "processing",
  "partially_completed",
  "completed",
  "needs_attention",
  "aborted",
] as const;
export type CancellationBatchStatus = (typeof cancellationBatchStatuses)[number];

export const cancellationRefundStatuses = [
  "pending",
  "processing",
  "succeeded",
  "failed_retryable",
  "failed_terminal",
  "reconciliation_required",
] as const;
export type CancellationRefundStatus = (typeof cancellationRefundStatuses)[number];

export type CancellationAuditAction =
  | "batch_created"
  | "batch_initialized"
  | "batch_initialization_completed"
  | "batch_aborted"
  | "batch_resumed"
  | "workflow_recovered"
  | "refund_item_created"
  | "refund_claimed"
  | "stripe_refund_requested"
  | "stripe_refund_confirmed"
  | "refund_retry_scheduled"
  | "refund_terminal_failure"
  | "webhook_received"
  | "webhook_deduplicated"
  | "late_payment_detected"
  | "passes_invalidated"
  | "notification_sent"
  | "reconciliation_completed"
  | "admin_retry"
  | "admin_reconcile"
  | "legacy_payout_anomaly"
  | "tax_reversal_created"
  | "tax_reversal_completed"
  | "tax_reversal_mismatch";

export const CANCELLATION_WORKFLOW_VERSION = 2;

export const taxReversalStatuses = ["pending", "completed", "mismatch", "not_applicable"] as const;
export type TaxReversalStatus = (typeof taxReversalStatuses)[number];

export interface CancellationAuditEntry {
  action: CancellationAuditAction;
  actorUserId?: Types.ObjectId | null;
  message?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
}

export interface IEventCancellationBatch {
  _id: Types.ObjectId;
  eventId: Types.ObjectId;
  hostUserId: Types.ObjectId;
  actorUserId: Types.ObjectId;
  cancellationOperationId: string;
  workflowVersion: number;
  reasonType: EventCancellationReasonType;
  customReason?: string | null;
  displayReason: string;
  status: CancellationBatchStatus;
  totalEligibleOrders: number;
  pendingCount: number;
  processingCount: number;
  succeededCount: number;
  failedRetryableCount: number;
  needsAttentionCount: number;
  totalRequestedAmountMinor: number;
  totalCompletedAmountMinor: number;
  currencySummaries: Record<string, { requestedAmountMinor: number; completedAmountMinor: number }>;
  processingStartedAt?: Date | null;
  completedAt?: Date | null;
  lastReconciledAt?: Date | null;
  lastErrorSummary?: string | null;
  legacyPayoutAnomaly: boolean;
  auditHistory: CancellationAuditEntry[];
  createdAt: Date;
  updatedAt: Date;
}

export interface IEventCancellationTaxReversal {
  _id: Types.ObjectId;
  eventId: Types.ObjectId;
  batchId: Types.ObjectId;
  refundItemId: Types.ObjectId;
  checkoutOrderId: Types.ObjectId;
  originalTaxAmountMinor: number;
  reversedTaxAmountMinor: number;
  currency: string;
  status: TaxReversalStatus;
  reason: string;
  completedAt?: Date | null;
  auditHistory: CancellationAuditEntry[];
  createdAt: Date;
  updatedAt: Date;
}

export interface IEventCancellationRefund {
  _id: Types.ObjectId;
  eventId: Types.ObjectId;
  batchId: Types.ObjectId;
  checkoutOrderId: Types.ObjectId;
  originalPayerUserId: Types.ObjectId;
  stripePaymentIntentId?: string | null;
  stripeRefundId?: string | null;
  providerIdempotencyKey: string;
  currency: string;
  originalCapturedAmountMinor: number;
  previouslyRefundedAmountMinor: number;
  requestedAmountMinor: number;
  completedAmountMinor: number;
  remainingRefundableAmountMinor: number;
  status: CancellationRefundStatus;
  attemptCount: number;
  nextRetryAt?: Date | null;
  lockedBy?: string | null;
  lockedAt?: Date | null;
  lockExpiresAt?: Date | null;
  lastErrorCode?: string | null;
  safeLastErrorMessage?: string | null;
  providerStatus?: string | null;
  paymentMethodLabel?: string | null;
  notificationState: {
    processingSentAt?: Date | null;
    completedSentAt?: Date | null;
    needsAttentionSentAt?: Date | null;
    sharedRecipientsSentAt?: Date | null;
  };
  processingStartedAt?: Date | null;
  completedAt?: Date | null;
  lastReconciledAt?: Date | null;
  auditHistory: CancellationAuditEntry[];
  createdAt: Date;
  updatedAt: Date;
}

export interface IStripeWebhookEvent {
  _id: Types.ObjectId;
  stripeEventId: string;
  eventType: string;
  processedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CancelEventDto {
  reasonType: EventCancellationReasonType;
  customReason?: string | null;
}

export interface CancellationRefundItemResponse {
  id: string;
  eventId: string;
  batchId: string;
  checkoutOrderId: string;
  originalPayerUserId: string;
  stripePaymentIntentId?: string | null;
  stripeRefundId?: string | null;
  currency: string;
  originalCapturedAmountMinor: number;
  previouslyRefundedAmountMinor: number;
  requestedAmountMinor: number;
  completedAmountMinor: number;
  remainingRefundableAmountMinor: number;
  status: CancellationRefundStatus;
  attemptCount: number;
  nextRetryAt?: Date | null;
  lastErrorCode?: string | null;
  safeLastErrorMessage?: string | null;
  providerStatus?: string | null;
  paymentMethodLabel?: string | null;
  taxReversal?: {
    id: string;
    originalTaxAmountMinor: number;
    reversedTaxAmountMinor: number;
    currency: string;
    status: TaxReversalStatus;
    completedAt?: Date | null;
  } | null;
  notificationState: IEventCancellationRefund["notificationState"];
  auditHistory: CancellationAuditEntry[];
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date | null;
}

export interface CancellationBatchResponse {
  id: string;
  eventId: string;
  hostUserId: string;
  actorUserId: string;
  cancellationOperationId: string;
  workflowVersion: number;
  reasonType: EventCancellationReasonType;
  customReason?: string | null;
  displayReason: string;
  status: CancellationBatchStatus;
  totalEligibleOrders: number;
  pendingCount: number;
  processingCount: number;
  succeededCount: number;
  failedRetryableCount: number;
  needsAttentionCount: number;
  totalRequestedAmountMinor: number;
  totalCompletedAmountMinor: number;
  currencySummaries: Record<string, { requestedAmountMinor: number; completedAmountMinor: number }>;
  processingStartedAt?: Date | null;
  completedAt?: Date | null;
  lastReconciledAt?: Date | null;
  lastErrorSummary?: string | null;
  legacyPayoutAnomaly: boolean;
  auditHistory: CancellationAuditEntry[];
  createdAt: Date;
  updatedAt: Date;
}

export interface CancelEventResult {
  event: unknown;
  refundBatch: CancellationBatchResponse;
}
