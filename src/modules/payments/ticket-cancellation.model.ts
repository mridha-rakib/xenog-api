import { Schema, model } from "mongoose";
import type { CancellationAuditEntry } from "./event-cancellation-refund.interface.js";
import {
  ticketCancellationRefundStatuses,
  ticketCancellationSourceTypes,
  ticketCancellationStatuses,
  ticketCancellationStepStatuses,
  type ITicketCancellation,
  type TicketCancellationNotificationState,
} from "./ticket-cancellation.interface.js";

const auditEntrySchema = new Schema<CancellationAuditEntry>(
  {
    action: { type: String, required: true },
    actorUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    message: { type: String, trim: true, maxlength: 500, default: null },
    metadata: { type: Schema.Types.Mixed, default: null },
    createdAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const notificationStateSchema = new Schema<TicketCancellationNotificationState>(
  {
    buyerAcceptedSentAt: { type: Date, default: null },
    buyerRefundProcessingSentAt: { type: Date, default: null },
    buyerRefundCompletedSentAt: { type: Date, default: null },
    buyerNeedsAttentionSentAt: { type: Date, default: null },
    recipientSentAt: { type: Date, default: null },
    hostSentAt: { type: Date, default: null },
  },
  { _id: false },
);

const ticketCancellationSchema = new Schema<ITicketCancellation>(
  {
    sourceType: {
      type: String,
      enum: ticketCancellationSourceTypes,
      required: true,
      default: "user_ticket_cancellation",
      index: true,
    },
    eventId: { type: Schema.Types.ObjectId, ref: "Event", required: true, index: true },
    ticketId: { type: String, required: true, trim: true, maxlength: 80, index: true },
    orderId: { type: Schema.Types.ObjectId, ref: "CheckoutOrder", required: true, index: true },
    ticketIndex: { type: Number, required: true, min: 1 },
    buyerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    hostUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    sharedRecipientUserId: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    activeShareId: { type: Schema.Types.ObjectId, ref: "TicketShare", default: null },
    eventName: { type: String, trim: true, maxlength: 180, default: null },
    ticketName: { type: String, trim: true, maxlength: 180, default: null },
    ticketType: { type: String, enum: ["paid", "free", "rewarded"], default: null, index: true },
    status: { type: String, enum: ticketCancellationStatuses, required: true, default: "cancelled", index: true },
    refundStatus: {
      type: String,
      enum: ticketCancellationRefundStatuses,
      required: true,
      default: "not_required",
      index: true,
    },
    currency: { type: String, lowercase: true, trim: true, minlength: 3, maxlength: 3, required: true },
    stripePaymentIntentId: { type: String, trim: true, default: null, index: true },
    stripeRefundId: { type: String, trim: true, default: null },
    providerIdempotencyKey: { type: String, required: true, trim: true, unique: true, index: true },
    providerStatus: { type: String, trim: true, maxlength: 120, default: null },
    ticketSubtotalAmountMinor: { type: Number, required: true, min: 0, default: 0 },
    platformFeeAmountMinor: { type: Number, required: true, min: 0, default: 0 },
    taxAmountMinor: { type: Number, required: true, min: 0, default: 0 },
    discountAmountMinor: { type: Number, required: true, min: 0, default: 0 },
    requestedAmountMinor: { type: Number, required: true, min: 0, default: 0 },
    completedAmountMinor: { type: Number, required: true, min: 0, default: 0 },
    remainingRefundableAmountMinor: { type: Number, required: true, min: 0, default: 0 },
    orderCapturedAmountMinor: { type: Number, required: true, min: 0, default: 0 },
    previousCancellationAmountMinor: { type: Number, required: true, min: 0, default: 0 },
    capacityReleaseStatus: {
      type: String,
      enum: ticketCancellationStepStatuses,
      required: true,
      default: "pending",
      index: true,
    },
    shareRevocationStatus: {
      type: String,
      enum: ticketCancellationStepStatuses,
      required: true,
      default: "not_required",
    },
    qrInvalidationStatus: {
      type: String,
      enum: ticketCancellationStepStatuses,
      required: true,
      default: "completed",
    },
    creatorEarningAdjustmentStatus: {
      type: String,
      enum: ticketCancellationStepStatuses,
      required: true,
      default: "completed",
    },
    taxReversalStatus: {
      type: String,
      enum: ticketCancellationStepStatuses,
      required: true,
      default: "completed",
    },
    notificationState: { type: notificationStateSchema, required: true, default: {} },
    attemptCount: { type: Number, required: true, min: 0, default: 0 },
    nextRetryAt: { type: Date, default: null, index: true },
    lockedBy: { type: String, trim: true, default: null },
    lockedAt: { type: Date, default: null },
    lockExpiresAt: { type: Date, default: null, index: true },
    lastErrorCode: { type: String, trim: true, maxlength: 120, default: null },
    safeLastErrorMessage: { type: String, trim: true, maxlength: 500, default: null },
    cancellationCutoffAt: { type: Date, required: true },
    cancelledAt: { type: Date, required: true, default: Date.now },
    refundCompletedAt: { type: Date, default: null },
    lastReconciledAt: { type: Date, default: null },
    auditHistory: { type: [auditEntrySchema], default: [] },
  },
  { timestamps: true, versionKey: false },
);

ticketCancellationSchema.index(
  { eventId: 1, ticketId: 1, orderId: 1, ticketIndex: 1 },
  { unique: true },
);
ticketCancellationSchema.index({ buyerUserId: 1, eventId: 1, ticketId: 1 });
ticketCancellationSchema.index({ refundStatus: 1, nextRetryAt: 1, lockExpiresAt: 1 });
ticketCancellationSchema.index({ requestedAmountMinor: 1, createdAt: -1, _id: -1 });
ticketCancellationSchema.index({ refundStatus: 1, createdAt: -1, _id: -1 });
ticketCancellationSchema.index({ eventId: 1, createdAt: -1, _id: -1 });
ticketCancellationSchema.index({ buyerUserId: 1, createdAt: -1, _id: -1 });
ticketCancellationSchema.index({ orderId: 1, ticketIndex: 1, createdAt: -1, _id: -1 });
ticketCancellationSchema.index(
  { stripeRefundId: 1 },
  { unique: true, partialFilterExpression: { stripeRefundId: { $type: "string" } } },
);
// Additive: backs the Admin Dashboard Overview's successful-refund aggregation
// ($match on refundStatus + currency, ranged on refundCompletedAt).
ticketCancellationSchema.index({ refundStatus: 1, currency: 1, refundCompletedAt: -1 });
// Additive: backs the Admin Dashboard Overview's User-Cancelled Passes count
// ($match on status, ranged on createdAt).
ticketCancellationSchema.index({ status: 1, createdAt: -1 });

export const TicketCancellationModel = model<ITicketCancellation>(
  "TicketCancellation",
  ticketCancellationSchema,
);

export const ensureTicketCancellationIndexes = async (): Promise<void> => {
  await TicketCancellationModel.syncIndexes();
};
