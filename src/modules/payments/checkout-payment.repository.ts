import type { Types } from "mongoose";
import type {
  CheckoutPaymentStatus,
  CheckoutPayoutStatus,
  ICheckoutOrder,
} from "./checkout-payment.interface.js";
import { CheckoutOrderModel } from "./checkout-payment.model.js";

type CreateCheckoutOrderRecord = Omit<
  ICheckoutOrder,
  "_id" | "userId" | "createdAt" | "updatedAt" | "paidAt" | "failedAt" | "failureMessage"
> & {
  _id?: Types.ObjectId;
  userId: string;
  paidAt?: Date | null;
};

interface UpdatePaymentStatusPayload {
  paymentStatus: CheckoutPaymentStatus;
  payoutStatus?: CheckoutPayoutStatus;
  paidAt?: Date | null;
  failedAt?: Date | null;
  failureMessage?: string | null;
}

export class CheckoutPaymentRepository {
  public async create(payload: CreateCheckoutOrderRecord): Promise<ICheckoutOrder> {
    return CheckoutOrderModel.create(payload);
  }

  public async findById(id: string): Promise<ICheckoutOrder | null> {
    return CheckoutOrderModel.findById(id);
  }

  public async findByCheckInCode(checkInCode: string): Promise<ICheckoutOrder | null> {
    return CheckoutOrderModel.findOne({ "ticketPasses.checkInCode": checkInCode })
      .hint({ "ticketPasses.checkInCode": 1 });
  }

  public async rotateTicketPassCheckInCode(
    orderId: string,
    eventId: string,
    ticketId: string,
    ticketIndex: number,
    checkInCode: string,
  ): Promise<ICheckoutOrder | null> {
    return CheckoutOrderModel.findOneAndUpdate(
      {
        _id: orderId,
        kind: "ticket",
        paymentStatus: "paid",
        ticketPasses: { $elemMatch: { eventId, ticketId, ticketIndex } },
      },
      { $set: { "ticketPasses.$.checkInCode": checkInCode } },
      { new: true },
    );
  }

  public async findByIds(ids: string[]): Promise<ICheckoutOrder[]> {
    return ids.length > 0 ? CheckoutOrderModel.find({ _id: { $in: ids } }) : [];
  }

  public async findByPaymentIntentId(paymentIntentId: string): Promise<ICheckoutOrder | null> {
    return CheckoutOrderModel.findOne({ stripePaymentIntentId: paymentIntentId });
  }

  public async findPaidTicketOrdersByEventId(eventId: string): Promise<ICheckoutOrder[]> {
    return CheckoutOrderModel.find({
      kind: "ticket",
      paymentStatus: "paid",
      "lineItems.eventId": eventId,
    });
  }

  public async findTicketStatOrdersByEventId(eventId: string): Promise<ICheckoutOrder[]> {
    return CheckoutOrderModel.find({
      kind: "ticket",
      paymentStatus: {
        $in: ["paid", "refunded", "canceled", "failed", "processing", "requires_payment"],
      },
      "lineItems.eventId": eventId,
    }).sort({ paidAt: -1, createdAt: -1, _id: -1 });
  }

  public async findTicketWalletOrdersByUserId(userId: string): Promise<ICheckoutOrder[]> {
    return CheckoutOrderModel.find({
      userId,
      kind: "ticket",
      paymentStatus: { $in: ["paid", "refunded"] },
      "lineItems.itemType": "ticket",
    }).sort({ paidAt: -1, createdAt: -1, _id: -1 });
  }

  public async findFirstPaidTicketOrderForUserTicket(
    userId: string,
    eventId: string,
    ticketId: string,
  ): Promise<ICheckoutOrder | null> {
    return CheckoutOrderModel.findOne({
      userId,
      kind: "ticket",
      paymentStatus: "paid",
      "lineItems.eventId": eventId,
      "lineItems.itemId": ticketId,
    }).sort({ paidAt: 1, createdAt: 1, _id: 1 });
  }

  public async updatePaymentStatus(
    orderId: string,
    payload: UpdatePaymentStatusPayload,
  ): Promise<ICheckoutOrder | null> {
    return CheckoutOrderModel.findByIdAndUpdate(
      orderId,
      {
        $set: payload,
      },
      {
        new: true,
        runValidators: true,
      },
    );
  }

  public async updatePaymentStatusIf(
    orderId: string,
    fromStatuses: CheckoutPaymentStatus[],
    payload: UpdatePaymentStatusPayload,
  ): Promise<ICheckoutOrder | null> {
    return CheckoutOrderModel.findOneAndUpdate(
      { _id: orderId, paymentStatus: { $in: fromStatuses } },
      { $set: payload },
      { new: true, runValidators: true },
    );
  }

  public async processRefundForCancelledEvent(orderId: string): Promise<ICheckoutOrder | null> {
    return CheckoutOrderModel.findByIdAndUpdate(
      orderId,
      { $set: { paymentStatus: "refunded" } },
      { new: true, runValidators: true },
    );
  }

  public async getPurchasedCountForTicket(
    userId: string,
    eventId: string,
    ticketId: string,
  ): Promise<number> {
    const orders = await CheckoutOrderModel.find({
      userId,
      kind: "ticket",
      paymentStatus: "paid",
      "lineItems.eventId": eventId,
      "lineItems.itemId": ticketId,
    })
      .select("lineItems")
      .lean();

    return orders.reduce((total, order) => {
      return (
        total +
        order.lineItems
          .filter((item) => item.itemId === ticketId)
          .reduce((sum, item) => sum + item.quantity, 0)
      );
    }, 0);
  }

  public async getActivePurchasedCountForTicket(
    userId: string,
    eventId: string,
    ticketId: string,
  ): Promise<number> {
    const orders = await CheckoutOrderModel.find({
      userId,
      kind: "ticket",
      paymentStatus: { $in: ["paid", "requires_payment", "processing"] },
      "lineItems.eventId": eventId,
      "lineItems.itemId": ticketId,
    })
      .select("lineItems")
      .lean();

    return orders.reduce((total, order) => {
      return (
        total +
        order.lineItems
          .filter((item) => item.itemId === ticketId)
          .reduce((sum, item) => sum + item.quantity, 0)
      );
    }, 0);
  }

  public async findExistingPendingTicketOrder(
    userId: string,
    eventId: string,
    ticketId: string,
  ): Promise<ICheckoutOrder | null> {
    return CheckoutOrderModel.findOne({
      userId,
      kind: "ticket",
      paymentStatus: "requires_payment",
      reservedUntil: { $gt: new Date() },
      stripePaymentIntentId: { $exists: true, $ne: null },
      "lineItems.eventId": eventId,
      "lineItems.itemId": ticketId,
    });
  }

  public async findExistingPaidFreeOrder(
    userId: string,
    eventId: string,
    ticketId: string,
  ): Promise<ICheckoutOrder | null> {
    return CheckoutOrderModel.findOne({
      userId,
      kind: "ticket",
      paymentStatus: "paid",
      totalAmount: 0,
      "lineItems.eventId": eventId,
      "lineItems.itemId": ticketId,
    });
  }

  public async findStaleReservedOrders(limit: number): Promise<ICheckoutOrder[]> {
    return CheckoutOrderModel.find({
      paymentStatus: "requires_payment",
      reservedUntil: { $lt: new Date() },
      stripePaymentIntentId: { $exists: true, $ne: null },
    }).limit(limit);
  }

  public async getOwnedTicketCountForTicket(
    userId: string,
    eventId: string,
    ticketId: string,
  ): Promise<number> {
    const orders = await CheckoutOrderModel.find({
      userId,
      kind: "ticket",
      paymentStatus: "paid",
      "lineItems.eventId": eventId,
      "lineItems.itemId": ticketId,
    })
      .select("lineItems")
      .lean();

    return orders.reduce((total, order) => {
      return (
        total +
        order.lineItems
          .filter((item) => item.itemId === ticketId)
          .reduce((sum, item) => sum + (item.totalQuantity ?? item.quantity), 0)
      );
    }, 0);
  }

  public async findPaidTicketOrdersForUserEventTicket(
    userId: string,
    eventId: string,
    ticketId: string,
  ): Promise<ICheckoutOrder[]> {
    return CheckoutOrderModel.find({
      userId,
      kind: "ticket",
      paymentStatus: "paid",
      "lineItems.eventId": eventId,
      "lineItems.itemId": ticketId,
    }).select("lineItems userId kind paymentStatus createdAt paidAt");
  }

  public async hasUserPaidTicketForEvent(userId: string, eventId: string): Promise<boolean> {
    const order = await CheckoutOrderModel.findOne({
      userId,
      kind: "ticket",
      paymentStatus: "paid",
      "lineItems.eventId": eventId,
    })
      .select("_id")
      .lean();

    return Boolean(order);
  }

  public async findPaidTicketEventIdsByUser(userId: string): Promise<string[]> {
    const orders = await CheckoutOrderModel.find({
      userId,
      kind: "ticket",
      paymentStatus: "paid",
    })
      .select("lineItems")
      .lean();

    const eventIds = new Set<string>();

    for (const order of orders) {
      for (const item of order.lineItems) {
        if (item.eventId) {
          eventIds.add(item.eventId);
        }
      }
    }

    return [...eventIds];
  }

  public async getEventTicketSales(eventId: string): Promise<Record<string, number>> {
    const orders = await CheckoutOrderModel.find({
      kind: "ticket",
      paymentStatus: "paid",
      "lineItems.eventId": eventId,
    })
      .select("lineItems")
      .lean();

    const sales: Record<string, number> = {};

    for (const order of orders) {
      for (const item of order.lineItems) {
        if (item.itemId && item.eventId === eventId) {
          const qty =
            item.totalQuantity ??
            (item.paidQuantity ?? item.quantity) + (item.freeQuantity ?? 0);
          sales[item.itemId] = (sales[item.itemId] ?? 0) + qty;
        }
      }
    }

    return sales;
  }

  public async getPurchasedTicketCountsByEvent(
    userId: string,
    eventId: string,
  ): Promise<Record<string, number>> {
    const orders = await CheckoutOrderModel.find({
      userId,
      kind: "ticket",
      paymentStatus: "paid",
      "lineItems.eventId": eventId,
    })
      .select("lineItems")
      .lean();

    const counts: Record<string, number> = {};

    for (const order of orders) {
      for (const item of order.lineItems) {
        if (item.itemId && item.eventId === eventId) {
          counts[item.itemId] = (counts[item.itemId] ?? 0) + item.quantity;
        }
      }
    }

    return counts;
  }
}
