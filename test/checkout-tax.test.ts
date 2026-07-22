import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";
process.env.STRIPE_TAX_ENABLED = "false";

test("checkout tax falls back to explicit zero status when Stripe Tax is disabled", async () => {
  const { CheckoutTaxService } = await import("../src/modules/payments/checkout-tax.service.js");
  const taxService = new CheckoutTaxService(() => {
    throw new Error("Stripe should not be called when tax is disabled");
  });

  const snapshot = await taxService.calculate({
    currency: "usd",
    platformFeeAmount: 2,
    lineItems: [{
      itemType: "ticket",
      itemId: "ticket-1",
      eventId: "event-1",
      name: "Standard",
      quantity: 1,
      paidQuantity: 1,
      freeQuantity: 0,
      totalQuantity: 1,
      unitAmount: 20,
      totalAmount: 20,
    }],
    event: {
      location: { address: "123 Test St" },
    } as never,
  });

  assert.equal(snapshot.amount, 0);
  assert.equal(snapshot.status, "configuration_unavailable_zero_fallback");
  assert.equal(snapshot.provider, "none");
  assert.equal(snapshot.failureCode, "STRIPE_TAX_DISABLED");
});

test("checkout tax falls back when structured country is missing", async () => {
  const { env } = await import("../src/config/env.js");
  const { CheckoutTaxService } = await import("../src/modules/payments/checkout-tax.service.js");
  env.STRIPE_TAX_ENABLED = true;
  const taxService = new CheckoutTaxService(() => {
    throw new Error("Stripe should not be called without structured country");
  });

  const snapshot = await taxService.calculate({
    currency: "usd",
    platformFeeAmount: 2,
    lineItems: [{
      itemType: "ticket",
      itemId: "ticket-1",
      eventId: "event-1",
      name: "Standard",
      quantity: 1,
      paidQuantity: 1,
      freeQuantity: 1,
      totalQuantity: 2,
      rewardId: "reward-1",
      unitAmount: 20,
      totalAmount: 20,
    }],
    event: {
      location: {
        address: "123 Test St",
        city: "New York",
        postalCode: "10001",
      },
    } as never,
  });

  assert.equal(snapshot.amount, 0);
  assert.equal(snapshot.status, "configuration_unavailable_zero_fallback");
  assert.equal(snapshot.provider, "stripe_tax");
  assert.equal(snapshot.failureCode, "VENUE_ADDRESS_INSUFFICIENT");
  env.STRIPE_TAX_ENABLED = false;
});
