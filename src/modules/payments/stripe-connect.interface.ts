import type { Types } from "mongoose";

export const stripeConnectOnboardingStatuses = ["not_started", "pending", "completed", "restricted"] as const;

export type StripeConnectOnboardingStatus = (typeof stripeConnectOnboardingStatuses)[number];

export interface StripeConnectRequirements {
  currentlyDue: string[];
  eventuallyDue: string[];
  pastDue: string[];
  disabledReason?: string | null;
}

export interface StripeConnectPayoutAccountView {
  id: string;
  type: "bank_account" | "card";
  name: string;
  bankName?: string | null;
  brand?: string | null;
  last4: string;
  currency?: string | null;
  country?: string | null;
  status?: string | null;
  defaultForCurrency?: boolean | null;
  availablePayoutMethods?: string[] | null;
}

export type InstantPayoutUnavailableReason =
  | "stripe_account_not_ready"
  | "payouts_disabled"
  | "no_external_card"
  | "card_not_instant_eligible"
  | "multiple_eligible_cards"
  | "unsupported_configuration";

export interface EligibleInstantDebitCardView {
  id: string;
  brand?: string | null;
  last4: string;
  currency?: string | null;
  country?: string | null;
  availablePayoutMethods: string[];
}

export interface InstantDebitCardEligibility {
  eligible: boolean;
  eligibleInstantDebitCard: EligibleInstantDebitCardView | null;
  unavailableReason: InstantPayoutUnavailableReason | null;
}

export interface StripePayoutReadiness {
  stripeAccountId: string;
  eligibleInstantDebitCard: EligibleInstantDebitCardView | null;
}

export interface IStripeConnectAccount {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  stripeAccountId: string;
  email?: string | null;
  country?: string | null;
  livemode: boolean;
  detailsSubmitted: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  onboardingStatus: StripeConnectOnboardingStatus;
  requirements: StripeConnectRequirements;
  lastSyncedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateStripeConnectOnboardingLinkDto {
  returnUrl?: string;
  refreshUrl?: string;
}

export interface StripeConnectAccountView {
  id: string;
  userId: string;
  stripeAccountId: string;
  email?: string | null;
  country?: string | null;
  livemode: boolean;
  detailsSubmitted: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  onboardingStatus: StripeConnectOnboardingStatus;
  requirements: StripeConnectRequirements;
  payoutAccounts: StripeConnectPayoutAccountView[];
  lastSyncedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StripeConnectOnboardingLinkResult {
  onboardingUrl: string;
  returnUrl: string;
  refreshUrl: string;
  expiresAt?: Date | null;
  linkType?: "account_onboarding" | "express_dashboard";
  account: StripeConnectAccountView;
}
