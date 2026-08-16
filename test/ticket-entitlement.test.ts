import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const eventId = new Types.ObjectId().toString();
const orderId = new Types.ObjectId();
const ownerId = new Types.ObjectId().toString();
const recipientId = new Types.ObjectId().toString();
const ticketId = "ticket-standard";

const paidOrder = (overrides: Record<string, unknown> = {}) => ({
  _id: orderId,
  userId: ownerId,
  kind: "ticket",
  paymentStatus: "paid",
  ticketPasses: [{ eventId, ticketId, ticketIndex: 1, checkInCode: "MOM-26-AAAA-AAAA" }],
  ...overrides,
});

const activeShare = (overrides: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  ownerUserId: ownerId,
  recipientUserId: recipientId,
  orderId,
  eventId,
  ticketId,
  ticketIndex: 1,
  status: "active",
  sharedAt: new Date(),
  ...overrides,
});

type Overrides = {
  order?: unknown;
  ownedOrders?: unknown[];
  activeSharesForRecipient?: unknown[];
  activeShareForPass?: unknown;
  cancelled?: boolean;
};

const createService = async (overrides: Overrides = {}) => {
  const { TicketEntitlementService } = await import("../src/modules/payments/ticket-entitlement.service.js");

  const checkoutPaymentRepository = {
    findById: async () => overrides.order ?? paidOrder(),
    findPaidTicketOrdersForUserAndEvent: async () => overrides.ownedOrders ?? [paidOrder()],
  };
  const ticketShareRepository = {
    findActiveByRecipientAndEvent: async () => overrides.activeSharesForRecipient ?? [],
    findActiveByTicketPass: async () => (
      Object.prototype.hasOwnProperty.call(overrides, "activeShareForPass") ? overrides.activeShareForPass : null
    ),
  };
  const ticketCancellationRepository = {
    existsByPass: async () => overrides.cancelled ?? false,
  };

  return new TicketEntitlementService(checkoutPaymentRepository, ticketShareRepository, ticketCancellationRepository);
};

test("original owner holds a valid entitlement when the pass has never been shared", async () => {
  const service = await createService();

  const entitlement = await service.findValidEntitlementForUser(ownerId, eventId);

  assert.deepEqual(entitlement, { orderId: orderId.toString(), ticketId, ticketIndex: 1, source: "owned" });
});

test("owner no longer holds a valid entitlement once the pass is actively shared away", async () => {
  const service = await createService({
    activeShareForPass: activeShare(),
  });

  const entitlement = await service.findValidEntitlementForUser(ownerId, eventId);

  assert.equal(entitlement, null);
});

test("Case A — share recipient holds a valid entitlement for the shared pass", async () => {
  const service = await createService({
    activeSharesForRecipient: [activeShare()],
  });

  const entitlement = await service.findValidEntitlementForUser(recipientId, eventId);

  assert.deepEqual(entitlement, { orderId: orderId.toString(), ticketId, ticketIndex: 1, source: "shared" });
});

test("a cancelled share leaves the recipient without an entitlement", async () => {
  const service = await createService({
    activeSharesForRecipient: [],
    ownedOrders: [],
  });

  const entitlement = await service.findValidEntitlementForUser(recipientId, eventId);

  assert.equal(entitlement, null);
});

test("a share for an unpaid/refunded order does not grant entitlement", async () => {
  const service = await createService({
    activeSharesForRecipient: [activeShare()],
    order: paidOrder({ paymentStatus: "refunded" }),
    ownedOrders: [],
  });

  const entitlement = await service.findValidEntitlementForUser(recipientId, eventId);

  assert.equal(entitlement, null);
});

test("a cancelled pass does not grant entitlement to the owner", async () => {
  const service = await createService({ cancelled: true });

  const entitlement = await service.findValidEntitlementForUser(ownerId, eventId);

  assert.equal(entitlement, null);
});

test("a cancelled pass does not grant entitlement to a share recipient either", async () => {
  const service = await createService({
    activeSharesForRecipient: [activeShare()],
    cancelled: true,
  });

  const entitlement = await service.findValidEntitlementForUser(recipientId, eventId);

  assert.equal(entitlement, null);
});

test("a user with no orders and no shares has no entitlement", async () => {
  const service = await createService({ ownedOrders: [], activeSharesForRecipient: [] });

  const entitlement = await service.findValidEntitlementForUser(new Types.ObjectId().toString(), eventId);

  assert.equal(entitlement, null);
});

test("hasValidEntitlement mirrors findValidEntitlementForUser as a boolean", async () => {
  const withTicket = await createService();
  const withoutTicket = await createService({ ownedOrders: [], activeSharesForRecipient: [] });

  assert.equal(await withTicket.hasValidEntitlement(ownerId, eventId), true);
  assert.equal(await withoutTicket.hasValidEntitlement(new Types.ObjectId().toString(), eventId), false);
});
