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
  account: StripeConnectAccountView;
}
