import type { Types } from "mongoose";

export const creatorPayoutStatuses = ["pending", "processing", "completed", "failed", "cancelled"] as const;
export type CreatorPayoutStatus = (typeof creatorPayoutStatuses)[number];

export const creatorPayoutTypes = ["bank_transfer", "instant_debit_card"] as const;
export type CreatorPayoutType = (typeof creatorPayoutTypes)[number];

export interface ICreatorPayout {
  _id: Types.ObjectId;
  creatorUserId: Types.ObjectId;
  earningIds: Types.ObjectId[];
  totalAmount: number;
  currency: string;
  payoutType: CreatorPayoutType;
  status: CreatorPayoutStatus;
  scheduledDate: Date;
  processingStartedAt?: Date | null;
  stripeTransferId?: string | null;
  failureReason?: string | null;
  processedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RequestWithdrawalDto {
  payoutType?: CreatorPayoutType;
  amount?: number;
}

export interface CreatorPayoutResponse {
  id: string;
  creatorUserId: string;
  earningIds: string[];
  totalAmount: number;
  currency: string;
  payoutType: CreatorPayoutType;
  status: CreatorPayoutStatus;
  scheduledDate: Date;
  processingStartedAt?: Date | null;
  stripeTransferId?: string | null;
  failureReason?: string | null;
  processedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
