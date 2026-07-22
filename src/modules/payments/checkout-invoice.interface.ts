import type { Types } from "mongoose";

export type CheckoutInvoiceStatus = "pending" | "sending" | "sent" | "failed_retryable" | "failed_terminal";

export interface CheckoutInvoiceSnapshot {
  orderId: string;
  eventName?: string | null;
  eventPrivacy?: "public" | "locked" | "private" | null;
  eventScheduledAt?: Date | null;
  eventEndAt?: Date | null;
  venue?: {
    searchLabel?: string | null;
    venue?: string | null;
    address?: string | null;
    formattedAddress?: string | null;
    addressLine1?: string | null;
    city?: string | null;
    region?: string | null;
    regionCode?: string | null;
    postalCode?: string | null;
    country?: string | null;
    countryCode?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    mapboxPlaceId?: string | null;
    locationProvider?: string | null;
    providerResultType?: string | null;
  } | null;
  purchasedAt: Date;
  buyerName: string;
  buyerEmail: string;
  paymentMethod: string;
  termsVersion?: string | null;
  refundEscrowVersion?: string | null;
  currency: string;
  subtotalAmount: number;
  platformFeeAmount: number;
  taxAmount: number;
  discountAmount: number;
  totalAmount: number;
  lineItems: Array<{
    itemType: string;
    itemId?: string | null;
    name: string;
    description?: string | null;
    ticketType?: string | null;
    quantity: number;
    paidQuantity: number;
    freeQuantity: number;
    unitAmount: number;
    originalUnitAmount?: number | null;
    discountAmount: number;
    totalAmount: number;
  }>;
}

export interface ICheckoutInvoice {
  _id: Types.ObjectId;
  orderId: Types.ObjectId;
  userId: Types.ObjectId;
  invoiceNumber: string;
  toEmail: string;
  status: CheckoutInvoiceStatus;
  attemptCount: number;
  nextRetryAt?: Date | null;
  lockedAt?: Date | null;
  sentAt?: Date | null;
  lastError?: string | null;
  snapshot: CheckoutInvoiceSnapshot;
  createdAt: Date;
  updatedAt: Date;
}
