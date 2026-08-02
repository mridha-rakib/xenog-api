import { randomUUID } from "node:crypto";
import httpStatus from "http-status";
import Stripe from "stripe";
import { Types } from "mongoose";
import { env } from "../../config/env.js";
import { logger } from "../../core/logger/logger.js";
import { AppError } from "../../core/errors/app-error.js";
import { createPaginationMeta, getPaginationOptions } from "../../core/utils/pagination.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { EventRepository } from "../events/event.repository.js";
import type { IEvent } from "../events/event.interface.js";
import { RewardClaimRepository } from "../events/reward-claim.repository.js";
import { NotificationService } from "../notifications/notification.service.js";
import { UserRepository } from "../user/user.repository.js";
import type { IUser } from "../user/user.interface.js";
import type { CheckoutOrderLineItem, ICheckoutOrder } from "./checkout-payment.interface.js";
import { CheckoutPaymentRepository } from "./checkout-payment.repository.js";
import { TicketShareRepository } from "./ticket-share.repository.js";
import { TicketUsageRepository } from "./ticket-usage.repository.js";
import { EventCancellationRefundRepository } from "./event-cancellation-refund.repository.js";
import { CreatorEarningRepository } from "./creator-earning.repository.js";
import {
  type CancelTicketPassDto,
  type ITicketCancellation,
  type ListAdminTicketCancellationsQuery,
  type TicketCancellationRefundStatus,
  type TicketCancellationResponse,
} from "./ticket-cancellation.interface.js";
import { TicketCancellationRepository } from "./ticket-cancellation.repository.js";
import { TicketPassClaimRepository } from "./ticket-pass-claim.repository.js";
import { RefundReceiptService } from "./refund-receipt.service.js";

type StripeClient = InstanceType<typeof Stripe>;
type StripeWebhookEvent = ReturnType<StripeClient["webhooks"]["constructEvent"]>;
type StripeRefund = Extract<StripeWebhookEvent, { type: "refund.created" | "refund.updated" }>["data"]["object"];

const CANCELLATION_CUTOFF_MS = 3 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 6;
const LOCK_MS = 2 * 60 * 1000;
const RECONCILE_LOCK_MS = 10 * 60 * 1000;
const WORKER_BATCH_SIZE = 20;

const toMinorAmount = (value?: number | null): number => Math.max(0, Math.round((value ?? 0) * 100));

const safeErrorMessage = (error: unknown): string => {
  if (error instanceof AppError) return error.message.slice(0, 500);
  if (error instanceof Error) return error.message.slice(0, 500);
  return "Ticket refund processing failed";
};

const getErrorCode = (error: unknown): string => {
  if (typeof error === "object" && error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  if (error instanceof AppError) return String(error.statusCode);
  return "TICKET_REFUND_ERROR";
};

const allocateEvenly = (amountMinor: number, count: number): number[] => {
  if (amountMinor <= 0 || count <= 0) {
    return Array.from({ length: Math.max(0, count) }, () => 0);
  }

  const base = Math.floor(amountMinor / count);
  let remainder = amountMinor - base * count;

  return Array.from({ length: count }, () => {
    const value = base + (remainder > 0 ? 1 : 0);
    remainder = Math.max(0, remainder - 1);
    return value;
  });
};

const weightedAllocate = (amountMinor: number, weights: number[], keys: string[]): number[] => {
  if (amountMinor <= 0 || weights.length === 0) {
    return weights.map(() => 0);
  }

  const weightTotal = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);
  if (weightTotal <= 0) {
    return weights.map(() => 0);
  }

  const provisional = weights.map((weight, index) => {
    const raw = (amountMinor * Math.max(0, weight)) / weightTotal;
    const floor = Math.floor(raw);
    return {
      index,
      floor,
      remainder: raw - floor,
      key: keys[index] ?? String(index),
    };
  });
  const allocations = provisional.map((item) => item.floor);
  let remainder = amountMinor - allocations.reduce((sum, value) => sum + value, 0);
  const remainderOrder = [...provisional].sort((left, right) => {
    if (right.remainder !== left.remainder) {
      return right.remainder - left.remainder;
    }
    return left.key.localeCompare(right.key);
  });

  for (const item of remainderOrder) {
    if (remainder <= 0) break;
    allocations[item.index] = (allocations[item.index] ?? 0) + 1;
    remainder -= 1;
  }

  return allocations;
};

export interface TicketPassRefundAllocation {
  eventId: string;
  ticketId: string;
  orderId: string;
  ticketIndex: number;
  lineItem: CheckoutOrderLineItem;
  paidQuantity: number;
  freeQuantity: number;
  totalQuantity: number;
  rewardId?: string | null;
  isRewardPass: boolean;
  ticketSubtotalAmountMinor: number;
  platformFeeAmountMinor: number;
  taxAmountMinor: number;
  discountAmountMinor: number;
  requestedAmountMinor: number;
}

export const buildTicketPassRefundAllocations = (order: ICheckoutOrder): TicketPassRefundAllocation[] => {
  const orderId = order._id.toString();
  const units: Omit<
    TicketPassRefundAllocation,
    "platformFeeAmountMinor" | "taxAmountMinor" | "discountAmountMinor" | "requestedAmountMinor"
  >[] = [];

  order.lineItems.forEach((lineItem) => {
    if (lineItem.itemType !== "ticket" || !lineItem.eventId || !lineItem.itemId) {
      return;
    }

    const paidQuantity = lineItem.paidQuantity ?? lineItem.quantity;
    const freeQuantity = lineItem.freeQuantity ?? 0;
    const totalQuantity = lineItem.totalQuantity ?? paidQuantity + freeQuantity;
    const lineSubtotalAllocations = allocateEvenly(toMinorAmount(lineItem.totalAmount), paidQuantity);

    for (let index = 1; index <= totalQuantity; index += 1) {
      const isPaidPass = index <= paidQuantity;
      units.push({
        eventId: lineItem.eventId,
        ticketId: lineItem.itemId,
        orderId,
        ticketIndex: index,
        lineItem,
        paidQuantity,
        freeQuantity,
        totalQuantity,
        rewardId: lineItem.rewardId ?? null,
        isRewardPass: !isPaidPass && Boolean(lineItem.rewardId),
        ticketSubtotalAmountMinor: isPaidPass ? lineSubtotalAllocations[index - 1] ?? 0 : 0,
      });
    }
  });

  const keys = units.map((unit, index) => [
    index.toString().padStart(4, "0"),
    unit.eventId,
    unit.ticketId,
    unit.orderId,
    unit.ticketIndex.toString().padStart(4, "0"),
  ].join(":"));
  const weights = units.map((unit) => unit.ticketSubtotalAmountMinor);
  const platformFeeAllocations = weightedAllocate(toMinorAmount(order.platformFeeAmount), weights, keys);
  const taxAllocations = weightedAllocate(toMinorAmount(order.taxAmount), weights, keys);
  const discountAllocations = weightedAllocate(toMinorAmount(order.discountAmount ?? 0), weights, keys);

  return units.map((unit, index) => {
    const platformFeeAmountMinor = platformFeeAllocations[index] ?? 0;
    const taxAmountMinor = taxAllocations[index] ?? 0;
    const discountAmountMinor = discountAllocations[index] ?? 0;
    const requestedAmountMinor = Math.max(
      0,
      unit.ticketSubtotalAmountMinor + platformFeeAmountMinor + taxAmountMinor,
    );

    return {
      ...unit,
      platformFeeAmountMinor,
      taxAmountMinor,
      discountAmountMinor,
      requestedAmountMinor,
    };
  });
};

export class TicketCancellationService {
  private stripe: StripeClient | null = null;

  public constructor(
    private readonly repository = new TicketCancellationRepository(),
    private readonly checkoutRepository = new CheckoutPaymentRepository(),
    private readonly eventRepository = new EventRepository(),
    private readonly ticketShareRepository = new TicketShareRepository(),
    private readonly ticketUsageRepository = new TicketUsageRepository(),
    private readonly eventCancellationRefundRepository = new EventCancellationRefundRepository(),
    private readonly notificationService = new NotificationService(),
    private readonly earningRepository = new CreatorEarningRepository(),
    private readonly passClaimRepository = new TicketPassClaimRepository(),
    private readonly userRepository = new UserRepository(),
    private readonly refundReceiptService = new RefundReceiptService(),
    private readonly rewardClaimRepository = new RewardClaimRepository(),
  ) {}

  public async cancelTicketPass(user: AuthUser, payload: CancelTicketPassDto): Promise<TicketCancellationResponse> {
    const existing = await this.repository.findByPass(payload);
    if (existing) {
      if (existing.buyerUserId.toString() !== user.id) {
        throw new AppError("Only the original buyer can cancel this ticket.", httpStatus.FORBIDDEN, { code: "NOT_ORIGINAL_BUYER" });
      }

      await this.releaseRewardForAcceptedCancellation(existing).catch((error) => {
        logger.error(
          { error, ticketCancellationId: existing._id.toString(), orderId: existing.orderId.toString() },
          "Failed to release reward claim for existing ticket cancellation",
        );
      });

      return this.toResponse(existing);
    }

    const [order, event] = await Promise.all([
      this.checkoutRepository.findById(payload.orderId),
      this.eventRepository.findById(payload.eventId),
    ]);

    if (!order || order.kind !== "ticket") {
      throw new AppError("Ticket pass not found for this order", httpStatus.NOT_FOUND, { code: "INVALID_PASS" });
    }

    if (order.userId.toString() !== user.id) {
      throw new AppError("Only the original buyer can cancel this ticket.", httpStatus.FORBIDDEN, { code: "NOT_ORIGINAL_BUYER" });
    }

    if (!event) {
      throw new AppError("Event not found", httpStatus.NOT_FOUND, { code: "EVENT_NOT_FOUND" });
    }

    this.assertCancellationAllowed(order, event);

    const ticket = event.tickets.find((item) => item.id === payload.ticketId);
    const lineItem = order.lineItems.find(
      (item) => item.itemType === "ticket" && item.eventId === payload.eventId && item.itemId === payload.ticketId,
    );
    const allocation = buildTicketPassRefundAllocations(order).find(
      (item) =>
        item.eventId === payload.eventId &&
        item.ticketId === payload.ticketId &&
        item.orderId === payload.orderId &&
        item.ticketIndex === payload.ticketIndex,
    );

    if (!ticket || !lineItem || !allocation || !this.hasStoredPass(order, payload.eventId, payload.ticketId, payload.ticketIndex)) {
      throw new AppError("Ticket pass not found for this order", httpStatus.NOT_FOUND, { code: "INVALID_PASS" });
    }

    await this.assertNoEventCancellationRefund(order, event);
    await this.assertPassNotUsed(payload);

    const claim = await this.passClaimRepository.claimForCancellation(payload);
    if (!claim.claimed) {
      if (claim.reason === "used") {
        throw new AppError(
          "This ticket has already been used and can no longer be cancelled.",
          httpStatus.CONFLICT,
          { code: "TICKET_ALREADY_USED" },
        );
      }

      if (claim.reason === "cancelled") {
        const accepted = await this.repository.findByPass(payload);
        if (accepted) {
          if (accepted.buyerUserId.toString() !== user.id) {
            throw new AppError("Only the original buyer can cancel this ticket.", httpStatus.FORBIDDEN, { code: "NOT_ORIGINAL_BUYER" });
          }

          await this.releaseRewardForAcceptedCancellation(accepted).catch((error) => {
            logger.error(
              { error, ticketCancellationId: accepted._id.toString(), orderId: accepted.orderId.toString() },
              "Failed to release reward claim for accepted ticket cancellation",
            );
          });

          return this.toResponse(accepted);
        }
      }

      throw new AppError(
        "Ticket cancellation is already being processed for this pass.",
        httpStatus.CONFLICT,
        { code: "TICKET_CANCELLATION_IN_PROGRESS" },
      );
    }

    let shouldAbortCancellationClaim = true;
    try {
    const activeShare = await this.ticketShareRepository.findActiveByTicketPass(
      payload.eventId,
      payload.ticketId,
      payload.orderId,
      payload.ticketIndex,
    );
    const previousCancellationAmountMinor = await this.repository.sumRequestedAmountByOrderId(order._id.toString());
    const orderCapturedAmountMinor = Math.max(0, order.amountMinor);
    const remainingCapturedAmountMinor = Math.max(0, orderCapturedAmountMinor - previousCancellationAmountMinor);
    const requestedAmountMinor = Math.min(allocation.requestedAmountMinor, remainingCapturedAmountMinor);
    const now = new Date();
    const cancellationCutoffAt = this.getCancellationCutoffAt(event);
    const monetary = requestedAmountMinor > 0;
    const payloadToCreate: Omit<ITicketCancellation, "_id" | "createdAt" | "updatedAt"> = {
      sourceType: "user_ticket_cancellation",
      eventId: new Types.ObjectId(payload.eventId),
      ticketId: payload.ticketId,
      orderId: new Types.ObjectId(payload.orderId),
      ticketIndex: payload.ticketIndex,
      buyerUserId: new Types.ObjectId(order.userId.toString()),
      hostUserId: new Types.ObjectId(event.userId.toString()),
      sharedRecipientUserId: activeShare ? new Types.ObjectId(activeShare.recipientUserId.toString()) : null,
      activeShareId: activeShare ? new Types.ObjectId(activeShare._id.toString()) : null,
      eventName: event.name ?? null,
      ticketName: ticket.name,
      ticketType: monetary ? "paid" : allocation.isRewardPass ? "rewarded" : "free",
      status: "cancelled",
      refundStatus: monetary ? "pending" : "not_required",
      currency: order.currency,
      stripePaymentIntentId: order.stripePaymentIntentId ?? null,
      stripeRefundId: null,
      providerIdempotencyKey: [
        "ticket-cancellation-refund",
        payload.eventId,
        payload.ticketId,
        payload.orderId,
        payload.ticketIndex,
        requestedAmountMinor,
      ].join(":"),
      providerStatus: null,
      ticketSubtotalAmountMinor: allocation.ticketSubtotalAmountMinor,
      platformFeeAmountMinor: allocation.platformFeeAmountMinor,
      taxAmountMinor: allocation.taxAmountMinor,
      discountAmountMinor: allocation.discountAmountMinor,
      requestedAmountMinor,
      completedAmountMinor: 0,
      remainingRefundableAmountMinor: requestedAmountMinor,
      orderCapturedAmountMinor,
      previousCancellationAmountMinor,
      capacityReleaseStatus: "pending",
      shareRevocationStatus: activeShare ? "pending" : "not_required",
      qrInvalidationStatus: "completed",
      creatorEarningAdjustmentStatus: allocation.ticketSubtotalAmountMinor > 0 && allocation.lineItem.sellerUserId
        ? "pending"
        : "not_required",
      taxReversalStatus: "completed",
      notificationState: {},
      attemptCount: 0,
      nextRetryAt: monetary ? now : null,
      lockedBy: null,
      lockedAt: null,
      lockExpiresAt: null,
      lastErrorCode: null,
      safeLastErrorMessage: null,
      cancellationCutoffAt,
      cancelledAt: now,
      refundCompletedAt: null,
      lastReconciledAt: null,
      auditHistory: [
        {
          action: "refund_item_created",
          actorUserId: new Types.ObjectId(user.id),
          message: "User ticket cancellation accepted",
          metadata: {
            sourceType: "user_ticket_cancellation",
            eventId: payload.eventId,
            ticketId: payload.ticketId,
            orderId: payload.orderId,
            ticketIndex: payload.ticketIndex,
            requestedAmountMinor,
          },
          createdAt: now,
        },
      ],
    };

    await this.assertPassNotUsed(payload);
    const { cancellation, created } = await this.repository.createOrGet(payloadToCreate);
    if (!created) {
      shouldAbortCancellationClaim = false;
      await this.releaseRewardForAcceptedCancellation(cancellation).catch((error) => {
        logger.error(
          { error, ticketCancellationId: cancellation._id.toString(), orderId: cancellation.orderId.toString() },
          "Failed to release reward claim for existing ticket cancellation",
        );
      });
      return this.toResponse(cancellation);
    }

    await this.passClaimRepository.acceptCancellation(payload, cancellation._id.toString());
    shouldAbortCancellationClaim = false;
    const completed = await this.ensureDurableCancellationEffects(cancellation, allocation);
    await this.sendAcceptanceNotifications(completed);

    return this.toResponse(completed);
    } catch (error) {
      if (shouldAbortCancellationClaim) {
        await this.passClaimRepository.abortCancellation(payload);
      }
      throw error;
    }
  }

  public async processDueRefunds(limit = WORKER_BATCH_SIZE): Promise<number> {
    const workerId = `ticket-cancellation-refund-worker:${process.pid}:${randomUUID()}`;
    let processed = 0;

    for (let i = 0; i < limit; i += 1) {
      const cancellation = await this.repository.claimNextRefund(workerId, LOCK_MS);
      if (!cancellation) break;

      await this.processClaimedRefund(cancellation).catch((error) => {
        logger.error(
          {
            error,
            ticketCancellationId: cancellation._id.toString(),
            orderId: cancellation.orderId.toString(),
            eventId: cancellation.eventId.toString(),
          },
          "Ticket cancellation refund processing threw unexpectedly",
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
        item.refundStatus === "reconciliation_required" ||
        (item.refundStatus === "processing" && lockExpired) ||
        (item.refundStatus === "failed_retryable" && Boolean(item.stripeRefundId))
      );

      if (!needsProviderCheck) continue;

      await this.reconcileCancellationWithStripe(item, null).catch((error) => {
        logger.error(
          { error, ticketCancellationId: item._id.toString(), orderId: item.orderId.toString() },
          "Ticket cancellation reconciliation threw unexpectedly",
        );
      });
      reconciled += 1;
    }

    return reconciled;
  }

  public async listAdminCancellations(query: ListAdminTicketCancellationsQuery = {}): Promise<{
    cancellations: TicketCancellationResponse[];
    pagination: ReturnType<typeof createPaginationMeta>;
  }> {
    const { page, limit, skip } = getPaginationOptions({ page: query.page, limit: query.limit ?? 20 });
    const result = await this.repository.listAdmin(
      {
        ...query,
        sourceType: query.sourceType ?? "user_ticket_cancellation",
        monetary: query.monetary ?? "monetary",
      },
      skip,
      limit,
    );
    const buyerById = await this.getBuyerMap(result.cancellations);

    return {
      cancellations: result.cancellations.map((item) => this.toResponse(
        item,
        buyerById.get(item.buyerUserId.toString()) ?? null,
        { includeAdminOperationalFields: true },
      )),
      pagination: createPaginationMeta(page, limit, result.total),
    };
  }

  public async getAdminCancellation(cancellationId: string): Promise<TicketCancellationResponse> {
    const cancellation = await this.repository.findById(cancellationId);
    if (!cancellation) {
      throw new AppError("Ticket cancellation not found", httpStatus.NOT_FOUND);
    }

    const buyer = await this.userRepository.findById(cancellation.buyerUserId.toString());
    return this.toResponse(cancellation, buyer, { includeAdminOperationalFields: true });
  }

  public async retryCancellation(cancellationId: string, actorUserId: string): Promise<TicketCancellationResponse> {
    const cancellation = await this.repository.findById(cancellationId);
    if (!cancellation) {
      throw new AppError("Ticket cancellation not found", httpStatus.NOT_FOUND);
    }

    if (!this.getActionCapabilities(cancellation).canRetry) {
      throw new AppError("Ticket cancellation refund is not retryable.", httpStatus.CONFLICT, {
        code: "REFUND_ACTION_NOT_AVAILABLE",
      });
    }

    const updated = await this.repository.retry(cancellationId, actorUserId);
    return this.toResponse(updated ?? cancellation);
  }

  public async reconcileCancellation(cancellationId: string, actorUserId?: string | null): Promise<TicketCancellationResponse> {
    const cancellation = await this.repository.findById(cancellationId);
    if (!cancellation) {
      throw new AppError("Ticket cancellation not found", httpStatus.NOT_FOUND);
    }

    if (!this.getActionCapabilities(cancellation).canReconcile) {
      throw new AppError("Ticket cancellation refund is not reconcilable.", httpStatus.CONFLICT, {
        code: "REFUND_ACTION_NOT_AVAILABLE",
      });
    }

    const reconciled = await this.reconcileCancellationWithStripe(cancellation, actorUserId ?? null);
    return this.toResponse(reconciled);
  }

  public async handleStripeWebhook(event: StripeWebhookEvent): Promise<void> {
    const firstSeen = await this.eventCancellationRefundRepository.markWebhookProcessed(event.id, event.type);
    if (!firstSeen) {
      logger.info({ stripeEventId: event.id, eventType: event.type }, "Duplicate ticket cancellation Stripe webhook ignored");
      return;
    }

    if (event.type === "refund.created" || event.type === "refund.updated") {
      await this.applyRefundWebhook(event.data.object);
    }
  }

  private async processClaimedRefund(cancellation: ITicketCancellation): Promise<void> {
    if (cancellation.requestedAmountMinor <= 0) {
      await this.markRefundSucceeded(cancellation, null, "not_required", 0);
      return;
    }

    if (!cancellation.stripePaymentIntentId) {
      await this.markTerminal(cancellation, "MISSING_PAYMENT_INTENT", "Paid ticket cancellation is missing its Stripe PaymentIntent reference.");
      return;
    }

    try {
      const reconciled = await this.reconcileCancellationWithStripe(cancellation, null, false);
      if (reconciled.refundStatus === "succeeded") {
        return;
      }

      const remaining = Math.max(0, reconciled.requestedAmountMinor - reconciled.completedAmountMinor);
      if (remaining <= 0) {
        await this.markRefundSucceeded(reconciled, reconciled.stripeRefundId ?? null, reconciled.providerStatus ?? "succeeded", reconciled.requestedAmountMinor);
        return;
      }

      logger.info(
        {
          ticketCancellationId: cancellation._id.toString(),
          orderId: cancellation.orderId.toString(),
          amountMinor: remaining,
          attemptCount: cancellation.attemptCount,
        },
        "Stripe ticket cancellation refund requested",
      );

      const refund = await this.getStripe().refunds.create(
        {
          payment_intent: cancellation.stripePaymentIntentId,
          amount: remaining,
          metadata: {
            sourceType: "user_ticket_cancellation",
            ticketCancellationId: cancellation._id.toString(),
            eventId: cancellation.eventId.toString(),
            orderId: cancellation.orderId.toString(),
            ticketId: cancellation.ticketId,
            ticketIndex: String(cancellation.ticketIndex),
          },
        },
        { idempotencyKey: cancellation.providerIdempotencyKey },
      );

      const completedAmount = refund.status === "succeeded"
        ? cancellation.requestedAmountMinor
        : cancellation.completedAmountMinor;
      const updated = await this.repository.update(cancellation._id.toString(), {
        $set: {
          stripeRefundId: refund.id,
          providerStatus: refund.status ?? null,
          completedAmountMinor: completedAmount,
          remainingRefundableAmountMinor: Math.max(0, cancellation.requestedAmountMinor - completedAmount),
          refundStatus: refund.status === "succeeded" ? "succeeded" : "processing",
          refundCompletedAt: refund.status === "succeeded" ? new Date() : null,
          lockedBy: null,
          lockedAt: null,
          lockExpiresAt: refund.status === "succeeded" ? null : new Date(Date.now() + RECONCILE_LOCK_MS),
        },
        $push: {
          auditHistory: {
            action: "stripe_refund_requested",
            actorUserId: null,
            message: "Stripe ticket cancellation refund request completed",
            metadata: { stripeRefundId: refund.id, providerStatus: refund.status },
            createdAt: new Date(),
          },
        },
      });

      if (refund.status === "succeeded") {
        await this.sendBuyerCompletedNotification(updated ?? cancellation);
      }
    } catch (error) {
      await this.scheduleFailure(cancellation, error);
    }
  }

  private async reconcileCancellationWithStripe(
    cancellation: ITicketCancellation,
    actorUserId?: string | null,
    appendAudit = true,
  ): Promise<ITicketCancellation> {
    if (cancellation.requestedAmountMinor <= 0 || !cancellation.stripePaymentIntentId) {
      return cancellation;
    }

    const refunds = await this.getStripe().refunds.list({
      payment_intent: cancellation.stripePaymentIntentId,
      limit: 100,
    });
    const matchingRefund = refunds.data.find((refund) =>
      refund.id === cancellation.stripeRefundId ||
      refund.metadata?.ticketCancellationId === cancellation._id.toString(),
    ) ?? null;

    if (!matchingRefund) {
      if (!appendAudit) {
        return cancellation;
      }

      const updated = await this.repository.update(cancellation._id.toString(), {
        $set: {
          refundStatus: cancellation.refundStatus === "processing" ? "reconciliation_required" : cancellation.refundStatus,
          lastReconciledAt: new Date(),
          lockedBy: null,
          lockedAt: null,
          lockExpiresAt: null,
        },
        $push: {
          auditHistory: {
            action: "reconciliation_completed",
            actorUserId: actorUserId ? new Types.ObjectId(actorUserId) : null,
            message: "Ticket cancellation refund reconciliation completed without matching provider refund",
            metadata: null,
            createdAt: new Date(),
          },
        },
      });

      return updated ?? cancellation;
    }

    const completedAmount = matchingRefund.status === "succeeded"
      ? Math.min(cancellation.requestedAmountMinor, matchingRefund.amount ?? cancellation.requestedAmountMinor)
      : cancellation.completedAmountMinor;
    const nextStatus: TicketCancellationRefundStatus = matchingRefund.status === "succeeded"
      ? "succeeded"
      : matchingRefund.status === "failed"
        ? "failed_retryable"
        : "processing";
    const updated = await this.repository.update(cancellation._id.toString(), {
      $set: {
        stripeRefundId: matchingRefund.id,
        providerStatus: matchingRefund.status ?? null,
        completedAmountMinor: completedAmount,
        remainingRefundableAmountMinor: Math.max(0, cancellation.requestedAmountMinor - completedAmount),
        refundStatus: nextStatus,
        refundCompletedAt: nextStatus === "succeeded" ? new Date() : cancellation.refundCompletedAt ?? null,
        lastReconciledAt: new Date(),
        lockedBy: null,
        lockedAt: null,
        lockExpiresAt: nextStatus === "processing" ? cancellation.lockExpiresAt ?? new Date(Date.now() + RECONCILE_LOCK_MS) : null,
      },
      ...(appendAudit ? {
        $push: {
          auditHistory: {
            action: "reconciliation_completed",
            actorUserId: actorUserId ? new Types.ObjectId(actorUserId) : null,
            message: "Ticket cancellation refund reconciled with Stripe",
            metadata: { stripeRefundId: matchingRefund.id, providerStatus: matchingRefund.status },
            createdAt: new Date(),
          },
        },
      } : {}),
    });
    const result = updated ?? cancellation;

    if (nextStatus === "succeeded") {
      await this.sendBuyerCompletedNotification(result);
    }

    return result;
  }

  private async applyRefundWebhook(refund: StripeRefund): Promise<void> {
    const cancellationId = typeof refund.metadata?.ticketCancellationId === "string"
      ? refund.metadata.ticketCancellationId
      : null;
    const cancellation = cancellationId
      ? await this.repository.findById(cancellationId)
      : refund.id
        ? await this.repository.findByStripeRefundId(refund.id)
        : null;

    if (!cancellation) {
      return;
    }

    const completedAmount = refund.status === "succeeded"
      ? Math.min(cancellation.requestedAmountMinor, refund.amount ?? cancellation.requestedAmountMinor)
      : cancellation.completedAmountMinor;
    const nextStatus: TicketCancellationRefundStatus = refund.status === "succeeded"
      ? "succeeded"
      : refund.status === "failed"
        ? "failed_retryable"
        : "processing";
    const updated = await this.repository.update(cancellation._id.toString(), {
      $set: {
        stripeRefundId: refund.id,
        providerStatus: refund.status ?? null,
        completedAmountMinor: completedAmount,
        remainingRefundableAmountMinor: Math.max(0, cancellation.requestedAmountMinor - completedAmount),
        refundStatus: nextStatus,
        refundCompletedAt: nextStatus === "succeeded" ? new Date() : cancellation.refundCompletedAt ?? null,
        lastReconciledAt: new Date(),
        lockedBy: null,
        lockedAt: null,
        lockExpiresAt: null,
      },
      $push: {
        auditHistory: {
          action: "webhook_received",
          actorUserId: null,
          message: "Ticket cancellation refund webhook applied",
          metadata: { stripeRefundId: refund.id, providerStatus: refund.status },
          createdAt: new Date(),
        },
      },
    });

    if (nextStatus === "succeeded") {
      await this.sendBuyerCompletedNotification(updated ?? cancellation);
    }
  }

  private async ensureDurableCancellationEffects(
    cancellation: ITicketCancellation,
    allocation: TicketPassRefundAllocation,
  ): Promise<ITicketCancellation> {
    let current = cancellation;

    if (current.shareRevocationStatus === "pending") {
      try {
        await this.ticketShareRepository.cancelActiveByTicketPass(
          current.eventId.toString(),
          current.ticketId,
          current.orderId.toString(),
          current.ticketIndex,
        );
        current = await this.repository.update(current._id.toString(), {
          $set: { shareRevocationStatus: "completed" },
          $push: {
            auditHistory: {
              action: "passes_invalidated",
              actorUserId: null,
              message: "Active shared ticket holder revoked",
              metadata: null,
              createdAt: new Date(),
            },
          },
        }) ?? current;
      } catch (error) {
        current = await this.repository.update(current._id.toString(), {
          $set: {
            shareRevocationStatus: "failed",
            lastErrorCode: getErrorCode(error),
            safeLastErrorMessage: safeErrorMessage(error),
          },
        }) ?? current;
        throw error;
      }
    }

    if (current.capacityReleaseStatus === "pending" || current.capacityReleaseStatus === "failed") {
      try {
        await this.eventRepository.releaseTicketAndRewardCapacity(
          current.eventId.toString(),
          current.ticketId,
          1,
          null,
          0,
        );
        current = await this.repository.update(current._id.toString(), {
          $set: { capacityReleaseStatus: "completed" },
          $push: {
            auditHistory: {
              action: "passes_invalidated",
              actorUserId: null,
              message: "Ticket capacity released for cancelled pass",
              metadata: {
                ticketQuantity: 1,
                rewardId: null,
                rewardQuantity: 0,
              },
              createdAt: new Date(),
            },
          },
        }) ?? current;
      } catch (error) {
        current = await this.repository.update(current._id.toString(), {
          $set: {
            capacityReleaseStatus: "failed",
            lastErrorCode: getErrorCode(error),
            safeLastErrorMessage: safeErrorMessage(error),
          },
        }) ?? current;
        throw error;
      }
    }

    await this.releaseRewardForFullyCancelledPurchase(current, allocation);

    if (current.creatorEarningAdjustmentStatus === "pending" || current.creatorEarningAdjustmentStatus === "failed") {
      try {
        const lineItemKey = [
          allocation.lineItem.itemType,
          allocation.eventId,
          allocation.ticketId,
        ].join(":");
        const result = await this.earningRepository.adjustTicketCancellationAmount(
          current.orderId.toString(),
          lineItemKey,
          allocation.ticketSubtotalAmountMinor / 100,
        );

        if (result === "withdrawn") {
          current = await this.repository.update(current._id.toString(), {
            $set: {
              creatorEarningAdjustmentStatus: "failed",
              status: "needs_attention",
              lastErrorCode: "CREATOR_EARNING_WITHDRAWN",
              safeLastErrorMessage: "Creator earning for this ticket was already withdrawn before cancellation adjustment.",
            },
            $push: {
              auditHistory: {
                action: "workflow_recovered",
                actorUserId: null,
                message: "Creator earning adjustment requires admin review",
                metadata: { lineItemKey },
                createdAt: new Date(),
              },
            },
          }) ?? current;
        } else {
          current = await this.repository.update(current._id.toString(), {
            $set: {
              creatorEarningAdjustmentStatus: result === "not_found" ? "not_required" : "completed",
            },
            $push: {
              auditHistory: {
                action: "workflow_recovered",
                actorUserId: null,
                message: result === "not_found"
                  ? "No creator earning record required adjustment"
                  : "Creator earning adjusted for cancelled ticket pass",
                metadata: { lineItemKey },
                createdAt: new Date(),
              },
            },
          }) ?? current;
        }
      } catch (error) {
        current = await this.repository.update(current._id.toString(), {
          $set: {
            creatorEarningAdjustmentStatus: "failed",
            lastErrorCode: getErrorCode(error),
            safeLastErrorMessage: safeErrorMessage(error),
          },
        }) ?? current;
        throw error;
      }
    }

    return current;
  }

  private async releaseRewardForAcceptedCancellation(cancellation: ITicketCancellation): Promise<void> {
    if (cancellation.capacityReleaseStatus !== "completed") {
      return;
    }

    const order = await this.checkoutRepository.findById(cancellation.orderId.toString());
    if (!order || order.kind !== "ticket") {
      return;
    }

    const allocation = buildTicketPassRefundAllocations(order).find(
      (item) =>
        item.eventId === cancellation.eventId.toString() &&
        item.ticketId === cancellation.ticketId &&
        item.orderId === cancellation.orderId.toString() &&
        item.ticketIndex === cancellation.ticketIndex,
    );

    if (!allocation) {
      return;
    }

    await this.releaseRewardForFullyCancelledPurchase(cancellation, allocation);
  }

  private async releaseRewardForFullyCancelledPurchase(
    cancellation: ITicketCancellation,
    allocation: TicketPassRefundAllocation,
  ): Promise<void> {
    const lineItem = allocation.lineItem;
    const rewardId = lineItem.rewardId ?? null;

    if (
      cancellation.capacityReleaseStatus !== "completed" ||
      lineItem.itemType !== "ticket" ||
      !lineItem.eventId ||
      !lineItem.itemId ||
      !rewardId ||
      !lineItem.rewardSnapshot ||
      lineItem.rewardSnapshot.rewardType !== "ticket" ||
      lineItem.rewardSnapshot.rewardId !== rewardId
    ) {
      return;
    }

    const totalQuantity = allocation.totalQuantity;
    if (totalQuantity <= 0) {
      return;
    }

    const cancellations = await this.repository.findByOrderId(allocation.orderId);
    const cancelledIndexes = new Set(
      cancellations
        .filter((item) =>
          item.eventId.toString() === lineItem.eventId &&
          item.ticketId === lineItem.itemId &&
          item.capacityReleaseStatus === "completed",
        )
        .map((item) => item.ticketIndex),
    );
    const allRewardedPassesCancelled = Array.from(
      { length: totalQuantity },
      (_unused, index) => index + 1,
    ).every((ticketIndex) => cancelledIndexes.has(ticketIndex));

    if (!allRewardedPassesCancelled) {
      return;
    }

    await this.rewardClaimRepository.releaseCheckoutRewardRedemptionAndRestoreCapacity({
      orderId: allocation.orderId,
      eventId: lineItem.eventId,
      ticketId: lineItem.itemId,
      rewardId,
    });
  }

  private async assertNoEventCancellationRefund(order: ICheckoutOrder, event: IEvent): Promise<void> {
    if (event.status === "cancelled") {
      throw new AppError("Event already cancelled; refund is already being processed.", httpStatus.CONFLICT, {
        code: "EVENT_CANCELLATION_REFUND_PROCESSING",
      });
    }

    const eventRefundItems = await this.eventCancellationRefundRepository.findRefundItemsByOrderIds([order._id.toString()]);
    const existing = eventRefundItems.find((item) => item.eventId.toString() === event._id.toString());
    if (existing && existing.status !== "failed_terminal") {
      throw new AppError("Event already cancelled; refund is already being processed.", httpStatus.CONFLICT, {
        code: "EVENT_CANCELLATION_REFUND_PROCESSING",
      });
    }
  }

  private assertCancellationAllowed(order: ICheckoutOrder, event: IEvent): void {
    if (order.paymentStatus !== "paid") {
      throw new AppError("This ticket is not eligible for cancellation.", httpStatus.CONFLICT, { code: "PAYMENT_NOT_ELIGIBLE" });
    }

    if (event.status === "cancelled") {
      throw new AppError("Event already cancelled; refund is already being processed.", httpStatus.CONFLICT, {
        code: "EVENT_CANCELLATION_REFUND_PROCESSING",
      });
    }

    if (event.status !== "published" || !event.scheduledAt) {
      throw new AppError("This ticket is not eligible for cancellation.", httpStatus.CONFLICT, { code: "PAYMENT_NOT_ELIGIBLE" });
    }

    const cutoffAt = this.getCancellationCutoffAt(event);
    if (Date.now() >= cutoffAt.getTime()) {
      throw new AppError(
        "Ticket cancellation is unavailable within 3 hours of the event start time.",
        httpStatus.CONFLICT,
        { code: "CUTOFF_REACHED" },
      );
    }
  }

  private getCancellationCutoffAt(event: IEvent): Date {
    if (!event.scheduledAt) {
      return new Date(0);
    }

    return new Date(event.scheduledAt.getTime() - CANCELLATION_CUTOFF_MS);
  }

  private async assertPassNotUsed(identity: CancelTicketPassDto): Promise<void> {
    const usage = await this.ticketUsageRepository.findByTicketPass(
      identity.eventId,
      identity.ticketId,
      identity.orderId,
      identity.ticketIndex,
    );

    if (usage) {
      throw new AppError(
        "This ticket has already been used and can no longer be cancelled.",
        httpStatus.CONFLICT,
        { code: "TICKET_ALREADY_USED" },
      );
    }
  }

  private hasStoredPass(order: ICheckoutOrder, eventId: string, ticketId: string, ticketIndex: number): boolean {
    return order.ticketPasses.some((pass) => (
      pass.eventId === eventId && pass.ticketId === ticketId && pass.ticketIndex === ticketIndex
    ));
  }

  private async markRefundSucceeded(
    cancellation: ITicketCancellation,
    stripeRefundId: string | null,
    providerStatus: string | null,
    completedAmountMinor: number,
  ): Promise<ITicketCancellation> {
    const updated = await this.repository.update(cancellation._id.toString(), {
      $set: {
        refundStatus: "succeeded",
        stripeRefundId,
        providerStatus,
        completedAmountMinor,
        remainingRefundableAmountMinor: 0,
        refundCompletedAt: new Date(),
        lockedBy: null,
        lockedAt: null,
        lockExpiresAt: null,
      },
      $push: {
        auditHistory: {
          action: "stripe_refund_confirmed",
          actorUserId: null,
          message: "Ticket cancellation refund marked succeeded",
          metadata: null,
          createdAt: new Date(),
        },
      },
    });

    if (updated) {
      await this.sendBuyerCompletedNotification(updated);
    }

    return updated ?? cancellation;
  }

  private async scheduleFailure(cancellation: ITicketCancellation, error: unknown): Promise<void> {
    const attemptCount = cancellation.attemptCount;
    const retryable = attemptCount < MAX_ATTEMPTS;
    const delayMs = Math.min(60 * 60 * 1000, 2 ** Math.max(0, attemptCount - 1) * 60_000);
    const nextRetryAt = retryable ? new Date(Date.now() + delayMs) : null;
    const refundStatus: TicketCancellationRefundStatus = retryable ? "failed_retryable" : "failed_terminal";
    const safeMessage = safeErrorMessage(error);

    const updated = await this.repository.update(cancellation._id.toString(), {
      $set: {
        refundStatus,
        status: retryable ? "cancelled" : "needs_attention",
        nextRetryAt,
        lockedBy: null,
        lockedAt: null,
        lockExpiresAt: null,
        lastErrorCode: getErrorCode(error),
        safeLastErrorMessage: safeMessage,
      },
      $push: {
        auditHistory: {
          action: retryable ? "refund_retry_scheduled" : "refund_terminal_failure",
          actorUserId: null,
          message: safeMessage,
          metadata: { nextRetryAt, attemptCount },
          createdAt: new Date(),
        },
      },
    });

    if (!retryable) {
      await this.sendBuyerNeedsAttentionNotification(updated ?? cancellation);
    }
  }

  private async markTerminal(cancellation: ITicketCancellation, code: string, message: string): Promise<void> {
    const updated = await this.repository.update(cancellation._id.toString(), {
      $set: {
        refundStatus: "failed_terminal",
        status: "needs_attention",
        lastErrorCode: code,
        safeLastErrorMessage: message,
        lockedBy: null,
        lockedAt: null,
        lockExpiresAt: null,
      },
      $push: {
        auditHistory: {
          action: "refund_terminal_failure",
          actorUserId: null,
          message,
          metadata: null,
          createdAt: new Date(),
        },
      },
    });
    await this.sendBuyerNeedsAttentionNotification(updated ?? cancellation);
  }

  private async sendAcceptanceNotifications(cancellation: ITicketCancellation): Promise<void> {
    const cancellationId = cancellation._id.toString();
    const eventId = cancellation.eventId.toString();
    const orderId = cancellation.orderId.toString();
    const buyerId = cancellation.buyerUserId.toString();
    const recipientId = cancellation.sharedRecipientUserId?.toString() ?? null;
    const hostId = cancellation.hostUserId.toString();
    const sent = new Set<string>();

    if (!cancellation.notificationState.buyerAcceptedSentAt) {
      await this.notificationService.sendSystemNotification(
        buyerId,
        "ticket_cancelled",
        cancellation.requestedAmountMinor > 0
          ? "Your ticket has been cancelled. The QR code is no longer valid and your refund is being prepared."
          : "Your ticket has been cancelled. The QR code is no longer valid.",
        {
          title: "Ticket cancelled",
          eventId,
          orderId,
          refundId: cancellationId,
          refundStatus: cancellation.refundStatus,
          deepLink: `/event-screen/ticket-detail?orderId=${encodeURIComponent(orderId)}`,
          sourceKey: `ticket-cancelled-buyer:${cancellationId}`,
        },
      );
      sent.add(buyerId);
      await this.repository.update(cancellationId, {
        $set: { "notificationState.buyerAcceptedSentAt": new Date() },
        $push: {
          auditHistory: {
            action: "notification_sent",
            actorUserId: null,
            message: "Buyer ticket cancellation notification sent",
            metadata: null,
            createdAt: new Date(),
          },
        },
      });
    }

    if (cancellation.requestedAmountMinor > 0 && !cancellation.notificationState.buyerRefundProcessingSentAt) {
      await this.notificationService.sendSystemNotification(
        buyerId,
        "refund_processing",
        "Your ticket refund is being processed to your original payment method.",
        {
          title: "Refund processing",
          eventId,
          orderId,
          refundId: cancellationId,
          refundStatus: cancellation.refundStatus,
          deepLink: `/event-screen/ticket-detail?orderId=${encodeURIComponent(orderId)}`,
          sourceKey: `ticket-refund-processing:${cancellationId}`,
        },
      );
      await this.repository.update(cancellationId, {
        $set: { "notificationState.buyerRefundProcessingSentAt": new Date() },
        $push: {
          auditHistory: {
            action: "notification_sent",
            actorUserId: null,
            message: "Buyer ticket refund processing notification sent",
            metadata: null,
            createdAt: new Date(),
          },
        },
      });
    }

    if (recipientId && !sent.has(recipientId) && !cancellation.notificationState.recipientSentAt) {
      await this.notificationService.sendSystemNotification(
        recipientId,
        "ticket_cancelled",
        "A shared ticket was cancelled by the original buyer. The QR code is no longer valid.",
        {
          title: "Shared ticket cancelled",
          eventId,
          orderId,
          deepLink: "/event-screen/wallet",
          sourceKey: `ticket-cancelled-recipient:${cancellationId}:${recipientId}`,
        },
      );
      sent.add(recipientId);
      await this.repository.update(cancellationId, {
        $set: { "notificationState.recipientSentAt": new Date() },
        $push: {
          auditHistory: {
            action: "notification_sent",
            actorUserId: null,
            message: "Shared recipient ticket cancellation notification sent",
            metadata: null,
            createdAt: new Date(),
          },
        },
      });
    }

    if (!sent.has(hostId) && !cancellation.notificationState.hostSentAt) {
      await this.notificationService.sendSystemNotification(
        hostId,
        "ticket_cancelled",
        "A ticket for your event has been cancelled and returned to availability.",
        {
          title: "Ticket cancelled",
          eventId,
          orderId,
          deepLink: `/event-screen/event?id=${encodeURIComponent(eventId)}`,
          sourceKey: `ticket-cancelled-host:${cancellationId}:${hostId}`,
        },
      );
      await this.repository.update(cancellationId, {
        $set: { "notificationState.hostSentAt": new Date() },
        $push: {
          auditHistory: {
            action: "notification_sent",
            actorUserId: null,
            message: "Host ticket cancellation notification sent",
            metadata: null,
            createdAt: new Date(),
          },
        },
      });
    }
  }

  private async sendBuyerCompletedNotification(cancellation: ITicketCancellation): Promise<void> {
    if (cancellation.requestedAmountMinor <= 0) {
      return;
    }

    await this.refundReceiptService.enqueueForTicketCancellation(cancellation).catch((error) => {
      logger.error(
        { error, ticketCancellationId: cancellation._id.toString(), orderId: cancellation.orderId.toString() },
        "Failed to enqueue ticket cancellation refund receipt",
      );
    });

    if (cancellation.notificationState.buyerRefundCompletedSentAt) {
      return;
    }

    const amount = (cancellation.completedAmountMinor / 100).toLocaleString("en-US", {
      style: "currency",
      currency: cancellation.currency.toUpperCase(),
    });
    await this.notificationService.sendSystemNotification(
      cancellation.buyerUserId.toString(),
      "refund_completed",
      `${amount} has been refunded to your original payment method. Bank processing time may vary.`,
      {
        title: "Refund completed",
        eventId: cancellation.eventId.toString(),
        orderId: cancellation.orderId.toString(),
        refundId: cancellation._id.toString(),
        refundStatus: "succeeded",
        deepLink: `/event-screen/ticket-detail?orderId=${encodeURIComponent(cancellation.orderId.toString())}`,
        sourceKey: `ticket-refund-completed:${cancellation._id.toString()}`,
      },
    );
    await this.repository.update(cancellation._id.toString(), {
      $set: { "notificationState.buyerRefundCompletedSentAt": new Date() },
      $push: {
        auditHistory: {
          action: "notification_sent",
          actorUserId: null,
          message: "Buyer ticket refund completed notification sent",
          metadata: null,
          createdAt: new Date(),
        },
      },
    });
  }

  private async sendBuyerNeedsAttentionNotification(cancellation: ITicketCancellation): Promise<void> {
    if (cancellation.requestedAmountMinor <= 0 || cancellation.notificationState.buyerNeedsAttentionSentAt) {
      return;
    }

    await this.notificationService.sendSystemNotification(
      cancellation.buyerUserId.toString(),
      "refund_needs_attention",
      "Your ticket refund requires additional processing and is being reviewed.",
      {
        title: "Refund update",
        eventId: cancellation.eventId.toString(),
        orderId: cancellation.orderId.toString(),
        refundId: cancellation._id.toString(),
        refundStatus: cancellation.refundStatus,
        deepLink: `/event-screen/ticket-detail?orderId=${encodeURIComponent(cancellation.orderId.toString())}`,
        sourceKey: `ticket-refund-needs-attention:${cancellation._id.toString()}`,
      },
    );
    await this.repository.update(cancellation._id.toString(), {
      $set: { "notificationState.buyerNeedsAttentionSentAt": new Date() },
      $push: {
        auditHistory: {
          action: "notification_sent",
          actorUserId: null,
          message: "Buyer ticket refund needs-attention notification sent",
          metadata: null,
          createdAt: new Date(),
        },
      },
    });
  }

  private async getBuyerMap(cancellations: ITicketCancellation[]): Promise<Map<string, IUser>> {
    const buyerIds = [...new Set(cancellations.map((item) => item.buyerUserId.toString()))];
    const buyers = await this.userRepository.findByIds(buyerIds);
    return new Map(buyers.map((buyer) => [buyer._id.toString(), buyer]));
  }

  private getActionCapabilities(cancellation: ITicketCancellation): { canRetry: boolean; canReconcile: boolean; canResume: boolean } {
    const monetary = cancellation.requestedAmountMinor > 0;
    const lockActive = cancellation.lockExpiresAt ? cancellation.lockExpiresAt.getTime() > Date.now() : false;
    const retryableStatus = ["failed_retryable", "failed_terminal", "reconciliation_required"].includes(cancellation.refundStatus);
    const reconcilableStatus = (
      cancellation.refundStatus === "reconciliation_required"
      || cancellation.refundStatus === "failed_retryable"
      || cancellation.refundStatus === "failed_terminal"
      || (cancellation.refundStatus === "processing" && !lockActive)
    );

    return {
      canRetry: monetary && !lockActive && retryableStatus,
      canReconcile: monetary && !lockActive && reconcilableStatus,
      canResume: false,
    };
  }

  private toBuyerResponse(buyer: IUser | null, buyerUserId: string): TicketCancellationResponse["buyer"] {
    if (!buyer) {
      return {
        id: buyerUserId,
        name: "Unknown user",
        email: null,
        username: null,
      };
    }

    return {
      id: buyer._id.toString(),
      name: buyer.name ?? "Unknown user",
      email: buyer.email ?? null,
      username: buyer.username ?? null,
    };
  }

  private toResponse(
    cancellation: ITicketCancellation,
    buyer: IUser | null = null,
    options: { includeAdminOperationalFields?: boolean } = {},
  ): TicketCancellationResponse {
    const buyerUserId = cancellation.buyerUserId.toString();
    const capabilities = this.getActionCapabilities(cancellation);

    return {
      id: cancellation._id.toString(),
      sourceType: cancellation.sourceType,
      eventId: cancellation.eventId.toString(),
      ticketId: cancellation.ticketId,
      orderId: cancellation.orderId.toString(),
      ticketIndex: cancellation.ticketIndex,
      buyerUserId,
      buyer: this.toBuyerResponse(buyer, buyerUserId),
      hostUserId: cancellation.hostUserId.toString(),
      sharedRecipientUserId: cancellation.sharedRecipientUserId?.toString() ?? null,
      eventName: cancellation.eventName ?? null,
      ticketName: cancellation.ticketName ?? null,
      ticketType: cancellation.ticketType ?? (cancellation.requestedAmountMinor > 0 ? "paid" : "free"),
      status: cancellation.status,
      refundStatus: cancellation.refundStatus,
      currency: cancellation.currency,
      stripePaymentIntentId: cancellation.stripePaymentIntentId ?? null,
      stripeRefundId: cancellation.stripeRefundId ?? null,
      requestedAmountMinor: cancellation.requestedAmountMinor,
      completedAmountMinor: cancellation.completedAmountMinor,
      remainingRefundableAmountMinor: cancellation.remainingRefundableAmountMinor,
      ticketSubtotalAmountMinor: cancellation.ticketSubtotalAmountMinor,
      platformFeeAmountMinor: cancellation.platformFeeAmountMinor,
      taxAmountMinor: cancellation.taxAmountMinor,
      discountAmountMinor: cancellation.discountAmountMinor,
      capacityReleaseStatus: cancellation.capacityReleaseStatus,
      shareRevocationStatus: cancellation.shareRevocationStatus,
      qrInvalidationStatus: cancellation.qrInvalidationStatus,
      attemptCount: cancellation.attemptCount,
      nextRetryAt: cancellation.nextRetryAt ?? null,
      lastErrorCode: cancellation.lastErrorCode ?? null,
      safeLastErrorMessage: cancellation.safeLastErrorMessage ?? null,
      providerStatus: cancellation.providerStatus ?? null,
      cancellationCutoffAt: cancellation.cancellationCutoffAt,
      cancelledAt: cancellation.cancelledAt,
      refundCompletedAt: cancellation.refundCompletedAt ?? null,
      ...(options.includeAdminOperationalFields ? { notificationState: cancellation.notificationState ?? {} } : {}),
      auditHistory: cancellation.auditHistory,
      ...capabilities,
      createdAt: cancellation.createdAt,
      updatedAt: cancellation.updatedAt,
    };
  }

  private getStripe(): StripeClient {
    if (this.stripe) return this.stripe;
    if (!env.STRIPE_SECRET_KEY || !env.STRIPE_PUBLISHABLE_KEY) {
      throw new AppError("Stripe is not configured", httpStatus.SERVICE_UNAVAILABLE);
    }

    this.stripe = new Stripe(env.STRIPE_SECRET_KEY, {
      appInfo: {
        name: env.APP_NAME,
      },
    });

    return this.stripe;
  }
}
