import type { CrowdStatus, EventReward, EventStatus, EventTicket } from "../events/event.interface.js";
import type { CheckoutOrderLineItem } from "./checkout-payment.interface.js";
import { CheckoutPaymentRepository } from "./checkout-payment.repository.js";
import { TicketCancellationRepository } from "./ticket-cancellation.repository.js";
import { TicketUsageRepository } from "./ticket-usage.repository.js";

type CapacityResult = {
  eventId: string;
  capacity: number;
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
    const liveCapacityResults = events
      .filter((event) => event.status === "live")
      .map((event) => this.getCanonicalCapacity(event))
      .filter((item): item is CapacityResult => item !== null);

    if (liveCapacityResults.length === 0) {
      return result;
    }

    const capacityByEventId = new Map(
      liveCapacityResults.map((item) => [item.eventId, item.capacity]),
    );
    const liveEventIds = [...capacityByEventId.keys()];
    const eventById = new Map<string, CrowdStatusEventInput>();
    for (const event of events) {
      const eventId = getEventId(event);
      if (eventId) {
        eventById.set(eventId, event);
      }
    }
    const [orders, cancellations] = await Promise.all([
      this.checkoutPaymentRepository.findIssuedTicketOrdersByEventIds(liveEventIds),
      this.ticketCancellationRepository.findByEventIds(liveEventIds),
    ]);
    const orderIds = [...new Set(orders.map((order) => order._id.toString()))];
    const usages = await this.ticketUsageRepository.findByEventIdsAndOrderIds(liveEventIds, orderIds);
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
      const orderId = order._id.toString();

      for (const ticketPass of order.ticketPasses) {
        const event = eventById.get(ticketPass.eventId);

        if (!event || !capacityByEventId.has(ticketPass.eventId)) {
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

        if (!cancelledPassKeys.has(key)) {
          validPassKeys.add(key);
        }
      }
    }

    const checkedInCountByEventId = new Map<string, number>();
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

    for (const [eventId, capacity] of capacityByEventId) {
      const checkedInCount = checkedInCountByEventId.get(eventId) ?? 0;
      const percentage = (checkedInCount / capacity) * 100;
      result.set(eventId, this.classify(percentage));
    }

    return result;
  }

  private getCanonicalCapacity(event: CrowdStatusEventInput): CapacityResult | null {
    const eventId = getEventId(event);

    if (!eventId) {
      return null;
    }

    if (!event.tickets.length) {
      return null;
    }

    let capacity = 0;

    for (const ticket of event.tickets) {
      if (!Number.isFinite(ticket.capacity) || ticket.capacity < 0) {
        return null;
      }

      capacity += ticket.capacity;
    }

    return capacity > 0 ? { eventId, capacity } : null;
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
    if (percentage < 34) {
      return "not_busy";
    }

    if (percentage < 67) {
      return "busy";
    }

    return "very_busy";
  }
}
