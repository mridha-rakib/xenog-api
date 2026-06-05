import httpStatus from "http-status";
import Stripe from "stripe";
import { env } from "../../config/env.js";
import { AppError } from "../../core/errors/app-error.js";
import type { AuthUser } from "../auth/auth.interface.js";
import type {
  CreateStripeConnectOnboardingLinkDto,
  IStripeConnectAccount,
  StripeConnectAccountView,
  StripeConnectOnboardingLinkResult,
  StripeConnectOnboardingStatus,
  StripeConnectPayoutAccountView,
  StripeConnectRequirements,
} from "./stripe-connect.interface.js";
import { StripeConnectRepository } from "./stripe-connect.repository.js";

type StripeClient = InstanceType<typeof Stripe>;
type StripeAccount = Awaited<ReturnType<StripeClient["accounts"]["retrieve"]>>;
type StripeExternalAccount = NonNullable<StripeAccount["external_accounts"]>["data"][number];

type RedirectUrls = {
  returnUrl: string;
  refreshUrl: string;
};

const toRequirements = (account: StripeAccount): StripeConnectRequirements => ({
  currentlyDue: account.requirements?.currently_due ?? [],
  eventuallyDue: account.requirements?.eventually_due ?? [],
  pastDue: account.requirements?.past_due ?? [],
  disabledReason: account.requirements?.disabled_reason ?? null,
});

const getOnboardingStatus = (account: StripeAccount): StripeConnectOnboardingStatus => {
  if (account.payouts_enabled && account.details_submitted && !account.requirements?.disabled_reason) {
    return "completed";
  }

  if (account.requirements?.disabled_reason) {
    return "restricted";
  }

  if (account.details_submitted || (account.requirements?.currently_due?.length ?? 0) > 0) {
    return "pending";
  }

  return "not_started";
};

const toPayoutAccountView = (account: StripeExternalAccount): StripeConnectPayoutAccountView => {
  if (account.object === "bank_account") {
    const bankName = account.bank_name ?? "Bank account";

    return {
      id: account.id,
      type: "bank_account",
      name: bankName,
      bankName,
      last4: account.last4,
      currency: account.currency,
      country: account.country,
      status: account.status,
      defaultForCurrency: account.default_for_currency,
      availablePayoutMethods: account.available_payout_methods ?? null,
    };
  }

  return {
    id: account.id,
    type: "card",
    name: `${account.brand} card`,
    brand: account.brand,
    last4: account.last4,
    currency: account.currency,
    country: account.country,
    defaultForCurrency: account.default_for_currency,
    availablePayoutMethods: account.available_payout_methods ?? null,
  };
};

const toPayoutAccounts = (account: StripeAccount): StripeConnectPayoutAccountView[] =>
  account.external_accounts?.data.map(toPayoutAccountView) ?? [];

const toAccountView = (
  account: IStripeConnectAccount,
  payoutAccounts: StripeConnectPayoutAccountView[] = [],
): StripeConnectAccountView => ({
  id: account._id.toString(),
  userId: account.userId.toString(),
  stripeAccountId: account.stripeAccountId,
  email: account.email,
  country: account.country,
  livemode: account.livemode,
  detailsSubmitted: account.detailsSubmitted,
  chargesEnabled: account.chargesEnabled,
  payoutsEnabled: account.payoutsEnabled,
  onboardingStatus: account.onboardingStatus,
  requirements: account.requirements,
  payoutAccounts,
  lastSyncedAt: account.lastSyncedAt,
  createdAt: account.createdAt,
  updatedAt: account.updatedAt,
});

export class StripeConnectService {
  private stripe: StripeClient | null = null;

  public constructor(private readonly repository = new StripeConnectRepository()) {}

  public async getAccount(userId: string): Promise<StripeConnectAccountView | null> {
    const existingAccount = await this.repository.findByUserId(userId);

    if (!existingAccount) {
      return null;
    }

    const stripeAccount = await this.retrieveStripeAccount(existingAccount.stripeAccountId);
    const syncedAccount = await this.repository.upsertByUserId(
      this.toPersistencePayload(existingAccount.userId.toString(), stripeAccount),
    );

    return toAccountView(syncedAccount, toPayoutAccounts(stripeAccount));
  }

  public async createOnboardingLink(
    user: AuthUser,
    payload: CreateStripeConnectOnboardingLinkDto,
  ): Promise<StripeConnectOnboardingLinkResult> {
    const stripe = this.getStripe();
    const redirectUrls = this.resolveRedirectUrls(payload);
    const account = await this.ensureConnectedAccount(user);
    const accountLink = await stripe.accountLinks.create({
      account: account.stripeAccountId,
      refresh_url: redirectUrls.refreshUrl,
      return_url: redirectUrls.returnUrl,
      type: "account_onboarding",
    });

    return {
      onboardingUrl: accountLink.url,
      returnUrl: redirectUrls.returnUrl,
      refreshUrl: redirectUrls.refreshUrl,
      expiresAt: accountLink.expires_at ? new Date(accountLink.expires_at * 1000) : null,
      account: toAccountView(account),
    };
  }

  private getStripe(): StripeClient {
    if (this.stripe) {
      return this.stripe;
    }

    if (!env.STRIPE_SECRET_KEY) {
      throw new AppError("Stripe is not configured", httpStatus.SERVICE_UNAVAILABLE);
    }

    this.stripe = new Stripe(env.STRIPE_SECRET_KEY, {
      appInfo: {
        name: env.APP_NAME,
      },
    });

    return this.stripe;
  }

  private async ensureConnectedAccount(user: AuthUser): Promise<IStripeConnectAccount> {
    const existingAccount = await this.repository.findByUserId(user.id);

    if (existingAccount) {
      return this.syncAccount(existingAccount);
    }

    const stripe = this.getStripe();
    const stripeAccount = await stripe.accounts.create({
      type: "express",
      country: env.STRIPE_MERCHANT_COUNTRY,
      email: user.email,
      business_type: user.accountType === "business" ? "company" : "individual",
      capabilities: {
        transfers: {
          requested: true,
        },
      },
      metadata: {
        userId: user.id,
      },
    });

    return this.repository.upsertByUserId(this.toPersistencePayload(user.id, stripeAccount));
  }

  private async syncAccount(account: IStripeConnectAccount): Promise<IStripeConnectAccount> {
    const stripeAccount = await this.retrieveStripeAccount(account.stripeAccountId);

    return this.repository.upsertByUserId(this.toPersistencePayload(account.userId.toString(), stripeAccount));
  }

  private async retrieveStripeAccount(accountId: string): Promise<StripeAccount> {
    return this.getStripe().accounts.retrieve(accountId, {
      expand: ["external_accounts"],
    });
  }

  private toPersistencePayload(userId: string, account: StripeAccount) {
    return {
      userId,
      stripeAccountId: account.id,
      email: account.email ?? null,
      country: account.country ?? null,
      livemode: env.STRIPE_SECRET_KEY?.startsWith("sk_live_") ?? false,
      detailsSubmitted: account.details_submitted,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      onboardingStatus: getOnboardingStatus(account),
      requirements: toRequirements(account),
      lastSyncedAt: new Date(),
    };
  }

  private resolveRedirectUrls(payload: CreateStripeConnectOnboardingLinkDto): RedirectUrls {
    const allowClientRedirects = env.STRIPE_CONNECT_ALLOW_CLIENT_REDIRECTS ?? env.NODE_ENV !== "production";
    const returnUrl = allowClientRedirects && payload.returnUrl ? payload.returnUrl : env.STRIPE_CONNECT_RETURN_URL;
    const refreshUrl =
      allowClientRedirects && payload.refreshUrl
        ? payload.refreshUrl
        : env.STRIPE_CONNECT_REFRESH_URL ?? env.STRIPE_CONNECT_RETURN_URL;

    if (!returnUrl || !refreshUrl) {
      throw new AppError(
        "Stripe Connect redirect URLs are not configured",
        httpStatus.SERVICE_UNAVAILABLE,
        {
          code: "STRIPE_CONNECT_REDIRECT_URLS_MISSING",
        },
      );
    }

    this.assertStripeRedirectUrl(returnUrl);
    this.assertStripeRedirectUrl(refreshUrl);

    return { returnUrl, refreshUrl };
  }

  private assertStripeRedirectUrl(url: string): void {
    const parsedUrl = new URL(url);

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new AppError("Stripe Connect return and refresh URLs must be HTTP(S) URLs", httpStatus.BAD_REQUEST);
    }

    if (parsedUrl.protocol !== "https:") {
      if (env.NODE_ENV !== "production") {
        return;
      }

      throw new AppError("Stripe Connect redirect URLs must use HTTPS in production", httpStatus.BAD_REQUEST);
    }
  }
}
