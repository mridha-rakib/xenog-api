import { randomUUID } from "node:crypto";
import httpStatus from "http-status";
import Stripe from "stripe";
import { env } from "../../config/env.js";
import { AppError } from "../../core/errors/app-error.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { EventRepository } from "../events/event.repository.js";
import type { EventTicket, IEvent } from "../events/event.interface.js";
import { ProductRepository } from "../products/product.repository.js";
import { UserRepository } from "../user/user.repository.js";
import { UserFollowRepository } from "../user/user-follow.repository.js";
import type { IUser } from "../user/user.interface.js";
import type {
  CheckoutIntentResponse,
  CheckoutOrderLineItem,
  CheckoutOrderResponse,
  CreateCheckoutIntentDto,
  ICheckoutOrder,
  ITicketShare,
  ShareTicketDto,
  TicketShareResponse,
  TicketWalletItem,
  TicketWalletStatus,
} from "./checkout-payment.interface.js";
import { CheckoutPaymentRepository } from "./checkout-payment.repository.js";
import { MoomentCreditPaymentRepository } from "./mooment-credit-payment.repository.js";
import { CreatorEarningRepository } from "./creator-earning.repository.js";
import { TicketShareRepository } from "./ticket-share.repository.js";

type StripeClient = InstanceType<typeof Stripe>;
type StripePaymentIntent = Awaited<ReturnType<StripeClient["paymentIntents"]["retrieve"]>>;

const BUYER_FEE_STRIPE = 0.10;
const BUYER_FEE_CREDITS = 0.05;
const CREATOR_PLATFORM_FEE = 0.05;

const roundCurrency = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

const toMinorAmount = (value: number): number => Math.round(roundCurrency(value) * 100);

const getBuyerFeeRate = (paymentMethod: string): number =>
  paymentMethod === "mooment_credits" ? BUYER_FEE_CREDITS : BUYER_FEE_STRIPE;

export class CheckoutPaymentService {
  private stripe: StripeClient | null = null;

  public constructor(
    private readonly repository = new CheckoutPaymentRepository(),
    private readonly eventRepository = new EventRepository(),
    private readonly productRepository = new ProductRepository(),
    private readonly creditRepository = new MoomentCreditPaymentRepository(),
    private readonly earningRepository = new CreatorEarningRepository(),
    private readonly userRepository = new UserRepository(),
    private readonly userFollowRepository = new UserFollowRepository(),
    private readonly ticketShareRepository = new TicketShareRepository(),
  ) {}

  public async getMyTicketPurchaseCounts(
    user: AuthUser,
    eventId: string,
  ): Promise<Record<string, number>> {
    return this.repository.getPurchasedTicketCountsByEvent(user.id, eventId);
  }

  public async getMyTicketWallet(user: AuthUser): Promise<TicketWalletItem[]> {
    const [orders, ownerShares, receivedShares] = await Promise.all([
      this.repository.findTicketWalletOrdersByUserId(user.id),
      this.ticketShareRepository.findActiveByOwnerId(user.id),
      this.ticketShareRepository.findActiveByRecipientId(user.id),
    ]);
    const eventIds = [
      ...new Set(
        [
          ...orders.flatMap((order) =>
            order.lineItems
              .filter((item) => item.itemType === "ticket" && item.eventId)
              .map((item) => item.eventId as string),
          ),
          ...ownerShares.map((share) => share.eventId),
          ...receivedShares.map((share) => share.eventId),
        ],
      ),
    ];

    if (eventIds.length === 0) {
      return [];
    }

    const events = await this.eventRepository.findManyByIds(eventIds);
    const eventById = new Map(events.map((event) => [event._id.toString(), event]));
    const userIds = [
      ...new Set([
        ...events.map((event) => event.userId.toString()),
        ...ownerShares.map((share) => share.recipientUserId.toString()),
        ...receivedShares.map((share) => share.ownerUserId.toString()),
      ]),
    ];
    const users = userIds.length > 0 ? await this.userRepository.findMany({ _id: { $in: userIds } }, 0, userIds.length) : [];
    const userById = new Map(users.map((item) => [item._id.toString(), item]));
    const shareByTicket = new Map(ownerShares.map((share) => [`${share.eventId}:${share.ticketId}`, share]));
    const walletItemByTicket = new Map<string, TicketWalletItem>();

    for (const order of orders) {
      for (const lineItem of order.lineItems) {
        if (lineItem.itemType !== "ticket" || !lineItem.eventId || !lineItem.itemId) {
          continue;
        }

        const event = eventById.get(lineItem.eventId);

        if (!event) {
          continue;
        }

        const host = userById.get(event.userId.toString()) ?? null;
        const walletItem = this.toTicketWalletItem(order, lineItem, event, host);
        const itemKey = `${lineItem.eventId}:${lineItem.itemId}`;
        const activeShare = shareByTicket.get(itemKey) ?? null;
        const shareFriend = activeShare ? userById.get(activeShare.recipientUserId.toString()) ?? null : null;
        walletItem.currentShare = activeShare ? this.toTicketShareResponse(activeShare, shareFriend) : null;
        const existingItem = walletItemByTicket.get(itemKey);

        if (existingItem) {
          existingItem.quantity += walletItem.quantity;
          existingItem.totalAmount = roundCurrency(existingItem.totalAmount + walletItem.totalAmount);
          existingItem.currentShare = existingItem.currentShare ?? walletItem.currentShare;
        } else {
          walletItemByTicket.set(itemKey, walletItem);
        }
      }
    }

    const sharedItems = receivedShares
      .map((share) => {
        const event = eventById.get(share.eventId);

        if (!event) {
          return null;
        }

        const ticket = event.tickets.find((item) => item.id === share.ticketId);

        if (!ticket) {
          return null;
        }

        const host = userById.get(event.userId.toString()) ?? null;
        const owner = userById.get(share.ownerUserId.toString()) ?? null;

        return this.toSharedTicketWalletItem(share, event, ticket, host, owner);
      })
      .filter((item): item is TicketWalletItem => Boolean(item));

    const walletItems = [...walletItemByTicket.values(), ...sharedItems];

    return walletItems.sort((left, right) => {
      const leftTime = left.event.scheduledAt ? new Date(left.event.scheduledAt).getTime() : 0;
      const rightTime = right.event.scheduledAt ? new Date(right.event.scheduledAt).getTime() : 0;

      if (left.walletStatus !== right.walletStatus) {
        return left.walletStatus === "active" ? -1 : 1;
      }

      return leftTime - rightTime;
    });
  }

  public async shareTicket(user: AuthUser, payload: ShareTicketDto): Promise<TicketShareResponse> {
    if (user.id === payload.friendId) {
      throw new AppError("You cannot share a ticket with yourself", httpStatus.BAD_REQUEST);
    }

    const [event, friend, isFollowingFriend, friendFollowsUser] = await Promise.all([
      this.eventRepository.findById(payload.eventId),
      this.userRepository.findById(payload.friendId),
      this.userFollowRepository.isFollowing(user.id, payload.friendId),
      this.userFollowRepository.isFollowing(payload.friendId, user.id),
    ]);

    if (!event || event.status !== "published") {
      throw new AppError("Event not found", httpStatus.NOT_FOUND);
    }

    if (!friend || friend.role !== "user" || !friend.isActive || !friend.emailVerified) {
      throw new AppError("Friend not found", httpStatus.NOT_FOUND);
    }

    if (!isFollowingFriend || !friendFollowsUser) {
      throw new AppError("Tickets can only be shared with mutual friends", httpStatus.FORBIDDEN);
    }

    const ticket = event.tickets.find((item) => item.id === payload.ticketId);

    if (!ticket) {
      throw new AppError("Event ticket not found", httpStatus.NOT_FOUND);
    }

    const purchasedCount = await this.repository.getPurchasedCountForTicket(user.id, payload.eventId, payload.ticketId);

    if (purchasedCount < 2) {
      throw new AppError("You need 2 purchased tickets of this type before sharing one", httpStatus.BAD_REQUEST);
    }

    const existingShare = await this.ticketShareRepository.findActiveByOwnerAndTicket(
      user.id,
      payload.eventId,
      payload.ticketId,
    );

    if (existingShare) {
      throw new AppError("Cancel the existing share before sharing this ticket with another friend", httpStatus.CONFLICT);
    }

    const order = await this.repository.findFirstPaidTicketOrderForUserTicket(
      user.id,
      payload.eventId,
      payload.ticketId,
    );

    if (!order) {
      throw new AppError("Paid ticket order not found", httpStatus.NOT_FOUND);
    }

    const share = await this.ticketShareRepository.create({
      ownerUserId: user.id,
      recipientUserId: payload.friendId,
      orderId: order._id.toString(),
      eventId: payload.eventId,
      ticketId: payload.ticketId,
    });

    return this.toTicketShareResponse(share, friend);
  }

  public async cancelTicketShare(user: AuthUser, shareId: string): Promise<TicketShareResponse> {
    const share = await this.ticketShareRepository.cancelByIdForOwner(shareId, user.id);

    if (!share) {
      throw new AppError("Active ticket share not found", httpStatus.NOT_FOUND);
    }

    const friend = await this.userRepository.findById(share.recipientUserId.toString());

    return this.toTicketShareResponse(share, friend);
  }

  public async createIntent(user: AuthUser, payload: CreateCheckoutIntentDto): Promise<CheckoutIntentResponse> {
    if (!payload.acceptedTerms) {
      throw new AppError("Terms must be accepted before payment", httpStatus.BAD_REQUEST);
    }

    if (payload.kind === "ticket") {
      const existingCount = await this.repository.getPurchasedCountForTicket(
        user.id,
        payload.eventId,
        payload.ticketId,
      );
      const remaining = Math.max(0, 2 - existingCount);

      if (remaining === 0) {
        throw new AppError(
          "You have already purchased the maximum of 2 tickets of this type",
          httpStatus.BAD_REQUEST,
        );
      }

      if (existingCount + payload.quantity > 2) {
        throw new AppError(
          `You can only purchase ${remaining} more ticket${remaining === 1 ? "" : "s"} of this type`,
          httpStatus.BAD_REQUEST,
        );
      }
    }

    const currency = env.STRIPE_CURRENCY.toLowerCase();
    const lineItems = await this.resolveLineItems(user, payload);
    const subtotalAmount = roundCurrency(lineItems.reduce((sum, item) => sum + item.totalAmount, 0));
    const feeRate = getBuyerFeeRate(payload.paymentMethod);
    const platformFeeAmount = roundCurrency(subtotalAmount * feeRate);
    const totalAmount = roundCurrency(subtotalAmount + platformFeeAmount);

    if (payload.paymentMethod === "mooment_credits") {
      return this.createMoomentCreditsOrder(user, payload, lineItems, {
        currency,
        subtotalAmount,
        platformFeeAmount,
        totalAmount,
      });
    }

    return this.createStripeOrder(user, payload, lineItems, {
      currency,
      subtotalAmount,
      platformFeeAmount,
      totalAmount,
    });
  }

  public async confirmOrder(user: AuthUser, orderId: string): Promise<CheckoutOrderResponse> {
    const order = await this.repository.findById(orderId);

    if (!order || order.userId.toString() !== user.id) {
      throw new AppError("Checkout order not found", httpStatus.NOT_FOUND);
    }

    if (order.paymentMethod === "mooment_credits") {
      return this.toOrderResponse(order);
    }

    const paymentIntent = await this.getStripe().paymentIntents.retrieve(order.stripePaymentIntentId!);
    const updatedOrder = await this.applyPaymentIntentStatus(order, paymentIntent);

    return this.toOrderResponse(updatedOrder);
  }

  public async refundUserOrder(user: AuthUser, orderId: string): Promise<CheckoutOrderResponse> {
    const order = await this.repository.findById(orderId);

    if (!order || order.userId.toString() !== user.id) {
      throw new AppError("Checkout order not found", httpStatus.NOT_FOUND);
    }

    if (order.kind !== "ticket") {
      throw new AppError("Only ticket orders are eligible for refund", httpStatus.BAD_REQUEST);
    }

    if (order.paymentStatus !== "paid") {
      throw new AppError("Only paid orders can be refunded", httpStatus.BAD_REQUEST);
    }

    const refunded = await this.processRefund(order);

    return this.toOrderResponse(refunded);
  }

  public async handleStripeWebhook(signature: string | undefined, rawBody: Buffer | undefined): Promise<void> {
    if (!env.STRIPE_WEBHOOK_SECRET) {
      throw new AppError("Stripe webhook secret is not configured", httpStatus.SERVICE_UNAVAILABLE);
    }

    if (!signature || !rawBody) {
      throw new AppError("Missing Stripe webhook signature", httpStatus.BAD_REQUEST);
    }

    const event = this.getStripe().webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);

    if (
      event.type === "payment_intent.succeeded" ||
      event.type === "payment_intent.payment_failed" ||
      event.type === "payment_intent.canceled" ||
      event.type === "payment_intent.processing"
    ) {
      await this.applyPaymentIntentEvent(event.data.object as StripePaymentIntent);
    }
  }

  public async processRefundForCancelledEvent(orderId: string): Promise<void> {
    const order = await this.repository.findById(orderId);

    if (!order || order.paymentStatus !== "paid") {
      return;
    }

    await this.processRefund(order);
  }

  private async createStripeOrder(
    user: AuthUser,
    payload: CreateCheckoutIntentDto,
    lineItems: CheckoutOrderLineItem[],
    amounts: { currency: string; subtotalAmount: number; platformFeeAmount: number; totalAmount: number },
  ): Promise<CheckoutIntentResponse> {
    const { currency, subtotalAmount, platformFeeAmount, totalAmount } = amounts;
    const amountMinor = toMinorAmount(totalAmount);

    if (amountMinor < 1) {
      throw new AppError("Paid checkout amount must be greater than zero", httpStatus.BAD_REQUEST);
    }

    const stripe = this.getStripe();

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountMinor,
      currency,
      automatic_payment_methods: {
        enabled: true,
        allow_redirects: "never",
      },
      metadata: {
        userId: user.id,
        kind: payload.kind,
      },
      description: this.buildPaymentDescription(payload.kind, lineItems),
    });

    if (!paymentIntent.client_secret) {
      throw new AppError("Stripe did not return a payment client secret", httpStatus.SERVICE_UNAVAILABLE);
    }

    const order = await this.repository.create({
      userId: user.id,
      kind: payload.kind,
      paymentMethod: payload.paymentMethod,
      paymentStatus: "requires_payment",
      payoutStatus: "not_ready",
      currency,
      subtotalAmount,
      platformFeeAmount,
      taxAmount: 0,
      totalAmount,
      amountMinor,
      lineItems,
      stripePaymentIntentId: paymentIntent.id,
      stripeClientSecret: paymentIntent.client_secret,
      anonymous: payload.kind === "ticket" ? Boolean((payload as { anonymous?: boolean }).anonymous) : false,
      termsAcceptedAt: new Date(),
    });

    await stripe.paymentIntents.update(paymentIntent.id, {
      metadata: {
        userId: user.id,
        kind: payload.kind,
        orderId: order._id.toString(),
      },
    });

    return {
      order: this.toOrderResponse(order),
      paymentIntentClientSecret: paymentIntent.client_secret,
      publishableKey: env.STRIPE_PUBLISHABLE_KEY ?? "",
      merchantDisplayName: env.APP_NAME,
      merchantCountryCode: env.STRIPE_MERCHANT_COUNTRY,
    };
  }

  private async createMoomentCreditsOrder(
    user: AuthUser,
    payload: CreateCheckoutIntentDto,
    lineItems: CheckoutOrderLineItem[],
    amounts: { currency: string; subtotalAmount: number; platformFeeAmount: number; totalAmount: number },
  ): Promise<CheckoutIntentResponse> {
    const { currency, subtotalAmount, platformFeeAmount, totalAmount } = amounts;
    const amountMinor = toMinorAmount(totalAmount);

    if (amountMinor < 1) {
      throw new AppError("Checkout amount must be greater than zero", httpStatus.BAD_REQUEST);
    }

    const deducted = await this.creditRepository.decrementWallet(user.id, totalAmount);

    if (!deducted) {
      throw new AppError("Insufficient Mooment Credits in your wallet", httpStatus.PAYMENT_REQUIRED);
    }

    const paymentRef = `mc-${randomUUID()}`;
    const now = new Date();

    const order = await this.repository.create({
      userId: user.id,
      kind: payload.kind,
      paymentMethod: "mooment_credits",
      paymentStatus: "paid",
      payoutStatus: "held",
      currency,
      subtotalAmount,
      platformFeeAmount,
      taxAmount: 0,
      totalAmount,
      amountMinor,
      lineItems,
      stripePaymentIntentId: paymentRef,
      stripeClientSecret: null,
      anonymous: payload.kind === "ticket" ? Boolean((payload as { anonymous?: boolean }).anonymous) : false,
      termsAcceptedAt: now,
      paidAt: now,
    });

    await this.recordCreatorEarnings(order);

    return {
      order: this.toOrderResponse(order),
      paymentIntentClientSecret: null,
      publishableKey: null,
      merchantDisplayName: env.APP_NAME,
      merchantCountryCode: env.STRIPE_MERCHANT_COUNTRY,
    };
  }

  private async processRefund(order: ICheckoutOrder): Promise<ICheckoutOrder> {
    if (order.paymentMethod === "mooment_credits") {
      await this.creditRepository.incrementWallet(order.userId.toString(), order.totalAmount);
    } else {
      if (!order.stripePaymentIntentId) {
        throw new AppError("Order has no payment reference for refund", httpStatus.INTERNAL_SERVER_ERROR);
      }

      await this.getStripe().refunds.create({
        payment_intent: order.stripePaymentIntentId,
      });
    }

    const updated = await this.repository.updatePaymentStatus(order._id.toString(), {
      paymentStatus: "refunded",
    });

    await this.earningRepository.markRefundedByOrderId(order._id.toString());

    return updated ?? order;
  }

  private getStripe(): StripeClient {
    if (this.stripe) {
      return this.stripe;
    }

    if (!env.STRIPE_SECRET_KEY || !env.STRIPE_PUBLISHABLE_KEY) {
      throw new AppError("Stripe is not configured", httpStatus.SERVICE_UNAVAILABLE);
    }

    this.stripe = new Stripe(env.STRIPE_SECRET_KEY, {
      appInfo: {
        name: env.APP_NAME,
      },
    });

    return this.stripe;
  }

  private async resolveLineItems(user: AuthUser, payload: CreateCheckoutIntentDto): Promise<CheckoutOrderLineItem[]> {
    if (payload.kind === "ticket") {
      const event = await this.eventRepository.findById(payload.eventId);

      if (!event || event.status !== "published") {
        throw new AppError("Event not found", httpStatus.NOT_FOUND);
      }

      if (event.privacy === "private") {
        const isOwner = event.userId.toString() === user.id;
        const isMember = event.memberUserIds.some((id) => id.toString() === user.id);
        if (!isOwner && !isMember) {
          throw new AppError("You are not invited to this private event", httpStatus.FORBIDDEN);
        }
      }

      const ticket = event.tickets.find((item) => item.id === payload.ticketId);

      if (!ticket) {
        throw new AppError("Event ticket not found", httpStatus.NOT_FOUND);
      }

      if (ticket.type === "free" || ticket.price <= 0) {
        throw new AppError("This ticket does not require online payment", httpStatus.BAD_REQUEST);
      }

      if (ticket.capacity < payload.quantity) {
        throw new AppError("Not enough tickets are available", httpStatus.BAD_REQUEST);
      }

      const unitAmount = roundCurrency(ticket.price);

      return [
        {
          itemType: "ticket",
          itemId: ticket.id,
          eventId: event._id.toString(),
          sellerUserId: event.userId,
          name: ticket.name,
          quantity: payload.quantity,
          unitAmount,
          totalAmount: roundCurrency(unitAmount * payload.quantity),
        },
      ];
    }

    if (payload.kind === "product") {
      const lineItems: CheckoutOrderLineItem[] = [];

      for (const item of payload.items) {
        const product = await this.productRepository.findPublishedById(item.productId);

        if (!product) {
          throw new AppError("Product not found", httpStatus.NOT_FOUND);
        }

        if (product.totalProduct < item.quantity) {
          throw new AppError(`Not enough stock is available for ${product.name}`, httpStatus.BAD_REQUEST);
        }

        const unitAmount = roundCurrency(
          product.discountPercent > 0 ? product.priceUsd * (1 - product.discountPercent / 100) : product.priceUsd,
        );

        lineItems.push({
          itemType: "product",
          itemId: product._id.toString(),
          sellerUserId: product.userId,
          name: product.name,
          quantity: item.quantity,
          unitAmount,
          totalAmount: roundCurrency(unitAmount * item.quantity),
        });
      }

      return lineItems;
    }

    return payload.items.map((item) => ({
      itemType: "custom",
      itemId: null,
      eventId: null,
      sellerUserId: null,
      name: item.name,
      quantity: item.quantity,
      unitAmount: roundCurrency(item.amount),
      totalAmount: roundCurrency(item.amount * item.quantity),
    }));
  }

  private async recordCreatorEarnings(order: ICheckoutOrder): Promise<void> {
    const sellerItems = order.lineItems.filter((item) => item.sellerUserId);

    for (const item of sellerItems) {
      if (item.itemType !== "ticket" && item.itemType !== "product") {
        continue;
      }

      const grossAmount = item.totalAmount;
      const platformFeeAmount = roundCurrency(grossAmount * CREATOR_PLATFORM_FEE);
      const netAmount = roundCurrency(grossAmount - platformFeeAmount);

      await this.earningRepository.create({
        creatorUserId: item.sellerUserId!.toString(),
        orderId: order._id.toString(),
        eventId: item.eventId ?? null,
        itemType: item.itemType,
        grossAmount,
        platformFeePercent: CREATOR_PLATFORM_FEE * 100,
        platformFeeAmount,
        netAmount,
        status: "held",
      });
    }
  }

  private async applyPaymentIntentEvent(paymentIntent: StripePaymentIntent): Promise<void> {
    const orderId = typeof paymentIntent.metadata.orderId === "string" ? paymentIntent.metadata.orderId : null;
    const order = orderId
      ? await this.repository.findById(orderId)
      : await this.repository.findByPaymentIntentId(paymentIntent.id);

    if (!order) {
      return;
    }

    await this.applyPaymentIntentStatus(order, paymentIntent);
  }

  private async applyPaymentIntentStatus(
    order: ICheckoutOrder,
    paymentIntent: StripePaymentIntent,
  ): Promise<ICheckoutOrder> {
    if (paymentIntent.status === "succeeded") {
      const alreadyPaid = order.paymentStatus === "paid";

      const updatedOrder = await this.repository.updatePaymentStatus(order._id.toString(), {
        paymentStatus: "paid",
        payoutStatus: "held",
        paidAt: order.paidAt ?? new Date(),
        failureMessage: null,
      });

      if (!alreadyPaid && updatedOrder) {
        await this.recordCreatorEarnings(updatedOrder);
      }

      return updatedOrder ?? order;
    }

    if (paymentIntent.status === "processing") {
      const updatedOrder = await this.repository.updatePaymentStatus(order._id.toString(), {
        paymentStatus: "processing",
      });

      return updatedOrder ?? order;
    }

    if (paymentIntent.status === "canceled") {
      const updatedOrder = await this.repository.updatePaymentStatus(order._id.toString(), {
        paymentStatus: "canceled",
        failedAt: new Date(),
        failureMessage: "Payment was canceled.",
      });

      return updatedOrder ?? order;
    }

    if (paymentIntent.status === "requires_payment_method") {
      const updatedOrder = await this.repository.updatePaymentStatus(order._id.toString(), {
        paymentStatus: "failed",
        failedAt: new Date(),
        failureMessage: paymentIntent.last_payment_error?.message ?? "Payment failed.",
      });

      return updatedOrder ?? order;
    }

    return order;
  }

  private buildPaymentDescription(kind: string, lineItems: CheckoutOrderLineItem[]): string {
    const firstItem = lineItems[0];

    if (!firstItem) {
      return `${env.APP_NAME} ${kind} checkout`;
    }

    const suffix = lineItems.length > 1 ? ` + ${lineItems.length - 1} more` : "";

    return `${env.APP_NAME} ${kind} checkout: ${firstItem.name}${suffix}`;
  }

  private toOrderResponse(order: ICheckoutOrder): CheckoutOrderResponse {
    return {
      id: order._id.toString(),
      kind: order.kind,
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      payoutStatus: order.payoutStatus,
      currency: order.currency,
      subtotalAmount: order.subtotalAmount,
      platformFeeAmount: order.platformFeeAmount,
      taxAmount: order.taxAmount,
      totalAmount: order.totalAmount,
      lineItems: order.lineItems.map((item) => ({
        itemType: item.itemType,
        itemId: item.itemId ?? null,
        eventId: item.eventId ?? null,
        sellerUserId: item.sellerUserId?.toString() ?? null,
        name: item.name,
        quantity: item.quantity,
        unitAmount: item.unitAmount,
        totalAmount: item.totalAmount,
      })),
      stripePaymentIntentId: order.stripePaymentIntentId ?? null,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };
  }

  private getWalletStatus(order: ICheckoutOrder, event: IEvent): TicketWalletStatus {
    if (order.paymentStatus === "refunded" || event.status === "cancelled") {
      return "cancelled";
    }

    if (event.scheduledAt && event.scheduledAt.getTime() < Date.now()) {
      return "used";
    }

    return "active";
  }

  private toTicketNo(order: ICheckoutOrder): string {
    return `MOM-${order.createdAt.getFullYear()}-${order._id.toString().slice(-4).toUpperCase()}`;
  }

  private toTicketWalletItem(
    order: ICheckoutOrder,
    lineItem: CheckoutOrderLineItem,
    event: IEvent,
    host: IUser | null,
  ): TicketWalletItem {
    return {
      id: `${order._id.toString()}-${lineItem.itemId}`,
      source: "owned",
      orderId: order._id.toString(),
      ticketNo: this.toTicketNo(order),
      ticketId: lineItem.itemId ?? "",
      ticketName: lineItem.name,
      quantity: lineItem.quantity,
      unitAmount: lineItem.unitAmount,
      totalAmount: lineItem.totalAmount,
      currency: order.currency,
      paymentStatus: order.paymentStatus,
      walletStatus: this.getWalletStatus(order, event),
      purchasedAt: order.paidAt ?? order.createdAt,
      event: {
        id: event._id.toString(),
        name: event.name ?? null,
        bannerImageKey: event.bannerImageKey ?? null,
        bannerOriginalImageKey: event.bannerOriginalImageKey ?? null,
        scheduledAt: event.scheduledAt ?? null,
        location: event.location
          ? {
              searchLabel: event.location.searchLabel ?? null,
              venue: event.location.venue ?? null,
              address: event.location.address ?? null,
            }
          : null,
        status: event.status,
        host: host
          ? {
              id: host._id.toString(),
              name: host.name,
              username: host.username,
              avatarKey: host.avatarKey ?? null,
            }
          : null,
      },
    };
  }

  private toSharedTicketWalletItem(
    share: ITicketShare,
    event: IEvent,
    ticket: EventTicket,
    host: IUser | null,
    owner: IUser | null,
  ): TicketWalletItem {
    const unitAmount = roundCurrency(ticket.type === "free" ? 0 : ticket.price);

    return {
      id: `share-${share._id.toString()}`,
      source: "shared",
      orderId: share.orderId.toString(),
      ticketNo: `MOM-SHARE-${share._id.toString().slice(-4).toUpperCase()}`,
      ticketId: share.ticketId,
      ticketName: ticket.name,
      quantity: 1,
      unitAmount,
      totalAmount: unitAmount,
      currency: env.STRIPE_CURRENCY.toLowerCase(),
      paymentStatus: "paid",
      walletStatus: this.getWalletStatus(
        {
          paymentStatus: "paid",
        } as ICheckoutOrder,
        event,
      ),
      purchasedAt: share.sharedAt,
      currentShare: null,
      sharedBy: owner ? this.toWalletUser(owner) : null,
      event: {
        id: event._id.toString(),
        name: event.name ?? null,
        bannerImageKey: event.bannerImageKey ?? null,
        bannerOriginalImageKey: event.bannerOriginalImageKey ?? null,
        scheduledAt: event.scheduledAt ?? null,
        location: event.location
          ? {
              searchLabel: event.location.searchLabel ?? null,
              venue: event.location.venue ?? null,
              address: event.location.address ?? null,
            }
          : null,
        status: event.status,
        host: host ? this.toWalletUser(host) : null,
      },
    };
  }

  private toTicketShareResponse(share: ITicketShare, friend?: IUser | null): TicketShareResponse {
    return {
      id: share._id.toString(),
      ownerUserId: share.ownerUserId.toString(),
      recipientUserId: share.recipientUserId.toString(),
      orderId: share.orderId.toString(),
      eventId: share.eventId,
      ticketId: share.ticketId,
      status: share.status,
      sharedAt: share.sharedAt,
      cancelledAt: share.cancelledAt ?? null,
      friend: friend ? this.toWalletUser(friend) : null,
    };
  }

  private toWalletUser(user: IUser) {
    return {
      id: user._id.toString(),
      name: user.name,
      username: user.username,
      avatarKey: user.avatarKey ?? null,
    };
  }
}
