import { Types } from "mongoose";
import { CheckoutOrderModel } from "./checkout-payment.model.js";
import { TicketCancellationModel } from "./ticket-cancellation.model.js";
import { EventCancellationRefundModel } from "./event-cancellation-refund.model.js";
import { UserModel } from "../user/user.model.js";
import type { IUser } from "../user/user.interface.js";
import type { CapturedTicketOrderRow, PaymentManagementStatus } from "./payment-management.interface.js";

/** Safety cap on how many matching users a name/email search can expand into
 *  before being used as a CheckoutOrder `$in` filter — bounds worst-case query
 *  size without materially affecting real admin searches. */
const MAX_SEARCH_MATCHED_USERS = 500;

export interface CapturedOrderFilter {
  paymentStatusFilter: PaymentManagementStatus | { $in: PaymentManagementStatus[] };
  paidAtRange?: { start: Date; end: Date };
  userIds?: Types.ObjectId[];
}

export class PaymentManagementRepository {
  /** Batched (never per-order) user search by name/email — returns matching
   *  user IDs so the caller can scope the CheckoutOrder query to them. */
  public async findMatchingUserIds(search: string): Promise<Types.ObjectId[]> {
    const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const users = await UserModel.find({
      $or: [
        { name: { $regex: escapedSearch, $options: "i" } },
        { email: { $regex: escapedSearch, $options: "i" } },
      ],
    })
      .select({ _id: 1 })
      .limit(MAX_SEARCH_MATCHED_USERS)
      .lean();

    return users.map((user) => user._id);
  }

  private buildMatch(filter: CapturedOrderFilter): Record<string, unknown> {
    const match: Record<string, unknown> = {
      kind: "ticket",
      paymentStatus: filter.paymentStatusFilter,
    };

    if (filter.paidAtRange) {
      match.paidAt = { $gte: filter.paidAtRange.start, $lt: filter.paidAtRange.end };
    }

    if (filter.userIds) {
      match.userId = { $in: filter.userIds };
    }

    return match;
  }

  public async countCapturedTicketOrders(filter: CapturedOrderFilter): Promise<number> {
    return CheckoutOrderModel.countDocuments(this.buildMatch(filter));
  }

  public async findCapturedTicketOrders(
    filter: CapturedOrderFilter,
    skip: number,
    limit: number,
  ): Promise<CapturedTicketOrderRow[]> {
    const orders = await CheckoutOrderModel.find(this.buildMatch(filter))
      .select({ userId: 1, paymentStatus: 1, paidAt: 1, amountMinor: 1, currency: 1 })
      .sort({ paidAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    return orders.map((order) => ({
      id: order._id.toString(),
      userId: order.userId.toString(),
      paymentStatus: order.paymentStatus as "paid" | "refunded",
      paidAt: order.paidAt ?? null,
      amountMinor: order.amountMinor,
      currency: order.currency,
    }));
  }

  /** Batched (never per-order) lookup of the buyer records for a page of
   *  orders, keyed by user id string. */
  public async findUsersByIds(userIds: string[]): Promise<Map<string, IUser>> {
    const distinctIds = [...new Set(userIds)].filter((id) => Types.ObjectId.isValid(id));

    if (distinctIds.length === 0) {
      return new Map();
    }

    const users = await UserModel.find({ _id: { $in: distinctIds } });

    return new Map(users.map((user) => [user._id.toString(), user]));
  }

  /** Batched (never per-order) sum of succeeded user-ticket-cancellation
   *  refunds for a page of orders, keyed by order id string. */
  public async getUserTicketRefundTotals(orderIds: string[]): Promise<Map<string, number>> {
    if (orderIds.length === 0) {
      return new Map();
    }

    const rows = await TicketCancellationModel.aggregate<{ _id: Types.ObjectId; amountMinor: number }>([
      {
        $match: {
          orderId: { $in: orderIds.map((id) => new Types.ObjectId(id)) },
          refundStatus: "succeeded",
        },
      },
      { $group: { _id: "$orderId", amountMinor: { $sum: "$completedAmountMinor" } } },
    ]);

    return new Map(rows.map((row) => [row._id.toString(), row.amountMinor]));
  }

  /** Batched (never per-order) sum of succeeded host-event-cancellation
   *  refunds for a page of orders, keyed by order id string. */
  public async getHostEventRefundTotals(orderIds: string[]): Promise<Map<string, number>> {
    if (orderIds.length === 0) {
      return new Map();
    }

    const rows = await EventCancellationRefundModel.aggregate<{ _id: Types.ObjectId; amountMinor: number }>([
      {
        $match: {
          checkoutOrderId: { $in: orderIds.map((id) => new Types.ObjectId(id)) },
          status: "succeeded",
        },
      },
      { $group: { _id: "$checkoutOrderId", amountMinor: { $sum: "$completedAmountMinor" } } },
    ]);

    return new Map(rows.map((row) => [row._id.toString(), row.amountMinor]));
  }
}
