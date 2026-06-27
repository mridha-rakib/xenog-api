import type { Types } from "mongoose";

export const creatorEarningStatuses = [
  "held",
  "eligible",
  "withdrawn",
  "refunded",
] as const;
export type CreatorEarningStatus = (typeof creatorEarningStatuses)[number];

export interface ICreatorEarning {
  _id: Types.ObjectId;
  creatorUserId: Types.ObjectId;
  orderId: Types.ObjectId;
  eventId?: Types.ObjectId | null;
  itemType: "ticket" | "product";
  grossAmount: number;
  platformFeePercent: number;
  platformFeeAmount: number;
  netAmount: number;
  status: CreatorEarningStatus;
  eligibleAt?: Date | null;
  payoutId?: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatorEarningResponse {
  id: string;
  creatorUserId: string;
  orderId: string;
  eventId?: string | null;
  itemType: "ticket" | "product";
  grossAmount: number;
  platformFeePercent: number;
  platformFeeAmount: number;
  netAmount: number;
  status: CreatorEarningStatus;
  eligibleAt?: Date | null;
  payoutId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatorEarningsSummaryResponse {
  heldAmount: number;
  eligibleAmount: number;
  pendingWithdrawalAmount: number;
  withdrawnAmount: number;
  totalEarnedAmount: number;
  earnings: CreatorEarningResponse[];
}

export interface EventEarningsSummaryResponse {
  grossAmount: number;
  platformFeeAmount: number;
  netAmount: number;
  refundedAmount: number;
  ticketNetAmount: number;
  productNetAmount: number;
  earnings: CreatorEarningResponse[];
}
