import type { Types } from "mongoose";
import type { MoomentCreditPackageResponse } from "../settings/mooment-credit.interface.js";

export const moomentCreditPaymentMethods = ["stripe", "card", "apple"] as const;
export type MoomentCreditPaymentMethod = (typeof moomentCreditPaymentMethods)[number];

export const moomentCreditPurchaseStatuses = ["completed", "failed"] as const;
export type MoomentCreditPurchaseStatus = (typeof moomentCreditPurchaseStatuses)[number];

export interface IMoomentCreditWallet {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  balance: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface IMoomentCreditPurchase {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  packageId: string;
  packageName: string;
  credits: number;
  subtotalUsd: number;
  platformFeeUsd: number;
  taxPercent: number;
  taxUsd: number;
  totalUsd: number;
  paymentMethod: MoomentCreditPaymentMethod;
  status: MoomentCreditPurchaseStatus;
  paymentReference: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface MoomentCreditCheckoutLineItems {
  itemLabel: string;
  itemAmountUsd: number;
  subtotalUsd: number;
  platformFeeUsd: number;
  taxPercent: number;
  taxUsd: number;
  totalUsd: number;
}

export interface MoomentCreditCheckoutQuote {
  creditPackage: MoomentCreditPackageResponse;
  lineItems: MoomentCreditCheckoutLineItems;
}

export interface CreateMoomentCreditPurchaseDto {
  packageId: string;
  paymentMethod: MoomentCreditPaymentMethod;
  acceptedTerms?: boolean;
}

export interface MoomentCreditPurchaseResponse {
  id: string;
  packageId: string;
  packageName: string;
  credits: number;
  subtotalUsd: number;
  platformFeeUsd: number;
  taxPercent: number;
  taxUsd: number;
  totalUsd: number;
  paymentMethod: MoomentCreditPaymentMethod;
  status: MoomentCreditPurchaseStatus;
  paymentReference: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface MoomentCreditWalletResponse {
  id: string;
  balance: number;
  purchases: MoomentCreditPurchaseResponse[];
  createdAt: Date;
  updatedAt: Date;
}
