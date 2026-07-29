import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { checkoutPaymentValidation } from "../src/modules/payments/checkout-payment.validation.js";
import {
  ADMIN_TICKET_CANCELLATION_SORT,
  buildAdminTicketCancellationFilter,
  buildAdminTicketCancellationSearchPipeline,
} from "../src/modules/payments/ticket-cancellation.repository.js";
import { TicketCancellationService } from "../src/modules/payments/ticket-cancellation.service.js";
import type { ITicketCancellation } from "../src/modules/payments/ticket-cancellation.interface.js";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const eventId = new Types.ObjectId("64f000000000000000001001");
const buyerUserId = new Types.ObjectId("64f000000000000000001002");
const orderId = new Types.ObjectId("64f000000000000000001003");
const hostUserId = new Types.ObjectId("64f000000000000000001004");

const createCancellation = (overrides: Partial<ITicketCancellation> = {}): ITicketCancellation => ({
  _id: new Types.ObjectId("64f000000000000000001005"),
  sourceType: "user_ticket_cancellation",
  eventId,
  ticketId: "general",
  orderId,
  ticketIndex: 2,
  buyerUserId,
  hostUserId,
  sharedRecipientUserId: null,
  activeShareId: null,
  eventName: "Admin Search Night",
  ticketName: "General Admission",
  ticketType: "free",
  status: "cancelled",
  refundStatus: "not_required",
  currency: "usd",
  stripePaymentIntentId: null,
  stripeRefundId: null,
  providerIdempotencyKey: "ticket-cancellation-refund:admin-search",
  providerStatus: null,
  ticketSubtotalAmountMinor: 0,
  platformFeeAmountMinor: 0,
  taxAmountMinor: 0,
  discountAmountMinor: 0,
  requestedAmountMinor: 0,
  completedAmountMinor: 0,
  remainingRefundableAmountMinor: 0,
  orderCapturedAmountMinor: 0,
  previousCancellationAmountMinor: 0,
  capacityReleaseStatus: "completed",
  shareRevocationStatus: "not_required",
  qrInvalidationStatus: "completed",
  creatorEarningAdjustmentStatus: "not_required",
  taxReversalStatus: "not_required",
  notificationState: { buyerAcceptedSentAt: new Date("2026-07-30T10:00:00.000Z") },
  attemptCount: 0,
  nextRetryAt: null,
  lockedBy: null,
  lockedAt: null,
  lockExpiresAt: null,
  lastErrorCode: null,
  safeLastErrorMessage: null,
  cancellationCutoffAt: new Date("2026-08-01T09:00:00.000Z"),
  cancelledAt: new Date("2026-07-30T09:00:00.000Z"),
  refundCompletedAt: null,
  lastReconciledAt: null,
  auditHistory: [],
  createdAt: new Date("2026-07-30T09:00:00.000Z"),
  updatedAt: new Date("2026-07-30T09:00:00.000Z"),
  ...overrides,
});

const parseListQuery = (query: Record<string, unknown>) => checkoutPaymentValidation.listTicketCancellations.parse({ query });

test("admin ticket cancellation exact filters include monetary mode and pass identity filters", () => {
  const filter = buildAdminTicketCancellationFilter({
    monetary: "non_monetary",
    status: "cancelled",
    refundStatus: "not_required",
    ticketType: "free",
    eventId: eventId.toString(),
    buyerUserId: buyerUserId.toString(),
    orderId: orderId.toString(),
    ticketId: "general",
    ticketIndex: 2,
  });

  assert.equal(filter.requestedAmountMinor, 0);
  assert.equal(filter.status, "cancelled");
  assert.equal(filter.refundStatus, "not_required");
  assert.equal(filter.ticketType, "free");
  assert.equal(filter.ticketId, "general");
  assert.equal(filter.ticketIndex, 2);
  assert.equal(filter.eventId?.toString(), eventId.toString());
  assert.equal(filter.buyerUserId?.toString(), buyerUserId.toString());
  assert.equal(filter.orderId?.toString(), orderId.toString());
});

test("admin ticket cancellation monetary filters keep default, monetary and all modes distinct", () => {
  assert.deepEqual(buildAdminTicketCancellationFilter({}).requestedAmountMinor, { $gt: 0 });
  assert.deepEqual(buildAdminTicketCancellationFilter({ monetary: "monetary" }).requestedAmountMinor, { $gt: 0 });
  assert.equal(buildAdminTicketCancellationFilter({ monetary: "non_monetary" }).requestedAmountMinor, 0);
  assert.equal(buildAdminTicketCancellationFilter({ monetary: "all" }).requestedAmountMinor, undefined);
});

test("admin ticket cancellation search pipeline covers buyer, order, event, ticket and pass fields", () => {
  const pipeline = buildAdminTicketCancellationSearchPipeline({
    monetary: "non_monetary",
    search: "Buyer Example",
  });
  const encoded = JSON.stringify(pipeline);

  assert.match(encoded, /"\$lookup"/);
  assert.match(encoded, /"from":"users"/);
  assert.match(encoded, /buyerSearchUser\.name/);
  assert.match(encoded, /buyerSearchUser\.email/);
  assert.match(encoded, /buyerSearchUser\.username/);
  assert.match(encoded, /orderIdSearch/);
  assert.match(encoded, /eventIdSearch/);
  assert.match(encoded, /ticketIndexSearch/);
  assert.match(encoded, /passIdentitySearch/);
  assert.match(encoded, /ticketTypeSearch/);
  assert.match(encoded, /ticketId/);
  assert.match(encoded, /ticketName/);
  assert.match(encoded, /eventName/);
  assert.match(encoded, /providerStatus/);
});

test("admin ticket cancellation search escapes regex characters and trims input", () => {
  const pipeline = buildAdminTicketCancellationSearchPipeline({
    search: "  buyer+test@example.com (vip)?  ",
  });
  const searchMatch = pipeline.find((stage) => "$match" in stage && "$or" in (stage.$match as Record<string, unknown>)) as {
    $match: { $or: Array<{ ticketId?: { $regex: string } }> };
  };
  const regexValue = searchMatch.$match.$or[0]?.ticketId?.$regex;

  assert.equal(regexValue, "buyer\\+test@example\\.com \\(vip\\)\\?");
  assert.doesNotMatch(regexValue || "", /  buyer/);
});

test("admin ticket cancellation search combines exact filters with AND semantics", () => {
  const pipeline = buildAdminTicketCancellationSearchPipeline({
    monetary: "monetary",
    eventId: eventId.toString(),
    buyerUserId: buyerUserId.toString(),
    orderId: orderId.toString(),
    refundStatus: "failed_retryable",
    search: "general",
  });
  const match = pipeline[0] as { $match: Record<string, unknown> };
  const searchMatch = pipeline.find((stage) => "$match" in stage && "$or" in (stage.$match as Record<string, unknown>)) as {
    $match: { $or: unknown[] };
  };

  assert.equal(match.$match.eventId?.toString(), eventId.toString());
  assert.equal(match.$match.buyerUserId?.toString(), buyerUserId.toString());
  assert.equal(match.$match.orderId?.toString(), orderId.toString());
  assert.equal(match.$match.refundStatus, "failed_retryable");
  assert.deepEqual(match.$match.requestedAmountMinor, { $gt: 0 });
  assert.ok(Array.isArray(searchMatch.$match.$or));
});

test("admin ticket cancellation search pipeline does not unwind buyer lookup or duplicate rows", () => {
  const pipeline = buildAdminTicketCancellationSearchPipeline({ search: "buyer@example.com" });
  const encoded = JSON.stringify(pipeline);

  assert.doesNotMatch(encoded, /"\$unwind"/);
});

test("admin ticket cancellation list service preserves defaults, pagination and admin-only operational fields", async () => {
  const cancellation = createCancellation();
  let capturedQuery: unknown;
  let capturedSkip = -1;
  let capturedLimit = -1;
  const service = new TicketCancellationService(
    {
      listAdmin: async (query: unknown, skip: number, limit: number) => {
        capturedQuery = query;
        capturedSkip = skip;
        capturedLimit = limit;
        return { cancellations: [cancellation], total: 1 };
      },
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {
      findByIds: async () => [{
        _id: buyerUserId,
        name: "Buyer Example",
        email: "buyer@example.com",
        username: "buyer",
      }],
    } as never,
  );

  const result = await service.listAdminCancellations({ page: 2, limit: 5, search: "buyer@example.com" });

  assert.deepEqual(capturedQuery, {
    page: 2,
    limit: 5,
    search: "buyer@example.com",
    sourceType: "user_ticket_cancellation",
    monetary: "monetary",
  });
  assert.equal(capturedSkip, 5);
  assert.equal(capturedLimit, 5);
  assert.equal(result.pagination.page, 2);
  assert.equal(result.pagination.total, 1);
  assert.equal(result.cancellations[0]?.buyer?.email, "buyer@example.com");
  assert.equal(result.cancellations[0]?.ticketType, "free");
  assert.equal(result.cancellations[0]?.notificationState?.buyerAcceptedSentAt?.toISOString(), "2026-07-30T10:00:00.000Z");
});

test("admin ticket cancellation detail includes buyer fallback and operational notification state", async () => {
  const cancellation = createCancellation();
  const service = new TicketCancellationService(
    { findById: async () => cancellation } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { findById: async () => null } as never,
  );

  const response = await service.getAdminCancellation(cancellation._id.toString());

  assert.equal(response.buyer?.id, buyerUserId.toString());
  assert.equal(response.buyer?.name, "Unknown user");
  assert.equal(response.notificationState?.buyerAcceptedSentAt?.toISOString(), "2026-07-30T10:00:00.000Z");
});

test("admin ticket cancellation query validation accepts final filters and rejects invalid values", () => {
  const parsed = parseListQuery({
    page: "1",
    limit: "100",
    monetary: "all",
    status: "cancelled",
    refundStatus: "not_required",
    ticketType: "free",
    eventId: eventId.toString(),
    buyerUserId: buyerUserId.toString(),
    orderId: orderId.toString(),
    ticketId: "general",
    ticketIndex: "2",
    search: " buyer@example.com ",
  });

  assert.equal(parsed.query.limit, 100);
  assert.equal(parsed.query.status, "cancelled");
  assert.equal(parsed.query.ticketType, "free");
  assert.equal(parsed.query.ticketIndex, 2);
  assert.equal(parsed.query.search, "buyer@example.com");
  assert.throws(() => parseListQuery({ ticketIndex: "abc" }));
  assert.throws(() => parseListQuery({ monetary: "free" }));
  assert.throws(() => parseListQuery({ status: "pending" }));
  assert.throws(() => parseListQuery({ ticketType: "vip" }));
  assert.throws(() => parseListQuery({ limit: "101" }));
  assert.throws(() => parseListQuery({ search: "x".repeat(121) }));
  assert.throws(() => parseListQuery({ unknown: "value" }));
});

test("admin ticket cancellation stable sort remains createdAt descending with id tiebreaker", () => {
  assert.deepEqual(ADMIN_TICKET_CANCELLATION_SORT, { createdAt: -1, _id: -1 });
});
