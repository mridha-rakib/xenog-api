import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const creatorId = new Types.ObjectId();
const payoutId = new Types.ObjectId();
const earningId = new Types.ObjectId();

const creator = {
  id: creatorId.toString(),
  name: "Creator",
  username: "creator",
  email: "creator@example.com",
  accountType: "business",
  role: "user",
};

const account = (payoutAccounts: unknown[]) => ({
  id: new Types.ObjectId().toString(),
  userId: creatorId.toString(),
  stripeAccountId: "acct_creator",
  email: "creator@example.com",
  country: "US",
  livemode: false,
  detailsSubmitted: true,
  chargesEnabled: true,
  payoutsEnabled: true,
  onboardingStatus: "completed",
  requirements: {
    currentlyDue: [],
    eventuallyDue: [],
    pastDue: [],
    disabledReason: null,
  },
  payoutAccounts,
  createdAt: new Date("2026-08-31T00:00:00.000Z"),
  updatedAt: new Date("2026-08-31T00:00:00.000Z"),
});

const bankAccount = {
  id: "ba_1",
  type: "bank_account",
  name: "Test Bank",
  bankName: "Test Bank",
  last4: "6789",
  currency: "usd",
  country: "US",
  status: "verified",
  defaultForCurrency: true,
  availablePayoutMethods: ["standard"],
};

const instantCard = {
  id: "card_instant",
  type: "card",
  name: "Visa card",
  brand: "Visa",
  last4: "4242",
  currency: "usd",
  country: "US",
  defaultForCurrency: true,
  availablePayoutMethods: ["instant", "standard"],
};

const standardCard = {
  ...instantCard,
  id: "card_standard",
  availablePayoutMethods: ["standard"],
};

const payout = (payoutType: "bank_transfer" | "instant_debit_card") => ({
  _id: payoutId,
  creatorUserId: creatorId,
  earningIds: [earningId],
  totalAmount: 12.34,
  currency: "usd",
  payoutType,
  status: "pending",
  scheduledDate: new Date("2026-08-31T00:00:00.000Z"),
  createdAt: new Date("2026-08-31T00:00:00.000Z"),
  updatedAt: new Date("2026-08-31T00:00:00.000Z"),
});

const earning = {
  _id: earningId,
  creatorUserId: creatorId,
  orderId: new Types.ObjectId(),
  eventId: new Types.ObjectId(),
  itemType: "ticket",
  grossAmount: 12.34,
  platformFeePercent: 0,
  platformFeeAmount: 0,
  netAmount: 12.34,
  status: "withdrawn",
  eligibleAt: new Date("2026-08-31T00:00:00.000Z"),
  createdAt: new Date("2026-08-31T00:00:00.000Z"),
  updatedAt: new Date("2026-08-31T00:00:00.000Z"),
};

test("D1: payout-account eligibility only accepts instant-capable external cards", async () => {
  const { resolveInstantDebitCardEligibilityFromPayoutAccounts } = await import(
    "../src/modules/payments/stripe-connect.service.js"
  );

  assert.deepEqual(
    resolveInstantDebitCardEligibilityFromPayoutAccounts([bankAccount] as never).unavailableReason,
    "no_external_card",
  );
  assert.equal(
    resolveInstantDebitCardEligibilityFromPayoutAccounts([standardCard] as never).eligible,
    false,
  );
  assert.equal(
    resolveInstantDebitCardEligibilityFromPayoutAccounts([instantCard] as never).eligible,
    true,
  );
  assert.equal(
    resolveInstantDebitCardEligibilityFromPayoutAccounts([
      { ...instantCard, id: "", last4: "" },
      { id: "ba_2", type: "bank_account", name: "Bank", last4: "9999", availablePayoutMethods: ["instant"] },
    ] as never).eligible,
    false,
  );
});

test("D1: eligible card metadata contains only safe fields", async () => {
  const { resolveInstantDebitCardEligibilityFromPayoutAccounts } = await import(
    "../src/modules/payments/stripe-connect.service.js"
  );

  const result = resolveInstantDebitCardEligibilityFromPayoutAccounts([instantCard] as never);

  assert.deepEqual(Object.keys(result.eligibleInstantDebitCard ?? {}).sort(), [
    "availablePayoutMethods",
    "brand",
    "country",
    "currency",
    "id",
    "last4",
  ]);
  assert.equal(result.eligibleInstantDebitCard?.id, "card_instant");
  assert.equal(result.eligibleInstantDebitCard?.brand, "Visa");
  assert.equal(result.eligibleInstantDebitCard?.last4, "4242");
});

test("D1: multiple instant cards require one Stripe default card for deterministic backend selection", async () => {
  const { resolveInstantDebitCardEligibilityFromPayoutAccounts } = await import(
    "../src/modules/payments/stripe-connect.service.js"
  );

  assert.equal(
    resolveInstantDebitCardEligibilityFromPayoutAccounts([
      { ...instantCard, id: "card_1", defaultForCurrency: false },
      { ...instantCard, id: "card_2", defaultForCurrency: false },
    ] as never).unavailableReason,
    "multiple_eligible_cards",
  );
  assert.equal(
    resolveInstantDebitCardEligibilityFromPayoutAccounts([
      { ...instantCard, id: "card_1", defaultForCurrency: false },
      { ...instantCard, id: "card_2", defaultForCurrency: true },
    ] as never).eligibleInstantDebitCard?.id,
    "card_2",
  );
});

test("D1: payout settings preserves instantPayoutEligible and adds safe eligibility details", async () => {
  const { PayoutSettingsService } = await import("../src/modules/payments/payout-settings.service.js");
  let updatedProfile: unknown = null;

  const service = new PayoutSettingsService(
    {
      findById: async () => ({
        businessProfile: {
          payoutPreference: "manual",
          withdrawalMethod: "bank_transfer",
        },
      }),
      updateById: async (_userId: string, payload: unknown) => {
        updatedProfile = payload;
      },
    } as never,
    {
      getInstantDebitCardEligibility: async () => ({
        eligible: true,
        eligibleInstantDebitCard: {
          id: "card_instant",
          brand: "Visa",
          last4: "4242",
          currency: "usd",
          country: "US",
          availablePayoutMethods: ["instant"],
        },
        unavailableReason: null,
      }),
    } as never,
  );

  const settings = await service.getPayoutSettings(creator as never);

  assert.equal(settings.instantPayoutEligible, true);
  assert.equal(settings.eligibleInstantDebitCard?.id, "card_instant");
  assert.equal(settings.instantPayoutUnavailableReason, null);

  const updated = await service.updatePayoutSettings(creator as never, {
    withdrawalMethod: "bank_transfer",
  });

  assert.deepEqual(updatedProfile, {
    businessProfile: {
      payoutPreference: "manual",
      withdrawalMethod: "bank_transfer",
    },
  });
  assert.equal(updated.instantPayoutEligible, true);
  assert.equal(updated.eligibleInstantDebitCard?.id, "card_instant");
});

test("D1: instant debit validation accepts eligible cards and rejects missing eligibility without requiring a bank account", async () => {
  const { StripeConnectService } = await import("../src/modules/payments/stripe-connect.service.js");
  const service = new StripeConnectService({} as never);

  Object.assign(service, {
    getAccount: async () => account([instantCard]),
  });

  const readiness = await service.validateReadyForPayoutDestination(creator.id, "instant_debit_card");

  assert.equal(readiness.stripeAccountId, "acct_creator");
  assert.equal(readiness.eligibleInstantDebitCard?.id, "card_instant");

  Object.assign(service, {
    getAccount: async () => account([standardCard]),
  });

  await assert.rejects(
    () => service.validateReadyForPayoutDestination(creator.id, "instant_debit_card"),
    /no eligible debit card/i,
  );
});

test("D1: bank transfer validation still requires a bank account and returns the connected account id", async () => {
  const { StripeConnectService } = await import("../src/modules/payments/stripe-connect.service.js");
  const service = new StripeConnectService({} as never);

  Object.assign(service, {
    getAccount: async () => account([bankAccount]),
  });

  const readiness = await service.validateReadyForPayoutDestination(creator.id, "bank_transfer");

  assert.equal(readiness.stripeAccountId, "acct_creator");
  assert.equal(readiness.eligibleInstantDebitCard, null);

  Object.assign(service, {
    getAccount: async () => account([instantCard]),
  });

  await assert.rejects(
    () => service.validateReadyForPayoutDestination(creator.id, "bank_transfer"),
    /No bank account found/i,
  );
});

test("D2: instant debit payout uses the explicit eligible card destination", async () => {
  const { processPayout } = await import("../src/modules/payments/creator-payout.scheduler.js");
  let instantPayoutParams: { destination?: string; method?: string } | null = null;
  let transferParams: { stripeAccountId?: string } | null = null;
  let validationOwner: string | null = null;
  let validationPayoutType: string | null = null;

  await processPayout(payout("instant_debit_card") as never, {
    payoutRepository: {
      markProcessingIfPending: async () => payout("instant_debit_card") as never,
      markCompleted: async () => null,
      markFailed: async () => null,
    },
    earningRepository: {
      findByIds: async () => [earning] as never,
      releaseToEligible: async () => undefined,
    },
    eventRepository: {
      findManyByIds: async (eventIds: string[]) => eventIds.map((id) => ({ _id: new Types.ObjectId(id), status: "completed" })) as never,
    },
    stripeConnectService: {
      validateReadyForPayoutDestination: async (userId: string, payoutType: string) => {
        validationOwner = userId;
        validationPayoutType = payoutType;

        return {
          stripeAccountId: "acct_creator",
          eligibleInstantDebitCard: {
            id: "card_instant",
            brand: "Visa",
            last4: "4242",
            availablePayoutMethods: ["instant"],
          },
        };
      },
      createTransfer: async (params: { stripeAccountId: string }) => {
        transferParams = params;
        return "tr_123";
      },
      createInstantPayoutOnConnectedAccount: async (params: { destination: string; method?: string }) => {
        instantPayoutParams = params;
        return "po_123";
      },
    },
    notificationService: {
      sendSystemNotification: async () => undefined,
    },
  });

  assert.equal(transferParams?.stripeAccountId, "acct_creator");
  assert.equal(instantPayoutParams?.destination, "card_instant");
  assert.equal(validationOwner, creator.id);
  assert.equal(validationPayoutType, "instant_debit_card");
});

test("D2: Stripe instant payout call includes method instant and explicit destination", async () => {
  const { StripeConnectService } = await import("../src/modules/payments/stripe-connect.service.js");
  const service = new StripeConnectService({} as never);
  let createParams: { method?: string; destination?: string; amount?: number; currency?: string } | null = null;
  let createOptions: { stripeAccount?: string; idempotencyKey?: string } | null = null;

  Object.assign(service, {
    getStripe: () => ({
      payouts: {
        create: async (
          params: { method?: string; destination?: string; amount?: number; currency?: string },
          options: { stripeAccount?: string; idempotencyKey?: string },
        ) => {
          createParams = params;
          createOptions = options;

          return { id: "po_123" };
        },
      },
    }),
  });

  const payoutId = await service.createInstantPayoutOnConnectedAccount({
    stripeAccountId: "acct_creator",
    destination: "card_instant",
    amountCents: 1234,
    currency: "usd",
    idempotencyKey: "instant-payout-test",
  });

  assert.equal(payoutId, "po_123");
  assert.equal(createParams?.method, "instant");
  assert.equal(createParams?.destination, "card_instant");
  assert.equal(createOptions?.stripeAccount, "acct_creator");
});

test("D2: bank transfer payout keeps the existing Stripe call shape and skips instant payout", async () => {
  const { processPayout } = await import("../src/modules/payments/creator-payout.scheduler.js");
  let instantPayoutCalled = false;

  await processPayout(payout("bank_transfer") as never, {
    payoutRepository: {
      markProcessingIfPending: async () => payout("bank_transfer") as never,
      markCompleted: async () => null,
      markFailed: async () => null,
    },
    earningRepository: {
      findByIds: async () => [earning] as never,
      releaseToEligible: async () => undefined,
    },
    eventRepository: {
      findManyByIds: async (eventIds: string[]) => eventIds.map((id) => ({ _id: new Types.ObjectId(id), status: "completed" })) as never,
    },
    stripeConnectService: {
      validateReadyForPayoutDestination: async () => ({
        stripeAccountId: "acct_creator",
        eligibleInstantDebitCard: null,
      }),
      createTransfer: async () => "tr_123",
      createInstantPayoutOnConnectedAccount: async () => {
        instantPayoutCalled = true;
        return "po_123";
      },
    },
    notificationService: {
      sendSystemNotification: async () => undefined,
    },
  });

  assert.equal(instantPayoutCalled, false);
});

test("D2: no eligible card at execution time fails safely before transfer or instant payout", async () => {
  const { processPayout } = await import("../src/modules/payments/creator-payout.scheduler.js");
  let transferCalled = false;
  let instantPayoutCalled = false;
  let markedFailed = false;
  let released = false;

  await processPayout(payout("instant_debit_card") as never, {
    payoutRepository: {
      markProcessingIfPending: async () => payout("instant_debit_card") as never,
      markCompleted: async () => null,
      markFailed: async () => {
        markedFailed = true;
        return null;
      },
    },
    earningRepository: {
      findByIds: async () => [earning] as never,
      releaseToEligible: async () => {
        released = true;
      },
    },
    eventRepository: {
      findManyByIds: async (eventIds: string[]) => eventIds.map((id) => ({ _id: new Types.ObjectId(id), status: "completed" })) as never,
    },
    stripeConnectService: {
      validateReadyForPayoutDestination: async () => {
        throw new Error("Instant payout is not available. Your account has no eligible debit card.");
      },
      createTransfer: async () => {
        transferCalled = true;
        return "tr_123";
      },
      createInstantPayoutOnConnectedAccount: async () => {
        instantPayoutCalled = true;
        return "po_123";
      },
    },
    notificationService: {
      sendSystemNotification: async () => undefined,
    },
  });

  assert.equal(transferCalled, false);
  assert.equal(instantPayoutCalled, false);
  assert.equal(markedFailed, true);
  assert.equal(released, true);
});

test("D2: instant debit readiness without a card destination fails before transfer", async () => {
  const { processPayout } = await import("../src/modules/payments/creator-payout.scheduler.js");
  let transferCalled = false;
  let markedFailed = false;

  await processPayout(payout("instant_debit_card") as never, {
    payoutRepository: {
      markProcessingIfPending: async () => payout("instant_debit_card") as never,
      markCompleted: async () => null,
      markFailed: async () => {
        markedFailed = true;
        return null;
      },
    },
    earningRepository: {
      findByIds: async () => [earning] as never,
      releaseToEligible: async () => undefined,
    },
    eventRepository: {
      findManyByIds: async (eventIds: string[]) => eventIds.map((id) => ({ _id: new Types.ObjectId(id), status: "completed" })) as never,
    },
    stripeConnectService: {
      validateReadyForPayoutDestination: async () => ({
        stripeAccountId: "acct_creator",
        eligibleInstantDebitCard: null,
      }),
      createTransfer: async () => {
        transferCalled = true;
        return "tr_123";
      },
      createInstantPayoutOnConnectedAccount: async () => "po_123",
    },
    notificationService: {
      sendSystemNotification: async () => undefined,
    },
  });

  assert.equal(transferCalled, false);
  assert.equal(markedFailed, true);
});

test("D1/D2: duplicate withdrawal protection remains active before payout record creation", async () => {
  const { CreatorEarningService } = await import("../src/modules/payments/creator-earning.service.js");
  const service = new CreatorEarningService(
    {
      releaseEligibleEarnings: async () => undefined,
      findEligibleByCreatorUserId: async () => [earning],
    } as never,
    {
      findPendingOrProcessingByCreatorUserId: async () => [payout("bank_transfer")],
    } as never,
    { validateReadyForPayout: async () => "acct_creator" } as never,
    { findById: async () => ({ businessProfile: { withdrawalMethod: "bank_transfer" } }) } as never,
    { sendSystemNotification: async () => undefined } as never,
    { findManyByIds: async () => [] } as never,
  );

  await assert.rejects(
    () => service.requestWithdrawal(creator as never, { amount: 10 }),
    /withdrawal is already in progress/i,
  );
});
