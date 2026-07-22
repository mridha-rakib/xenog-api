import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";
process.env.STRIPE_TAX_ENABLED = "false";

const eventId = new Types.ObjectId();
const hostId = new Types.ObjectId();
const buyerId = new Types.ObjectId();

const makeEvent = (privacy: "public" | "locked" | "private") => ({
  _id: eventId,
  userId: hostId,
  status: "published",
  privacy,
  memberUserIds: privacy === "private" ? [buyerId] : [],
  scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  tickets: [{
    id: "general",
    name: "General Admission",
    type: "free",
    price: 0,
    capacity: 20,
    availableCount: 20,
  }],
  rewards: [],
  location: { searchLabel: "Test Venue" },
});

const makeService = async (privacy: "public" | "locked" | "private", joinStatus?: string | null) => {
  const { CheckoutPaymentService } = await import("../src/modules/payments/checkout-payment.service.js");
  const event = makeEvent(privacy);

  return new CheckoutPaymentService(
    {} as never,
    {
      findById: async () => event,
      findUserJoinRequest: async () => joinStatus ? { status: joinStatus } : null,
    } as never,
  );
};

const payload = {
  kind: "ticket" as const,
  paymentMethod: "card" as const,
  eventId: eventId.toString(),
  ticketId: "general",
  quantity: 1,
  acceptedTerms: true,
};

test("public event checkout quote remains available", async () => {
  const service = await makeService("public");
  const quote = await service.quoteCheckout({ id: buyerId.toString() } as never, payload);

  assert.equal(quote.totalAmount, 0);
  assert.equal(quote.lineItems[0]?.name, "General Admission");
});

test("locked event checkout quote requires accepted join request", async () => {
  const service = await makeService("locked", "pending");

  await assert.rejects(
    () => service.quoteCheckout({ id: buyerId.toString() } as never, payload),
    /request must be accepted/i,
  );
});

test("locked event checkout quote works after accepted join request", async () => {
  const service = await makeService("locked", "accepted");
  const quote = await service.quoteCheckout({ id: buyerId.toString() } as never, payload);

  assert.equal(quote.lineItems[0]?.itemId, "general");
});

test("private event checkout quote remains available for invited member", async () => {
  const service = await makeService("private");
  const quote = await service.quoteCheckout({ id: buyerId.toString() } as never, payload);

  assert.equal(quote.lineItems[0]?.itemId, "general");
});

test("private event checkout quote rejects uninvited user", async () => {
  const service = await makeService("private");

  await assert.rejects(
    () => service.quoteCheckout({ id: new Types.ObjectId().toString() } as never, payload),
    /not invited/i,
  );
});
