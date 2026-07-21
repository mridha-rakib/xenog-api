import { randomUUID } from "node:crypto";
import httpStatus from "http-status";
import Stripe from "stripe";
import { env } from "../../config/env.js";
import { logger } from "../../core/logger/logger.js";
import { AppError } from "../../core/errors/app-error.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { EventRepository } from "../events/event.repository.js";
import type { IEvent } from "../events/event.interface.js";
import type { ICheckoutOrder } from "./checkout-payment.interface.js";
import { CheckoutPaymentRepository } from "./checkout-payment.repository.js";
import { CreatorEarningRepository } from "./creator-earning.repository.js";
import { TicketShareRepository } from "./ticket-share.repository.js";
import { NotificationService } from "../notifications/notification.service.js";
import {
  CANCELLATION_WORKFLOW_VERSION,
  type CancelEventDto,
  type CancellationBatchResponse,
  type CancellationRefundItemResponse,
  type CancellationRefundStatus,
  type EventCancellationReasonType,
  eventCancellationReasonTypes,
  type IEventCancellationBatch,
  type IEventCancellationRefund,
  type IEventCancellationTaxReversal,
} from "./event-cancellation-refund.interface.js";
import { EventCancellationRefundRepository } from "./event-cancellation-refund.repository.js";

type StripeClient = InstanceType<typeof Stripe>;
type StripeRefund = Stripe.Refund;

const MAX_ATTEMPTS = 6;
const LOCK_MS = 2 * 60 * 1000;
const RECONCILE_LOCK_MS = 10 * 60 * 1000;
const WORKER_BATCH_SIZE = 20;

const toMinor = (value: number): number => Math.max(0, Math.round(value));

const safeErrorMessage = (error: unknown): string => {
  if (error instanceof AppError) return error.message.slice(0, 500);
  if (error instanceof Error) return error.message.slice(0, 500);
  return "Refund processing failed";
};

const getErrorCode = (error: unknown): string => {
  if (typeof error === "object" && error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  if (error instanceof AppError) return String(error.statusCode);
  return "REFUND_ERROR";
};

export class EventCancellationRefundService {
  private stripe: StripeClient | null = null;

  public constructor(
    private readonly repository = new EventCancellationRefundRepository(),
    private readonly eventRepository = new EventRepository(),
    private readonly checkoutRepository = new CheckoutPaymentRepository(),
    private readonly earningRepository = new CreatorEarningRepository(),
    private readonly ticketShareRepository = new TicketShareRepository(),
    private readonly notificationService = new NotificationService(),
  ) {}

  public async cancelPublishedEvent(
    user: AuthUser,
    eventId: string,
    dto: CancelEventDto,
  ): Promise<{ event: IEvent; batch: CancellationBatchResponse }> {
    const reason = this.normalizeReason(dto);
    const now = new Date();
    const existing = await this.eventRepository.findByIdForUser(eventId, user.id);

    if (!existing) {
      throw new AppError("Event not found", httpStatus.NOT_FOUND);
    }

    if (existing.status === "cancelled") {
      if (!existing.cancellationWorkflowVersion) {
        throw new AppError("Event is already cancelled and is not managed by the refund workflow.", httpStatus.CONFLICT);
      }

      const batch = await this.recoverEventCancellationWorkflow(existing, user.id);
      await this.repository.appendBatchAudit(batch._id.toString(), "batch_resumed", user.id, "Existing cancelled event batch resumed");
      return { event: existing, batch: this.toBatchResponse(batch) };
    }

    if (existing.status !== "published" || !existing.scheduledAt || existing.scheduledAt.getTime() <= now.getTime()) {
      throw new AppError("Published event can only be cancelled before its scheduled start time.", httpStatus.CONFLICT);
    }

    const preexistingBatch = await this.repository.findBatchByEventId(eventId);
    const batch = preexistingBatch ?? await this.repository.createOrGetBatch({
      eventId,
      hostUserId: existing.userId.toString(),
      actorUserId: user.id,
      reasonType: reason.reasonType,
      customReason: reason.customReason ?? null,
      displayReason: reason.displayReason,
      cancellationOperationId: randomUUID(),
      workflowVersion: CANCELLATION_WORKFLOW_VERSION,
      status: "initializing",
    });

    const event = await this.eventRepository.cancelPublishedBeforeStartById(
      eventId,
      user.id,
      reason,
      {
        refundBatchId: batch._id.toString(),
        cancellationOperationId: batch.cancellationOperationId,
        cancellationWorkflowVersion: CANCELLATION_WORKFLOW_VERSION,
      },
      now,
    );

    if (!event) {
      const current = await this.eventRepository.findByIdForUser(eventId, user.id);
      if (current?.status === "cancelled" && current.cancellationWorkflowVersion) {
        const recovered = await this.recoverEventCancellationWorkflow(current, user.id);
        return { event: current, batch: this.toBatchResponse(recovered) };
      }

      if (batch.status === "initializing") {
        await this.repository.markBatchAborted(batch._id.toString(), user.id, "Event cancellation transition was not eligible.");
      }
      throw new AppError("Published event can only be cancelled before its scheduled start time.", httpStatus.CONFLICT);
    }

    const completedBatch = await this.completeBatchInitialization(event, batch, user.id);

    logger.info(
      { eventId, batchId: completedBatch._id.toString(), actorUserId: user.id },
      "Event cancellation accepted and refund batch created",
    );

    return { event, batch: this.toBatchResponse(completedBatch) };
  }

  public async ensureLatePaymentRefund(order: ICheckoutOrder, event: IEvent): Promise<void> {
    if (event.status !== "cancelled") return;
    if (!event.cancellationWorkflowVersion) {
      await this.flagLegacyLatePaymentForAdmin(order, event);
      return;
    }

    const batch = await this.recoverEventCancellationWorkflow(event, event.userId.toString());

    await this.ensureRefundItemForOrder(batch, order);
    await this.repository.appendBatchAudit(batch._id.toString(), "late_payment_detected", null, "Late successful payment attached to cancellation batch", {
      orderId: order._id.toString(),
    });
    await this.repository.recalculateBatch(batch._id.toString());
    await this.sendBuyerProcessingNotification(batch, order._id.toString());
  }

  private async flagLegacyLatePaymentForAdmin(order: ICheckoutOrder, event: IEvent): Promise<void> {
    const batch = await this.repository.createOrGetBatch({
      eventId: event._id.toString(),
      hostUserId: event.userId.toString(),
      actorUserId: event.userId.toString(),
      reasonType: event.cancellationReasonType ?? "Other",
      customReason: event.cancellationCustomReason ?? "Legacy cancellation requires manual refund review",
      displayReason: event.cancellationDisplayReason ?? "Legacy cancellation requires manual refund review",
      cancellationOperationId: `legacy-review:${event._id.toString()}`,
      workflowVersion: 1,
      status: "aborted",
    });
    const message = "Late successful payment detected for a legacy-cancelled event without refund workflow marker.";

    await this.repository.setBatchAnomaly(batch._id.toString(), message);
    await this.repository.markBatchAborted(batch._id.toString(), event.userId.toString(), message);
    logger.warn(
      { eventId: event._id.toString(), orderId: order._id.toString(), batchId: batch._id.toString() },
      "Legacy cancelled event late payment requires admin review",
    );
  }

  public async recoverCancellationWorkflows(limit = WORKER_BATCH_SIZE): Promise<number> {
    const [initializingBatches, markedEvents] = await Promise.all([
      this.repository.findInitializingBatches(limit),
      this.eventRepository.findRecoverableNewSystemCancelled(limit),
    ]);
    let recovered = 0;

    for (const batch of initializingBatches) {
      const event = await this.eventRepository.findById(batch.eventId.toString());
      if (!event) {
        await this.repository.markBatchAborted(batch._id.toString(), batch.actorUserId.toString(), "Recovery could not find the event.");
        continue;
      }

      if (event.status === "published" && event.scheduledAt && event.scheduledAt.getTime() > Date.now()) {
        const transitioned = await this.eventRepository.cancelPublishedBeforeStartById(
          event._id.toString(),
          batch.hostUserId.toString(),
          {
            reasonType: batch.reasonType,
            customReason: batch.customReason ?? null,
            displayReason: batch.displayReason,
          },
          {
            refundBatchId: batch._id.toString(),
            cancellationOperationId: batch.cancellationOperationId,
            cancellationWorkflowVersion: batch.workflowVersion,
          },
        );

        if (transitioned) {
          await this.completeBatchInitialization(transitioned, batch, batch.actorUserId.toString(), true);
          recovered += 1;
          continue;
        }
      }

      if (event.status === "cancelled" && event.cancellationWorkflowVersion) {
        await this.completeBatchInitialization(event, batch, batch.actorUserId.toString(), true);
        recovered += 1;
        continue;
      }

      await this.repository.markBatchAborted(batch._id.toString(), batch.actorUserId.toString(), "Recovery found the event in a non-cancellable state.");
    }

    for (const event of markedEvents) {
      await this.recoverEventCancellationWorkflow(event, event.userId.toString());
      recovered += 1;
    }

    return recovered;
  }

  private async recoverEventCancellationWorkflow(event: IEvent, actorUserId: string): Promise<IEventCancellationBatch> {
    if (!event.cancellationWorkflowVersion) {
      throw new AppError("Cancelled event is not managed by the refund workflow.", httpStatus.CONFLICT);
    }

    const reason = {
      reasonType: event.cancellationReasonType ?? "Other",
      customReason: event.cancellationCustomReason ?? null,
      displayReason: event.cancellationDisplayReason ?? "Event cancelled",
    };
    const batchById = event.refundBatchId
      ? await this.repository.findBatchById(event.refundBatchId.toString())
      : null;
    const batch = batchById
      ?? await this.repository.findBatchByEventId(event._id.toString())
      ?? await this.repository.createOrGetBatch({
        eventId: event._id.toString(),
        hostUserId: event.userId.toString(),
        actorUserId,
        ...reason,
        cancellationOperationId: event.cancellationOperationId ?? randomUUID(),
        workflowVersion: event.cancellationWorkflowVersion,
        status: "initializing",
      });

    return this.completeBatchInitialization(event, batch, actorUserId, true);
  }

  public async processDueRefunds(limit = WORKER_BATCH_SIZE): Promise<number> {
    const workerId = `refund-worker:${process.pid}:${randomUUID()}`;
    let processed = 0;

    for (let i = 0; i < limit; i += 1) {
      const item = await this.repository.claimNextRefundItem(workerId, LOCK_MS);
      if (!item) break;

      await this.processClaimedRefund(item).catch((error) => {
        logger.error(
          { error, refundItemId: item._id.toString(), orderId: item.checkoutOrderId.toString(), eventId: item.eventId.toString() },
          "Refund item processing threw unexpectedly",
        );
      });
      processed += 1;
    }

    return processed;
  }

  public async reconcileDueRefunds(limit = WORKER_BATCH_SIZE): Promise<number> {
    const items = await this.repository.findNonFinalRefunds(limit);
    const now = Date.now();
    let reconciled = 0;

    for (const item of items) {
      const lockExpired = item.lockExpiresAt ? item.lockExpiresAt.getTime() <= now : false;
      const needsProviderCheck = (
        item.status === "reconciliation_required" ||
        (item.status === "processing" && lockExpired) ||
        (item.status === "failed_retryable" && Boolean(item.stripeRefundId))
      );

      if (!needsProviderCheck) continue;

      await this.reconcileItemWithStripe(item, null).catch((error) => {
        logger.error(
          { error, refundItemId: item._id.toString(), orderId: item.checkoutOrderId.toString(), eventId: item.eventId.toString() },
          "Refund reconciliation threw unexpectedly",
        );
      });
      await this.repository.recalculateBatch(item.batchId.toString());
      reconciled += 1;
    }

    return reconciled;
  }

  public async reconcileRefundItem(refundId: string, actorUserId?: string | null): Promise<CancellationRefundItemResponse> {
    const item = await this.repository.findRefundItemById(refundId);
    if (!item) throw new AppError("Refund item not found", httpStatus.NOT_FOUND);

    const reconciled = await this.reconcileItemWithStripe(item, actorUserId);
    await this.repository.recalculateBatch(item.batchId.toString());

    return this.toRefundItemResponse(reconciled);
  }

  public async reconcileBatch(batchId: string, actorUserId?: string | null): Promise<CancellationBatchResponse> {
    const batch = await this.repository.findBatchById(batchId);
    if (!batch) throw new AppError("Refund batch not found", httpStatus.NOT_FOUND);

    const items = await this.repository.findRefundItemsByBatchId(batchId);
    for (const item of items) {
      if (item.status !== "succeeded") {
        await this.reconcileItemWithStripe(item, actorUserId);
      }
    }

    await this.repository.appendBatchAudit(batchId, "admin_reconcile", actorUserId ?? null, "Batch reconciliation requested");
    const updated = await this.repository.recalculateBatch(batchId);
    return this.toBatchResponse(updated ?? batch);
  }

  public async retryRefundItem(refundId: string, actorUserId: string): Promise<CancellationRefundItemResponse> {
    const item = await this.repository.findRefundItemById(refundId);
    if (!item) throw new AppError("Refund item not found", httpStatus.NOT_FOUND);

    if (!["failed_retryable", "failed_terminal", "reconciliation_required"].includes(item.status)) {
      return this.toRefundItemResponse(item);
    }

    const updated = await this.repository.updateRefundItem(refundId, {
      $set: {
        status: "pending",
        nextRetryAt: new Date(),
        lockedBy: null,
        lockedAt: null,
        lockExpiresAt: null,
        lastErrorCode: null,
        safeLastErrorMessage: null,
      },
      $push: { auditHistory: this.audit("admin_retry", actorUserId, "Admin retry requested") },
    });
    await this.repository.recalculateBatch(item.batchId.toString());

    return this.toRefundItemResponse(updated ?? item);
  }

  public async retryBatch(batchId: string, actorUserId: string): Promise<CancellationBatchResponse> {
    const batch = await this.repository.findBatchById(batchId);
    if (!batch) throw new AppError("Refund batch not found", httpStatus.NOT_FOUND);

    await this.repository.updateManyByBatch(batchId, ["failed_retryable", "failed_terminal", "reconciliation_required"], {
      $set: {
        status: "pending",
        nextRetryAt: new Date(),
        lockedBy: null,
        lockedAt: null,
        lockExpiresAt: null,
        lastErrorCode: null,
        safeLastErrorMessage: null,
      },
      $push: { auditHistory: this.audit("admin_retry", actorUserId, "Admin batch retry requested") },
    });
    await this.repository.appendBatchAudit(batchId, "admin_retry", actorUserId, "Admin batch retry requested");
    const updated = await this.repository.recalculateBatch(batchId);

    return this.toBatchResponse(updated ?? batch);
  }

  public async resumeBatch(batchId: string, actorUserId: string): Promise<CancellationBatchResponse> {
    const batch = await this.repository.findBatchById(batchId);
    if (!batch) throw new AppError("Refund batch not found", httpStatus.NOT_FOUND);

    const event = await this.eventRepository.findById(batch.eventId.toString());
    if (!event) throw new AppError("Event not found", httpStatus.NOT_FOUND);

    if (event.status === "published" && event.scheduledAt && event.scheduledAt.getTime() > Date.now()) {
      const transitioned = await this.eventRepository.cancelPublishedBeforeStartById(
        event._id.toString(),
        batch.hostUserId.toString(),
        {
          reasonType: batch.reasonType,
          customReason: batch.customReason ?? null,
          displayReason: batch.displayReason,
        },
        {
          refundBatchId: batch._id.toString(),
          cancellationOperationId: batch.cancellationOperationId,
          cancellationWorkflowVersion: batch.workflowVersion,
        },
      );

      if (transitioned) {
        const recovered = await this.completeBatchInitialization(transitioned, batch, actorUserId, true);
        return this.toBatchResponse(recovered);
      }
    }

    if (event.status !== "cancelled" || !event.cancellationWorkflowVersion) {
      throw new AppError("Refund batch cannot be resumed for this event state.", httpStatus.CONFLICT);
    }

    const recovered = await this.completeBatchInitialization(event, batch, actorUserId, true);

    return this.toBatchResponse(recovered);
  }

  public async listBatches(): Promise<CancellationBatchResponse[]> {
    const batches = await this.repository.findBatches();
    return batches.map((batch) => this.toBatchResponse(batch));
  }

  public async getBatchDetails(batchId: string): Promise<{
    batch: CancellationBatchResponse;
    refunds: CancellationRefundItemResponse[];
  }> {
    const batch = await this.repository.findBatchById(batchId);
    if (!batch) throw new AppError("Refund batch not found", httpStatus.NOT_FOUND);
    const refunds = await this.repository.findRefundItemsByBatchId(batchId);
    const taxReversals = await this.repository.findTaxReversalsByRefundItemIds(refunds.map((refund) => refund._id.toString()));
    const taxReversalByRefundId = new Map(taxReversals.map((reversal) => [reversal.refundItemId.toString(), reversal]));

    return {
      batch: this.toBatchResponse(batch),
      refunds: refunds.map((refund) => this.toRefundItemResponse(refund, taxReversalByRefundId.get(refund._id.toString()))),
    };
  }

  public async handleStripeWebhook(event: Stripe.Event): Promise<void> {
    const firstSeen = await this.repository.markWebhookProcessed(event.id, event.type);

    if (!firstSeen) {
      logger.info({ stripeEventId: event.id, eventType: event.type }, "Duplicate Stripe webhook ignored");
      return;
    }

    logger.info({ stripeEventId: event.id, eventType: event.type }, "Stripe webhook received");

    if (event.type === "refund.created" || event.type === "refund.updated") {
      await this.applyRefundWebhook(event.data.object as StripeRefund);
      return;
    }

    if (event.type === "charge.refunded") {
      const charge = event.data.object as Stripe.Charge;
      const paymentIntentId = typeof charge.payment_intent === "string" ? charge.payment_intent : null;
      if (!paymentIntentId) return;

      const items = await this.repository.findRefundItemsByPaymentIntentId(paymentIntentId);
      for (const item of items) {
        await this.reconcileItemWithStripe(item, null);
      }
    }
  }

  private async completeBatchInitialization(
    event: IEvent,
    batch: IEventCancellationBatch,
    actorUserId: string,
    recovered = false,
  ): Promise<IEventCancellationBatch> {
    const paidOrders = await this.checkoutRepository.findPaidTicketOrdersByEventId(event._id.toString());
    for (const order of paidOrders) {
      await this.ensureRefundItemForOrder(batch, order);
    }

    const activeShares = await this.ticketShareRepository.findActiveByEventId(event._id.toString());
    const cancelledShareCount = await this.ticketShareRepository.cancelActiveByEventId(event._id.toString());

    if (cancelledShareCount > 0) {
      await this.repository.appendBatchAudit(
        batch._id.toString(),
        "passes_invalidated",
        actorUserId,
        "Active ticket shares invalidated for cancelled event",
        { cancelledShareCount },
      );
    }

    await Promise.allSettled(
      activeShares.map((share) =>
        this.sendSharedRecipientCancellationNotification(
          batch,
          share.recipientUserId.toString(),
          share.orderId.toString(),
        ),
      ),
    );

    await Promise.allSettled(paidOrders.map((order) => this.sendBuyerProcessingNotification(batch, order._id.toString())));

    const withdrawnCount = await this.earningRepository.countWithdrawnByEventId(event._id.toString());
    if (withdrawnCount > 0) {
      await this.repository.setBatchAnomaly(
        batch._id.toString(),
        `Detected ${withdrawnCount} withdrawn creator earning records for a pre-start cancelled event.`,
      );
    }

    await this.earningRepository.markRefundedByEventId(event._id.toString());
    if (recovered) {
      await this.repository.appendBatchAudit(batch._id.toString(), "workflow_recovered", actorUserId, "Cancellation workflow recovery completed");
      logger.info({ eventId: event._id.toString(), batchId: batch._id.toString() }, "Cancellation workflow recovered");
    }

    const pending = batch.status === "initializing"
      ? await this.repository.markBatchPending(batch._id.toString(), actorUserId)
      : batch;

    return (await this.repository.recalculateBatch(batch._id.toString())) ?? pending ?? batch;
  }

  private async ensureRefundItemForOrder(
    batch: IEventCancellationBatch,
    order: ICheckoutOrder,
  ): Promise<IEventCancellationRefund> {
    const requestedAmountMinor = toMinor(order.amountMinor);
    const providerIdempotencyKey = [
      "event-cancellation-refund",
      batch.eventId.toString(),
      order._id.toString(),
      requestedAmountMinor,
    ].join(":");

    const refundItem = await this.repository.upsertRefundItem({
      eventId: batch.eventId.toString(),
      batchId: batch._id.toString(),
      checkoutOrderId: order._id.toString(),
      originalPayerUserId: order.userId.toString(),
      stripePaymentIntentId: order.stripePaymentIntentId ?? null,
      providerIdempotencyKey,
      currency: order.currency,
      originalCapturedAmountMinor: requestedAmountMinor,
      requestedAmountMinor,
      paymentMethodLabel: this.getPaymentMethodLabel(order.paymentMethod),
    });

    await this.ensureInternalTaxReversal(batch, refundItem, order);

    return refundItem;
  }

  private async processClaimedRefund(item: IEventCancellationRefund): Promise<void> {
    const order = await this.checkoutRepository.findById(item.checkoutOrderId.toString());
    if (!order || order.kind !== "ticket") {
      await this.markTerminal(item, "ORDER_NOT_FOUND", "Refund order no longer exists or is not a ticket order.");
      return;
    }

    if (item.originalCapturedAmountMinor === 0) {
      await this.markSucceeded(item, null, "not_required", 0);
      await this.finalizeOrderRefund(order, item);
      return;
    }

    if (!order.stripePaymentIntentId) {
      await this.markTerminal(item, "MISSING_PAYMENT_INTENT", "Paid order is missing its Stripe PaymentIntent reference.");
      return;
    }

    try {
      const reconciled = await this.reconcileProviderAmounts(item, order.stripePaymentIntentId);
      const remaining = Math.max(0, reconciled.originalCapturedAmountMinor - reconciled.previouslyRefundedAmountMinor);

      if (remaining === 0) {
        await this.markSucceeded(item, reconciled.stripeRefundId ?? item.stripeRefundId ?? null, reconciled.providerStatus ?? item.providerStatus ?? "succeeded", reconciled.originalCapturedAmountMinor);
        await this.finalizeOrderRefund(order, item);
        return;
      }

      logger.info(
        { refundItemId: item._id.toString(), orderId: order._id.toString(), amountMinor: remaining, attemptCount: item.attemptCount },
        "Stripe refund requested",
      );

      const refund = await this.getStripe().refunds.create(
        {
          payment_intent: order.stripePaymentIntentId,
          amount: remaining,
          metadata: {
            eventId: item.eventId.toString(),
            batchId: item.batchId.toString(),
            orderId: order._id.toString(),
            refundItemId: item._id.toString(),
          },
        },
        { idempotencyKey: item.providerIdempotencyKey },
      );

      const completedAmount = refund.status === "succeeded"
        ? reconciled.previouslyRefundedAmountMinor + (refund.amount ?? remaining)
        : reconciled.previouslyRefundedAmountMinor;

      const updated = await this.repository.updateRefundItem(item._id.toString(), {
        $set: {
          stripeRefundId: refund.id,
          providerStatus: refund.status ?? null,
          previouslyRefundedAmountMinor: reconciled.previouslyRefundedAmountMinor,
          completedAmountMinor: completedAmount,
          remainingRefundableAmountMinor: Math.max(0, reconciled.originalCapturedAmountMinor - completedAmount),
          status: refund.status === "succeeded" ? "succeeded" : "processing",
          completedAt: refund.status === "succeeded" ? new Date() : null,
          lockedBy: null,
          lockedAt: null,
          lockExpiresAt: refund.status === "succeeded" ? null : new Date(Date.now() + RECONCILE_LOCK_MS),
        },
        $push: {
          auditHistory: this.audit("stripe_refund_requested", null, "Stripe refund request completed", {
            stripeRefundId: refund.id,
            providerStatus: refund.status,
          }),
        },
      });

      if (refund.status === "succeeded") {
        await this.finalizeOrderRefund(order, updated ?? item);
        await this.sendBuyerCompletedNotification(updated ?? item);
      }
    } catch (error) {
      await this.scheduleFailure(item, error);
    } finally {
      await this.repository.recalculateBatch(item.batchId.toString());
    }
  }

  private async reconcileItemWithStripe(
    item: IEventCancellationRefund,
    actorUserId?: string | null,
  ): Promise<IEventCancellationRefund> {
    const order = await this.checkoutRepository.findById(item.checkoutOrderId.toString());
    if (!order?.stripePaymentIntentId) {
      return item;
    }

    const reconciled = await this.reconcileProviderAmounts(item, order.stripePaymentIntentId);
    const remaining = Math.max(0, reconciled.originalCapturedAmountMinor - reconciled.previouslyRefundedAmountMinor);
    const status: CancellationRefundStatus = remaining === 0 && (!reconciled.providerStatus || reconciled.providerStatus === "succeeded")
      ? "succeeded"
      : "reconciliation_required";
    const updated = await this.repository.updateRefundItem(item._id.toString(), {
      $set: {
        stripeRefundId: reconciled.stripeRefundId ?? item.stripeRefundId ?? null,
        providerStatus: reconciled.providerStatus ?? item.providerStatus ?? null,
        originalCapturedAmountMinor: reconciled.originalCapturedAmountMinor,
        previouslyRefundedAmountMinor: reconciled.previouslyRefundedAmountMinor,
        completedAmountMinor: reconciled.previouslyRefundedAmountMinor,
        remainingRefundableAmountMinor: remaining,
        status,
        lastReconciledAt: new Date(),
        completedAt: status === "succeeded" ? new Date() : null,
        lockedBy: null,
        lockedAt: null,
        lockExpiresAt: null,
      },
      $push: { auditHistory: this.audit("reconciliation_completed", actorUserId ?? null, "Refund item reconciled with Stripe") },
    });

    if (status === "succeeded") {
      await this.finalizeOrderRefund(order, updated ?? item);
      await this.sendBuyerCompletedNotification(updated ?? item);
    }

    return updated ?? item;
  }

  private async reconcileProviderAmounts(
    item: IEventCancellationRefund,
    paymentIntentId: string,
  ): Promise<{
    originalCapturedAmountMinor: number;
    previouslyRefundedAmountMinor: number;
    stripeRefundId?: string | null;
    providerStatus?: string | null;
  }> {
    const paymentIntent = await this.getStripe().paymentIntents.retrieve(paymentIntentId);
    const captured = Math.max(item.originalCapturedAmountMinor, paymentIntent.amount_received ?? 0);
    const refunds = await this.getStripe().refunds.list({ payment_intent: paymentIntentId, limit: 100 });
    const matchingRefund = refunds.data.find((refund) =>
      refund.id === item.stripeRefundId ||
      refund.metadata?.refundItemId === item._id.toString() ||
      refund.metadata?.orderId === item.checkoutOrderId.toString(),
    ) ?? null;
    const providerRefunded = refunds.data.reduce((sum, refund) => {
      if (refund.status === "failed" || refund.status === "canceled") return sum;
      return sum + (refund.amount ?? 0);
    }, 0);

    return {
      originalCapturedAmountMinor: captured,
      previouslyRefundedAmountMinor: Math.min(captured, providerRefunded),
      stripeRefundId: matchingRefund?.id ?? null,
      providerStatus: matchingRefund?.status ?? null,
    };
  }

  private async applyRefundWebhook(refund: StripeRefund): Promise<void> {
    const item = refund.id
      ? await this.repository.findRefundItemByStripeRefundId(refund.id)
      : null;
    const paymentIntentId = typeof refund.payment_intent === "string" ? refund.payment_intent : null;
    const candidates = item ? [item] : paymentIntentId ? await this.repository.findRefundItemsByPaymentIntentId(paymentIntentId) : [];

    for (const candidate of candidates) {
      if (paymentIntentId && candidate.stripePaymentIntentId !== paymentIntentId) {
        continue;
      }

      const completedAmountMinor = refund.status === "succeeded"
        ? Math.min(candidate.originalCapturedAmountMinor, candidate.previouslyRefundedAmountMinor + (refund.amount ?? 0))
        : candidate.completedAmountMinor;
      const nextStatus: CancellationRefundStatus = refund.status === "succeeded"
        ? "succeeded"
        : refund.status === "failed"
          ? "failed_retryable"
          : "processing";
      const updated = await this.repository.updateRefundItem(candidate._id.toString(), {
        $set: {
          stripeRefundId: refund.id,
          providerStatus: refund.status ?? null,
          completedAmountMinor,
          remainingRefundableAmountMinor: Math.max(0, candidate.originalCapturedAmountMinor - completedAmountMinor),
          status: nextStatus,
          completedAt: nextStatus === "succeeded" ? new Date() : candidate.completedAt ?? null,
          lastReconciledAt: new Date(),
          lockedBy: null,
          lockedAt: null,
          lockExpiresAt: null,
        },
        $push: { auditHistory: this.audit("webhook_received", null, "Refund webhook applied", { stripeRefundId: refund.id }) },
      });

      if (nextStatus === "succeeded") {
        const order = await this.checkoutRepository.findById(candidate.checkoutOrderId.toString());
        if (order) await this.finalizeOrderRefund(order, updated ?? candidate);
        await this.sendBuyerCompletedNotification(updated ?? candidate);
      }
      await this.repository.recalculateBatch(candidate.batchId.toString());
    }
  }

  private async finalizeOrderRefund(order: ICheckoutOrder, item?: IEventCancellationRefund | null): Promise<void> {
    await this.checkoutRepository.updatePaymentStatus(order._id.toString(), { paymentStatus: "refunded" });
    await this.earningRepository.markRefundedByOrderId(order._id.toString());
    if (item) {
      await this.repository.markTaxReversalCompleted(item._id.toString());
    }
    await this.releaseCapacityForOrder(order);
  }

  private async ensureInternalTaxReversal(
    batch: IEventCancellationBatch,
    item: IEventCancellationRefund,
    order: ICheckoutOrder,
  ): Promise<void> {
    const originalTaxAmountMinor = Math.max(0, Math.round((order.taxAmount ?? 0) * 100));
    const reversedTaxAmountMinor = order.amountMinor > 0
      ? Math.min(originalTaxAmountMinor, Math.round(originalTaxAmountMinor * (item.requestedAmountMinor / order.amountMinor)))
      : 0;

    await this.repository.upsertTaxReversal({
      eventId: batch.eventId.toString(),
      batchId: batch._id.toString(),
      refundItemId: item._id.toString(),
      checkoutOrderId: order._id.toString(),
      originalTaxAmountMinor,
      reversedTaxAmountMinor,
      currency: order.currency,
      reason: "event_cancellation_full_refund",
    });
  }

  private async releaseCapacityForOrder(order: ICheckoutOrder): Promise<void> {
    for (const item of order.lineItems.filter((lineItem) => lineItem.itemType === "ticket" && lineItem.eventId && lineItem.itemId)) {
      const qty = item.totalQuantity ?? item.quantity;
      await this.eventRepository.releaseTicketCapacity(item.eventId!, item.itemId!, qty).catch((error) => {
        logger.error({ error, eventId: item.eventId, ticketId: item.itemId, orderId: order._id.toString() }, "Failed to release cancelled-event ticket capacity");
      });
    }
  }

  private async markSucceeded(
    item: IEventCancellationRefund,
    stripeRefundId: string | null,
    providerStatus: string | null,
    completedAmountMinor: number,
  ): Promise<IEventCancellationRefund> {
    const updated = await this.repository.updateRefundItem(item._id.toString(), {
      $set: {
        status: "succeeded",
        stripeRefundId,
        providerStatus,
        completedAmountMinor,
        remainingRefundableAmountMinor: 0,
        completedAt: new Date(),
        lockedBy: null,
        lockedAt: null,
        lockExpiresAt: null,
      },
      $push: { auditHistory: this.audit("stripe_refund_confirmed", null, "Refund marked succeeded") },
    });
    await this.repository.recalculateBatch(item.batchId.toString());
    await this.sendBuyerCompletedNotification(updated ?? item);

    return updated ?? item;
  }

  private async scheduleFailure(item: IEventCancellationRefund, error: unknown): Promise<void> {
    const attemptCount = item.attemptCount;
    const retryable = attemptCount < MAX_ATTEMPTS;
    const delayMs = Math.min(60 * 60 * 1000, 2 ** Math.max(0, attemptCount - 1) * 60_000);
    const nextRetryAt = retryable ? new Date(Date.now() + delayMs) : null;
    const status: CancellationRefundStatus = retryable ? "failed_retryable" : "failed_terminal";
    const safeMessage = safeErrorMessage(error);

    await this.repository.updateRefundItem(item._id.toString(), {
      $set: {
        status,
        nextRetryAt,
        lockedBy: null,
        lockedAt: null,
        lockExpiresAt: null,
        lastErrorCode: getErrorCode(error),
        safeLastErrorMessage: safeMessage,
      },
      $push: {
        auditHistory: this.audit(
          retryable ? "refund_retry_scheduled" : "refund_terminal_failure",
          null,
          safeMessage,
          { nextRetryAt, attemptCount },
        ),
      },
    });

    if (!retryable) {
      await this.sendBuyerNeedsAttentionNotification(item);
    }

    logger.warn(
      { refundItemId: item._id.toString(), orderId: item.checkoutOrderId.toString(), retryable, nextRetryAt, attemptCount },
      "Refund failure recorded",
    );
  }

  private async markTerminal(item: IEventCancellationRefund, code: string, message: string): Promise<void> {
    await this.repository.updateRefundItem(item._id.toString(), {
      $set: {
        status: "failed_terminal",
        lastErrorCode: code,
        safeLastErrorMessage: message,
        lockedBy: null,
        lockedAt: null,
        lockExpiresAt: null,
      },
      $push: { auditHistory: this.audit("refund_terminal_failure", null, message) },
    });
    await this.repository.recalculateBatch(item.batchId.toString());
    await this.sendBuyerNeedsAttentionNotification(item);
  }

  private async sendBuyerProcessingNotification(batch: IEventCancellationBatch, orderId: string): Promise<void> {
    const item = (await this.repository.findRefundItemsByBatchId(batch._id.toString()))
      .find((refund) => refund.checkoutOrderId.toString() === orderId);
    if (!item || item.notificationState.processingSentAt) return;

    await this.notificationService.sendSystemNotification(
      item.originalPayerUserId.toString(),
      "refund_processing",
      "The event has been cancelled. Your full refund is being processed to your original payment method.",
      {
        title: "Event cancelled",
        eventId: batch.eventId.toString(),
        orderId,
        refundId: item._id.toString(),
        refundStatus: item.status,
        cancellationReason: batch.displayReason,
        deepLink: `/event-screen/ticket-detail?orderId=${encodeURIComponent(orderId)}`,
        sourceKey: `refund-processing:${item._id.toString()}`,
      },
    );
    await this.repository.updateRefundItem(item._id.toString(), {
      $set: { "notificationState.processingSentAt": new Date() },
      $push: { auditHistory: this.audit("notification_sent", null, "Buyer refund processing notification sent") },
    });
  }

  private async sendBuyerCompletedNotification(item: IEventCancellationRefund): Promise<void> {
    if (item.notificationState.completedSentAt) return;

    const amount = (item.completedAmountMinor / 100).toLocaleString("en-US", {
      style: "currency",
      currency: item.currency.toUpperCase(),
    });
    await this.notificationService.sendSystemNotification(
      item.originalPayerUserId.toString(),
      "refund_completed",
      `${amount} has been refunded to your original payment method. Bank processing time may vary.`,
      {
        title: "Refund completed",
        eventId: item.eventId.toString(),
        orderId: item.checkoutOrderId.toString(),
        refundId: item._id.toString(),
        refundStatus: "succeeded",
        deepLink: `/event-screen/ticket-detail?orderId=${encodeURIComponent(item.checkoutOrderId.toString())}`,
        sourceKey: `refund-completed:${item._id.toString()}`,
      },
    );
    await this.repository.updateRefundItem(item._id.toString(), {
      $set: { "notificationState.completedSentAt": new Date() },
      $push: { auditHistory: this.audit("notification_sent", null, "Buyer refund completed notification sent") },
    });
  }

  private async sendBuyerNeedsAttentionNotification(item: IEventCancellationRefund): Promise<void> {
    if (item.notificationState.needsAttentionSentAt) return;

    await this.notificationService.sendSystemNotification(
      item.originalPayerUserId.toString(),
      "refund_needs_attention",
      "Your refund requires additional processing and is being reviewed.",
      {
        title: "Refund update",
        eventId: item.eventId.toString(),
        orderId: item.checkoutOrderId.toString(),
        refundId: item._id.toString(),
        refundStatus: item.status,
        deepLink: `/event-screen/ticket-detail?orderId=${encodeURIComponent(item.checkoutOrderId.toString())}`,
        sourceKey: `refund-needs-attention:${item._id.toString()}`,
      },
    );
    await this.repository.updateRefundItem(item._id.toString(), {
      $set: { "notificationState.needsAttentionSentAt": new Date() },
      $push: { auditHistory: this.audit("notification_sent", null, "Buyer refund needs-attention notification sent") },
    });
  }

  private async sendSharedRecipientCancellationNotification(
    batch: IEventCancellationBatch,
    recipientUserId: string,
    orderId: string,
  ): Promise<void> {
    await this.notificationService.sendSystemNotification(
      recipientUserId,
      "event_cancelled",
      "This ticket is no longer valid. The original buyer will receive the refund.",
      {
        title: "Event cancelled",
        eventId: batch.eventId.toString(),
        orderId,
        cancellationReason: batch.displayReason,
        deepLink: `/event-screen/wallet`,
        sourceKey: `event-cancelled-share:${batch._id.toString()}:${recipientUserId}:${orderId}`,
      },
    );
  }

  private normalizeReason(dto: CancelEventDto): {
    reasonType: EventCancellationReasonType;
    customReason?: string | null;
    displayReason: string;
  } {
    if (!eventCancellationReasonTypes.includes(dto.reasonType)) {
      throw new AppError("Cancellation reason is invalid", httpStatus.BAD_REQUEST);
    }

    const customReason = dto.customReason?.trim() || null;
    if (dto.reasonType === "Other" && !customReason) {
      throw new AppError("Custom reason is required when Other is selected", httpStatus.BAD_REQUEST);
    }

    return {
      reasonType: dto.reasonType,
      customReason,
      displayReason: dto.reasonType === "Other" ? customReason! : dto.reasonType,
    };
  }

  private getStripe(): StripeClient {
    if (this.stripe) return this.stripe;
    if (!env.STRIPE_SECRET_KEY || !env.STRIPE_PUBLISHABLE_KEY) {
      throw new AppError("Stripe is not configured", httpStatus.SERVICE_UNAVAILABLE);
    }

    this.stripe = new Stripe(env.STRIPE_SECRET_KEY, { appInfo: { name: env.APP_NAME } });
    return this.stripe;
  }

  private getPaymentMethodLabel(paymentMethod: string): string {
    if (paymentMethod === "apple_pay") return "Apple Pay";
    return "Card";
  }

  private audit(
    action: Parameters<EventCancellationRefundRepository["appendBatchAudit"]>[1],
    actorUserId?: string | null,
    message?: string | null,
    metadata?: Record<string, unknown> | null,
  ) {
    return {
      action,
      actorUserId: actorUserId ? (actorUserId as never) : null,
      message: message ?? null,
      metadata: metadata ?? null,
      createdAt: new Date(),
    };
  }

  private toBatchResponse(batch: IEventCancellationBatch): CancellationBatchResponse {
    const rawSummaries = batch.currencySummaries instanceof Map
      ? Object.fromEntries(batch.currencySummaries.entries())
      : batch.currencySummaries;

    return {
      id: batch._id.toString(),
      eventId: batch.eventId.toString(),
      hostUserId: batch.hostUserId.toString(),
      actorUserId: batch.actorUserId.toString(),
      cancellationOperationId: batch.cancellationOperationId,
      workflowVersion: batch.workflowVersion,
      reasonType: batch.reasonType,
      customReason: batch.customReason ?? null,
      displayReason: batch.displayReason,
      status: batch.status,
      totalEligibleOrders: batch.totalEligibleOrders,
      pendingCount: batch.pendingCount,
      processingCount: batch.processingCount,
      succeededCount: batch.succeededCount,
      failedRetryableCount: batch.failedRetryableCount,
      needsAttentionCount: batch.needsAttentionCount,
      totalRequestedAmountMinor: batch.totalRequestedAmountMinor,
      totalCompletedAmountMinor: batch.totalCompletedAmountMinor,
      currencySummaries: rawSummaries,
      processingStartedAt: batch.processingStartedAt ?? null,
      completedAt: batch.completedAt ?? null,
      lastReconciledAt: batch.lastReconciledAt ?? null,
      lastErrorSummary: batch.lastErrorSummary ?? null,
      legacyPayoutAnomaly: batch.legacyPayoutAnomaly,
      auditHistory: batch.auditHistory ?? [],
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
    };
  }

  private toRefundItemResponse(
    item: IEventCancellationRefund,
    taxReversal?: IEventCancellationTaxReversal | null,
  ): CancellationRefundItemResponse {
    return {
      id: item._id.toString(),
      eventId: item.eventId.toString(),
      batchId: item.batchId.toString(),
      checkoutOrderId: item.checkoutOrderId.toString(),
      originalPayerUserId: item.originalPayerUserId.toString(),
      stripePaymentIntentId: item.stripePaymentIntentId ?? null,
      stripeRefundId: item.stripeRefundId ?? null,
      currency: item.currency,
      originalCapturedAmountMinor: item.originalCapturedAmountMinor,
      previouslyRefundedAmountMinor: item.previouslyRefundedAmountMinor,
      requestedAmountMinor: item.requestedAmountMinor,
      completedAmountMinor: item.completedAmountMinor,
      remainingRefundableAmountMinor: item.remainingRefundableAmountMinor,
      status: item.status,
      attemptCount: item.attemptCount,
      nextRetryAt: item.nextRetryAt ?? null,
      lastErrorCode: item.lastErrorCode ?? null,
      safeLastErrorMessage: item.safeLastErrorMessage ?? null,
      providerStatus: item.providerStatus ?? null,
      paymentMethodLabel: item.paymentMethodLabel ?? null,
      taxReversal: taxReversal
        ? {
            id: taxReversal._id.toString(),
            originalTaxAmountMinor: taxReversal.originalTaxAmountMinor,
            reversedTaxAmountMinor: taxReversal.reversedTaxAmountMinor,
            currency: taxReversal.currency,
            status: taxReversal.status,
            completedAt: taxReversal.completedAt ?? null,
          }
        : null,
      notificationState: item.notificationState ?? {},
      auditHistory: item.auditHistory ?? [],
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      completedAt: item.completedAt ?? null,
    };
  }
}
