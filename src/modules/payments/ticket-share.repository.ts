import { TicketShareModel } from "./ticket-share.model.js";
import type { ITicketShare } from "./checkout-payment.interface.js";

type CreateTicketShareRecord = {
  ownerUserId: string;
  recipientUserId: string;
  orderId: string;
  eventId: string;
  ticketId: string;
  ticketIndex: number;
};

export class TicketShareRepository {
  public async create(payload: CreateTicketShareRecord): Promise<ITicketShare> {
    return TicketShareModel.create({
      ...payload,
      status: "active",
      sharedAt: new Date(),
      cancelledAt: null,
    });
  }

  public async findActiveByOwnerAndTicket(
    ownerUserId: string,
    eventId: string,
    ticketId: string,
    orderId: string,
    ticketIndex: number,
  ): Promise<ITicketShare | null> {
    return TicketShareModel.findOne({
      ownerUserId,
      eventId,
      ticketId,
      orderId,
      ticketIndex,
      status: "active",
    });
  }

  public async findActiveByTicketPass(
    eventId: string,
    ticketId: string,
    orderId: string,
    ticketIndex: number,
  ): Promise<ITicketShare | null> {
    return TicketShareModel.findOne({
      eventId,
      ticketId,
      orderId,
      ticketIndex,
      status: "active",
    });
  }

  public async findActiveById(shareId: string): Promise<ITicketShare | null> {
    return TicketShareModel.findOne({
      _id: shareId,
      status: "active",
    });
  }

  public async findActiveByOwnerId(ownerUserId: string): Promise<ITicketShare[]> {
    return TicketShareModel.find({
      ownerUserId,
      status: "active",
    }).sort({ sharedAt: -1, _id: -1 });
  }

  public async findActiveByRecipientId(recipientUserId: string): Promise<ITicketShare[]> {
    return TicketShareModel.find({
      recipientUserId,
      status: "active",
    }).sort({ sharedAt: -1, _id: -1 });
  }

  public async hasActiveShareForRecipientAtEvent(recipientUserId: string, eventId: string): Promise<boolean> {
    const share = await TicketShareModel.findOne({
      recipientUserId,
      eventId,
      status: "active",
    })
      .select("_id")
      .lean();

    return Boolean(share);
  }

  public async countActiveByOwnerAndTicket(ownerUserId: string, eventId: string, ticketId: string): Promise<number> {
    return TicketShareModel.countDocuments({
      ownerUserId,
      eventId,
      ticketId,
      status: "active",
    });
  }

  public async findActiveEventIdsByRecipient(recipientUserId: string): Promise<string[]> {
    const shares = await TicketShareModel.find({
      recipientUserId,
      status: "active",
    })
      .select("eventId")
      .lean();

    return [...new Set(shares.map((s) => s.eventId))];
  }

  public async cancelByIdForOwner(shareId: string, ownerUserId: string): Promise<ITicketShare | null> {
    return TicketShareModel.findOneAndUpdate(
      {
        _id: shareId,
        ownerUserId,
        status: "active",
      },
      {
        $set: {
          status: "cancelled",
          cancelledAt: new Date(),
        },
      },
      {
        new: true,
        runValidators: true,
      },
    );
  }
}
