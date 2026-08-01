import type { Types } from "mongoose";
import type { EventLocation } from "../events/event.interface.js";

export const refundReceiptSourceTypes = ["user_ticket_cancellation", "event_cancellation"] as const;
export type RefundReceiptSourceType = (typeof refundReceiptSourceTypes)[number];

export type RefundReceiptStatus = "pending" | "sending" | "sent" | "failed_retryable" | "failed_terminal";

export interface RefundReceiptItemSnapshot {
  name: string;
  type?: string | null;
  passLabel?: string | null;
  quantity: number;
}

export interface RefundReceiptFinancialSnapshot {
  subtotalAmountMinor?: number | null;
  platformFeeAmountMinor?: number | null;
  taxAmountMinor?: number | null;
  discountAmountMinor?: number | null;
  completedAmountMinor: number;
  requestedAmountMinor: number;
  currency: string;
}

export interface RefundReceiptSnapshot {
  context: "Ticket cancelled by buyer" | "Event cancelled by organizer";
  buyerName: string;
  buyerEmail: string;
  eventName?: string | null;
  eventScheduledAt?: Date | null;
  eventEndAt?: Date | null;
  venue?: EventLocation | null;
  hostName?: string | null;
  supportEmail?: string | null;
  orderReference: string;
  receiptReference: string;
  purchasedAt?: Date | null;
  refundCompletedAt: Date;
  statusLabel: "Refund completed";
  paymentMethod?: string | null;
  items: RefundReceiptItemSnapshot[];
  financial: RefundReceiptFinancialSnapshot;
}

export interface IRefundReceipt {
  _id: Types.ObjectId;
  idempotencyKey: string;
  sourceType: RefundReceiptSourceType;
  sourceRefundId: Types.ObjectId;
  payerUserId: Types.ObjectId;
  toEmail: string;
  receiptReference: string;
  orderReference: string;
  status: RefundReceiptStatus;
  attemptCount: number;
  nextRetryAt?: Date | null;
  lockedAt?: Date | null;
  sentAt?: Date | null;
  lastError?: string | null;
  snapshot: RefundReceiptSnapshot;
  createdAt: Date;
  updatedAt: Date;
}
