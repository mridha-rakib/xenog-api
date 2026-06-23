import { Types } from "mongoose";
import type { ITicketUsage, TicketWalletSource } from "./checkout-payment.interface.js";
import { TicketUsageModel } from "./ticket-usage.model.js";

type CreateTicketUsageRecord = {
  ownerUserId: string;
  holderUserId: string;
  usedByUserId: string;
  shareId?: string | null;
  orderId: string;
  eventId: string;
  ticketId: string;
  ticketIndex: number;
  source: TicketWalletSource;
  usedAt?: Date;
};

export class TicketUsageRepository {
  public async create(payload: CreateTicketUsageRecord): Promise<ITicketUsage> {
    return TicketUsageModel.create({
      ...payload,
      shareId: payload.shareId ? new Types.ObjectId(payload.shareId) : null,
      usedAt: payload.usedAt ?? new Date(),
    });
  }

  public async findByTicketPass(
    eventId: string,
    ticketId: string,
    orderId: string,
    ticketIndex: number,
  ): Promise<ITicketUsage | null> {
    return TicketUsageModel.findOne({
      eventId,
      ticketId,
      orderId,
      ticketIndex,
    });
  }

  public async findByEventIdsAndOrderIds(eventIds: string[], orderIds: string[]): Promise<ITicketUsage[]> {
    if (eventIds.length === 0 || orderIds.length === 0) {
      return [];
    }

    return TicketUsageModel.find({
      eventId: { $in: eventIds },
      orderId: { $in: orderIds },
    }).sort({ usedAt: -1, _id: -1 });
  }
}
