import type { FilterQuery, UpdateQuery } from "mongoose";
import {
  EventCancellationBatchModel,
  EventCancellationRefundModel,
  EventCancellationTaxReversalModel,
  StripeWebhookEventModel,
} from "./event-cancellation-refund.model.js";
import type {
  CancellationAuditEntry,
  CancellationBatchStatus,
  CancellationRefundStatus,
  EventCancellationReasonType,
  IEventCancellationBatch,
  IEventCancellationRefund,
  IEventCancellationTaxReversal,
} from "./event-cancellation-refund.interface.js";

type CreateBatchPayload = {
  eventId: string;
  hostUserId: string;
  actorUserId: string;
  reasonType: EventCancellationReasonType;
  customReason?: string | null;
  displayReason: string;
  cancellationOperationId?: string;
  workflowVersion?: number;
  status?: CancellationBatchStatus;
};

type UpsertRefundPayload = {
  eventId: string;
  batchId: string;
  checkoutOrderId: string;
  originalPayerUserId: string;
  stripePaymentIntentId?: string | null;
  providerIdempotencyKey: string;
  currency: string;
  originalCapturedAmountMinor: number;
  requestedAmountMinor: number;
  paymentMethodLabel?: string | null;
};

type UpsertTaxReversalPayload = {
  eventId: string;
  batchId: string;
  refundItemId: string;
  checkoutOrderId: string;
  originalTaxAmountMinor: number;
  reversedTaxAmountMinor: number;
  currency: string;
  reason: string;
};

const audit = (
  action: CancellationAuditEntry["action"],
  actorUserId?: string | null,
  message?: string | null,
  metadata?: Record<string, unknown> | null,
): CancellationAuditEntry => ({
  action,
  actorUserId: actorUserId ? (actorUserId as never) : null,
  message: message ?? null,
  metadata: metadata ?? null,
  createdAt: new Date(),
});

export class EventCancellationRefundRepository {
  public async createOrGetBatch(payload: CreateBatchPayload): Promise<IEventCancellationBatch> {
    const created = await EventCancellationBatchModel.findOneAndUpdate(
      { eventId: payload.eventId },
      {
        $setOnInsert: {
          ...payload,
          cancellationOperationId: payload.cancellationOperationId ?? `legacy-${payload.eventId}`,
          workflowVersion: payload.workflowVersion ?? 1,
          status: payload.status ?? "pending",
          totalEligibleOrders: 0,
          pendingCount: 0,
          processingCount: 0,
          succeededCount: 0,
          failedRetryableCount: 0,
          needsAttentionCount: 0,
          totalRequestedAmountMinor: 0,
          totalCompletedAmountMinor: 0,
          currencySummaries: {},
          legacyPayoutAnomaly: false,
          auditHistory: [
            audit(
              payload.status === "initializing" ? "batch_initialized" : "batch_created",
              payload.actorUserId,
              payload.status === "initializing" ? "Cancellation batch initialized" : "Cancellation batch created",
            ),
          ],
        },
      },
      { new: true, upsert: true, runValidators: true },
    );

    return created;
  }

  public async markBatchPending(batchId: string, actorUserId?: string | null): Promise<IEventCancellationBatch | null> {
    return EventCancellationBatchModel.findByIdAndUpdate(
      batchId,
      {
        $set: { status: "pending", lastErrorSummary: null },
        $push: { auditHistory: audit("batch_initialization_completed", actorUserId, "Cancellation workflow initialization completed") },
      },
      { new: true, runValidators: true },
    );
  }

  public async markBatchAborted(batchId: string, actorUserId: string, message: string): Promise<IEventCancellationBatch | null> {
    return EventCancellationBatchModel.findByIdAndUpdate(
      batchId,
      {
        $set: { status: "aborted", lastErrorSummary: message.slice(0, 500) },
        $push: { auditHistory: audit("batch_aborted", actorUserId, message) },
      },
      { new: true, runValidators: true },
    );
  }

  public async findBatchByEventId(eventId: string): Promise<IEventCancellationBatch | null> {
    return EventCancellationBatchModel.findOne({ eventId });
  }

  public async findBatchById(batchId: string): Promise<IEventCancellationBatch | null> {
    return EventCancellationBatchModel.findById(batchId);
  }

  public async findBatches(limit = 100): Promise<IEventCancellationBatch[]> {
    return EventCancellationBatchModel.find()
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit);
  }

  public async findInitializingBatches(limit = 50): Promise<IEventCancellationBatch[]> {
    return EventCancellationBatchModel.find({ status: "initializing", workflowVersion: { $gte: 2 } })
      .sort({ updatedAt: 1, _id: 1 })
      .limit(limit);
  }

  public async upsertRefundItem(payload: UpsertRefundPayload): Promise<IEventCancellationRefund> {
    const item = await EventCancellationRefundModel.findOneAndUpdate(
      { eventId: payload.eventId, checkoutOrderId: payload.checkoutOrderId },
      {
        $setOnInsert: {
          ...payload,
          previouslyRefundedAmountMinor: 0,
          completedAmountMinor: 0,
          remainingRefundableAmountMinor: payload.requestedAmountMinor,
          status: payload.requestedAmountMinor > 0 ? "pending" : "succeeded",
          attemptCount: 0,
          nextRetryAt: new Date(),
          notificationState: {},
          completedAt: payload.requestedAmountMinor > 0 ? null : new Date(),
          auditHistory: [audit("refund_item_created", null, "Refund item created")],
        },
      },
      { new: true, upsert: true, runValidators: true },
    );

    return item;
  }

  public async findRefundItemsByBatchId(batchId: string): Promise<IEventCancellationRefund[]> {
    return EventCancellationRefundModel.find({ batchId }).sort({ createdAt: 1, _id: 1 });
  }

  public async findRefundItemsByEventId(eventId: string): Promise<IEventCancellationRefund[]> {
    return EventCancellationRefundModel.find({ eventId }).sort({ createdAt: 1, _id: 1 });
  }

  public async findRefundItemsByOrderIds(orderIds: string[]): Promise<IEventCancellationRefund[]> {
    return orderIds.length > 0
      ? EventCancellationRefundModel.find({ checkoutOrderId: { $in: orderIds } }).sort({ createdAt: -1, _id: -1 })
      : [];
  }

  public async findRefundItemById(refundId: string): Promise<IEventCancellationRefund | null> {
    return EventCancellationRefundModel.findById(refundId);
  }

  public async findRefundItemByStripeRefundId(stripeRefundId: string): Promise<IEventCancellationRefund | null> {
    return EventCancellationRefundModel.findOne({ stripeRefundId });
  }

  public async findRefundItemsByPaymentIntentId(paymentIntentId: string): Promise<IEventCancellationRefund[]> {
    return EventCancellationRefundModel.find({ stripePaymentIntentId: paymentIntentId }).sort({ createdAt: -1 });
  }

  public async claimNextRefundItem(workerId: string, lockMs: number): Promise<IEventCancellationRefund | null> {
    const now = new Date();
    const lockExpiresAt = new Date(now.getTime() + lockMs);
    const query: FilterQuery<IEventCancellationRefund> = {
      $or: [
        { status: { $in: ["pending", "failed_retryable"] }, $or: [{ nextRetryAt: null }, { nextRetryAt: { $lte: now } }] },
        { status: "processing", lockExpiresAt: { $lte: now } },
      ],
    };

    return EventCancellationRefundModel.findOneAndUpdate(
      query,
      {
        $set: {
          status: "processing",
          lockedBy: workerId,
          lockedAt: now,
          lockExpiresAt,
          processingStartedAt: now,
        },
        $inc: { attemptCount: 1 },
        $push: { auditHistory: audit("refund_claimed", null, "Refund item claimed", { workerId }) },
      },
      { new: true, sort: { nextRetryAt: 1, createdAt: 1 } },
    );
  }

  public async updateRefundItem(
    refundId: string,
    update: UpdateQuery<IEventCancellationRefund>,
  ): Promise<IEventCancellationRefund | null> {
    return EventCancellationRefundModel.findByIdAndUpdate(refundId, update, { new: true, runValidators: true });
  }

  public async upsertTaxReversal(payload: UpsertTaxReversalPayload): Promise<IEventCancellationTaxReversal> {
    return EventCancellationTaxReversalModel.findOneAndUpdate(
      { refundItemId: payload.refundItemId },
      {
        $setOnInsert: {
          ...payload,
          status: payload.reversedTaxAmountMinor > 0 ? "pending" : "not_applicable",
          completedAt: payload.reversedTaxAmountMinor > 0 ? null : new Date(),
          auditHistory: [audit("tax_reversal_created", null, "Internal tax reversal record created")],
        },
      },
      { new: true, upsert: true, runValidators: true },
    );
  }

  public async markTaxReversalCompleted(refundItemId: string): Promise<IEventCancellationTaxReversal | null> {
    return EventCancellationTaxReversalModel.findOneAndUpdate(
      { refundItemId },
      {
        $set: { status: "completed", completedAt: new Date() },
        $push: { auditHistory: audit("tax_reversal_completed", null, "Internal tax reversal completed with refund") },
      },
      { new: true, runValidators: true },
    );
  }

  public async findTaxReversalsByRefundItemIds(refundItemIds: string[]): Promise<IEventCancellationTaxReversal[]> {
    return refundItemIds.length > 0
      ? EventCancellationTaxReversalModel.find({ refundItemId: { $in: refundItemIds } })
      : [];
  }

  public async markWebhookProcessed(stripeEventId: string, eventType: string): Promise<boolean> {
    try {
      await StripeWebhookEventModel.create({ stripeEventId, eventType, processedAt: new Date() });
      return true;
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        return false;
      }

      throw error;
    }
  }

  public async findNonFinalRefunds(limit = 50): Promise<IEventCancellationRefund[]> {
    return EventCancellationRefundModel.find({
      status: { $in: ["pending", "processing", "failed_retryable", "reconciliation_required"] },
    })
      .sort({ updatedAt: 1, _id: 1 })
      .limit(limit);
  }

  public async recalculateBatch(batchId: string): Promise<IEventCancellationBatch | null> {
    const items = await EventCancellationRefundModel.find({ batchId });
    const currencySummaries: Record<string, { requestedAmountMinor: number; completedAmountMinor: number }> = {};
    let pendingCount = 0;
    let processingCount = 0;
    let succeededCount = 0;
    let failedRetryableCount = 0;
    let needsAttentionCount = 0;
    let totalRequestedAmountMinor = 0;
    let totalCompletedAmountMinor = 0;

    for (const item of items) {
      totalRequestedAmountMinor += item.requestedAmountMinor;
      totalCompletedAmountMinor += item.completedAmountMinor;

      const summary = currencySummaries[item.currency] ?? { requestedAmountMinor: 0, completedAmountMinor: 0 };
      summary.requestedAmountMinor += item.requestedAmountMinor;
      summary.completedAmountMinor += item.completedAmountMinor;
      currencySummaries[item.currency] = summary;

      if (item.status === "pending") pendingCount += 1;
      else if (item.status === "processing") processingCount += 1;
      else if (item.status === "succeeded") succeededCount += 1;
      else if (item.status === "failed_retryable") failedRetryableCount += 1;
      else needsAttentionCount += 1;
    }

    let status: CancellationBatchStatus = "pending";
    if (needsAttentionCount > 0) status = "needs_attention";
    else if (processingCount > 0) status = "processing";
    else if (failedRetryableCount > 0) status = "partially_completed";
    else if (items.length > 0 && succeededCount === items.length) status = "completed";
    else if (succeededCount > 0) status = "partially_completed";

    const completedAt = status === "completed" ? new Date() : null;

    return EventCancellationBatchModel.findByIdAndUpdate(
      batchId,
      {
        $set: {
          ...(items.length > 0 ? { status } : {}),
          totalEligibleOrders: items.length,
          pendingCount,
          processingCount,
          succeededCount,
          failedRetryableCount,
          needsAttentionCount,
          totalRequestedAmountMinor,
          totalCompletedAmountMinor,
          currencySummaries,
          ...(status === "processing" ? { processingStartedAt: new Date() } : {}),
          ...(completedAt ? { completedAt } : {}),
        },
      },
      { new: true, runValidators: true },
    );
  }

  public async appendBatchAudit(
    batchId: string,
    action: CancellationAuditEntry["action"],
    actorUserId?: string | null,
    message?: string | null,
    metadata?: Record<string, unknown> | null,
  ): Promise<void> {
    await EventCancellationBatchModel.updateOne(
      { _id: batchId },
      { $push: { auditHistory: audit(action, actorUserId, message, metadata) } },
    );
  }

  public async setBatchAnomaly(batchId: string, message: string): Promise<void> {
    await EventCancellationBatchModel.updateOne(
      { _id: batchId },
      {
        $set: { legacyPayoutAnomaly: true, status: "needs_attention", lastErrorSummary: message.slice(0, 500) },
        $push: { auditHistory: audit("legacy_payout_anomaly", null, message) },
      },
    );
  }

  public async updateManyByBatch(
    batchId: string,
    statuses: CancellationRefundStatus[],
    update: UpdateQuery<IEventCancellationRefund>,
  ): Promise<void> {
    await EventCancellationRefundModel.updateMany({ batchId, status: { $in: statuses } }, update);
  }
}
