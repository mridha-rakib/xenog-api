import type { Types } from "mongoose";
import type { EventCategory } from "../events/event.interface.js";
import type { CancellationRefundStatus } from "./event-cancellation-refund.interface.js";

export const checkoutOrderKinds = ["ticket", "product", "custom"] as const;
export type CheckoutOrderKind = (typeof checkoutOrderKinds)[number];

export const checkoutPaymentMethods = ["card", "apple_pay"] as const;
export type CheckoutPaymentMethod = (typeof checkoutPaymentMethods)[number];

export const checkoutPaymentStatuses = [
  "requires_payment",
  "processing",
  "paid",
  "failed",
  "canceled",
  "refunded",
] as const;
export type CheckoutPaymentStatus = (typeof checkoutPaymentStatuses)[number];

export const checkoutPayoutStatuses = ["not_ready", "held", "eligible", "transferred", "failed"] as const;
export type CheckoutPayoutStatus = (typeof checkoutPayoutStatuses)[number];

export type CheckoutTaxStatus =
  | "calculated_non_zero"
  | "calculated_zero"
  | "not_applicable"
  | "configuration_unavailable_zero_fallback"
  | "provider_failure_zero_fallback";

export interface CheckoutTaxSnapshot {
  amount: number;
  status: CheckoutTaxStatus;
  provider: "stripe_tax" | "none";
  calculationId?: string | null;
  transactionId?: string | null;
  failureCode?: string | null;
  failureReason?: string | null;
  venueSnapshot?: {
    searchLabel?: string | null;
    venue?: string | null;
    address?: string | null;
    formattedAddress?: string | null;
    addressLine1?: string | null;
    neighborhood?: string | null;
    district?: string | null;
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
  jurisdictionSummary?: string | null;
  calculatedAt: Date;
}

export interface CheckoutPolicySnapshot {
  termsVersion: string;
  refundEscrowVersion: string;
  acceptedAt: Date;
}

export interface CheckoutOrderLineItem {
  itemType: CheckoutOrderKind;
  itemId?: string | null;
  eventId?: string | null;
  sellerUserId?: Types.ObjectId | null;
  name: string;
  quantity: number;
  paidQuantity?: number;
  freeQuantity?: number;
  totalQuantity?: number;
  rewardId?: string | null;
  unitAmount: number;
  totalAmount: number;
}

export interface CheckoutOrderTicketPass {
  eventId: string;
  ticketId: string;
  ticketIndex: number;
  checkInCode: string;
}

export interface ICheckoutOrder {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  kind: CheckoutOrderKind;
  paymentMethod: CheckoutPaymentMethod;
  paymentStatus: CheckoutPaymentStatus;
  payoutStatus: CheckoutPayoutStatus;
  currency: string;
  subtotalAmount: number;
  platformFeeAmount: number;
  taxAmount: number;
  discountAmount?: number;
  totalAmount: number;
  amountMinor: number;
  taxSnapshot?: CheckoutTaxSnapshot | null;
  policySnapshot?: CheckoutPolicySnapshot | null;
  lineItems: CheckoutOrderLineItem[];
  ticketPasses: CheckoutOrderTicketPass[];
  stripePaymentIntentId?: string | null;
  stripeClientSecret?: string | null;
  reservedUntil?: Date | null;
  anonymous: boolean;
  termsAcceptedAt?: Date | null;
  paidAt?: Date | null;
  failedAt?: Date | null;
  failureMessage?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTicketCheckoutIntentDto {
  kind: "ticket";
  paymentMethod: CheckoutPaymentMethod;
  eventId: string;
  ticketId: string;
  quantity: number;
  anonymous?: boolean;
  acceptedTerms: boolean;
}

export interface CreateProductCheckoutIntentDto {
  kind: "product";
  paymentMethod: CheckoutPaymentMethod;
  items: Array<{
    productId: string;
    quantity: number;
  }>;
  acceptedTerms: boolean;
}

export interface CreateCustomCheckoutIntentDto {
  kind: "custom";
  paymentMethod: CheckoutPaymentMethod;
  items: Array<{
    name: string;
    amount: number;
    quantity: number;
  }>;
  acceptedTerms: boolean;
}

export type CreateCheckoutIntentDto =
  | CreateTicketCheckoutIntentDto
  | CreateProductCheckoutIntentDto
  | CreateCustomCheckoutIntentDto;

export interface CheckoutOrderResponse {
  id: string;
  kind: CheckoutOrderKind;
  paymentMethod: CheckoutPaymentMethod;
  paymentStatus: CheckoutPaymentStatus;
  payoutStatus: CheckoutPayoutStatus;
  currency: string;
  subtotalAmount: number;
  platformFeeAmount: number;
  taxAmount: number;
  discountAmount: number;
  totalAmount: number;
  taxSnapshot?: CheckoutTaxSnapshot | null;
  policySnapshot?: CheckoutPolicySnapshot | null;
  lineItems: Array<Omit<CheckoutOrderLineItem, "sellerUserId"> & { sellerUserId?: string | null }>;
  ticketPasses: CheckoutOrderTicketPass[];
  stripePaymentIntentId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CheckoutIntentResponse {
  order: CheckoutOrderResponse;
  paymentIntentClientSecret?: string | null;
  publishableKey?: string | null;
  merchantDisplayName: string;
  merchantCountryCode: string;
}

export type TicketWalletStatus = "active" | "used" | "cancelled";
export type TicketWalletSource = "owned" | "shared";
export type TicketShareStatus = "active" | "cancelled";
export type TicketPassStatus = "active" | "used";

export interface TicketWalletEventHost {
  id: string;
  name: string;
  username?: string;
  avatarKey?: string | null;
  isFollowing?: boolean;
}

export interface TicketWalletEvent {
  id: string;
  name?: string | null;
  bannerImageKey?: string | null;
  bannerOriginalImageKey?: string | null;
  category?: EventCategory | null;
  categories: EventCategory[];
  scheduledAt?: Date | null;
  endAt?: Date | null;
  location?: {
    searchLabel?: string | null;
    venue?: string | null;
    address?: string | null;
    formattedAddress?: string | null;
    addressLine1?: string | null;
    neighborhood?: string | null;
    district?: string | null;
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
  status: string;
  cancellationDisplayReason?: string | null;
  host?: TicketWalletEventHost | null;
  publicGoingSummary?: PublicEventGoingSummaryResponse;
}

export interface CheckoutQuoteResponse {
  currency: string;
  subtotalAmount: number;
  platformFeeAmount: number;
  taxAmount: number;
  discountAmount: number;
  totalAmount: number;
  taxSnapshot: CheckoutTaxSnapshot;
  policySnapshot: CheckoutPolicySnapshot;
  lineItems: CheckoutOrderResponse["lineItems"];
}

export interface TicketWalletPass {
  orderId: string;
  ticketNo: string;
  ticketIndex: number;
  qrCode: string;
  status: TicketPassStatus;
  usedAt?: Date | null;
  currentShare?: TicketShareResponse | null;
}

export interface TicketWalletItem {
  id: string;
  source: TicketWalletSource;
  orderId: string;
  ticketNo: string;
  ticketId: string;
  ticketName: string;
  quantity: number;
  paidQuantity: number;
  freeQuantity: number;
  totalQuantity: number;
  unitAmount: number;
  totalAmount: number;
  orderSubtotalAmount?: number | null;
  orderPlatformFeeAmount?: number | null;
  orderTaxAmount?: number | null;
  orderDiscountAmount?: number | null;
  orderTotalAmount?: number | null;
  currency: string;
  paymentStatus: CheckoutPaymentStatus;
  walletStatus: TicketWalletStatus;
  refund?: {
    id: string;
    status: CancellationRefundStatus;
    requestedAmountMinor: number;
    completedAmountMinor: number;
    remainingRefundableAmountMinor: number;
    currency: string;
    providerStatus?: string | null;
    safeLastErrorMessage?: string | null;
    updatedAt: Date;
    completedAt?: Date | null;
  } | null;
  purchasedAt?: Date | null;
  ticketPasses: TicketWalletPass[];
  currentShare?: TicketShareResponse | null;
  sharedBy?: TicketWalletEventHost | null;
  event: TicketWalletEvent;
}

export interface ITicketShare {
  _id: Types.ObjectId;
  ownerUserId: Types.ObjectId;
  recipientUserId: Types.ObjectId;
  orderId: Types.ObjectId;
  eventId: string;
  ticketId: string;
  ticketIndex: number;
  status: TicketShareStatus;
  sharedAt: Date;
  cancelledAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ITicketUsage {
  _id: Types.ObjectId;
  ownerUserId: Types.ObjectId;
  holderUserId: Types.ObjectId;
  usedByUserId: Types.ObjectId;
  shareId?: Types.ObjectId | null;
  orderId: Types.ObjectId;
  eventId: string;
  ticketId: string;
  ticketIndex: number;
  source: TicketWalletSource;
  usedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface TicketShareResponse {
  id: string;
  ownerUserId: string;
  recipientUserId: string;
  orderId: string;
  eventId: string;
  ticketId: string;
  ticketIndex: number;
  qrCode: string;
  status: TicketShareStatus;
  sharedAt: Date;
  cancelledAt?: Date | null;
  friend?: TicketWalletEventHost | null;
}

export interface ShareTicketDto {
  eventId: string;
  ticketId: string;
  orderId: string;
  ticketIndex: number;
  friendId: string;
}

export interface ScanTicketDto {
  checkInCode: string;
  eventId?: string;
}

export interface ScanTicketResponse {
  eventName: string;
  ticketName: string;
  ticketIndex: number;
  ticketNo: string;
  source: TicketWalletSource;
  holderUserId: string;
  holderName: string;
  usedAt: Date;
}

export type EventTicketStatFilter = "going" | "attended" | "canceled" | "noShow";
export type EventTicketStatItemStatus = "checked_in" | "no_show" | "active" | CheckoutPaymentStatus;

export interface EventTicketStatUserResponse {
  id: string;
  name: string;
  username?: string;
  avatarKey?: string | null;
  isFollowing?: boolean;
}

export interface EventTicketStatItemResponse {
  id: string;
  attendee: EventTicketStatUserResponse | null;
  ticketName: string;
  amount: number;
  currency: string;
  status: EventTicketStatItemStatus;
}

export interface EventAttendanceSummaryAvatarResponse {
  userId: string;
  name: string;
  avatarUrl?: string | null;
}

export interface EventAttendanceSummaryResponse {
  going: number;
  attended: number;
  canceled: number;
  noShow: number;
  avatars: EventAttendanceSummaryAvatarResponse[];
}

export interface PublicEventGoingAvatarResponse {
  userId: string;
  name: string;
  avatarKey?: string | null;
}

export interface PublicEventGoingSummaryResponse {
  going: number;
  avatars: PublicEventGoingAvatarResponse[];
}

export interface PublicEventGoingItemResponse {
  id: string;
  attendee: EventTicketStatUserResponse | null;
}
