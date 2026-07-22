import { EmailService } from "../../core/email/email.service.js";
import { logger } from "../../core/logger/logger.js";
import { EventRepository } from "../events/event.repository.js";
import type { EventLocation, IEvent } from "../events/event.interface.js";
import { UserRepository } from "../user/user.repository.js";
import type { ICheckoutOrder } from "./checkout-payment.interface.js";
import type { ICheckoutInvoice } from "./checkout-invoice.interface.js";
import { CheckoutInvoiceRepository } from "./checkout-invoice.repository.js";

const MAX_ATTEMPTS = 8;

const formatMoney = (currency: string, value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(value);

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

export class CheckoutInvoiceService {
  public constructor(
    private readonly repository = new CheckoutInvoiceRepository(),
    private readonly userRepository = new UserRepository(),
    private readonly eventRepository = new EventRepository(),
    private readonly emailService = new EmailService(),
  ) {}

  public async enqueueForOrder(order: ICheckoutOrder): Promise<void> {
    const buyer = await this.userRepository.findById(order.userId.toString());
    if (!buyer?.email) {
      logger.warn({ orderId: order._id.toString() }, "Invoice skipped because buyer email is unavailable");
      return;
    }

    const eventId = order.lineItems.find((item) => item.eventId)?.eventId;
    const event = eventId ? await this.eventRepository.findById(eventId) : null;
    const ticketById = new Map((event?.tickets ?? []).map((ticket) => [ticket.id, ticket]));
    const orderId = order._id.toString();

    await this.repository.createOrGet({
      orderId,
      userId: order.userId.toString(),
      invoiceNumber: `XG-${orderId.slice(-8).toUpperCase()}`,
      toEmail: buyer.email,
      snapshot: {
        orderId,
        eventName: event?.name ?? null,
        eventPrivacy: event?.privacy ?? null,
        eventScheduledAt: event?.scheduledAt ?? null,
        eventEndAt: event?.endAt ?? null,
        venue: this.toVenueSnapshot(event),
        purchasedAt: order.paidAt ?? order.createdAt,
        buyerName: buyer.name,
        buyerEmail: buyer.email,
        paymentMethod: this.getPaymentMethodLabel(order.paymentMethod),
        termsVersion: order.policySnapshot?.termsVersion ?? null,
        refundEscrowVersion: order.policySnapshot?.refundEscrowVersion ?? null,
        currency: order.currency,
        subtotalAmount: order.subtotalAmount,
        platformFeeAmount: order.platformFeeAmount,
        taxAmount: order.taxAmount,
        discountAmount: order.discountAmount ?? 0,
        totalAmount: order.totalAmount,
        lineItems: order.lineItems.map((item) => {
          const ticket = item.itemId ? ticketById.get(item.itemId) : null;

          return {
            itemType: item.itemType,
            itemId: item.itemId ?? null,
            name: item.name,
            description: ticket?.description ?? null,
            ticketType: ticket?.type ?? null,
            quantity: item.totalQuantity ?? item.quantity,
            paidQuantity: item.paidQuantity ?? item.quantity,
            freeQuantity: item.freeQuantity ?? 0,
            unitAmount: item.unitAmount,
            originalUnitAmount: ticket && ticket.price > item.unitAmount ? ticket.price : null,
            discountAmount: ticket && ticket.price > item.unitAmount
              ? Math.round((ticket.price - item.unitAmount) * (item.paidQuantity ?? item.quantity) * 100) / 100
              : 0,
            totalAmount: item.totalAmount,
          };
        }),
      },
    });
  }

  public async processDueInvoices(limit = 20): Promise<number> {
    const invoices = await this.repository.claimDue(limit);
    let processed = 0;

    for (const invoice of invoices) {
      await this.sendClaimedInvoice(invoice);
      processed += 1;
    }

    return processed;
  }

  private async sendClaimedInvoice(invoice: ICheckoutInvoice): Promise<void> {
    try {
      await this.emailService.sendMail({
        to: invoice.toEmail,
        subject: `Your Xenog invoice ${invoice.invoiceNumber}`,
        text: this.renderText(invoice),
        html: this.renderHtml(invoice),
      });

      await this.repository.update(invoice._id.toString(), {
        $set: {
          status: "sent",
          sentAt: new Date(),
          lockedAt: null,
          nextRetryAt: null,
          lastError: null,
        },
      });
    } catch (error) {
      const attemptCount = invoice.attemptCount;
      const terminal = attemptCount >= MAX_ATTEMPTS;
      const retryDelayMs = Math.min(24 * 60 * 60 * 1000, 5 * 60 * 1000 * 2 ** Math.max(0, attemptCount - 1));
      const message = error instanceof Error ? error.message : "Invoice email failed";

      await this.repository.update(invoice._id.toString(), {
        $set: {
          status: terminal ? "failed_terminal" : "failed_retryable",
          lockedAt: null,
          nextRetryAt: terminal ? null : new Date(Date.now() + retryDelayMs),
          lastError: message.slice(0, 500),
        },
      });
    }
  }

  public renderText(invoice: ICheckoutInvoice): string {
    const snapshot = invoice.snapshot;
    const lines = snapshot.lineItems.flatMap((item) => {
      const entries = [
        `${item.name} paid x ${item.paidQuantity} @ ${formatMoney(snapshot.currency, item.unitAmount)}: ${formatMoney(snapshot.currency, item.totalAmount)}`,
      ];
      if (item.freeQuantity > 0) entries.push(`${item.name} rewarded x ${item.freeQuantity}: ${formatMoney(snapshot.currency, 0)}`);
      return entries;
    });
    const venue = snapshot.venue;

    return [
      `Xenog invoice ${invoice.invoiceNumber}`,
      "Payment confirmed",
      `Order: ${snapshot.orderId}`,
      `Purchased: ${formatDateTime(snapshot.purchasedAt)}`,
      `Purchaser: ${snapshot.buyerName} <${snapshot.buyerEmail}>`,
      snapshot.eventName ? `Event: ${snapshot.eventName}` : null,
      snapshot.eventPrivacy ? `Access: ${snapshot.eventPrivacy}` : null,
      `Event time: ${formatDateTime(snapshot.eventScheduledAt)}`,
      venue?.venue || venue?.searchLabel ? `Venue: ${venue.venue || venue.searchLabel}` : null,
      venue?.formattedAddress || venue?.address ? `Address: ${venue.formattedAddress || venue.address}` : null,
      `Payment method: ${snapshot.paymentMethod}`,
      snapshot.termsVersion ? `Terms version: ${snapshot.termsVersion}` : null,
      snapshot.refundEscrowVersion ? `Refund/Escrow version: ${snapshot.refundEscrowVersion}` : null,
      ...lines,
      `Subtotal: ${formatMoney(snapshot.currency, snapshot.subtotalAmount)}`,
      `Discount: ${formatMoney(snapshot.currency, snapshot.discountAmount)}`,
      `Reward/free tickets: ${snapshot.lineItems.reduce((sum, item) => sum + item.freeQuantity, 0)} free`,
      `Platform fee: ${formatMoney(snapshot.currency, snapshot.platformFeeAmount)}`,
      `Tax: ${formatMoney(snapshot.currency, snapshot.taxAmount)}`,
      `Total: ${formatMoney(snapshot.currency, snapshot.totalAmount)}`,
    ].filter((line): line is string => Boolean(line)).join("\n");
  }

  public renderHtml(invoice: ICheckoutInvoice): string {
    const snapshot = invoice.snapshot;
    const lineRows = snapshot.lineItems.flatMap((item) => {
      const description = [item.description, item.ticketType ? `${item.ticketType} ticket` : null]
        .filter(Boolean)
        .join(" · ");
      const rows = [
        `<tr>
          <td style="padding:14px 0;border-bottom:1px solid #ECEEF2;">
            <div style="font-weight:700;color:#111827;">${escapeHtml(item.name)}</div>
            ${description ? `<div style="font-size:12px;color:#6B7280;margin-top:4px;">${escapeHtml(description)}</div>` : ""}
          </td>
          <td style="padding:14px 8px;border-bottom:1px solid #ECEEF2;text-align:center;color:#111827;">${item.paidQuantity}</td>
          <td style="padding:14px 8px;border-bottom:1px solid #ECEEF2;text-align:center;color:#111827;">${item.freeQuantity}</td>
          <td style="padding:14px 8px;border-bottom:1px solid #ECEEF2;text-align:right;color:#111827;">${formatMoney(snapshot.currency, item.unitAmount)}</td>
          <td style="padding:14px 0;border-bottom:1px solid #ECEEF2;text-align:right;font-weight:700;color:#111827;">${formatMoney(snapshot.currency, item.totalAmount)}</td>
        </tr>`,
      ];
      if (item.freeQuantity > 0) {
        rows.push(`<tr>
          <td style="padding:10px 0 14px 18px;border-bottom:1px solid #ECEEF2;color:#4B5563;">Rewarded ${escapeHtml(item.name)}</td>
          <td style="padding:10px 8px 14px;border-bottom:1px solid #ECEEF2;text-align:center;color:#4B5563;">0</td>
          <td style="padding:10px 8px 14px;border-bottom:1px solid #ECEEF2;text-align:center;color:#4B5563;">${item.freeQuantity}</td>
          <td style="padding:10px 8px 14px;border-bottom:1px solid #ECEEF2;text-align:right;color:#4B5563;">${formatMoney(snapshot.currency, 0)}</td>
          <td style="padding:10px 0 14px;border-bottom:1px solid #ECEEF2;text-align:right;font-weight:700;color:#4B5563;">${formatMoney(snapshot.currency, 0)}</td>
        </tr>`);
      }
      return rows;
    }).join("");
    const venue = snapshot.venue;
    const venueName = venue?.venue || venue?.searchLabel || "Venue TBA";
    const venueAddress = venue?.formattedAddress || venue?.address || "Address TBA";
    const rewardCount = snapshot.lineItems.reduce((sum, item) => sum + item.freeQuantity, 0);

    return `
      <div style="margin:0;padding:0;background:#F5F6F8;font-family:Arial,Helvetica,sans-serif;color:#111827;">
        <div style="max-width:680px;margin:0 auto;padding:24px 12px;">
          <div style="background:#0B0B0C;border-radius:18px 18px 0 0;padding:28px 28px 24px;">
            <div style="font-size:24px;font-weight:800;color:#FFFFFF;letter-spacing:0;">Xenog</div>
            <div style="margin-top:16px;color:#D1FAE5;font-size:13px;font-weight:700;">Payment confirmed</div>
            <div style="margin-top:6px;color:#FFFFFF;font-size:28px;font-weight:800;line-height:34px;">Invoice ${escapeHtml(invoice.invoiceNumber)}</div>
          </div>
          <div style="background:#FFFFFF;border:1px solid #E5E7EB;border-top:0;border-radius:0 0 18px 18px;padding:28px;">
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
              <tr>
                <td style="vertical-align:top;padding-right:12px;">
                  <div style="font-size:12px;color:#6B7280;font-weight:700;text-transform:uppercase;">Event</div>
                  <div style="font-size:18px;font-weight:800;color:#111827;margin-top:6px;">${escapeHtml(snapshot.eventName || "Event")}</div>
                  <div style="font-size:13px;color:#4B5563;margin-top:6px;">${escapeHtml(formatDateTime(snapshot.eventScheduledAt))}</div>
                  <div style="font-size:13px;color:#4B5563;margin-top:6px;">${escapeHtml(venueName)}</div>
                  <div style="font-size:13px;color:#6B7280;margin-top:4px;">${escapeHtml(venueAddress)}</div>
                </td>
                <td style="vertical-align:top;text-align:right;">
                  <div style="font-size:12px;color:#6B7280;font-weight:700;text-transform:uppercase;">Order</div>
                  <div style="font-size:13px;color:#111827;margin-top:6px;">${escapeHtml(snapshot.orderId)}</div>
                  <div style="font-size:13px;color:#4B5563;margin-top:6px;">${escapeHtml(formatDateTime(snapshot.purchasedAt))}</div>
                  <div style="font-size:13px;color:#4B5563;margin-top:6px;">${escapeHtml(snapshot.paymentMethod)}</div>
                </td>
              </tr>
            </table>
            <div style="background:#F9FAFB;border:1px solid #ECEEF2;border-radius:12px;padding:16px;margin-bottom:24px;">
              <div style="font-size:13px;color:#4B5563;"><strong style="color:#111827;">Purchaser:</strong> ${escapeHtml(snapshot.buyerName)} &lt;${escapeHtml(snapshot.buyerEmail)}&gt;</div>
              <div style="font-size:13px;color:#4B5563;margin-top:6px;"><strong style="color:#111827;">Access:</strong> ${escapeHtml(snapshot.eventPrivacy || "public")}</div>
              <div style="font-size:13px;color:#4B5563;margin-top:6px;"><strong style="color:#111827;">Policy:</strong> ${escapeHtml(snapshot.termsVersion || "terms-current")} / ${escapeHtml(snapshot.refundEscrowVersion || "refund-escrow-current")}</div>
            </div>
            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
              <thead>
                <tr>
                  <th align="left" style="padding:0 0 10px;color:#6B7280;font-size:12px;text-transform:uppercase;">Ticket</th>
                  <th style="padding:0 8px 10px;color:#6B7280;font-size:12px;text-transform:uppercase;">Paid</th>
                  <th style="padding:0 8px 10px;color:#6B7280;font-size:12px;text-transform:uppercase;">Free</th>
                  <th align="right" style="padding:0 8px 10px;color:#6B7280;font-size:12px;text-transform:uppercase;">Unit</th>
                  <th align="right" style="padding:0 0 10px;color:#6B7280;font-size:12px;text-transform:uppercase;">Line total</th>
                </tr>
              </thead>
              <tbody>${lineRows}</tbody>
            </table>
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;">
              ${this.summaryRow("Subtotal", formatMoney(snapshot.currency, snapshot.subtotalAmount))}
              ${this.summaryRow("Discount", formatMoney(snapshot.currency, snapshot.discountAmount))}
              ${this.summaryRow("Reward/free tickets", `${rewardCount} free`)}
              ${this.summaryRow("Platform fee", formatMoney(snapshot.currency, snapshot.platformFeeAmount))}
              ${this.summaryRow("Tax", formatMoney(snapshot.currency, snapshot.taxAmount))}
              <tr><td style="padding-top:14px;border-top:2px solid #111827;font-size:16px;font-weight:800;color:#111827;">Total paid</td><td style="padding-top:14px;border-top:2px solid #111827;text-align:right;font-size:20px;font-weight:800;color:#111827;">${formatMoney(snapshot.currency, snapshot.totalAmount)}</td></tr>
            </table>
            <div style="margin-top:26px;padding-top:18px;border-top:1px solid #ECEEF2;font-size:12px;color:#6B7280;line-height:18px;">
              Present your generated QR code at the event. Refund and escrow handling follows the policy version listed above. Keep this email for your records and support reference.
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private summaryRow(label: string, value: string): string {
    return `<tr><td style="padding:6px 0;color:#4B5563;font-size:14px;">${escapeHtml(label)}</td><td style="padding:6px 0;text-align:right;color:#111827;font-size:14px;font-weight:700;">${escapeHtml(value)}</td></tr>`;
  }

  private toVenueSnapshot(event: IEvent | null): EventLocation | null {
    return event?.location ? { ...event.location } : null;
  }

  private getPaymentMethodLabel(method: string): string {
    return method === "apple_pay" ? "Apple Pay" : "Card";
  }
}
