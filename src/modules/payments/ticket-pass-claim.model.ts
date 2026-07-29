import { Schema, model } from "mongoose";

export type TicketPassClaimOwnerType = "check_in" | "cancellation";
export type TicketPassClaimStatus = "pending" | "accepted" | "aborted";

export interface ITicketPassClaim {
  eventId: string;
  ticketId: string;
  orderId: string;
  ticketIndex: number;
  ownerType: TicketPassClaimOwnerType;
  ownerId?: string | null;
  status: TicketPassClaimStatus;
  claimedAt: Date;
  expiresAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const ticketPassClaimSchema = new Schema<ITicketPassClaim>(
  {
    eventId: { type: String, required: true, trim: true, index: true },
    ticketId: { type: String, required: true, trim: true, maxlength: 80, index: true },
    orderId: { type: String, required: true, trim: true, index: true },
    ticketIndex: { type: Number, required: true, min: 1 },
    ownerType: { type: String, enum: ["check_in", "cancellation"], required: true, index: true },
    ownerId: { type: String, trim: true, default: null },
    status: { type: String, enum: ["pending", "accepted", "aborted"], required: true, index: true },
    claimedAt: { type: Date, required: true, default: Date.now },
    expiresAt: { type: Date, default: null, index: true },
  },
  { timestamps: true, versionKey: false },
);

ticketPassClaimSchema.index(
  { eventId: 1, ticketId: 1, orderId: 1, ticketIndex: 1 },
  { unique: true },
);
ticketPassClaimSchema.index({ status: 1, expiresAt: 1, updatedAt: 1 });

export const TicketPassClaimModel = model<ITicketPassClaim>("TicketPassClaim", ticketPassClaimSchema);

export const ensureTicketPassClaimIndexes = async (): Promise<void> => {
  await TicketPassClaimModel.syncIndexes();
};
