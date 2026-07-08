import httpStatus from "http-status";
import { AppError } from "../../core/errors/app-error.js";
import { CheckoutPaymentRepository } from "../payments/checkout-payment.repository.js";
import type {
  CheckoutOrderLineItem,
  ICheckoutOrder,
  ITicketShare,
  ITicketUsage,
} from "../payments/checkout-payment.interface.js";
import { TicketShareRepository } from "../payments/ticket-share.repository.js";
import { TicketUsageRepository } from "../payments/ticket-usage.repository.js";
import type { IEvent } from "./event.interface.js";
import { EventRepository } from "./event.repository.js";

export type EventChatAccessResult = {
  event: IEvent;
  attendance: ITicketUsage;
};

export class EventChatAccessService {
  public constructor(
    private readonly eventRepository = new EventRepository(),
    private readonly checkoutPaymentRepository = new CheckoutPaymentRepository(),
    private readonly ticketShareRepository = new TicketShareRepository(),
    private readonly ticketUsageRepository = new TicketUsageRepository(),
  ) {}

  public async assertEventChatAccess(
    eventId: string,
    userId: string,
    now = new Date(),
  ): Promise<EventChatAccessResult> {
    const event = await this.eventRepository.findById(eventId);

    if (!event || event.status === "draft") {
      throw new AppError("Event not found.", httpStatus.NOT_FOUND);
    }

    this.assertEventChatWindow(event, now);

    const attendance = await this.ticketUsageRepository.findByEventIdAndHolderUserId(
      eventId,
      userId,
    );

    if (!attendance) {
      throw new AppError("Check in to join event chat.", httpStatus.FORBIDDEN);
    }

    await this.assertValidCheckedInTicket(event, attendance, userId);

    return { event, attendance };
  }

  private assertEventChatWindow(event: IEvent, now: Date): void {
    if (event.status === "cancelled") {
      throw new AppError("Event chat is closed.", httpStatus.FORBIDDEN);
    }

    if (event.status === "completed") {
      throw new AppError("Event chat is closed.", httpStatus.FORBIDDEN);
    }

    if (!event.scheduledAt || !event.endAt) {
      throw new AppError("Event chat is unavailable.", httpStatus.FORBIDDEN);
    }

    if (event.scheduledAt.getTime() > now.getTime()) {
      throw new AppError("Event chat opens when the event starts.", httpStatus.FORBIDDEN);
    }

    if (event.endAt.getTime() <= now.getTime()) {
      throw new AppError("Event chat is closed.", httpStatus.FORBIDDEN);
    }
  }

  private async assertValidCheckedInTicket(
    event: IEvent,
    attendance: ITicketUsage,
    userId: string,
  ): Promise<void> {
    const eventId = event._id.toString();
    const orderId = attendance.orderId.toString();
    const ticketId = attendance.ticketId;
    const holderUserId = attendance.holderUserId.toString();

    if (attendance.eventId !== eventId || holderUserId !== userId) {
      throw new AppError("Check in to join event chat.", httpStatus.FORBIDDEN);
    }

    if (!event.tickets.some((ticket) => ticket.id === ticketId)) {
      throw new AppError(
        "Your checked-in ticket is no longer valid for this event.",
        httpStatus.FORBIDDEN,
      );
    }

    const order = await this.checkoutPaymentRepository.findById(orderId);

    if (!this.isPaidTicketOrderForUsage(order, attendance)) {
      throw new AppError(
        "Your checked-in ticket is no longer valid for this event.",
        httpStatus.FORBIDDEN,
      );
    }

    const activeShare = await this.ticketShareRepository.findActiveByTicketPass(
      eventId,
      ticketId,
      orderId,
      attendance.ticketIndex,
    );

    if (activeShare) {
      this.assertActiveShareMatchesUsage(activeShare, attendance, userId);
      return;
    }

    if (attendance.source !== "owned" || order.userId.toString() !== userId || attendance.shareId) {
      throw new AppError(
        "Your checked-in ticket is no longer valid for this event.",
        httpStatus.FORBIDDEN,
      );
    }
  }

  private isPaidTicketOrderForUsage(
    order: ICheckoutOrder | null,
    attendance: ITicketUsage,
  ): order is ICheckoutOrder {
    if (!order || order.kind !== "ticket" || order.paymentStatus !== "paid") {
      return false;
    }

    const lineItem = order.lineItems.find((item) => this.lineItemMatchesUsage(item, attendance));

    if (!lineItem) {
      return false;
    }

    return attendance.ticketIndex <= this.getLineItemTicketQuantity(lineItem);
  }

  private lineItemMatchesUsage(lineItem: CheckoutOrderLineItem, attendance: ITicketUsage): boolean {
    return (
      lineItem.itemType === "ticket" &&
      lineItem.eventId === attendance.eventId &&
      lineItem.itemId === attendance.ticketId
    );
  }

  private getLineItemTicketQuantity(lineItem: CheckoutOrderLineItem): number {
    return (
      lineItem.totalQuantity ??
      (lineItem.paidQuantity ?? lineItem.quantity) + (lineItem.freeQuantity ?? 0)
    );
  }

  private assertActiveShareMatchesUsage(
    activeShare: ITicketShare,
    attendance: ITicketUsage,
    userId: string,
  ): void {
    if (
      attendance.source !== "shared" ||
      activeShare.recipientUserId.toString() !== userId ||
      attendance.shareId?.toString() !== activeShare._id.toString()
    ) {
      throw new AppError(
        "Your checked-in ticket is no longer valid for this event.",
        httpStatus.FORBIDDEN,
      );
    }
  }
}
