import type { CrowdStatus, EventReward, EventStatus, EventTicket } from "../events/event.interface.js";
import type { CheckoutOrderLineItem } from "./checkout-payment.interface.js";
import { CheckoutPaymentRepository } from "./checkout-payment.repository.js";
import { TicketCancellationRepository } from "./ticket-cancellation.repository.js";
import { TicketUsageRepository } from "./ticket-usage.repository.js";

type AdmissionCounts = {
  validAdmissionCountByEventId: Map<string, number>;
  checkedInCountByEventId: Map<string, number>;
};

type CrowdStatusEventInput = {
  id?: string;
  _id?: { toString(): string };
  status: EventStatus;
  tickets: EventTicket[];
  rewards: EventReward[];
};

const toTicketPassKey = (eventId: string, ticketId: string, orderId: string, ticketIndex: number): string =>
  `${eventId}:${ticketId}:${orderId}:${ticketIndex}`;

const getEventId = (event: CrowdStatusEventInput): string =>
  event.id ?? event._id?.toString() ?? "";

export class CrowdStatusService {
  public constructor(
    private readonly checkoutPaymentRepository = new CheckoutPaymentRepository(),
    private readonly ticketCancellationRepository = new TicketCancellationRepository(),
    private readonly ticketUsageRepository = new TicketUsageRepository(),
  ) {}

  public async getCrowdStatusByEventId(events: CrowdStatusEventInput[]): Promise<Map<string, CrowdStatus | null>> {
    const result = new Map<string, CrowdStatus | null>();
    for (const event of events) {
      const eventId = getEventId(event);
      if (eventId) {
        result.set(eventId, null);
      }
    }
    const liveEventIds = [...new Set(events
      .filter((event) => event.status === "live")
      .map(getEventId)
      .filter(Boolean))];

    if (liveEventIds.length === 0) {
      return result;
    }

    const eventById = this.buildEventById(events);
    const { validAdmissionCountByEventId, checkedInCountByEventId } = await this.computeAdmissionCounts(
      liveEventIds,
      eventById,
    );

    for (const eventId of liveEventIds) {
      const totalValidAdmissions = validAdmissionCountByEventId.get(eventId) ?? 0;

      if (totalValidAdmissions === 0) {
        continue;
      }

      const checkedInCount = checkedInCountByEventId.get(eventId) ?? 0;
      const percentage = (checkedInCount / totalValidAdmissions) * 100;
      result.set(eventId, this.classify(percentage));
    }

    return result;
  }

  /**
   * Raw authoritative checked-in pass count per event (no live/occupancy gating,
   * no percentage classification) — reuses the same valid-pass-key semantics as
   * getCrowdStatusByEventId (duplicate-scan prevention, cancelled/refunded pass
   * exclusion, BOGO-aware quantity validation) for every event supplied, not
   * just live ones.
   */
  public async getCheckedInCountsByEventId(events: CrowdStatusEventInput[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    const eventById = this.buildEventById(events);

    for (const eventId of eventById.keys()) {
      result.set(eventId, 0);
    }

    const { checkedInCountByEventId } = await this.computeAdmissionCounts([...eventById.keys()], eventById);

    for (const [eventId, count] of checkedInCountByEventId) {
      result.set(eventId, count);
    }

    return result;
  }

  private buildEventById(events: CrowdStatusEventInput[]): Map<string, CrowdStatusEventInput> {
    const eventById = new Map<string, CrowdStatusEventInput>();

    for (const event of events) {
      const eventId = getEventId(event);
      if (eventId) {
        eventById.set(eventId, event);
      }
    }

    return eventById;
  }

  private async computeAdmissionCounts(
    eventIds: string[],
    eventById: Map<string, CrowdStatusEventInput>,
  ): Promise<AdmissionCounts> {
    const validAdmissionCountByEventId = new Map<string, number>();
    const checkedInCountByEventId = new Map<string, number>();

    if (eventIds.length === 0) {
      return { validAdmissionCountByEventId, checkedInCountByEventId };
    }

    const [orders, cancellations] = await Promise.all([
      this.checkoutPaymentRepository.findIssuedTicketOrdersByEventIds(eventIds),
      this.ticketCancellationRepository.findByEventIds(eventIds),
    ]);
    const orderIds = [...new Set(orders.map((order) => order._id.toString()))];
    const usages = await this.ticketUsageRepository.findByEventIdsAndOrderIds(eventIds, orderIds);
    const cancelledPassKeys = new Set(
      cancellations.map((cancellation) =>
        toTicketPassKey(
          cancellation.eventId.toString(),
          cancellation.ticketId,
          cancellation.orderId.toString(),
          cancellation.ticketIndex,
        ),
      ),
    );
    const validPassKeys = new Set<string>();

    for (const order of orders) {
      if (order.kind !== "ticket" || order.paymentStatus !== "paid") {
        continue;
      }

      const orderId = order._id.toString();

      for (const ticketPass of order.ticketPasses) {
        const event = eventById.get(ticketPass.eventId);

        if (!event) {
          continue;
        }

        const lineItem = order.lineItems.find(
          (item) =>
            item.itemType === "ticket" &&
            item.eventId === ticketPass.eventId &&
            item.itemId === ticketPass.ticketId,
        );

        if (!lineItem) {
          continue;
        }

        const { totalQuantity } = this.getEffectiveTicketQuantities(event, lineItem);

        if (ticketPass.ticketIndex > totalQuantity) {
          continue;
        }

        const key = toTicketPassKey(
          ticketPass.eventId,
          ticketPass.ticketId,
          orderId,
          ticketPass.ticketIndex,
        );

        if (!cancelledPassKeys.has(key) && !validPassKeys.has(key)) {
          validPassKeys.add(key);
          validAdmissionCountByEventId.set(
            ticketPass.eventId,
            (validAdmissionCountByEventId.get(ticketPass.eventId) ?? 0) + 1,
          );
        }
      }
    }

    const countedUsageKeys = new Set<string>();

    for (const usage of usages) {
      const key = toTicketPassKey(
        usage.eventId,
        usage.ticketId,
        usage.orderId.toString(),
        usage.ticketIndex,
      );

      if (!validPassKeys.has(key) || countedUsageKeys.has(key)) {
        continue;
      }

      countedUsageKeys.add(key);
      checkedInCountByEventId.set(
        usage.eventId,
        (checkedInCountByEventId.get(usage.eventId) ?? 0) + 1,
      );
    }

    return { validAdmissionCountByEventId, checkedInCountByEventId };
  }

  private calculateTicketRewardQuantity(paidQuantity: number, reward?: EventReward | null): number {
    const bogoEnabled = reward?.bogoEnabled ?? (
      typeof reward?.buyQuantity === "number" && typeof reward?.freeQuantity === "number"
    );

    if (!reward || reward.rewardType !== "ticket" || !bogoEnabled) {
      return 0;
    }

    if (reward.expiresAt && reward.expiresAt.getTime() < Date.now()) {
      return 0;
    }

    return Math.floor(paidQuantity / (reward.buyQuantity ?? 1)) * (reward.freeQuantity ?? 0);
  }

  private getTicketRewardForLineItem(event: CrowdStatusEventInput, lineItem: CheckoutOrderLineItem): EventReward | null {
    if (lineItem.itemType !== "ticket" || !lineItem.itemId) {
      return null;
    }

    return event.rewards.find(
      (reward) => reward.rewardType === "ticket" && reward.ticketId === lineItem.itemId,
    ) ?? null;
  }

  private getEffectiveTicketQuantities(
    event: CrowdStatusEventInput,
    lineItem: CheckoutOrderLineItem,
  ): { paidQuantity: number; freeQuantity: number; totalQuantity: number } {
    const paidQuantity = lineItem.paidQuantity ?? lineItem.quantity;
    const derivedFreeQuantity = this.calculateTicketRewardQuantity(
      paidQuantity,
      this.getTicketRewardForLineItem(event, lineItem),
    );
    const freeQuantity = lineItem.freeQuantity ?? derivedFreeQuantity;
    const totalQuantity = lineItem.totalQuantity ?? paidQuantity + freeQuantity;

    return {
      paidQuantity,
      freeQuantity,
      totalQuantity,
    };
  }

  private classify(percentage: number): CrowdStatus {
    if (percentage < 30) {
      return "not_busy";
    }

    if (percentage < 70) {
      return "busy";
    }

    return "very_busy";
  }
}
