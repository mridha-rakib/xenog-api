import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import type { IRefundReceipt } from "../src/modules/payments/refund-receipt.interface.js";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const ticketCancellationId = new Types.ObjectId("64f100000000000000000001");
const eventRefundId = new Types.ObjectId("64f100000000000000000002");
const orderId = new Types.ObjectId("64f10000000000000000abcd");
const eventId = new Types.ObjectId("64f100000000000000000003");
const buyerId = new Types.ObjectId("64f100000000000000000004");
const hostId = new Types.ObjectId("64f100000000000000000005");
const sharedRecipientId = new Types.ObjectId("64f100000000000000000006");

type MemoryReceiptPayload = {
  idempotencyKey: string;
  sourceType: IRefundReceipt["sourceType"];
  sourceRefundId: string;
  payerUserId: string;
  toEmail: string;
  receiptReference: string;
  orderReference: string;
  snapshot: IRefundReceipt["snapshot"];
};

type MemoryReceiptUpdate = { $set?: Partial<IRefundReceipt> };

const createMemoryReceiptRepository = () => {
  const byKey = new Map<string, IRefundReceipt>();
  const updates: Array<{ id: string; update: MemoryReceiptUpdate }> = [];
  return {
    byKey,
    updates,
    async createOrGet(payload: MemoryReceiptPayload) {
      const existing = byKey.get(payload.idempotencyKey);
      if (existing) return existing;
      const receipt = {
        _id: new Types.ObjectId(),
        ...payload,
        status: "pending",
        attemptCount: 0,
        nextRetryAt: new Date(),
        lockedAt: null,
        sentAt: null,
        lastError: null,
        createdAt: new Date("2026-08-01T10:00:00.000Z"),
        updatedAt: new Date("2026-08-01T10:00:00.000Z"),
      } as unknown as IRefundReceipt;
      byKey.set(payload.idempotencyKey, receipt);
      return receipt;
    },
    async findByIdempotencyKey(idempotencyKey: string) {
      return byKey.get(idempotencyKey) ?? null;
    },
    async claimDue() {
      return [...byKey.values()].filter((receipt) => receipt.status === "sending");
    },
    async update(id: string, update: MemoryReceiptUpdate) {
      updates.push({ id, update });
      const receipt = [...byKey.values()].find((row) => row._id.toString() === id);
      if (!receipt) return null;
      if (update.$set) Object.assign(receipt, update.$set);
      return receipt;
    },
  };
};

const createTicketCancellation = (overrides: Record<string, unknown> = {}) => ({
  _id: ticketCancellationId,
  sourceType: "user_ticket_cancellation",
  eventId,
  ticketId: "vip-ticket",
  orderId,
  ticketIndex: 1,
  buyerUserId: buyerId,
  hostUserId: hostId,
  sharedRecipientUserId: sharedRecipientId,
  eventName: "Launch <Night>",
  ticketName: "VIP <Pass>",
  ticketType: "paid",
  status: "cancelled",
  refundStatus: "succeeded",
  currency: "usd",
  stripePaymentIntentId: "pi_hidden",
  stripeRefundId: "re_hidden",
  providerIdempotencyKey: "private-key",
  providerStatus: "succeeded",
  ticketSubtotalAmountMinor: 4500,
  platformFeeAmountMinor: 450,
  taxAmountMinor: 225,
  discountAmountMinor: 500,
  requestedAmountMinor: 4675,
  completedAmountMinor: 4675,
  remainingRefundableAmountMinor: 0,
  orderCapturedAmountMinor: 10000,
  previousCancellationAmountMinor: 0,
  capacityReleaseStatus: "completed",
  shareRevocationStatus: "completed",
  qrInvalidationStatus: "completed",
  creatorEarningAdjustmentStatus: "completed",
  taxReversalStatus: "completed",
  notificationState: {},
  attemptCount: 1,
  cancellationCutoffAt: new Date("2026-08-01T09:00:00.000Z"),
  cancelledAt: new Date("2026-07-31T09:00:00.000Z"),
  refundCompletedAt: new Date("2026-07-31T09:05:00.000Z"),
  lastReconciledAt: null,
  auditHistory: [],
  createdAt: new Date("2026-07-31T09:00:00.000Z"),
  updatedAt: new Date("2026-07-31T09:05:00.000Z"),
  ...overrides,
});

const createOrder = (overrides: Record<string, unknown> = {}) => ({
  _id: orderId,
  userId: buyerId,
  kind: "ticket",
  paymentMethod: "card",
  paymentStatus: "paid",
  payoutStatus: "held",
  currency: "usd",
  subtotalAmount: 90,
  platformFeeAmount: 9,
  taxAmount: 4.5,
  discountAmount: 0,
  totalAmount: 103.5,
  amountMinor: 10350,
  lineItems: [
    {
      itemType: "ticket",
      eventId: eventId.toString(),
      itemId: "vip-ticket",
      name: "VIP",
      quantity: 2,
      paidQuantity: 2,
      freeQuantity: 0,
      totalQuantity: 2,
      unitAmount: 45,
      totalAmount: 90,
    },
  ],
  ticketPasses: [],
  anonymous: false,
  paidAt: new Date("2026-07-30T10:00:00.000Z"),
  createdAt: new Date("2026-07-30T09:58:00.000Z"),
  updatedAt: new Date("2026-07-30T10:00:00.000Z"),
  ...overrides,
});

const createEvent = () => ({
  _id: eventId,
  userId: hostId,
  name: "Launch <Night>",
  scheduledAt: new Date("2026-08-02T20:00:00.000Z"),
  endAt: new Date("2026-08-02T23:00:00.000Z"),
  location: {
    venue: "Main <Hall>",
    formattedAddress: "123 Test St",
  },
  tickets: [{ id: "vip-ticket", name: "VIP", type: "pay", price: 45, capacity: 10, availableCount: 8 }],
});

const createService = async (options: {
  repository?: ReturnType<typeof createMemoryReceiptRepository>;
  emailService?: { sendMail(payload: { to: string; subject: string; text: string; html: string }): Promise<void> };
  ticketCancellations?: Array<ReturnType<typeof createTicketCancellation>>;
} = {}) => {
  const { RefundReceiptService } = await import("../src/modules/payments/refund-receipt.service.js");
  const repository = options.repository ?? createMemoryReceiptRepository();
  const users = new Map([
    [buyerId.toString(), { _id: buyerId, name: "Buyer <One>", email: "buyer@example.com" }],
    [hostId.toString(), { _id: hostId, name: "Host <Person>", email: "host@example.com" }],
    [sharedRecipientId.toString(), { _id: sharedRecipientId, name: "Shared User", email: "shared@example.com" }],
  ]);
  const service = new RefundReceiptService(
    repository as never,
    { findById: async (id: string) => users.get(id) ?? null } as never,
    { findById: async () => createEvent() } as never,
    { findById: async () => createOrder() } as never,
    { findTaxReversalsByRefundItemIds: async () => [{ refundItemId: eventRefundId, reversedTaxAmountMinor: 450, currency: "usd", status: "completed" }] } as never,
    { findByOrderId: async () => options.ticketCancellations ?? [] } as never,
    options.emailService ?? { sendMail: async () => undefined } as never,
  );
  return { service, repository };
};

test("ticket cancellation refund receipt snapshots exact stored breakdown and original payer", async () => {
  const { service, repository } = await createService();
  const receipt = await service.enqueueForTicketCancellation(createTicketCancellation() as never);

  assert.ok(receipt);
  assert.equal(repository.byKey.size, 1);
  assert.equal(receipt?.toEmail, "buyer@example.com");
  assert.equal(receipt?.snapshot.buyerEmail, "buyer@example.com");
  assert.equal(receipt?.snapshot.context, "Ticket cancelled by buyer");
  assert.equal(receipt?.snapshot.orderReference, "XG-0000ABCD");
  assert.match(receipt?.snapshot.receiptReference ?? "", /^RF-2026-[0-9A-F]{6}$/);
  assert.deepEqual(receipt?.snapshot.items, [{
    name: "VIP <Pass>",
    type: "paid",
    passLabel: "Pass 1",
    quantity: 1,
  }]);
  assert.equal(receipt?.snapshot.financial.subtotalAmountMinor, 4500);
  assert.equal(receipt?.snapshot.financial.platformFeeAmountMinor, 450);
  assert.equal(receipt?.snapshot.financial.taxAmountMinor, 225);
  assert.equal(receipt?.snapshot.financial.discountAmountMinor, 500);
  assert.equal(receipt?.snapshot.financial.completedAmountMinor, 4675);
});

test("refund receipt renderer escapes user content and hides raw ids/provider ids", async () => {
  const { service } = await createService();
  const receipt = await service.enqueueForTicketCancellation(createTicketCancellation() as never);
  assert.ok(receipt);

  const html = service.renderHtml(receipt);
  const text = service.renderText(receipt);

  assert.match(html, /Buyer &lt;One&gt;/);
  assert.match(html, /Launch &lt;Night&gt;/);
  assert.doesNotMatch(html, new RegExp(orderId.toString()));
  assert.doesNotMatch(text, new RegExp(orderId.toString()));
  assert.doesNotMatch(html, /pi_hidden|re_hidden|private-key|vip-ticket/);
  assert.doesNotMatch(text, /pi_hidden|re_hidden|private-key|vip-ticket/);
  assert.match(text, /Pass 1/);
  assert.match(text, /Total refunded: \$46\.75/);
});

test("pending failed and zero-money refunds do not enqueue receipts", async () => {
  const { service, repository } = await createService();

  assert.equal(await service.enqueueForTicketCancellation(createTicketCancellation({ refundStatus: "processing" }) as never), null);
  assert.equal(await service.enqueueForTicketCancellation(createTicketCancellation({ refundStatus: "failed_retryable" }) as never), null);
  assert.equal(await service.enqueueForTicketCancellation(createTicketCancellation({ requestedAmountMinor: 0, completedAmountMinor: 0, refundStatus: "not_required" }) as never), null);
  assert.equal(repository.byKey.size, 0);
});

test("duplicate ticket cancellation success observations reuse one receipt", async () => {
  const { service, repository } = await createService();
  const first = await service.enqueueForTicketCancellation(createTicketCancellation() as never);
  const second = await service.enqueueForTicketCancellation(createTicketCancellation() as never);

  assert.equal(repository.byKey.size, 1);
  assert.equal(first?._id.toString(), second?._id.toString());
  assert.equal(first?.snapshot.receiptReference, second?.snapshot.receiptReference);
});

test("event cancellation receipt is per order and summarizes affected remaining ticket quantities", async () => {
  const { service } = await createService({
    ticketCancellations: [createTicketCancellation({ ticketIndex: 1 })],
  });
  const receipt = await service.enqueueForEventCancellation({
    _id: eventRefundId,
    eventId,
    batchId: new Types.ObjectId(),
    checkoutOrderId: orderId,
    originalPayerUserId: buyerId,
    stripePaymentIntentId: "pi_hidden",
    stripeRefundId: "re_hidden",
    providerIdempotencyKey: "private-key",
    currency: "usd",
    originalCapturedAmountMinor: 5175,
    previouslyRefundedAmountMinor: 0,
    requestedAmountMinor: 5175,
    completedAmountMinor: 5175,
    remainingRefundableAmountMinor: 0,
    status: "succeeded",
    attemptCount: 1,
    providerStatus: "succeeded",
    paymentMethodLabel: "Card",
    notificationState: {},
    completedAt: new Date("2026-07-31T10:00:00.000Z"),
    auditHistory: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never);

  assert.ok(receipt);
  assert.equal(receipt?.snapshot.context, "Event cancelled by organizer");
  assert.equal(receipt?.snapshot.items.length, 1);
  assert.equal(receipt?.snapshot.items[0]?.name, "VIP");
  assert.equal(receipt?.snapshot.items[0]?.quantity, 1);
  assert.equal(receipt?.snapshot.financial.completedAmountMinor, 5175);
  assert.equal(receipt?.snapshot.financial.taxAmountMinor, 450);
});

test("processDueReceipts sends claimed receipts and marks sent", async () => {
  const repository = createMemoryReceiptRepository();
  let sent = 0;
  const { service } = await createService({
    repository,
    emailService: { sendMail: async () => { sent += 1; } },
  });
  const receipt = await service.enqueueForTicketCancellation(createTicketCancellation() as never);
  receipt!.status = "sending";

  const processed = await service.processDueReceipts();

  assert.equal(processed, 1);
  assert.equal(sent, 1);
  assert.equal(receipt?.status, "sent");
  assert.equal(receipt?.sentAt instanceof Date, true);
});

test("processDueReceipts records retryable email failure without throwing", async () => {
  const repository = createMemoryReceiptRepository();
  const { service } = await createService({
    repository,
    emailService: { sendMail: async () => { throw new Error("SMTP down"); } },
  });
  const receipt = await service.enqueueForTicketCancellation(createTicketCancellation() as never);
  receipt!.status = "sending";
  receipt!.attemptCount = 1;

  const processed = await service.processDueReceipts();

  assert.equal(processed, 1);
  assert.equal(receipt?.status, "failed_retryable");
  assert.equal(receipt?.lastError, "SMTP down");
  assert.equal(receipt?.sentAt, null);
});
