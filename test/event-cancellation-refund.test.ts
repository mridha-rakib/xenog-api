import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { EventCancellationRefundService } from "../src/modules/payments/event-cancellation-refund.service.js";
import {
  CANCELLATION_WORKFLOW_VERSION,
  eventCancellationReasonTypes,
  type EventCancellationReasonType,
} from "../src/modules/payments/event-cancellation-refund.interface.js";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

test.afterEach(async () => {
  const { RedisClient } = await import("../src/config/redis.js");
  await RedisClient.disconnect().catch(() => undefined);
});

const ownerId = new Types.ObjectId();
const eventId = new Types.ObjectId();
const batchId = new Types.ObjectId();
const orderId = new Types.ObjectId();
const buyerId = new Types.ObjectId();
const now = new Date("2026-07-20T12:00:00.000Z");

const owner = {
  id: ownerId.toString(),
  name: "Owner",
  username: "owner",
  email: "owner@example.com",
  accountType: "business",
  role: "user",
};

const createEvent = (overrides: Record<string, unknown> = {}) => ({
  _id: eventId,
  userId: ownerId,
  status: "published",
  scheduledAt: new Date("2026-07-21T12:00:00.000Z"),
  cancellationReasonType: null,
  cancellationCustomReason: null,
  cancellationDisplayReason: null,
  refundBatchId: null,
  cancellationOperationId: null,
  cancellationWorkflowVersion: null,
  ...overrides,
});

const createCancelledEvent = (reasonType: EventCancellationReasonType, displayReason: string) =>
  createEvent({
    status: "cancelled",
    cancellationReasonType: reasonType,
    cancellationCustomReason: reasonType === "Other" ? displayReason : null,
    cancellationDisplayReason: displayReason,
    refundBatchId: batchId,
    cancellationOperationId: "operation-test",
    cancellationWorkflowVersion: CANCELLATION_WORKFLOW_VERSION,
  });

const createBatch = (reasonType: EventCancellationReasonType, displayReason: string, status = "pending") => ({
  _id: batchId,
  eventId,
  hostUserId: ownerId,
  actorUserId: ownerId,
  cancellationOperationId: "operation-test",
  workflowVersion: CANCELLATION_WORKFLOW_VERSION,
  reasonType,
  customReason: reasonType === "Other" ? displayReason : null,
  displayReason,
  status,
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
  auditHistory: [],
  createdAt: now,
  updatedAt: now,
});

const createOrder = (overrides: Record<string, unknown> = {}) => ({
  _id: orderId,
  userId: buyerId,
  kind: "ticket",
  paymentMethod: "card",
  paymentStatus: "paid",
  currency: "usd",
  taxAmount: 1.23,
  amountMinor: 1234,
  stripePaymentIntentId: "pi_test",
  lineItems: [{
    itemType: "ticket",
    eventId: eventId.toString(),
    itemId: "ticket-1",
    name: "General",
    quantity: 2,
    paidQuantity: 1,
    freeQuantity: 1,
    totalQuantity: 2,
    unitAmount: 10,
    totalAmount: 10,
  }],
  ...overrides,
});

const createService = (overrides: {
  orders?: unknown[];
  event?: Record<string, unknown> | null;
  existingBatch?: Record<string, unknown> | null;
  existingRefundItems?: Record<string, unknown>[];
  onRefundItem?: (payload: Record<string, unknown>) => void;
  onTaxReversal?: (payload: Record<string, unknown>) => void;
  onBatchAborted?: (message: string) => void;
  onBatchAnomaly?: (message: string) => void;
  onNotification?: (type: string, message: string, options?: Record<string, unknown>) => void;
} = {}) => {
  const orders = overrides.orders ?? [];
  const refundItems: Record<string, unknown>[] = [...(overrides.existingRefundItems ?? [])];
  let event = overrides.event ?? createEvent();
  let batch = overrides.existingBatch ?? null;

  const repository = {
    findBatchByEventId: async () => batch,
    findBatchById: async () => batch,
    createOrGetBatch: async (payload: { reasonType: EventCancellationReasonType; displayReason: string; status?: string }) => {
      batch = createBatch(payload.reasonType, payload.displayReason, payload.status ?? "pending");
      return batch;
    },
    markBatchPending: async () => {
      batch = { ...(batch ?? createBatch("Schedule conflict", "Schedule conflict")), status: "pending" };
      return batch;
    },
    markBatchAborted: async () => {
      batch = { ...(batch ?? createBatch("Schedule conflict", "Schedule conflict")), status: "aborted" };
      overrides.onBatchAborted?.("aborted");
      return batch;
    },
    findInitializingBatches: async () => batch?.status === "initializing" ? [batch] : [],
    upsertRefundItem: async (payload: Record<string, unknown>) => {
      overrides.onRefundItem?.(payload);
      const existing = refundItems.find((item) => item.checkoutOrderId === payload.checkoutOrderId);
      if (existing) return existing;
      const item = {
        _id: new Types.ObjectId(),
        ...payload,
        status: "pending",
        attemptCount: 0,
        previouslyRefundedAmountMinor: 0,
        completedAmountMinor: 0,
        remainingRefundableAmountMinor: payload.requestedAmountMinor,
        notificationState: {},
        auditHistory: [],
        createdAt: now,
        updatedAt: now,
      };
      refundItems.push(item);
      return item;
    },
    upsertTaxReversal: async (payload: Record<string, unknown>) => {
      overrides.onTaxReversal?.(payload);
      return {
        _id: new Types.ObjectId(),
        ...payload,
        status: payload.reversedTaxAmountMinor ? "pending" : "not_applicable",
        auditHistory: [],
        createdAt: now,
        updatedAt: now,
      };
    },
    findRefundItemsByBatchId: async () => refundItems,
    updateRefundItem: async (refundItemId: string, update: { $set?: Record<string, unknown>; $push?: Record<string, unknown> }) => {
      const item = refundItems.find((candidate) => candidate._id?.toString() === refundItemId);
      if (!item) return null;
      for (const [path, value] of Object.entries(update.$set ?? {})) {
        if (path === "notificationState.processingSentAt") {
          item.notificationState = { ...((item.notificationState as Record<string, unknown>) ?? {}), processingSentAt: value };
        }
      }
      return item;
    },
    recalculateBatch: async () => batch ?? createBatch("Schedule conflict", "Schedule conflict"),
    appendBatchAudit: async () => undefined,
    setBatchAnomaly: async (_batchId: string, message: string) => {
      overrides.onBatchAnomaly?.(message);
      return batch;
    },
    findNonFinalRefunds: async () => [],
  };
  const eventRepository = {
    findByIdForUser: async () => event,
    findById: async () => event,
    findRecoverableNewSystemCancelled: async () => [],
    cancelPublishedBeforeStartById: async (
      _eventId: string,
      _ownerId: string,
      reason: { reasonType: EventCancellationReasonType; displayReason: string; customReason?: string | null },
      workflow?: { refundBatchId: string; cancellationOperationId: string; cancellationWorkflowVersion: number },
    ) => {
      if (event?.status !== "published") return null;
      event = {
        ...createCancelledEvent(reason.reasonType, reason.displayReason),
        cancellationCustomReason: reason.customReason ?? null,
        refundBatchId: new Types.ObjectId(workflow?.refundBatchId ?? batchId.toString()),
        cancellationOperationId: workflow?.cancellationOperationId ?? "operation-test",
        cancellationWorkflowVersion: workflow?.cancellationWorkflowVersion ?? CANCELLATION_WORKFLOW_VERSION,
      };
      return event;
    },
    releaseTicketCapacity: async () => undefined,
  };
  const checkoutRepository = {
    findPaidTicketOrdersByEventId: async () => orders,
  };
  const earningRepository = {
    countWithdrawnByEventId: async () => 0,
    markRefundedByEventId: async () => undefined,
  };
  const ticketShareRepository = {
    findActiveByEventId: async () => [],
    cancelActiveByEventId: async () => 0,
  };
  const notificationService = {
    sendSystemNotification: async (_recipientId: string, type: string, message: string, options?: Record<string, unknown>) =>
      overrides.onNotification?.(type, message, options),
  };

  return new EventCancellationRefundService(
    repository as never,
    eventRepository as never,
    checkoutRepository as never,
    earningRepository as never,
    ticketShareRepository as never,
    notificationService as never,
  );
};

test("cancellation accepts every predefined reason and persists display reason", async () => {
  for (const reasonType of eventCancellationReasonTypes) {
    const customReason = reasonType === "Other" ? "Weather-related vendor issue" : null;
    const service = createService();
    const result = await service.cancelPublishedEvent(owner as never, eventId.toString(), { reasonType, customReason });

    assert.equal(result.event.cancellationReasonType, reasonType);
    assert.equal(result.event.cancellationDisplayReason, reasonType === "Other" ? customReason : reasonType);
    assert.equal(result.event.cancellationWorkflowVersion, CANCELLATION_WORKFLOW_VERSION);
    assert.ok(result.event.refundBatchId);
  }
});

test("Other cancellation reason requires non-whitespace custom text", async () => {
  const service = createService();

  await assert.rejects(
    () => service.cancelPublishedEvent(owner as never, eventId.toString(), { reasonType: "Other", customReason: "   " }),
    /Custom reason is required/i,
  );
});

test("paid event order creates one refund item for captured minor amount and internal tax reversal", async () => {
  let refundPayload: Record<string, unknown> | null = null;
  let taxPayload: Record<string, unknown> | null = null;
  const service = createService({
    orders: [createOrder()],
    onRefundItem: (payload) => {
      refundPayload = payload;
    },
    onTaxReversal: (payload) => {
      taxPayload = payload;
    },
  });

  await service.cancelPublishedEvent(owner as never, eventId.toString(), { reasonType: "Safety concern" });

  assert.equal(refundPayload?.checkoutOrderId, orderId.toString());
  assert.equal(refundPayload?.requestedAmountMinor, 1234);
  assert.equal(refundPayload?.originalCapturedAmountMinor, 1234);
  assert.equal(refundPayload?.currency, "usd");
  assert.match(String(refundPayload?.providerIdempotencyKey), /^event-cancellation-refund:/);
  assert.equal(taxPayload?.originalTaxAmountMinor, 123);
  assert.equal(taxPayload?.reversedTaxAmountMinor, 123);
});

test("duplicate new-system cancellation resumes existing batch without duplicate notifications", async () => {
  let notificationCount = 0;
  const existingRefundItem = {
    _id: new Types.ObjectId(),
    eventId,
    batchId,
    checkoutOrderId: orderId,
    originalPayerUserId: buyerId,
    stripePaymentIntentId: "pi_test",
    providerIdempotencyKey: "event-cancellation-refund:test",
    currency: "usd",
    originalCapturedAmountMinor: 1234,
    requestedAmountMinor: 1234,
    previouslyRefundedAmountMinor: 0,
    completedAmountMinor: 0,
    remainingRefundableAmountMinor: 1234,
    status: "pending",
    attemptCount: 0,
    notificationState: { processingSentAt: now },
    auditHistory: [],
    createdAt: now,
    updatedAt: now,
  };
  const service = createService({
    event: createCancelledEvent("Organizer issue", "Organizer issue"),
    existingBatch: createBatch("Organizer issue", "Organizer issue"),
    existingRefundItems: [existingRefundItem],
    orders: [createOrder()],
    onNotification: () => {
      notificationCount += 1;
    },
  });

  const result = await service.cancelPublishedEvent(owner as never, eventId.toString(), { reasonType: "Organizer issue" });

  assert.equal(result.batch.id, batchId.toString());
  assert.equal(notificationCount, 0);
});

test("legacy cancelled event without workflow marker does not create refund work", async () => {
  const service = createService({
    event: createEvent({ status: "cancelled", cancellationWorkflowVersion: null }),
    orders: [createOrder()],
  });

  await assert.rejects(
    () => service.cancelPublishedEvent(owner as never, eventId.toString(), { reasonType: "Venue unavailable" }),
    /not managed by the refund workflow/i,
  );
});

test("late payment on legacy cancelled event is flagged without refund item creation", async () => {
  let refundCount = 0;
  let anomalyCount = 0;
  const service = createService({
    event: createEvent({ status: "cancelled", cancellationWorkflowVersion: null }),
    onRefundItem: () => {
      refundCount += 1;
    },
    onBatchAnomaly: (message) => {
      if (/legacy-cancelled event/i.test(message)) anomalyCount += 1;
    },
  });

  await service.ensureLatePaymentRefund(createOrder() as never, createEvent({ status: "cancelled", cancellationWorkflowVersion: null }) as never);

  assert.equal(refundCount, 0);
  assert.equal(anomalyCount, 1);
});

test("recoverCancellationWorkflows completes an initializing batch before refunds run", async () => {
  let refundCount = 0;
  const service = createService({
    event: createEvent(),
    existingBatch: createBatch("Schedule conflict", "Schedule conflict", "initializing"),
    orders: [createOrder()],
    onRefundItem: () => {
      refundCount += 1;
    },
  });

  const recovered = await service.recoverCancellationWorkflows();

  assert.equal(recovered, 1);
  assert.equal(refundCount, 1);
});
