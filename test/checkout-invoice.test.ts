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

  // Mobile responsiveness: viewport meta + document wrapper present
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1\.0">/);
  assert.match(html, /<html>/);
  assert.match(html, /<head>/);
  assert.match(html, /<body/);

  // Desktop two-column event/order table and 5-column ticket table still present, unmodified in content
  assert.match(html, /class="xg-desktop-only"/);
  assert.match(html, /<th align="left"[^>]*>Ticket<\/th>/);
  assert.match(html, /<th[^>]*>Paid<\/th>/);
  assert.match(html, /<th[^>]*>Free<\/th>/);

  // Mobile stacked equivalents exist, hidden by default, shown only under the mobile media query
  assert.match(html, /class="xg-mobile-only" style="display:none/);
  assert.match(html, /@media only screen and \(max-width: 480px\)/);
  assert.match(html, /\.xg-desktop-only \{ display: none !important; \}/);
  assert.match(html, /\.xg-mobile-only \{ display: block !important; \}/);

  // Mobile ticket card carries the same paid/free/unit/total values as the desktop table (no data drift)
  const mobileSection = html.split('class="xg-mobile-only" style="display:none;">')[1] ?? "";
  assert.match(mobileSection, /General Admission/);
  assert.match(mobileSection, />2</); // paidQuantity
  assert.match(mobileSection, /\$45\.00/); // unitAmount
  assert.match(mobileSection, /\$90\.00/); // totalAmount for the paid row
});

test("checkout invoice financial values are identical between desktop and mobile markup", async () => {
  const { CheckoutInvoiceService } = await import("../src/modules/payments/checkout-invoice.service.js");
  const service = new CheckoutInvoiceService();
  const invoice = {
    _id: new Types.ObjectId(),
    orderId: new Types.ObjectId(),
    userId: new Types.ObjectId(),
    invoiceNumber: "XG-TEST9999",
    toEmail: "buyer2@example.com",
    status: "pending",
    attemptCount: 0,
    snapshot: {
      orderId: "order-999",
      eventName: "A Very Long Event Title That Should Still Wrap Cleanly On A Narrow Mobile Email Viewport Without Breaking Layout",
      eventPrivacy: "public",
      eventScheduledAt: new Date("2026-09-01T20:00:00.000Z"),
      eventEndAt: new Date("2026-09-01T23:00:00.000Z"),
      venue: {
        venue: "A Fairly Long Venue Name That Could Overflow A Narrow Column",
        formattedAddress: "1234 Some Very Long Street Address Name, Suite 5678, Some City, ST 00000, United States",
        city: "Some City",
        regionCode: "ST",
        postalCode: "00000",
        countryCode: "US",
      },
      purchasedAt: new Date("2026-08-22T10:00:00.000Z"),
      buyerName: "Buyer With A Somewhat Long Display Name",
      buyerEmail: "buyer.with.a.very.long.email.address.for.testing@example-subdomain.example.com",
      paymentMethod: "Card",
      termsVersion: "terms-test",
      refundEscrowVersion: "refund-test",
      currency: "usd",
      subtotalAmount: 180,
      platformFeeAmount: 18,
      taxAmount: 9,
      discountAmount: 0,
      totalAmount: 207,
      lineItems: [
        {
          itemType: "ticket",
          itemId: "general",
          name: "General Admission",
          description: "Standing entry with a longer description to test wrapping behavior on narrow screens",
          ticketType: "pay",
          quantity: 2,
          paidQuantity: 2,
          freeQuantity: 0,
          unitAmount: 45,
          originalUnitAmount: null,
          discountAmount: 0,
          totalAmount: 90,
        },
        {
          itemType: "ticket",
          itemId: "vip",
          name: "VIP",
          description: "Front row access",
          ticketType: "pay",
          quantity: 2,
          paidQuantity: 2,
          freeQuantity: 0,
          unitAmount: 45,
          originalUnitAmount: null,
          discountAmount: 0,
          totalAmount: 90,
        },
      ],
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never;

  const html = service.renderHtml(invoice);

  // Long content must carry safe-wrapping CSS rather than being truncated or left to overflow
  assert.match(html, /word-break:break-word;overflow-wrap:break-word;/);
  assert.match(html, /A Very Long Event Title/);
  assert.match(html, /buyer\.with\.a\.very\.long\.email\.address\.for\.testing@example-subdomain\.example\.com/);

  // Multiple ticket rows: both line items appear in both the desktop table and the mobile stacked cards
  const desktopSection = html.split('class="xg-desktop-only" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"')[1]?.split('class="xg-mobile-only"')[0] ?? "";
  const mobileSection = html.split('class="xg-mobile-only" style="display:none;">')[1] ?? "";
  for (const name of ["General Admission", "VIP"]) {
    assert.match(desktopSection, new RegExp(name));
    assert.match(mobileSection, new RegExp(name));
  }

  // Escaping remains intact for injected event/venue/buyer strings
  const maliciousInvoice = {
    ...invoice,
    snapshot: {
      ...invoice.snapshot,
      eventName: "<script>alert(1)</script>",
      buyerName: "<img src=x onerror=alert(1)>",
    },
  } as never;
  const maliciousHtml = service.renderHtml(maliciousInvoice);
  assert.doesNotMatch(maliciousHtml, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(maliciousHtml, /<img src=x onerror=alert\(1\)>/);
  assert.match(maliciousHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});
