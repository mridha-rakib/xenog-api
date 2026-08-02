import { Types } from "mongoose";
import { UserModel } from "../user/user.model.js";
import { CheckoutOrderModel } from "../payments/checkout-payment.model.js";
import { TicketUsageModel } from "../payments/ticket-usage.model.js";
import { TicketCancellationModel } from "../payments/ticket-cancellation.model.js";
import { EventCancellationRefundModel } from "../payments/event-cancellation-refund.model.js";
import { EventModel } from "../events/event.model.js";
import type {
  DashboardUserTotals,
  MonetaryPeriodTotal,
  RefundStatusTotals,
  TicketBreakdownRow,
  TicketIssuanceTotals,
} from "./dashboard.interface.js";

interface DateWindow {
  start: Date;
  end: Date;
}

const CAPTURED_TICKET_PAYMENT_STATUSES = ["paid", "refunded"] as const;

const zeroMonetaryTotal: MonetaryPeriodTotal = { amountMinor: 0, count: 0 };

const readGroupTotal = (
  facetResult: Record<string, Array<{ amountMinor?: number; count?: number; qty?: number }>>,
  key: string,
): { amountMinor: number; count: number; qty: number } => {
  const row = facetResult[key]?.[0];
  return {
    amountMinor: row?.amountMinor ?? 0,
    count: row?.count ?? 0,
    qty: row?.qty ?? 0,
  };
};

export class DashboardRepository {
  /**
   * All-time user total plus period-bounded new-user counts, in one round trip.
   * `baseFilter` mirrors the existing Admin User Management exclusion rule
   * (non-admin, non-deleted/anonymized) so the two surfaces stay consistent.
   */
  public async getUserTotals(
    baseFilter: Record<string, unknown>,
    current: DateWindow,
    previous: DateWindow,
  ): Promise<DashboardUserTotals> {
    const [result] = await UserModel.aggregate<{
      total: Array<{ count: number }>;
      currentNew: Array<{ count: number }>;
      previousNew: Array<{ count: number }>;
    }>([
      { $match: baseFilter },
      {
        $facet: {
          total: [{ $count: "count" }],
          currentNew: [
            { $match: { createdAt: { $gte: current.start, $lt: current.end } } },
            { $count: "count" },
          ],
          previousNew: [
            { $match: { createdAt: { $gte: previous.start, $lt: previous.end } } },
            { $count: "count" },
          ],
        },
      },
    ]);

    return {
      total: result?.total?.[0]?.count ?? 0,
      currentNew: result?.currentNew?.[0]?.count ?? 0,
      previousNew: result?.previousNew?.[0]?.count ?? 0,
    };
  }

  /**
   * Gross ticket sales and tickets-issued totals for the current and comparison
   * periods, computed at the order level (never per-line-item) so `amountMinor`
   * is never double-counted across an order's line items.
   */
  public async getTicketIssuanceTotals(
    currency: string,
    current: DateWindow,
    previous: DateWindow,
  ): Promise<TicketIssuanceTotals> {
    const [result] = await CheckoutOrderModel.aggregate<
      Record<
        "currentGross" | "previousGross" | "currentIssued" | "previousIssued",
        Array<{ amountMinor?: number; qty?: number }>
      >
    >([
      {
        $match: {
          kind: "ticket",
          paymentStatus: { $in: CAPTURED_TICKET_PAYMENT_STATUSES },
          currency,
          paidAt: { $gte: previous.start, $lt: current.end },
        },
      },
      {
        $facet: {
          currentGross: [
            { $match: { paidAt: { $gte: current.start, $lt: current.end } } },
            { $group: { _id: null, amountMinor: { $sum: "$amountMinor" } } },
          ],
          previousGross: [
            { $match: { paidAt: { $gte: previous.start, $lt: previous.end } } },
            { $group: { _id: null, amountMinor: { $sum: "$amountMinor" } } },
          ],
          currentIssued: [
            { $match: { paidAt: { $gte: current.start, $lt: current.end } } },
            { $unwind: "$lineItems" },
            { $match: { "lineItems.itemType": "ticket" } },
            {
              $group: {
                _id: null,
                qty: { $sum: { $ifNull: ["$lineItems.totalQuantity", "$lineItems.quantity"] } },
              },
            },
          ],
          previousIssued: [
            { $match: { paidAt: { $gte: previous.start, $lt: previous.end } } },
            { $unwind: "$lineItems" },
            { $match: { "lineItems.itemType": "ticket" } },
            {
              $group: {
                _id: null,
                qty: { $sum: { $ifNull: ["$lineItems.totalQuantity", "$lineItems.quantity"] } },
              },
            },
          ],
        },
      },
    ]);

    const currentGross = readGroupTotal(result ?? {}, "currentGross");
    const previousGross = readGroupTotal(result ?? {}, "previousGross");
    const currentIssued = readGroupTotal(result ?? {}, "currentIssued");
    const previousIssued = readGroupTotal(result ?? {}, "previousIssued");

    return {
      currentGrossAmountMinor: currentGross.amountMinor,
      previousGrossAmountMinor: previousGross.amountMinor,
      currentIssued: currentIssued.qty,
      previousIssued: previousIssued.qty,
    };
  }

  /**
   * Per-ticket-type breakdown (paid/discounted/rewarded/issued quantities) for
   * the current period only, grouped by (eventId, ticketId). The caller resolves
   * "free" ticket-type classification separately via `resolveEventTicketTypes`
   * since that requires joining against Event configuration.
   */
  public async getTicketBreakdownRows(currency: string, current: DateWindow): Promise<TicketBreakdownRow[]> {
    const rows = await CheckoutOrderModel.aggregate<{
      _id: { eventId: string; ticketId: string };
      issuedQty: number;
      paidQty: number;
      discountedQty: number;
      rewardedQty: number;
    }>([
      {
        $match: {
          kind: "ticket",
          paymentStatus: { $in: CAPTURED_TICKET_PAYMENT_STATUSES },
          currency,
          paidAt: { $gte: current.start, $lt: current.end },
        },
      },
      { $unwind: "$lineItems" },
      { $match: { "lineItems.itemType": "ticket" } },
      {
        $addFields: {
          _issuedQty: { $ifNull: ["$lineItems.totalQuantity", "$lineItems.quantity"] },
          _paidQty: { $ifNull: ["$lineItems.paidQuantity", "$lineItems.quantity"] },
          _discountEnabled: { $ifNull: ["$lineItems.rewardSnapshot.discountEnabled", false] },
        },
      },
      {
        $group: {
          _id: { eventId: "$lineItems.eventId", ticketId: "$lineItems.itemId" },
          issuedQty: { $sum: "$_issuedQty" },
          paidQty: { $sum: "$_paidQty" },
          discountedQty: { $sum: { $cond: ["$_discountEnabled", "$_paidQty", 0] } },
          rewardedQty: { $sum: { $subtract: ["$_issuedQty", "$_paidQty"] } },
        },
      },
    ]);

    return rows.map((row) => ({
      eventId: row._id.eventId,
      ticketId: row._id.ticketId,
      issuedQty: row.issuedQty,
      paidQty: row.paidQty,
      discountedQty: row.discountedQty,
      rewardedQty: row.rewardedQty,
    }));
  }

  /**
   * Batched (never per-ticket) lookup of Event ticket "free"/"pay" type for the
   * distinct (eventId, ticketId) pairs referenced by a breakdown result.
   */
  public async resolveEventTicketTypes(
    pairs: Array<{ eventId: string; ticketId: string }>,
  ): Promise<Map<string, "free" | "pay">> {
    const typeByKey = new Map<string, "free" | "pay">();
    const distinctEventIds = [...new Set(pairs.map((pair) => pair.eventId))].filter((id) =>
      Types.ObjectId.isValid(id),
    );

    if (distinctEventIds.length === 0) {
      return typeByKey;
    }

    const events = await EventModel.find({ _id: { $in: distinctEventIds } })
      .select({ tickets: 1 })
      .lean();

    const ticketTypeByEventId = new Map<string, Map<string, "free" | "pay">>();
    for (const event of events) {
      const ticketMap = new Map<string, "free" | "pay">();
      for (const ticket of event.tickets ?? []) {
        ticketMap.set(ticket.id, ticket.type);
      }
      ticketTypeByEventId.set(event._id.toString(), ticketMap);
    }

    for (const pair of pairs) {
      const type = ticketTypeByEventId.get(pair.eventId)?.get(pair.ticketId);
      if (type) {
        typeByKey.set(`${pair.eventId}:${pair.ticketId}`, type);
      }
    }

    return typeByKey;
  }

  public async getCheckedInCount(current: DateWindow): Promise<number> {
    return TicketUsageModel.countDocuments({ usedAt: { $gte: current.start, $lt: current.end } });
  }

  public async getUserCancelledPassCount(current: DateWindow): Promise<number> {
    return TicketCancellationModel.countDocuments({
      status: "cancelled",
      createdAt: { $gte: current.start, $lt: current.end },
    });
  }

  /**
   * User-initiated ticket cancellation refund totals: completed refunds are
   * period-attributed by `refundCompletedAt`; pending/failed/reconciliation
   * buckets are current operational backlog and are not date-bounded.
   */
  public async getTicketCancellationRefundTotals(
    currency: string,
    current: DateWindow,
    previous: DateWindow,
  ): Promise<RefundStatusTotals> {
    const [result] = await TicketCancellationModel.aggregate<
      Record<
        "successful" | "successfulPrevious" | "pending" | "failed" | "reconciliationRequired",
        Array<{ amountMinor: number; count: number }>
      >
    >([
      { $match: { currency } },
      {
        $facet: {
          successful: [
            {
              $match: {
                refundStatus: "succeeded",
                refundCompletedAt: { $gte: current.start, $lt: current.end },
              },
            },
            { $group: { _id: null, amountMinor: { $sum: "$completedAmountMinor" }, count: { $sum: 1 } } },
          ],
          successfulPrevious: [
            {
              $match: {
                refundStatus: "succeeded",
                refundCompletedAt: { $gte: previous.start, $lt: previous.end },
              },
            },
            { $group: { _id: null, amountMinor: { $sum: "$completedAmountMinor" }, count: { $sum: 1 } } },
          ],
          pending: [
            { $match: { refundStatus: { $in: ["pending", "processing"] } } },
            { $group: { _id: null, amountMinor: { $sum: "$requestedAmountMinor" }, count: { $sum: 1 } } },
          ],
          failed: [
            { $match: { refundStatus: { $in: ["failed_retryable", "failed_terminal"] } } },
            { $group: { _id: null, amountMinor: { $sum: "$requestedAmountMinor" }, count: { $sum: 1 } } },
          ],
          reconciliationRequired: [
            { $match: { refundStatus: "reconciliation_required" } },
            { $group: { _id: null, amountMinor: { $sum: "$requestedAmountMinor" }, count: { $sum: 1 } } },
          ],
        },
      },
    ]);

    return this.toRefundStatusTotals(result ?? {});
  }

  /**
   * Host event-cancellation refund totals, using the same successful/pending/
   * failed/reconciliation-required shape as `getTicketCancellationRefundTotals`
   * so the service can sum both sources without re-deriving refund state.
   */
  public async getEventCancellationRefundTotals(
    currency: string,
    current: DateWindow,
    previous: DateWindow,
  ): Promise<RefundStatusTotals> {
    const [result] = await EventCancellationRefundModel.aggregate<
      Record<
        "successful" | "successfulPrevious" | "pending" | "failed" | "reconciliationRequired",
        Array<{ amountMinor: number; count: number }>
      >
    >([
      { $match: { currency } },
      {
        $facet: {
          successful: [
            { $match: { status: "succeeded", completedAt: { $gte: current.start, $lt: current.end } } },
            { $group: { _id: null, amountMinor: { $sum: "$completedAmountMinor" }, count: { $sum: 1 } } },
          ],
          successfulPrevious: [
            { $match: { status: "succeeded", completedAt: { $gte: previous.start, $lt: previous.end } } },
            { $group: { _id: null, amountMinor: { $sum: "$completedAmountMinor" }, count: { $sum: 1 } } },
          ],
          pending: [
            { $match: { status: { $in: ["pending", "processing"] } } },
            { $group: { _id: null, amountMinor: { $sum: "$requestedAmountMinor" }, count: { $sum: 1 } } },
          ],
          failed: [
            { $match: { status: { $in: ["failed_retryable", "failed_terminal"] } } },
            { $group: { _id: null, amountMinor: { $sum: "$requestedAmountMinor" }, count: { $sum: 1 } } },
          ],
          reconciliationRequired: [
            { $match: { status: "reconciliation_required" } },
            { $group: { _id: null, amountMinor: { $sum: "$requestedAmountMinor" }, count: { $sum: 1 } } },
          ],
        },
      },
    ]);

    return this.toRefundStatusTotals(result ?? {});
  }

  private toRefundStatusTotals(
    facetResult: Record<string, Array<{ amountMinor: number; count: number }>>,
  ): RefundStatusTotals {
    const read = (key: string): MonetaryPeriodTotal => {
      const row = facetResult[key]?.[0];
      return row ? { amountMinor: row.amountMinor, count: row.count } : { ...zeroMonetaryTotal };
    };

    return {
      successful: read("successful"),
      successfulPrevious: read("successfulPrevious"),
      pending: read("pending"),
      failed: read("failed"),
      reconciliationRequired: read("reconciliationRequired"),
    };
  }
}
