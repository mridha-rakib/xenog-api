import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "sk_test_hosted_link";
process.env.STRIPE_CONNECT_RETURN_URL = process.env.STRIPE_CONNECT_RETURN_URL ?? "https://api.example.test/stripe-return";
process.env.STRIPE_CONNECT_REFRESH_URL =
  process.env.STRIPE_CONNECT_REFRESH_URL ?? "https://api.example.test/stripe-refresh";
process.env.STRIPE_CONNECT_ALLOW_CLIENT_REDIRECTS = "true";

const userId = new Types.ObjectId();
const accountId = new Types.ObjectId();
const createdAt = new Date("2026-08-31T00:00:00.000Z");

const authUser = {
  id: userId.toString(),
  name: "Creator",
  username: "creator",
  email: "creator@example.com",
  accountType: "business",
  currentLocationSharingEnabled: false,
  notificationsEnabled: true,
  role: "user",
  isActive: true,
  emailVerified: true,
  createdAt,
  updatedAt: createdAt,
};

const existingAccount = {
  _id: accountId,
  userId,
  stripeAccountId: "acct_existing",
  email: "creator@example.com",
  country: "US",
  livemode: false,
  detailsSubmitted: false,
  chargesEnabled: false,
  payoutsEnabled: false,
  onboardingStatus: "restricted",
  requirements: {
    currentlyDue: ["external_account"],
    eventuallyDue: ["external_account"],
    pastDue: ["external_account"],
    disabledReason: "requirements.past_due",
  },
  lastSyncedAt: createdAt,
  createdAt,
  updatedAt: createdAt,
};

const retrievedStripeAccount = {
  id: "acct_existing",
  object: "account",
  type: "express",
  email: "creator@example.com",
  country: "US",
  default_currency: "usd",
  charges_enabled: false,
  payouts_enabled: false,
  details_submitted: false,
  external_accounts: { object: "list", data: [] },
  requirements: {
    currently_due: ["external_account"],
    eventually_due: ["external_account"],
    past_due: ["external_account"],
    disabled_reason: "requirements.past_due",
  },
};

test("existing connected account uses Stripe-hosted onboarding link without creating a duplicate account", async () => {
  const { StripeConnectService } = await import("../src/modules/payments/stripe-connect.service.js");
  const repositoryCalls: string[] = [];
  let accountCreateCalled = false;
  let accountLinkParams: {
    account?: string;
    return_url?: string;
    refresh_url?: string;
    collection_options?: { fields?: string };
    type?: string;
  } | null = null;
  let loginLinkCalled = false;
  let upsertPayload: { userId?: string; stripeAccountId?: string } | null = null;

  const service = new StripeConnectService({
    findByUserId: async (requestedUserId: string) => {
      repositoryCalls.push(`find:${requestedUserId}`);
      return existingAccount as never;
    },
    upsertByUserId: async (payload: { userId: string; stripeAccountId: string }) => {
      repositoryCalls.push(`upsert:${payload.userId}`);
      upsertPayload = payload;
      return { ...existingAccount, ...payload, userId: new Types.ObjectId(payload.userId) } as never;
    },
  } as never);

  Object.assign(service, {
    getStripe: () => ({
      accounts: {
        create: async () => {
          accountCreateCalled = true;
          return { id: "acct_duplicate" };
        },
        retrieve: async (requestedAccountId: string, options: { expand?: string[] }) => {
          assert.equal(requestedAccountId, "acct_existing");
          assert.deepEqual(options.expand, ["external_accounts"]);
          return retrievedStripeAccount;
        },
      },
      createLoginLink: async () => {
        loginLinkCalled = true;
        return { url: "https://connect.stripe.test/express/acct_existing" };
      },
      accountLinks: {
        create: async (params: typeof accountLinkParams) => {
          accountLinkParams = params;
          return {
            url: "https://connect.stripe.test/setup/acct_existing",
            expires_at: 1788172800,
          };
        },
      },
    }),
  });

  const result = await service.createOnboardingLink(authUser as never, {
    returnUrl: "https://app.example.test/profile-screen/bank-account?stripeConnect=return",
    refreshUrl: "https://app.example.test/profile-screen/bank-account?stripeConnect=refresh",
  });

  assert.equal(accountCreateCalled, false);
  assert.equal(loginLinkCalled, false);
  assert.equal(upsertPayload?.userId, userId.toString());
  assert.equal(upsertPayload?.stripeAccountId, "acct_existing");
  assert.deepEqual(repositoryCalls, [`find:${userId.toString()}`, `upsert:${userId.toString()}`]);
  assert.deepEqual(accountLinkParams, {
    account: "acct_existing",
    refresh_url: "https://app.example.test/profile-screen/bank-account?stripeConnect=refresh",
    return_url: "https://app.example.test/profile-screen/bank-account?stripeConnect=return",
    collection_options: { fields: "currently_due" },
    type: "account_onboarding",
  });
  assert.equal(result.onboardingUrl, "https://connect.stripe.test/setup/acct_existing");
  assert.equal(result.linkType, "account_onboarding");
  assert.equal(result.account.stripeAccountId, "acct_existing");
});

test("onboarded Express account opens a Stripe-hosted Dashboard login link for payout account management", async () => {
  const { StripeConnectService } = await import("../src/modules/payments/stripe-connect.service.js");
  let accountCreateCalled = false;
  let accountLinkCalled = false;
  let loginLinkAccountId: string | null = null;

  const completeAccount = {
    ...existingAccount,
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
  };

  const completeStripeAccount = {
    ...retrievedStripeAccount,
    charges_enabled: true,
    payouts_enabled: true,
    details_submitted: true,
    requirements: {
      currently_due: [],
      eventually_due: [],
      past_due: [],
      disabled_reason: null,
    },
    external_accounts: {
      object: "list",
      data: [
        {
          id: "ba_existing",
          object: "bank_account",
          bank_name: "Test Bank",
          last4: "6789",
          currency: "usd",
          country: "US",
          status: "verified",
          default_for_currency: true,
          available_payout_methods: ["standard"],
        },
      ],
    },
  };

  const service = new StripeConnectService({
    findByUserId: async () => completeAccount as never,
    upsertByUserId: async (payload: { userId: string; stripeAccountId: string }) =>
      ({ ...completeAccount, ...payload, userId: new Types.ObjectId(payload.userId) }) as never,
  } as never);

  Object.assign(service, {
    getStripe: () => ({
      accounts: {
        create: async () => {
          accountCreateCalled = true;
          return { id: "acct_duplicate" };
        },
        retrieve: async (requestedAccountId: string, options: { expand?: string[] }) => {
          assert.equal(requestedAccountId, "acct_existing");
          assert.deepEqual(options.expand, ["external_accounts"]);
          return completeStripeAccount;
        },
        createLoginLink: async (requestedAccountId: string) => {
          loginLinkAccountId = requestedAccountId;
          return { url: "https://connect.stripe.test/express/acct_existing" };
        },
      },
      accountLinks: {
        create: async () => {
          accountLinkCalled = true;
          return { url: "https://connect.stripe.test/setup/acct_existing", expires_at: 1788172800 };
        },
      },
    }),
  });

  const result = await service.createOnboardingLink(authUser as never, {
    returnUrl: "https://app.example.test/profile-screen/bank-account?stripeConnect=return",
    refreshUrl: "https://app.example.test/profile-screen/bank-account?stripeConnect=refresh",
  });

  assert.equal(accountCreateCalled, false);
  assert.equal(accountLinkCalled, false);
  assert.equal(loginLinkAccountId, "acct_existing");
  assert.equal(result.onboardingUrl, "https://connect.stripe.test/express/acct_existing");
  assert.equal(result.linkType, "express_dashboard");
  assert.equal(result.returnUrl, "https://app.example.test/profile-screen/bank-account?stripeConnect=return");
  assert.equal(result.refreshUrl, "https://app.example.test/profile-screen/bank-account?stripeConnect=refresh");
});
