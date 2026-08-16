import type { ICheckoutOrder } from "./checkout-payment.interface.js";
import { CheckoutPaymentRepository } from "./checkout-payment.repository.js";
import { TicketCancellationRepository } from "./ticket-cancellation.repository.js";
import { TicketShareRepository } from "./ticket-share.repository.js";

export type TicketEntitlementSource = "owned" | "shared";

export interface TicketEntitlement {
  orderId: string;
  ticketId: string;
  ticketIndex: number;
  source: TicketEntitlementSource;
}

const isPaidTicketOrder = (order: ICheckoutOrder | null): order is ICheckoutOrder =>
  order !== null && order.kind === "ticket" && order.paymentStatus === "paid";

// Resolves whether a user currently holds a valid ticket entitlement for an
// event, independent of check-in. Mirrors the exact holder-resolution
// precedence already used by ticket scanning
// (CheckoutPaymentService.scanTicket) and chat access
// (EventChatAccessService.assertValidCheckedInTicket): an actively shared
// pass belongs to its recipient, not its original owner, and there is no
// dual-holder state or acceptance step. This is the single source of truth
// for "does user X hold a valid ticket for event Y" — callers should not
// re-derive share/cancellation precedence themselves.
export class TicketEntitlementService {
  public constructor(
    private readonly checkoutPaymentRepository = new CheckoutPaymentRepository(),
    private readonly ticketShareRepository = new TicketShareRepository(),
    private readonly ticketCancellationRepository = new TicketCancellationRepository(),
  ) {}

  public async findValidEntitlementForUser(userId: string, eventId: string): Promise<TicketEntitlement | null> {
    const shared = await this.findSharedEntitlement(userId, eventId);
    if (shared) {
      return shared;
    }

    return this.findOwnedEntitlement(userId, eventId);
  }

  public async hasValidEntitlement(userId: string, eventId: string): Promise<boolean> {
    return (await this.findValidEntitlementForUser(userId, eventId)) !== null;
  }

  private async findSharedEntitlement(userId: string, eventId: string): Promise<TicketEntitlement | null> {
    const shares = await this.ticketShareRepository.findActiveByRecipientAndEvent(userId, eventId);

    for (const share of shares) {
      const orderId = share.orderId.toString();
      const order = await this.checkoutPaymentRepository.findById(orderId);

      if (!isPaidTicketOrder(order)) {
        continue;
      }

      const isCancelled = await this.ticketCancellationRepository.existsByPass({
        eventId,
        ticketId: share.ticketId,
        orderId,
        ticketIndex: share.ticketIndex,
      });

      if (isCancelled) {
        continue;
      }

      return { orderId, ticketId: share.ticketId, ticketIndex: share.ticketIndex, source: "shared" };
    }

    return null;
  }

  private async findOwnedEntitlement(userId: string, eventId: string): Promise<TicketEntitlement | null> {
    const orders = await this.checkoutPaymentRepository.findPaidTicketOrdersForUserAndEvent(userId, eventId);

    for (const order of orders) {
      const orderId = order._id.toString();

      for (const pass of order.ticketPasses ?? []) {
        if (pass.eventId !== eventId) {
          continue;
        }

        // A pass the owner has actively shared away no longer belongs to
        // them — the recipient is the valid holder instead (see
        // findSharedEntitlement above and CheckoutPaymentService.scanTicket).
        const activeShare = await this.ticketShareRepository.findActiveByTicketPass(
          eventId,
          pass.ticketId,
          orderId,
          pass.ticketIndex,
        );

        if (activeShare) {
          continue;
        }

        const isCancelled = await this.ticketCancellationRepository.existsByPass({
          eventId,
          ticketId: pass.ticketId,
          orderId,
          ticketIndex: pass.ticketIndex,
        });

        if (isCancelled) {
          continue;
        }

        return { orderId, ticketId: pass.ticketId, ticketIndex: pass.ticketIndex, source: "owned" };
      }
    }

    return null;
  }
}
