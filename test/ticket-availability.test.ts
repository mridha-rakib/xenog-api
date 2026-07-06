import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

test("event ticket stats returns availableCount instead of recalculating from original capacity", async () => {
  const { CheckoutPaymentService } = await import("../src/modules/payments/checkout-payment.service.js");
  const service = new CheckoutPaymentService(
    {
      getEventTicketSales: async () => ({ standard: 2 }),
    } as never,
    {
      findByIdForUser: async () => ({
        tickets: [
          {
            id: "standard",
            name: "Standard",
            type: "free",
            price: 0,
            capacity: 185,
            availableCount: 183,
          },
        ],
      }),
    } as never,
  );

  const result = await service.getEventTicketStats({ id: "host-1" } as never, "event-1");

  assert.equal(result.stats.standard?.capacity, 185);
  assert.equal(result.stats.standard?.sold, 2);
  assert.equal(result.stats.standard?.available, 183);
});
