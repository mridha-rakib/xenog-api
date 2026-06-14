import type { Types } from "mongoose";

export const creatorPayoutStatuses = ["pending", "processing", "completed", "failed"] as const;
export type CreatorPayoutStatus = (typeof creatorPayoutStatuses)[number];

export const creatorPayoutTypes = ["bank_transfer", "mooment_credits"] as const;
export type CreatorPayoutType = (typeof creatorPayoutTypes)[number];

export interface ICreatorPayout {
  _id: Types.ObjectId;
  creatorUserId: Types.ObjectId;
  earningIds: Types.ObjectId[];
  totalAmount: number;
  payoutType: CreatorPayoutType;
  status: CreatorPayoutStatus;
  scheduledDate: Date;
  moomentCreditsAwarded?: number | null;
  stripeTransferId?: string | null;
  failureReason?: string | null;
  processedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RequestWithdrawalDto {
  payoutType: CreatorPayoutType;
}

export interface CreatorPayoutResponse {
  id: string;
  creatorUserId: string;
  earningIds: string[];
  totalAmount: number;
  payoutType: CreatorPayoutType;
  status: CreatorPayoutStatus;
  scheduledDate: Date;
  moomentCreditsAwarded?: number | null;
  stripeTransferId?: string | null;
  failureReason?: string | null;
  processedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
