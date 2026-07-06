import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { createCheckoutTicketPasses } from "../src/modules/payments/ticket-check-in-code.js";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

test("limited 100-ticket check-in validation", async (t) => {
  const { CheckoutPaymentService } = await import("../src/modules/payments/checkout-payment.service.js");
  const { CheckoutOrderModel } = await import("../src/modules/payments/checkout-payment.model.js");
  const now = new Date("2026-07-06T00:00:00.000Z");
  const eventId = new Types.ObjectId();
  const orderId = new Types.ObjectId();
  const hostId = new Types.ObjectId();
  const otherHostId = new Types.ObjectId();
  const ownerId = new Types.ObjectId();
  const recipientId = new Types.ObjectId();
  const ticketId = "ticket-load-100";
  const lineItem = {
    itemType: "ticket" as const,
    itemId: ticketId,
    eventId: eventId.toString(),
    name: "100-pass validation ticket",
    quantity: 100,
    paidQuantity: 100,
    freeQuantity: 0,
    totalQuantity: 100,
    unitAmount: 1,
    totalAmount: 100,
  };
  const ticketPasses = createCheckoutTicketPasses([lineItem], now);
  const order = {
    _id: orderId,
    userId: ownerId,
    kind: "ticket",
    paymentMethod: "card",
    paymentStatus: "paid",
    payoutStatus: "not_ready",
    currency: "usd",
    subtotalAmount: 100,
    platformFeeAmount: 10,
    taxAmount: 0,
    totalAmount: 110,
    amountMinor: 11000,
    lineItems: [lineItem],
    ticketPasses,
    anonymous: false,
    createdAt: now,
    updatedAt: now,
  };
  const event = {
    _id: eventId,
    userId: hostId,
    status: "published",
    name: "100 Ticket Validation Event",
    tickets: [{
      id: ticketId,
      name: "100-pass validation ticket",
      type: "pay",
      price: 1,
      capacity: 100,
    }],
    rewards: [],
  };
  const usages = new Map<string, Record<string, unknown>>();
  let successfulUsageCreates = 0;
  let codeLookupCount = 0;
  const passKey = (eventValue: string, ticketValue: string, orderValue: string, ticketIndex: number) =>
    `${eventValue}:${ticketValue}:${orderValue}:${ticketIndex}`;
  const repository = {
    findByCheckInCode: async (checkInCode: string) => {
      codeLookupCount += 1;
      return ticketPasses.some((pass) => pass.checkInCode === checkInCode) ? order : null;
    },
  };
  const eventRepository = { findById: async () => event };
  const ticketShareRepository = {
    findActiveByTicketPass: async (
      _eventValue: string,
      _ticketValue: string,
      _orderValue: string,
      ticketIndex: number,
    ) => ticketIndex === 2
      ? { _id: new Types.ObjectId(), recipientUserId: recipientId }
      : null,
  };
  const ticketUsageRepository = {
    findByTicketPass: async (
      eventValue: string,
      ticketValue: string,
      orderValue: string,
      ticketIndex: number,
    ) => usages.get(passKey(eventValue, ticketValue, orderValue, ticketIndex)) ?? null,
    create: async (payload: Record<string, unknown>) => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const key = passKey(
        payload.eventId as string,
        payload.ticketId as string,
        payload.orderId as string,
        payload.ticketIndex as number,
      );

      if (usages.has(key)) {
        throw Object.assign(new Error("duplicate ticket usage"), { code: 11000 });
      }

      const usage = { _id: new Types.ObjectId(), ...payload, usedAt: now };
      usages.set(key, usage);
      successfulUsageCreates += 1;
      return usage;
    },
  };
  const userRepository = {
    findById: async (id: string) => ({
      _id: new Types.ObjectId(id),
      name: id === recipientId.toString() ? "Shared Recipient" : "Ticket Owner",
    }),
  };
  const service = new CheckoutPaymentService(
    repository as never,
    eventRepository as never,
    {} as never,
    {} as never,
    userRepository as never,
    {} as never,
    ticketShareRepository as never,
    ticketUsageRepository as never,
    {} as never,
  );
  const host = {
    id: hostId.toString(),
    name: "Host",
    email: "host@example.com",
    accountType: "business",
    currentLocationSharingEnabled: false,
    notificationsEnabled: true,
    role: "user",
    isActive: true,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  };
  const unauthorizedHost = { ...host, id: otherHostId.toString(), email: "other-host@example.com" };

  await t.test("all 100 generated codes are unique and QR equals Ticket No", () => {
    assert.equal(ticketPasses.length, 100);
    assert.equal(new Set(ticketPasses.map((pass) => pass.checkInCode)).size, 100);
    assert.ok(ticketPasses.every((pass) => /^MOM-26-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(pass.checkInCode)));

    const walletPasses = (
      service as unknown as {
        buildTicketPasses: (orderValue: unknown, lineItemValue: unknown, eventValue: unknown) =>
          Array<{ ticketNo: string; qrCode: string }>;
      }
    ).buildTicketPasses(order, lineItem, event);

    assert.equal(walletPasses.length, 100);
    assert.ok(walletPasses.every((pass, index) => (
      pass.ticketNo === ticketPasses[index]!.checkInCode
      && pass.qrCode === pass.ticketNo
    )));
  });

  await t.test("invalid, wrong-event, and unauthorized attempts are rejected cleanly", async () => {
    await assert.rejects(
      () => service.scanTicket(host as never, { checkInCode: "MOM-26-AAAA-BBBB" }),
      (error: unknown) => (
        (error as { details?: { code?: string } }).details?.code === "INVALID_TICKET"
      ),
    );
    await assert.rejects(
      () => service.scanTicket(host as never, {
        checkInCode: ticketPasses[2]!.checkInCode,
        eventId: new Types.ObjectId().toString(),
      }),
      (error: unknown) => (
        (error as { details?: { code?: string } }).details?.code === "WRONG_EVENT"
      ),
    );
    await assert.rejects(
      () => service.scanTicket(unauthorizedHost as never, {
        checkInCode: ticketPasses[3]!.checkInCode,
      }),
      (error: unknown) => (
        (error as { statusCode?: number }).statusCode === 403
        && (error as { details?: { code?: string } }).details?.code === "UNAUTHORIZED_TICKET_HOST"
      ),
    );
  });

  await t.test("five simultaneous scans produce one success and four already-checked-in errors", async () => {
    const concurrentCode = ticketPasses[0]!.checkInCode;
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => service.scanTicket(host as never, { checkInCode: concurrentCode })),
    );

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 4);
    for (const result of results) {
      if (result.status === "rejected") {
        assert.equal(result.reason.message, "This ticket has already been checked in");
        assert.equal(result.reason.details?.code, "TICKET_ALREADY_CHECKED_IN");
      }
    }
    assert.equal(usages.size, 1);
  });

  await t.test("remaining 99 codes check in through alternating scan/manual payloads", async () => {
    for (let index = 1; index < ticketPasses.length; index += 1) {
      const pass = ticketPasses[index]!;
      const result = await service.scanTicket(
        host as never,
        index % 2 === 0
          ? { checkInCode: pass.checkInCode }
          : { checkInCode: pass.checkInCode, eventId: eventId.toString() },
      );
      assert.equal(result.ticketNo, pass.checkInCode);
    }

    assert.equal(usages.size, 100);
    assert.equal(successfulUsageCreates, 100);
    const sharedUsage = usages.get(passKey(eventId.toString(), ticketId, orderId.toString(), 2));
    assert.equal(sharedUsage?.holderUserId, recipientId.toString());
    assert.equal(sharedUsage?.source, "shared");
  });

  await t.test("all 100 second attempts return already checked in without new usage", async () => {
    const secondAttempts = await Promise.allSettled(
      ticketPasses.map((pass) => service.scanTicket(host as never, { checkInCode: pass.checkInCode })),
    );

    assert.equal(secondAttempts.filter((result) => result.status === "fulfilled").length, 0);
    assert.equal(secondAttempts.filter((result) => result.status === "rejected").length, 100);
    for (const result of secondAttempts) {
      if (result.status === "rejected") {
        assert.equal(result.reason.message, "This ticket has already been checked in");
        assert.equal(result.reason.details?.code, "TICKET_ALREADY_CHECKED_IN");
      }
    }
    assert.equal(usages.size, 100);
    assert.equal(successfulUsageCreates, 100);
  });

  await t.test("checkInCode unique index is declared and lookup path was exercised", () => {
    const checkInIndex = CheckoutOrderModel.schema.indexes().find(
      ([fields]) => fields["ticketPasses.checkInCode"] === 1,
    );

    assert.equal(checkInIndex?.[1]?.unique, true);
    assert.ok(codeLookupCount >= 200);
  });

  await t.test("repository lookup explicitly applies the checkInCode index hint", async () => {
    const { CheckoutPaymentRepository } = await import(
      "../src/modules/payments/checkout-payment.repository.js"
    );
    const modelWithMutableFind = CheckoutOrderModel as unknown as {
      findOne: (filter: unknown) => unknown;
    };
    const originalFindOne = modelWithMutableFind.findOne;
    let appliedHint: Record<string, number> | null = null;

    modelWithMutableFind.findOne = () => ({
      hint: (hint: Record<string, number>) => {
        appliedHint = hint;
        return Promise.resolve(null);
      },
    });

    try {
      await new CheckoutPaymentRepository().findByCheckInCode(ticketPasses[0]!.checkInCode);
    } finally {
      modelWithMutableFind.findOne = originalFindOne;
    }

    assert.deepEqual(appliedHint, { "ticketPasses.checkInCode": 1 });
  });
});
