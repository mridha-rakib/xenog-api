import { Schema, model } from "mongoose";
import type {
  CancellationAuditEntry,
  IEventCancellationBatch,
  IEventCancellationRefund,
  IEventCancellationTaxReversal,
  IStripeWebhookEvent,
} from "./event-cancellation-refund.interface.js";
import {
  cancellationBatchStatuses,
  cancellationRefundStatuses,
  eventCancellationReasonTypes,
  taxReversalStatuses,
} from "./event-cancellation-refund.interface.js";

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

const currencySummarySchema = new Schema(
  {
    requestedAmountMinor: { type: Number, required: true, min: 0, default: 0 },
    completedAmountMinor: { type: Number, required: true, min: 0, default: 0 },
  },
  { _id: false },
);

const eventCancellationBatchSchema = new Schema<IEventCancellationBatch>(
  {
    eventId: { type: Schema.Types.ObjectId, ref: "Event", required: true, unique: true, index: true },
    hostUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    actorUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    cancellationOperationId: { type: String, required: true, trim: true, unique: true, index: true },
    workflowVersion: { type: Number, required: true, min: 1, default: 2, index: true },
    reasonType: { type: String, enum: eventCancellationReasonTypes, required: true },
    customReason: { type: String, trim: true, maxlength: 500, default: null },
    displayReason: { type: String, trim: true, maxlength: 500, required: true },
    status: { type: String, enum: cancellationBatchStatuses, required: true, default: "pending", index: true },
    totalEligibleOrders: { type: Number, required: true, min: 0, default: 0 },
    pendingCount: { type: Number, required: true, min: 0, default: 0 },
    processingCount: { type: Number, required: true, min: 0, default: 0 },
    succeededCount: { type: Number, required: true, min: 0, default: 0 },
    failedRetryableCount: { type: Number, required: true, min: 0, default: 0 },
    needsAttentionCount: { type: Number, required: true, min: 0, default: 0 },
    totalRequestedAmountMinor: { type: Number, required: true, min: 0, default: 0 },
    totalCompletedAmountMinor: { type: Number, required: true, min: 0, default: 0 },
    currencySummaries: { type: Map, of: currencySummarySchema, default: {} },
    processingStartedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    lastReconciledAt: { type: Date, default: null },
    lastErrorSummary: { type: String, trim: true, maxlength: 500, default: null },
    legacyPayoutAnomaly: { type: Boolean, required: true, default: false },
    auditHistory: { type: [auditEntrySchema], default: [] },
  },
  { timestamps: true, versionKey: false },
);

const notificationStateSchema = new Schema(
  {
    processingSentAt: { type: Date, default: null },
    completedSentAt: { type: Date, default: null },
    needsAttentionSentAt: { type: Date, default: null },
    sharedRecipientsSentAt: { type: Date, default: null },
  },
  { _id: false },
);

const eventCancellationRefundSchema = new Schema<IEventCancellationRefund>(
  {
    eventId: { type: Schema.Types.ObjectId, ref: "Event", required: true, index: true },
    batchId: { type: Schema.Types.ObjectId, ref: "EventCancellationBatch", required: true, index: true },
    checkoutOrderId: { type: Schema.Types.ObjectId, ref: "CheckoutOrder", required: true, index: true },
    originalPayerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    stripePaymentIntentId: { type: String, trim: true, default: null, index: true },
    stripeRefundId: { type: String, trim: true, default: null },
    providerIdempotencyKey: { type: String, trim: true, required: true, index: true },
    currency: { type: String, lowercase: true, trim: true, minlength: 3, maxlength: 3, required: true },
    originalCapturedAmountMinor: { type: Number, required: true, min: 0 },
    previouslyRefundedAmountMinor: { type: Number, required: true, min: 0, default: 0 },
    requestedAmountMinor: { type: Number, required: true, min: 0 },
    completedAmountMinor: { type: Number, required: true, min: 0, default: 0 },
    remainingRefundableAmountMinor: { type: Number, required: true, min: 0 },
    status: { type: String, enum: cancellationRefundStatuses, required: true, default: "pending", index: true },
    attemptCount: { type: Number, required: true, min: 0, default: 0 },
    nextRetryAt: { type: Date, default: null, index: true },
    lockedBy: { type: String, trim: true, default: null },
    lockedAt: { type: Date, default: null },
    lockExpiresAt: { type: Date, default: null, index: true },
    lastErrorCode: { type: String, trim: true, maxlength: 120, default: null },
    safeLastErrorMessage: { type: String, trim: true, maxlength: 500, default: null },
    providerStatus: { type: String, trim: true, maxlength: 120, default: null },
    paymentMethodLabel: { type: String, trim: true, maxlength: 120, default: null },
    notificationState: { type: notificationStateSchema, required: true, default: {} },
    processingStartedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    lastReconciledAt: { type: Date, default: null },
    auditHistory: { type: [auditEntrySchema], default: [] },
  },
  { timestamps: true, versionKey: false },
);

eventCancellationRefundSchema.index({ eventId: 1, checkoutOrderId: 1 }, { unique: true });
eventCancellationRefundSchema.index({ status: 1, nextRetryAt: 1, lockExpiresAt: 1 });
eventCancellationRefundSchema.index(
  { stripeRefundId: 1 },
  { unique: true, partialFilterExpression: { stripeRefundId: { $type: "string" } } },
);

const eventCancellationTaxReversalSchema = new Schema<IEventCancellationTaxReversal>(
  {
    eventId: { type: Schema.Types.ObjectId, ref: "Event", required: true, index: true },
    batchId: { type: Schema.Types.ObjectId, ref: "EventCancellationBatch", required: true, index: true },
    refundItemId: { type: Schema.Types.ObjectId, ref: "EventCancellationRefund", required: true, unique: true, index: true },
    checkoutOrderId: { type: Schema.Types.ObjectId, ref: "CheckoutOrder", required: true, index: true },
    originalTaxAmountMinor: { type: Number, required: true, min: 0, default: 0 },
    reversedTaxAmountMinor: { type: Number, required: true, min: 0, default: 0 },
    currency: { type: String, lowercase: true, trim: true, minlength: 3, maxlength: 3, required: true },
    status: { type: String, enum: taxReversalStatuses, required: true, default: "pending", index: true },
    reason: { type: String, trim: true, maxlength: 240, required: true },
    completedAt: { type: Date, default: null },
    auditHistory: { type: [auditEntrySchema], default: [] },
  },
  { timestamps: true, versionKey: false },
);

const stripeWebhookEventSchema = new Schema<IStripeWebhookEvent>(
  {
    stripeEventId: { type: String, required: true, trim: true, unique: true, index: true },
    eventType: { type: String, required: true, trim: true },
    processedAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true, versionKey: false },
);

export const EventCancellationBatchModel = model<IEventCancellationBatch>(
  "EventCancellationBatch",
  eventCancellationBatchSchema,
);
export const EventCancellationRefundModel = model<IEventCancellationRefund>(
  "EventCancellationRefund",
  eventCancellationRefundSchema,
);
export const StripeWebhookEventModel = model<IStripeWebhookEvent>(
  "StripeWebhookEvent",
  stripeWebhookEventSchema,
);
export const EventCancellationTaxReversalModel = model<IEventCancellationTaxReversal>(
  "EventCancellationTaxReversal",
  eventCancellationTaxReversalSchema,
);

export const ensureEventCancellationRefundIndexes = async (): Promise<void> => {
  await EventCancellationBatchModel.syncIndexes();
  await EventCancellationRefundModel.syncIndexes();
  await StripeWebhookEventModel.syncIndexes();
  await EventCancellationTaxReversalModel.syncIndexes();
};
