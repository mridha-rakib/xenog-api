import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

test("checkout invoice renders professional html and readable text with rewarded zero line", async () => {
  const { CheckoutInvoiceService } = await import("../src/modules/payments/checkout-invoice.service.js");
  const service = new CheckoutInvoiceService();
  const invoice = {
    _id: new Types.ObjectId(),
    orderId: new Types.ObjectId(),
    userId: new Types.ObjectId(),
    invoiceNumber: "XG-TEST1234",
    toEmail: "buyer@example.com",
    status: "pending",
    attemptCount: 0,
    snapshot: {
      orderId: "order-123",
      eventName: "Launch Night",
      eventPrivacy: "locked",
      eventScheduledAt: new Date("2026-08-01T20:00:00.000Z"),
      eventEndAt: new Date("2026-08-01T23:00:00.000Z"),
      venue: {
        venue: "Main Hall",
        formattedAddress: "123 Test St, New York, NY 10001, United States",
        city: "New York",
        regionCode: "NY",
        postalCode: "10001",
        countryCode: "US",
      },
      purchasedAt: new Date("2026-07-22T10:00:00.000Z"),
      buyerName: "Buyer One",
      buyerEmail: "buyer@example.com",
      paymentMethod: "Card",
      termsVersion: "terms-test",
      refundEscrowVersion: "refund-test",
      currency: "usd",
      subtotalAmount: 90,
      platformFeeAmount: 9,
      taxAmount: 4.5,
      discountAmount: 0,
      totalAmount: 103.5,
      lineItems: [{
        itemType: "ticket",
        itemId: "general",
        name: "General Admission",
        description: "Standing entry",
        ticketType: "pay",
        quantity: 4,
        paidQuantity: 2,
        freeQuantity: 2,
        unitAmount: 45,
        originalUnitAmount: null,
        discountAmount: 0,
        totalAmount: 90,
      }],
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never;

  const html = service.renderHtml(invoice);
  const text = service.renderText(invoice);

  assert.match(html, /Xenog/);
  assert.match(html, /Payment confirmed/);
  assert.match(html, /General Admission/);
  assert.match(html, /Rewarded General Admission/);
  assert.match(html, /\$0\.00/);
  assert.match(html, /Total paid/);
  assert.match(text, /rewarded x 2/i);
  assert.match(text, /Terms version: terms-test/);
});
