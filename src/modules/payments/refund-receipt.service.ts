import { randomBytes } from "node:crypto";
import { env } from "../../config/env.js";
import { EmailService } from "../../core/email/email.service.js";
import { logger } from "../../core/logger/logger.js";
import { EventRepository } from "../events/event.repository.js";
import type { EventLocation, IEvent } from "../events/event.interface.js";
import { UserRepository } from "../user/user.repository.js";
import type { IUser } from "../user/user.interface.js";
import type { ICheckoutOrder } from "./checkout-payment.interface.js";
import { CheckoutPaymentRepository } from "./checkout-payment.repository.js";
import { EventCancellationRefundRepository } from "./event-cancellation-refund.repository.js";
import type { IEventCancellationRefund } from "./event-cancellation-refund.interface.js";
import type { ITicketCancellation } from "./ticket-cancellation.interface.js";
import { TicketCancellationRepository } from "./ticket-cancellation.repository.js";
import type { IRefundReceipt, RefundReceiptSnapshot, RefundReceiptSourceType } from "./refund-receipt.interface.js";
import { RefundReceiptRepository } from "./refund-receipt.repository.js";

const MAX_ATTEMPTS = 8;

const formatMoneyMinor = (currency: string, amountMinor: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(amountMinor / 100);

const formatDateTime = (value?: Date | null) =>
  value
    ? new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(value)
    : "TBA";

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

const sanitizeSubjectPart = (value?: string | null): string =>
  value?.replace(/[\r\n]+/g, " ").trim() || "your event";

const toOrderReference = (orderId: string): string => `XG-${orderId.slice(-8).toUpperCase()}`;

const toReceiptReference = (date: Date): string =>
  `RF-${date.getUTCFullYear()}-${randomBytes(3).toString("hex").toUpperCase()}`;

const duplicateCode = (error: unknown): boolean => (error as { code?: number }).code === 11000;

export class RefundReceiptService {
  public constructor(
    private readonly repository = new RefundReceiptRepository(),
    private readonly userRepository = new UserRepository(),
    private readonly eventRepository = new EventRepository(),
    private readonly checkoutRepository = new CheckoutPaymentRepository(),
    private readonly eventRefundRepository = new EventCancellationRefundRepository(),
    private readonly ticketCancellationRepository = new TicketCancellationRepository(),
    private readonly emailService = new EmailService(),
  ) {}

  public async enqueueForTicketCancellation(cancellation: ITicketCancellation): Promise<IRefundReceipt | null> {
    if (cancellation.refundStatus !== "succeeded" || cancellation.requestedAmountMinor <= 0 || cancellation.completedAmountMinor <= 0) {
      return null;
    }

    const [buyer, event, order] = await Promise.all([
      this.userRepository.findById(cancellation.buyerUserId.toString()),
      this.eventRepository.findById(cancellation.eventId.toString()),
      this.checkoutRepository.findById(cancellation.orderId.toString()),
    ]);
    if (!buyer?.email) {
      logger.warn({ ticketCancellationId: cancellation._id.toString() }, "Refund receipt skipped because buyer email is unavailable");
      return null;
    }

    const host = await this.resolveHost(event, cancellation.hostUserId.toString());
    const refundCompletedAt = cancellation.refundCompletedAt ?? new Date();
    const orderReference = toOrderReference(cancellation.orderId.toString());
    const idempotencyKey = `refund-receipt:user_ticket_cancellation:${cancellation._id.toString()}`;

    return this.createOrGetWithUniqueReference({
      idempotencyKey,
      sourceType: "user_ticket_cancellation",
      sourceRefundId: cancellation._id.toString(),
      payerUserId: cancellation.buyerUserId.toString(),
      toEmail: buyer.email,
      orderReference,
      refundCompletedAt,
      snapshotBase: {
        context: "Ticket cancelled by buyer",
        buyerName: buyer.name,
        buyerEmail: buyer.email,
        eventName: cancellation.eventName ?? event?.name ?? null,
        eventScheduledAt: event?.scheduledAt ?? null,
        eventEndAt: event?.endAt ?? null,
        venue: this.toVenueSnapshot(event),
        hostName: host?.name ?? null,
        supportEmail: env.EMAIL_FROM ?? null,
        orderReference,
        purchasedAt: order?.paidAt ?? order?.createdAt ?? null,
        refundCompletedAt,
        statusLabel: "Refund completed",
        paymentMethod: order ? this.getPaymentMethodLabel(order.paymentMethod) : null,
        items: [{
          name: cancellation.ticketName ?? "Ticket",
          type: cancellation.ticketType ?? null,
          passLabel: `Pass ${cancellation.ticketIndex}`,
          quantity: 1,
        }],
        financial: {
          subtotalAmountMinor: cancellation.ticketSubtotalAmountMinor,
          platformFeeAmountMinor: cancellation.platformFeeAmountMinor,
          taxAmountMinor: cancellation.taxAmountMinor,
          discountAmountMinor: cancellation.discountAmountMinor,
          completedAmountMinor: cancellation.completedAmountMinor,
          requestedAmountMinor: cancellation.requestedAmountMinor,
          currency: cancellation.currency,
        },
      },
    });
  }

  public async enqueueForEventCancellation(item: IEventCancellationRefund): Promise<IRefundReceipt | null> {
    if (item.status !== "succeeded" || item.requestedAmountMinor <= 0 || item.completedAmountMinor <= 0) {
      return null;
    }

    const [buyer, event, order, taxReversals] = await Promise.all([
      this.userRepository.findById(item.originalPayerUserId.toString()),
      this.eventRepository.findById(item.eventId.toString()),
      this.checkoutRepository.findById(item.checkoutOrderId.toString()),
      this.eventRefundRepository.findTaxReversalsByRefundItemIds([item._id.toString()]),
    ]);
    if (!buyer?.email) {
      logger.warn({ refundItemId: item._id.toString() }, "Refund receipt skipped because payer email is unavailable");
      return null;
    }

    const host = await this.resolveHost(event, null);
    const refundCompletedAt = item.completedAt ?? new Date();
    const orderReference = toOrderReference(item.checkoutOrderId.toString());
    const idempotencyKey = `refund-receipt:event_cancellation:${item._id.toString()}`;
    const taxReversal = taxReversals.find((row) => row.refundItemId.toString() === item._id.toString()) ?? null;

    return this.createOrGetWithUniqueReference({
      idempotencyKey,
      sourceType: "event_cancellation",
      sourceRefundId: item._id.toString(),
      payerUserId: item.originalPayerUserId.toString(),
      toEmail: buyer.email,
      orderReference,
      refundCompletedAt,
      snapshotBase: {
        context: "Event cancelled by organizer",
        buyerName: buyer.name,
        buyerEmail: buyer.email,
        eventName: event?.name ?? null,
        eventScheduledAt: event?.scheduledAt ?? null,
        eventEndAt: event?.endAt ?? null,
        venue: this.toVenueSnapshot(event),
        hostName: host?.name ?? null,
        supportEmail: env.EMAIL_FROM ?? null,
        orderReference,
        purchasedAt: order?.paidAt ?? order?.createdAt ?? null,
        refundCompletedAt,
        statusLabel: "Refund completed",
        paymentMethod: item.paymentMethodLabel ?? (order ? this.getPaymentMethodLabel(order.paymentMethod) : null),
        items: order ? await this.toEventRefundItems(order, item.eventId.toString()) : [{ name: event?.name ?? "Event tickets", quantity: 1 }],
        financial: {
          subtotalAmountMinor: null,
          platformFeeAmountMinor: null,
          taxAmountMinor: taxReversal?.reversedTaxAmountMinor ?? null,
          discountAmountMinor: null,
          completedAmountMinor: item.completedAmountMinor,
          requestedAmountMinor: item.requestedAmountMinor,
          currency: item.currency,
        },
      },
    });
  }

  public async processDueReceipts(limit = 20): Promise<number> {
    const receipts = await this.repository.claimDue(limit);
    let processed = 0;

    for (const receipt of receipts) {
      await this.sendClaimedReceipt(receipt);
      processed += 1;
    }

    return processed;
  }

  public renderText(receipt: IRefundReceipt): string {
    const snapshot = receipt.snapshot;
    const financial = snapshot.financial;
    const lines = [
      "Refund Receipt",
      "Refund completed",
      `Receipt reference: ${snapshot.receiptReference}`,
      `Order reference: ${snapshot.orderReference}`,
      `Refund context: ${snapshot.context}`,
      `Status: ${snapshot.statusLabel}`,
      `Refund completed: ${formatDateTime(snapshot.refundCompletedAt)}`,
      snapshot.purchasedAt ? `Original purchase: ${formatDateTime(snapshot.purchasedAt)}` : null,
      `Buyer: ${snapshot.buyerName} <${snapshot.buyerEmail}>`,
      snapshot.eventName ? `Event: ${snapshot.eventName}` : null,
      `Event time: ${formatDateTime(snapshot.eventScheduledAt)}`,
      this.venueName(snapshot.venue) ? `Venue: ${this.venueName(snapshot.venue)}` : null,
      this.venueAddress(snapshot.venue) ? `Address: ${this.venueAddress(snapshot.venue)}` : null,
      snapshot.hostName ? `Organizer: ${snapshot.hostName}` : null,
      snapshot.paymentMethod ? `Payment method: ${snapshot.paymentMethod}` : null,
      "Items:",
      ...snapshot.items.map((item) => {
        const label = item.passLabel ? ` (${item.passLabel})` : "";
        const type = item.type ? `, ${item.type}` : "";
        return `- ${item.name}${label}${type}: quantity ${item.quantity}`;
      }),
      financial.subtotalAmountMinor !== null && financial.subtotalAmountMinor !== undefined
        ? `Refunded subtotal: ${formatMoneyMinor(financial.currency, financial.subtotalAmountMinor)}`
        : null,
      financial.discountAmountMinor !== null && financial.discountAmountMinor !== undefined
        ? `Discount applied: ${formatMoneyMinor(financial.currency, financial.discountAmountMinor)}`
        : null,
      financial.platformFeeAmountMinor !== null && financial.platformFeeAmountMinor !== undefined
        ? `Buyer/platform fee refunded: ${formatMoneyMinor(financial.currency, financial.platformFeeAmountMinor)}`
        : null,
      financial.taxAmountMinor !== null && financial.taxAmountMinor !== undefined
        ? `Tax refunded: ${formatMoneyMinor(financial.currency, financial.taxAmountMinor)}`
        : null,
      `Total refunded: ${formatMoneyMinor(financial.currency, financial.completedAmountMinor)}`,
      snapshot.supportEmail ? `Support: ${snapshot.supportEmail}` : null,
    ];

    return lines.filter((line): line is string => Boolean(line)).join("\n");
  }

  public renderHtml(receipt: IRefundReceipt): string {
    const snapshot = receipt.snapshot;
    const financial = snapshot.financial;
    const itemRows = snapshot.items.map((item) => `
      <tr>
        <td style="padding:14px 0;border-bottom:1px solid #ECEEF2;">
          <div style="font-weight:700;color:#111827;">${escapeHtml(item.name)}</div>
          <div style="font-size:12px;color:#6B7280;margin-top:4px;">${escapeHtml([item.passLabel, item.type].filter(Boolean).join(" · ") || "Ticket")}</div>
        </td>
        <td style="padding:14px 0;border-bottom:1px solid #ECEEF2;text-align:right;color:#111827;font-weight:700;">${item.quantity}</td>
      </tr>
    `).join("");

    return `
      <div style="margin:0;padding:0;background:#F5F6F8;font-family:Arial,Helvetica,sans-serif;color:#111827;">
        <div style="max-width:680px;margin:0 auto;padding:24px 12px;">
          <div style="background:#0B0B0C;border-radius:18px 18px 0 0;padding:28px 28px 24px;">
            <div style="font-size:24px;font-weight:800;color:#FFFFFF;letter-spacing:0;">Xenog</div>
            <div style="margin-top:16px;color:#D1FAE5;font-size:13px;font-weight:700;">Refund completed</div>
            <div style="margin-top:6px;color:#FFFFFF;font-size:28px;font-weight:800;line-height:34px;">Refund Receipt</div>
          </div>
          <div style="background:#FFFFFF;border:1px solid #E5E7EB;border-top:0;border-radius:0 0 18px 18px;padding:28px;">
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
              <tr>
                <td style="vertical-align:top;padding-right:12px;">
                  <div style="font-size:12px;color:#6B7280;font-weight:700;text-transform:uppercase;">Event</div>
                  <div style="font-size:18px;font-weight:800;color:#111827;margin-top:6px;">${escapeHtml(snapshot.eventName || "Event")}</div>
                  <div style="font-size:13px;color:#4B5563;margin-top:6px;">${escapeHtml(formatDateTime(snapshot.eventScheduledAt))}</div>
                  <div style="font-size:13px;color:#4B5563;margin-top:6px;">${escapeHtml(this.venueName(snapshot.venue) || "Venue TBA")}</div>
                  <div style="font-size:13px;color:#6B7280;margin-top:4px;">${escapeHtml(this.venueAddress(snapshot.venue) || "Address TBA")}</div>
                </td>
                <td style="vertical-align:top;text-align:right;">
                  <div style="font-size:12px;color:#6B7280;font-weight:700;text-transform:uppercase;">Receipt</div>
                  <div style="font-size:13px;color:#111827;margin-top:6px;">${escapeHtml(snapshot.receiptReference)}</div>
                  <div style="font-size:13px;color:#4B5563;margin-top:6px;">${escapeHtml(snapshot.orderReference)}</div>
                  <div style="font-size:13px;color:#4B5563;margin-top:6px;">${escapeHtml(formatDateTime(snapshot.refundCompletedAt))}</div>
                </td>
              </tr>
            </table>
            <div style="background:#F9FAFB;border:1px solid #ECEEF2;border-radius:12px;padding:16px;margin-bottom:24px;">
              <div style="font-size:13px;color:#4B5563;"><strong style="color:#111827;">Buyer:</strong> ${escapeHtml(snapshot.buyerName)} &lt;${escapeHtml(snapshot.buyerEmail)}&gt;</div>
              <div style="font-size:13px;color:#4B5563;margin-top:6px;"><strong style="color:#111827;">Reason:</strong> ${escapeHtml(snapshot.context)}</div>
              <div style="font-size:13px;color:#4B5563;margin-top:6px;"><strong style="color:#111827;">Status:</strong> ${escapeHtml(snapshot.statusLabel)}</div>
              ${snapshot.hostName ? `<div style="font-size:13px;color:#4B5563;margin-top:6px;"><strong style="color:#111827;">Organizer:</strong> ${escapeHtml(snapshot.hostName)}</div>` : ""}
              ${snapshot.paymentMethod ? `<div style="font-size:13px;color:#4B5563;margin-top:6px;"><strong style="color:#111827;">Payment method:</strong> ${escapeHtml(snapshot.paymentMethod)}</div>` : ""}
            </div>
            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
              <thead>
                <tr>
                  <th align="left" style="padding:0 0 10px;color:#6B7280;font-size:12px;text-transform:uppercase;">Refunded item</th>
                  <th align="right" style="padding:0 0 10px;color:#6B7280;font-size:12px;text-transform:uppercase;">Quantity</th>
                </tr>
              </thead>
              <tbody>${itemRows}</tbody>
            </table>
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;">
              ${this.optionalSummaryRow("Refunded subtotal", financial.subtotalAmountMinor, financial.currency)}
              ${this.optionalSummaryRow("Discount applied", financial.discountAmountMinor, financial.currency)}
              ${this.optionalSummaryRow("Buyer/platform fee refunded", financial.platformFeeAmountMinor, financial.currency)}
              ${this.optionalSummaryRow("Tax refunded", financial.taxAmountMinor, financial.currency)}
              <tr><td style="padding-top:14px;border-top:2px solid #111827;font-size:16px;font-weight:800;color:#111827;">Total refunded</td><td style="padding-top:14px;border-top:2px solid #111827;text-align:right;font-size:20px;font-weight:800;color:#111827;">${formatMoneyMinor(financial.currency, financial.completedAmountMinor)}</td></tr>
            </table>
            <div style="margin-top:26px;padding-top:18px;border-top:1px solid #ECEEF2;font-size:12px;color:#6B7280;line-height:18px;">
              This receipt confirms that the refund above has been completed to the original payment method. Bank processing time may vary.
              ${snapshot.supportEmail ? `<br />Support: ${escapeHtml(snapshot.supportEmail)}` : ""}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private async createOrGetWithUniqueReference(payload: {
    idempotencyKey: string;
    sourceType: RefundReceiptSourceType;
    sourceRefundId: string;
    payerUserId: string;
    toEmail: string;
    orderReference: string;
    refundCompletedAt: Date;
    snapshotBase: Omit<RefundReceiptSnapshot, "receiptReference">;
  }): Promise<IRefundReceipt> {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const receiptReference = toReceiptReference(payload.refundCompletedAt);
      try {
        return await this.repository.createOrGet({
          idempotencyKey: payload.idempotencyKey,
          sourceType: payload.sourceType,
          sourceRefundId: payload.sourceRefundId,
          payerUserId: payload.payerUserId,
          toEmail: payload.toEmail,
          receiptReference,
          orderReference: payload.orderReference,
          snapshot: {
            ...payload.snapshotBase,
            receiptReference,
          },
        });
      } catch (error) {
        const existing = await this.repository.findByIdempotencyKey(payload.idempotencyKey);
        if (existing) return existing;
        if (!duplicateCode(error) || attempt === 5) throw error;
      }
    }

    throw new Error("Unable to allocate a unique refund receipt reference");
  }

  private async sendClaimedReceipt(receipt: IRefundReceipt): Promise<void> {
    try {
      await this.emailService.sendMail({
        to: receipt.toEmail,
        subject: `Your refund for ${sanitizeSubjectPart(receipt.snapshot.eventName)} has been completed`,
        text: this.renderText(receipt),
        html: this.renderHtml(receipt),
      });

      await this.repository.update(receipt._id.toString(), {
        $set: {
          status: "sent",
          sentAt: new Date(),
          lockedAt: null,
          nextRetryAt: null,
          lastError: null,
        },
      });
    } catch (error) {
      const terminal = receipt.attemptCount >= MAX_ATTEMPTS;
      const retryDelayMs = Math.min(24 * 60 * 60 * 1000, 5 * 60 * 1000 * 2 ** Math.max(0, receipt.attemptCount - 1));
      const message = error instanceof Error ? error.message : "Refund receipt email failed";

      await this.repository.update(receipt._id.toString(), {
        $set: {
          status: terminal ? "failed_terminal" : "failed_retryable",
          lockedAt: null,
          nextRetryAt: terminal ? null : new Date(Date.now() + retryDelayMs),
          lastError: message.slice(0, 500),
        },
      });
    }
  }

  private optionalSummaryRow(label: string, amountMinor: number | null | undefined, currency: string): string {
    if (amountMinor === null || amountMinor === undefined) return "";
    return `<tr><td style="padding:6px 0;color:#4B5563;font-size:14px;">${escapeHtml(label)}</td><td style="padding:6px 0;text-align:right;color:#111827;font-size:14px;font-weight:700;">${formatMoneyMinor(currency, amountMinor)}</td></tr>`;
  }

  private async toEventRefundItems(order: ICheckoutOrder, eventId: string): Promise<RefundReceiptSnapshot["items"]> {
    const cancellations = await this.ticketCancellationRepository.findByOrderId(order._id.toString());
    const items = order.lineItems
      .filter((lineItem) => lineItem.itemType === "ticket" && lineItem.eventId === eventId)
      .map((lineItem) => {
        const totalQuantity = lineItem.totalQuantity ?? lineItem.quantity;
        const cancelledQuantity = cancellations.filter((cancellation) =>
          cancellation.eventId.toString() === eventId &&
          cancellation.ticketId === lineItem.itemId
        ).length;
        const quantity = Math.max(0, totalQuantity - cancelledQuantity);
        return {
          name: lineItem.name,
          type: "ticket",
          quantity,
        };
      })
      .filter((item) => item.quantity > 0);

    return items.length > 0 ? items : [{ name: "Event tickets", quantity: 1 }];
  }

  private async resolveHost(event: IEvent | null, fallbackHostUserId: string | null): Promise<IUser | null> {
    const hostId = event?.userId?.toString() ?? fallbackHostUserId;
    return hostId ? this.userRepository.findById(hostId) : null;
  }

  private toVenueSnapshot(event: IEvent | null): EventLocation | null {
    return event?.location ? { ...event.location } : null;
  }

  private venueName(venue?: EventLocation | null): string | null {
    return venue?.venue || venue?.searchLabel || null;
  }

  private venueAddress(venue?: EventLocation | null): string | null {
    return venue?.formattedAddress || venue?.address || null;
  }

  private getPaymentMethodLabel(method: string): string {
    return method === "apple_pay" ? "Apple Pay" : "Card";
  }
}
