import httpStatus from "http-status";
import Stripe from "stripe";
import { Types } from "mongoose";
import { env } from "../../config/env.js";
import { AppError } from "../../core/errors/app-error.js";
import { RedisClient } from "../../config/redis.js";
import { logger } from "../../core/logger/logger.js";
import type { AuthUser } from "../auth/auth.interface.js";
import { EventRepository } from "../events/event.repository.js";
import type { EventReward, EventTicket, IEvent } from "../events/event.interface.js";
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
  ITicketUsage,
  ScanTicketDto,
  ScanTicketResponse,
  ShareTicketDto,
  TicketShareResponse,
  TicketWalletItem,
  TicketWalletPass,
  TicketWalletStatus,
} from "./checkout-payment.interface.js";
import { CheckoutPaymentRepository } from "./checkout-payment.repository.js";
import { CreatorEarningRepository } from "./creator-earning.repository.js";
import { TicketShareRepository } from "./ticket-share.repository.js";
import { TicketUsageRepository } from "./ticket-usage.repository.js";
import { NotificationRepository } from "../notifications/notification.repository.js";
import { realtimeGateway } from "../realtime/realtime.gateway.js";

type StripeClient = InstanceType<typeof Stripe>;
type StripePaymentIntent = Awaited<ReturnType<StripeClient["paymentIntents"]["retrieve"]>>;

const BUYER_FEE_STRIPE = 0.10;
const CREATOR_PLATFORM_FEE = 0.05;

const roundCurrency = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

const toMinorAmount = (value: number): number => Math.round(roundCurrency(value) * 100);

export class CheckoutPaymentService {
  private stripe: StripeClient | null = null;

  public constructor(
    private readonly repository = new CheckoutPaymentRepository(),
    private readonly eventRepository = new EventRepository(),
    private readonly productRepository = new ProductRepository(),
    private readonly earningRepository = new CreatorEarningRepository(),
    private readonly userRepository = new UserRepository(),
    private readonly userFollowRepository = new UserFollowRepository(),
    private readonly ticketShareRepository = new TicketShareRepository(),
    private readonly ticketUsageRepository = new TicketUsageRepository(),
    private readonly notificationRepository = new NotificationRepository(),
  ) {}

  public async getMyTicketPurchaseCounts(
    user: AuthUser,
    eventId: string,
  ): Promise<Record<string, number>> {
    return this.repository.getPurchasedTicketCountsByEvent(user.id, eventId);
  }

  public async getEventTicketStats(
    user: AuthUser,
    eventId: string,
  ): Promise<{ stats: Record<string, { sold: number; available: number; capacity: number }> }> {
    const event = await this.eventRepository.findByIdForUser(eventId, user.id);

    if (!event) {
      throw new AppError("Event not found", httpStatus.NOT_FOUND);
    }

    const sales = await this.repository.getEventTicketSales(eventId);
    const stats: Record<string, { sold: number; available: number; capacity: number }> = {};

    for (const ticket of event.tickets) {
      const sold = sales[ticket.id] ?? 0;
      stats[ticket.id] = {
        sold,
        available: Math.max(0, ticket.capacity - sold),
        capacity: ticket.capacity,
      };
    }

    return { stats };
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

    const orderIds = [
      ...new Set([
        ...orders.map((order) => order._id.toString()),
        ...ownerShares.map((share) => share.orderId.toString()),
        ...receivedShares.map((share) => share.orderId.toString()),
      ]),
    ];
    const [events, usages] = await Promise.all([
      this.eventRepository.findManyByIds(eventIds),
      this.ticketUsageRepository.findByEventIdsAndOrderIds(eventIds, orderIds),
    ]);
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
    const shareByTicketPass = new Map(
      ownerShares.map((share) => [
        this.getTicketPassKey(share.eventId, share.ticketId, share.orderId.toString(), share.ticketIndex ?? 1),
        share,
      ]),
    );
    const usageByTicketPass = new Map(
      usages.map((usage) => [
        this.getTicketPassKey(usage.eventId, usage.ticketId, usage.orderId.toString(), usage.ticketIndex),
        usage,
      ]),
    );
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
        for (const ticketPass of walletItem.ticketPasses) {
          const ticketPassKey = this.getTicketPassKey(lineItem.eventId, lineItem.itemId, ticketPass.orderId, ticketPass.ticketIndex);
          const activeShare = shareByTicketPass.get(ticketPassKey) ?? null;
          const shareFriend = activeShare ? userById.get(activeShare.recipientUserId.toString()) ?? null : null;
          const usage = usageByTicketPass.get(ticketPassKey) ?? null;
          ticketPass.currentShare = activeShare ? this.toTicketShareResponse(activeShare, shareFriend) : null;
          this.applyUsageToTicketPass(ticketPass, usage);
        }
        walletItem.currentShare = walletItem.ticketPasses.find((pass) => pass.currentShare)?.currentShare ?? null;
        walletItem.walletStatus = this.getWalletStatus(order, event, walletItem.ticketPasses);
        const existingItem = walletItemByTicket.get(itemKey);

        if (existingItem) {
          existingItem.quantity += walletItem.quantity;
          existingItem.paidQuantity += walletItem.paidQuantity;
          existingItem.freeQuantity += walletItem.freeQuantity;
          existingItem.totalQuantity += walletItem.totalQuantity;
          existingItem.totalAmount = roundCurrency(existingItem.totalAmount + walletItem.totalAmount);
          existingItem.ticketPasses.push(...walletItem.ticketPasses);
          existingItem.currentShare = existingItem.currentShare ?? walletItem.currentShare;
          existingItem.walletStatus = this.getWalletStatus(order, event, existingItem.ticketPasses);
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
        const usage = usageByTicketPass.get(
          this.getTicketPassKey(share.eventId, share.ticketId, share.orderId.toString(), share.ticketIndex ?? 1),
        ) ?? null;

        return this.toSharedTicketWalletItem(share, event, ticket, host, owner, usage);
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

    const recipientAlreadyHasSharedTicket = await this.ticketShareRepository.hasActiveShareForRecipientAtEvent(
      payload.friendId,
      payload.eventId,
    );

    if (recipientAlreadyHasSharedTicket) {
      throw new AppError("This friend already has a shared ticket for this event", httpStatus.CONFLICT);
    }

    const ticket = event.tickets.find((item) => item.id === payload.ticketId);

    if (!ticket) {
      throw new AppError("Event ticket not found", httpStatus.NOT_FOUND);
    }

    const order = await this.repository.findById(payload.orderId);

    if (!order || order.userId.toString() !== user.id || order.kind !== "ticket" || order.paymentStatus !== "paid") {
      throw new AppError("Ticket order not found", httpStatus.NOT_FOUND);
    }

    const lineItem = order.lineItems.find(
      (item) => item.itemType === "ticket" && item.eventId === payload.eventId && item.itemId === payload.ticketId,
    );

    if (!lineItem) {
      throw new AppError("Ticket pass not found for this order", httpStatus.NOT_FOUND);
    }

    const orderTicketCount = this.getEffectiveTicketQuantities(event, lineItem).totalQuantity;

    if (payload.ticketIndex > orderTicketCount) {
      throw new AppError("Ticket pass not found for this order", httpStatus.NOT_FOUND);
    }

    const purchasedCount = await this.getEffectiveOwnedTicketCount(user.id, event, payload.ticketId);

    if (purchasedCount < 2) {
      throw new AppError("You need 2 purchased tickets of this type before sharing one", httpStatus.BAD_REQUEST);
    }

    const usedPass = await this.ticketUsageRepository.findByTicketPass(
      payload.eventId,
      payload.ticketId,
      payload.orderId,
      payload.ticketIndex,
    );

    if (usedPass) {
      throw new AppError("Used tickets cannot be shared", httpStatus.CONFLICT);
    }

    const existingShare = await this.ticketShareRepository.findActiveByOwnerAndTicket(
      user.id,
      payload.eventId,
      payload.ticketId,
      payload.orderId,
      payload.ticketIndex,
    );

    if (existingShare) {
      throw new AppError("Cancel the existing share before sharing this ticket with another friend", httpStatus.CONFLICT);
    }

    const activeShareCount = await this.ticketShareRepository.countActiveByOwnerAndTicket(
      user.id,
      payload.eventId,
      payload.ticketId,
    );

    if (purchasedCount - activeShareCount < 2) {
      throw new AppError("You must keep at least 1 ticket and can only share up to n - 1 tickets", httpStatus.BAD_REQUEST);
    }

    const share = await this.ticketShareRepository.create({
      ownerUserId: user.id,
      recipientUserId: payload.friendId,
      orderId: payload.orderId,
      eventId: payload.eventId,
      ticketId: payload.ticketId,
      ticketIndex: payload.ticketIndex,
    });

    void this.dispatchTicketShareNotification(user, payload.friendId, event.name ?? null, ticket.name);

    return this.toTicketShareResponse(share, friend);
  }

  private async dispatchTicketShareNotification(
    sharer: AuthUser,
    recipientId: string,
    eventName: string | null,
    ticketName: string,
  ): Promise<void> {
    try {
      const notification = await this.notificationRepository.create({
        recipientUserId: recipientId,
        type: "ticket_share",
        actorUserId: sharer.id,
        actorName: sharer.name,
        actorUsername: sharer.username,
        actorAvatarKey: sharer.avatarKey ?? null,
        eventName,
        ticketName,
      });

      realtimeGateway.notifyUser(recipientId, {
        type: "notification:new",
        notification: {
          id: notification._id.toString(),
          type: "ticket_share",
          actorId: sharer.id,
          actorName: sharer.name,
          actorUsername: sharer.username ?? null,
          actorAvatarUrl: null,
          eventId: null,
          eventName,
          ticketName,
          isRead: false,
          createdAt: notification.createdAt.toISOString(),
        },
      });
    } catch {
      // Notification failure must not break ticket sharing
    }
  }

  public async cancelTicketShare(user: AuthUser, shareId: string): Promise<TicketShareResponse> {
    const activeShare = await this.ticketShareRepository.findActiveById(shareId);

    if (!activeShare || activeShare.ownerUserId.toString() !== user.id) {
      throw new AppError("Active ticket share not found", httpStatus.NOT_FOUND);
    }

    const usedPass = await this.ticketUsageRepository.findByTicketPass(
      activeShare.eventId,
      activeShare.ticketId,
      activeShare.orderId.toString(),
      activeShare.ticketIndex ?? 1,
    );

    if (usedPass) {
      throw new AppError("Used shared tickets cannot be cancelled", httpStatus.CONFLICT);
    }

    const share = await this.ticketShareRepository.cancelByIdForOwner(shareId, user.id);

    if (!share) {
      throw new AppError("Active ticket share not found", httpStatus.NOT_FOUND);
    }

    const friend = await this.userRepository.findById(share.recipientUserId.toString());

    return this.toTicketShareResponse(share, friend);
  }

  public async scanTicket(user: AuthUser, payload: ScanTicketDto): Promise<ScanTicketResponse> {
    const qrPayload = this.parseTicketQrCode(payload.qrCode);
    const [event, order, share] = await Promise.all([
      this.eventRepository.findById(qrPayload.eventId),
      this.repository.findById(qrPayload.orderId),
      qrPayload.shareId ? this.ticketShareRepository.findActiveById(qrPayload.shareId) : Promise.resolve(null),
    ]);

    if (!event) {
      throw new AppError("Event not found", httpStatus.NOT_FOUND);
    }

    if (event.userId.toString() !== user.id) {
      throw new AppError("Only the event host can scan this ticket", httpStatus.FORBIDDEN);
    }

    if (!order || order.kind !== "ticket" || order.paymentStatus !== "paid") {
      throw new AppError("Ticket order not found", httpStatus.NOT_FOUND);
    }

    const ticket = event.tickets.find((item) => item.id === qrPayload.ticketId);

    if (!ticket) {
      throw new AppError("Event ticket not found", httpStatus.NOT_FOUND);
    }

    const lineItem = order.lineItems.find(
      (item) => item.itemType === "ticket" && item.eventId === qrPayload.eventId && item.itemId === qrPayload.ticketId,
    );

    if (!lineItem) {
      throw new AppError("Ticket pass not found for this order", httpStatus.NOT_FOUND);
    }

    const orderTicketCount = this.getEffectiveTicketQuantities(event, lineItem).totalQuantity;

    if (qrPayload.ticketIndex > orderTicketCount) {
      throw new AppError("Ticket pass not found for this order", httpStatus.NOT_FOUND);
    }

    const existingUsage = await this.ticketUsageRepository.findByTicketPass(
      qrPayload.eventId,
      qrPayload.ticketId,
      qrPayload.orderId,
      qrPayload.ticketIndex,
    );

    if (existingUsage) {
      throw new AppError("This ticket has already been used", httpStatus.CONFLICT);
    }

    const activeShare = share ?? (await this.ticketShareRepository.findActiveByTicketPass(
      qrPayload.eventId,
      qrPayload.ticketId,
      qrPayload.orderId,
      qrPayload.ticketIndex,
    ));

    if (qrPayload.shareId) {
      if (
        !activeShare ||
        activeShare._id.toString() !== qrPayload.shareId ||
        activeShare.eventId !== qrPayload.eventId ||
        activeShare.ticketId !== qrPayload.ticketId ||
        activeShare.orderId.toString() !== qrPayload.orderId ||
        (activeShare.ticketIndex ?? 1) !== qrPayload.ticketIndex
      ) {
        throw new AppError("This shared ticket is no longer valid", httpStatus.CONFLICT);
      }
    } else if (activeShare) {
      throw new AppError("This ticket is currently shared. Use the shared QR instead.", httpStatus.CONFLICT);
    }

    const holderUserId = activeShare ? activeShare.recipientUserId.toString() : order.userId.toString();
    const holder = await this.userRepository.findById(holderUserId);

    const usage = await this.ticketUsageRepository.create({
      ownerUserId: order.userId.toString(),
      holderUserId,
      usedByUserId: user.id,
      shareId: activeShare?._id.toString() ?? null,
      orderId: qrPayload.orderId,
      eventId: qrPayload.eventId,
      ticketId: qrPayload.ticketId,
      ticketIndex: qrPayload.ticketIndex,
      source: activeShare ? "shared" : "owned",
    });

    return {
      eventId: event._id.toString(),
      eventName: event.name ?? "Event",
      ticketId: ticket.id,
      ticketName: ticket.name,
      orderId: order._id.toString(),
      ticketIndex: qrPayload.ticketIndex,
      ticketNo: activeShare
        ? `MOM-SHARE-${activeShare._id.toString().slice(-4).toUpperCase()}-${String(qrPayload.ticketIndex).padStart(2, "0")}`
        : this.toTicketPassNo(order, qrPayload.ticketIndex),
      source: activeShare ? "shared" : "owned",
      holderUserId,
      holderName: holder?.name ?? "Attendee",
      usedAt: usage.usedAt,
    };
  }

  public async createIntent(user: AuthUser, payload: CreateCheckoutIntentDto): Promise<CheckoutIntentResponse> {
    if (!payload.acceptedTerms) {
      throw new AppError("Terms must be accepted before payment", httpStatus.BAD_REQUEST);
    }

    const isTicket = payload.kind === "ticket";
    const lockKey = isTicket
      ? `checkout_lock:${user.id}:${payload.eventId}:${payload.ticketId}`
      : null;
    let lockAcquired = false;

    if (lockKey) {
      try {
        const redis = RedisClient.getClient();

        if (redis.status === "ready") {
          // Atomic SET NX EX — returns 1 if key was newly set, 0 if it already existed
          const acquired = await redis.setnx(lockKey, "1");
          lockAcquired = acquired === 1;

          if (lockAcquired) {
            await redis.expire(lockKey, 60);
          } else {
            throw new AppError(
              "A checkout is already in progress for this ticket. Please wait a moment and try again.",
              httpStatus.CONFLICT,
            );
          }
        }
      } catch (error) {
        if (error instanceof AppError) throw error;
        logger.warn({ error, lockKey }, "Redis checkout lock unavailable — proceeding without lock");
      }
    }

    try {
      if (isTicket) {
        // Use active count (paid + requires_payment + processing) to prevent per-user limit bypass
        const activeCount = await this.repository.getActivePurchasedCountForTicket(
          user.id,
          payload.eventId,
          payload.ticketId,
        );
        const remaining = Math.max(0, 2 - activeCount);

        if (remaining === 0) {
          throw new AppError(
            "You have already purchased the maximum of 2 tickets of this type",
            httpStatus.BAD_REQUEST,
          );
        }

        if (activeCount + payload.quantity > 2) {
          throw new AppError(
            `You can only purchase ${remaining} more ticket${remaining === 1 ? "" : "s"} of this type`,
            httpStatus.BAD_REQUEST,
          );
        }

        // Idempotency: return existing non-expired Stripe pending order
        const existingPending = await this.repository.findExistingPendingTicketOrder(
          user.id,
          payload.eventId,
          payload.ticketId,
        );

        if (existingPending) {
          return {
            order: this.toOrderResponse(existingPending),
            paymentIntentClientSecret: existingPending.stripeClientSecret ?? null,
            publishableKey: env.STRIPE_PUBLISHABLE_KEY ?? "",
            merchantDisplayName: env.APP_NAME,
            merchantCountryCode: env.STRIPE_MERCHANT_COUNTRY,
          };
        }

        // Idempotency: return existing paid free ticket order
        const existingFree = await this.repository.findExistingPaidFreeOrder(
          user.id,
          payload.eventId,
          payload.ticketId,
        );

        if (existingFree) {
          return {
            order: this.toOrderResponse(existingFree),
            paymentIntentClientSecret: null,
            publishableKey: null,
            merchantDisplayName: env.APP_NAME,
            merchantCountryCode: env.STRIPE_MERCHANT_COUNTRY,
          };
        }
      }

      const currency = env.STRIPE_CURRENCY.toLowerCase();
      const lineItems = await this.resolveLineItems(user, payload);
      const subtotalAmount = roundCurrency(lineItems.reduce((sum, item) => sum + item.totalAmount, 0));
      const platformFeeAmount = roundCurrency(subtotalAmount * BUYER_FEE_STRIPE);
      const totalAmount = roundCurrency(subtotalAmount + platformFeeAmount);
      const amounts = { currency, subtotalAmount, platformFeeAmount, totalAmount };

      if (!isTicket) {
        if (totalAmount === 0) {
          return this.createFreeOrder(user, payload, lineItems, amounts);
        }

        return this.createStripeOrder(user, payload, lineItems, amounts);
      }

      // Atomic ticket capacity reservation — single MongoDB round-trip, prevents oversell
      const ticketLineItem = lineItems[0];
      const reserveQty = ticketLineItem?.totalQuantity ?? payload.quantity;
      const reserved = await this.eventRepository.reserveTicketCapacity(
        payload.eventId,
        payload.ticketId,
        reserveQty,
      );

      if (!reserved) {
        throw new AppError(
          "Not enough tickets are available. Please try a different ticket or quantity.",
          httpStatus.BAD_REQUEST,
        );
      }

      // Create the order; compensate on any failure
      try {
        if (totalAmount === 0) {
          return await this.createFreeOrder(user, payload, lineItems, amounts);
        }

        return await this.createStripeOrder(user, payload, lineItems, amounts);
      } catch (error) {
        await this.eventRepository.releaseTicketCapacity(payload.eventId, payload.ticketId, reserveQty).catch(
          (releaseError) => {
            logger.error({ releaseError, eventId: payload.eventId, ticketId: payload.ticketId }, "Failed to release ticket capacity after order creation failure");
          },
        );
        throw error;
      }
    } finally {
      if (lockKey && lockAcquired) {
        try {
          const redis = RedisClient.getClient();

          if (redis.status === "ready") {
            await redis.del(lockKey);
          }
        } catch {
          // Non-critical: lock expires automatically after 60s
        }
      }
    }
  }

  public async confirmOrder(user: AuthUser, orderId: string): Promise<CheckoutOrderResponse> {
    const order = await this.repository.findById(orderId);

    if (!order || order.userId.toString() !== user.id) {
      throw new AppError("Checkout order not found", httpStatus.NOT_FOUND);
    }

    if (!order.stripePaymentIntentId) {
      return this.toOrderResponse(order);
    }

    const paymentIntent = await this.getStripe().paymentIntents.retrieve(order.stripePaymentIntentId);
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

  private async createFreeOrder(
    user: AuthUser,
    payload: CreateCheckoutIntentDto,
    lineItems: CheckoutOrderLineItem[],
    amounts: { currency: string; subtotalAmount: number; platformFeeAmount: number; totalAmount: number },
  ): Promise<CheckoutIntentResponse> {
    const { currency, subtotalAmount, platformFeeAmount, totalAmount } = amounts;
    const now = new Date();

    const order = await this.repository.create({
      userId: user.id,
      kind: payload.kind,
      paymentMethod: payload.paymentMethod,
      paymentStatus: "paid",
      payoutStatus: "not_ready",
      currency,
      subtotalAmount,
      platformFeeAmount,
      taxAmount: 0,
      totalAmount,
      amountMinor: 0,
      lineItems,
      stripePaymentIntentId: null,
      stripeClientSecret: null,
      anonymous: payload.kind === "ticket" ? Boolean((payload as { anonymous?: boolean }).anonymous) : false,
      termsAcceptedAt: now,
      paidAt: now,
    });

    void this.dispatchTicketNotifications(order);

    return {
      order: this.toOrderResponse(order),
      paymentIntentClientSecret: null,
      publishableKey: null,
      merchantDisplayName: env.APP_NAME,
      merchantCountryCode: env.STRIPE_MERCHANT_COUNTRY,
    };
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

    // Pre-generate the order ID so we can include it in the PI metadata at creation time
    // and use it as the PI idempotency key — eliminates the extra stripe.paymentIntents.update() call
    // and prevents duplicate PIs on double-tap / network retry.
    const preOrderId = new Types.ObjectId();
    const stripe = this.getStripe();

    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: amountMinor,
        currency,
        automatic_payment_methods: {
          enabled: true,
          allow_redirects: "never",
        },
        metadata: {
          userId: user.id,
          kind: payload.kind,
          orderId: preOrderId.toString(),
        },
        description: this.buildPaymentDescription(payload.kind, lineItems),
      },
      { idempotencyKey: `pi-${preOrderId.toString()}` },
    );

    if (!paymentIntent.client_secret) {
      throw new AppError("Stripe did not return a payment client secret", httpStatus.SERVICE_UNAVAILABLE);
    }

    const reservedUntil = new Date(Date.now() + 30 * 60 * 1000);

    const order = await this.repository.create({
      _id: preOrderId,
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
      reservedUntil,
      anonymous: payload.kind === "ticket" ? Boolean((payload as { anonymous?: boolean }).anonymous) : false,
      termsAcceptedAt: new Date(),
    });

    return {
      order: this.toOrderResponse(order),
      paymentIntentClientSecret: paymentIntent.client_secret,
      publishableKey: env.STRIPE_PUBLISHABLE_KEY ?? "",
      merchantDisplayName: env.APP_NAME,
      merchantCountryCode: env.STRIPE_MERCHANT_COUNTRY,
    };
  }

  private async processRefund(order: ICheckoutOrder): Promise<ICheckoutOrder> {
    if (order.totalAmount > 0 && order.stripePaymentIntentId) {
      // Free ticket orders have totalAmount === 0 and no stripePaymentIntentId — skip Stripe refund
      await this.getStripe().refunds.create({
        payment_intent: order.stripePaymentIntentId,
      });
    }

    const updated = await this.repository.updatePaymentStatus(order._id.toString(), {
      paymentStatus: "refunded",
    });

    await this.earningRepository.markRefundedByOrderId(order._id.toString());

    if (order.kind === "ticket") {
      await this.releaseCapacityForOrder(order);
    }

    return updated ?? order;
  }

  public async cancelOrder(user: AuthUser, orderId: string): Promise<CheckoutOrderResponse> {
    const order = await this.repository.findById(orderId);

    if (!order || order.userId.toString() !== user.id) {
      throw new AppError("Checkout order not found", httpStatus.NOT_FOUND);
    }

    if (order.paymentStatus !== "requires_payment") {
      throw new AppError("Only pending payment orders can be cancelled", httpStatus.BAD_REQUEST);
    }

    const updated = await this.repository.updatePaymentStatusIf(
      orderId,
      ["requires_payment"],
      { paymentStatus: "canceled", failedAt: new Date(), failureMessage: "Payment cancelled by user." },
    );

    if (updated && updated.kind === "ticket") {
      await this.releaseCapacityForOrder(updated);
    }

    return this.toOrderResponse(updated ?? order);
  }

  public async expireStaleReservations(): Promise<void> {
    const staleOrders = await this.repository.findStaleReservedOrders(50);

    for (const order of staleOrders) {
      try {
        const updated = await this.repository.updatePaymentStatusIf(
          order._id.toString(),
          ["requires_payment"],
          { paymentStatus: "canceled", failedAt: new Date(), failureMessage: "Reservation expired." },
        );

        if (updated && updated.kind === "ticket") {
          await this.releaseCapacityForOrder(updated);
        }
      } catch (error) {
        logger.error({ error, orderId: order._id.toString() }, "Failed to expire stale reservation");
      }
    }
  }

  private async releaseCapacityForOrder(order: ICheckoutOrder): Promise<void> {
    const ticketItems = order.lineItems.filter(
      (item) => item.itemType === "ticket" && item.eventId && item.itemId,
    );

    for (const item of ticketItems) {
      const qty = item.totalQuantity ?? item.quantity;
      await this.eventRepository.releaseTicketCapacity(item.eventId!, item.itemId!, qty).catch((error) => {
        logger.error(
          { error, eventId: item.eventId, ticketId: item.itemId, orderId: order._id.toString() },
          "Failed to release ticket capacity",
        );
      });
    }
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

      if (ticket.salesEndAt && ticket.salesEndAt <= new Date()) {
        throw new AppError(
          "Ticket sales have ended for this ticket. Please choose another available ticket.",
          httpStatus.BAD_REQUEST,
        );
      }

      const linkedReward = event.rewards.find(
        (reward) => reward.rewardType === "ticket" && reward.ticketId === ticket.id,
      );
      const freeQuantity = this.calculateTicketRewardQuantity(payload.quantity, linkedReward);
      const totalQuantity = payload.quantity + freeQuantity;
      // Capacity enforcement is handled atomically by reserveTicketCapacity — no non-atomic check here.
      const unitAmount = ticket.type === "free" || ticket.price <= 0 ? 0 : roundCurrency(ticket.price);

      return [
        {
          itemType: "ticket",
          itemId: ticket.id,
          eventId: event._id.toString(),
          sellerUserId: event.userId,
          name: ticket.name,
          quantity: payload.quantity,
          paidQuantity: payload.quantity,
          freeQuantity,
          totalQuantity,
          rewardId: freeQuantity > 0 ? linkedReward?.id ?? null : null,
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

  private calculateTicketRewardQuantity(paidQuantity: number, reward?: EventReward | null): number {
    if (!reward || reward.rewardType !== "ticket" || reward.buyQuantity <= 0 || reward.freeQuantity <= 0) {
      return 0;
    }

    if (reward.expiresAt && reward.expiresAt.getTime() < Date.now()) {
      return 0;
    }

    return Math.floor(paidQuantity / reward.buyQuantity) * reward.freeQuantity;
  }

  private getTicketRewardForLineItem(event: IEvent, lineItem: CheckoutOrderLineItem): EventReward | null {
    if (lineItem.itemType !== "ticket" || !lineItem.itemId) {
      return null;
    }

    return event.rewards.find(
      (reward) => reward.rewardType === "ticket" && reward.ticketId === lineItem.itemId,
    ) ?? null;
  }

  private getEffectiveTicketQuantities(
    event: IEvent,
    lineItem: CheckoutOrderLineItem,
  ): { paidQuantity: number; freeQuantity: number; totalQuantity: number } {
    const paidQuantity = lineItem.paidQuantity ?? lineItem.quantity;
    const derivedFreeQuantity = this.calculateTicketRewardQuantity(
      paidQuantity,
      this.getTicketRewardForLineItem(event, lineItem),
    );
    const freeQuantity = Math.max(lineItem.freeQuantity ?? 0, derivedFreeQuantity);
    const storedTotalQuantity = lineItem.totalQuantity ?? paidQuantity + (lineItem.freeQuantity ?? 0);
    const totalQuantity = Math.max(storedTotalQuantity, paidQuantity + freeQuantity);

    return {
      paidQuantity,
      freeQuantity,
      totalQuantity,
    };
  }

  private async getEffectiveOwnedTicketCount(
    userId: string,
    event: IEvent,
    ticketId: string,
  ): Promise<number> {
    const orders = await this.repository.findPaidTicketOrdersForUserEventTicket(
      userId,
      event._id.toString(),
      ticketId,
    );

    return orders.reduce((total, order) => {
      const orderTotal = order.lineItems
        .filter((item) => item.itemType === "ticket" && item.eventId === event._id.toString() && item.itemId === ticketId)
        .reduce((sum, item) => sum + this.getEffectiveTicketQuantities(event, item).totalQuantity, 0);

      return total + orderTotal;
    }, 0);
  }

  private async dispatchTicketNotifications(order: ICheckoutOrder): Promise<void> {
    if (order.kind !== "ticket") {
      return;
    }

    try {
      const buyer = await this.userRepository.findById(order.userId.toString());
      const ticketItem = order.lineItems.find((item) => item.itemType === "ticket");

      if (!ticketItem) {
        return;
      }

      const eventId = ticketItem.eventId ?? null;
      const eventName = ticketItem.name ?? null;
      const ticketName = ticketItem.name ?? null;

      // Buyer confirmation notification
      const buyerNotification = await this.notificationRepository.create({
        recipientUserId: order.userId.toString(),
        type: "ticket_buyer",
        actorName: buyer?.name ?? null,
        actorUsername: buyer?.username ?? null,
        actorAvatarKey: buyer?.avatarKey ?? null,
        eventId,
        eventName,
        ticketName,
      });

      realtimeGateway.notifyUser(order.userId.toString(), {
        type: "notification:new",
        notification: {
          id: buyerNotification._id.toString(),
          type: "ticket_buyer",
          actorId: null,
          actorName: null,
          actorUsername: null,
          actorAvatarUrl: null,
          eventId,
          eventName,
          ticketName,
          isRead: false,
          createdAt: buyerNotification.createdAt.toISOString(),
        },
      });

      // Creator notification
      if (ticketItem.sellerUserId) {
        const creatorId = ticketItem.sellerUserId.toString();

        if (creatorId !== order.userId.toString()) {
          const creatorNotification = await this.notificationRepository.create({
            recipientUserId: creatorId,
            type: "ticket_creator",
            actorUserId: order.userId.toString(),
            actorName: buyer?.name ?? null,
            actorUsername: buyer?.username ?? null,
            actorAvatarKey: buyer?.avatarKey ?? null,
            eventId,
            eventName,
            ticketName,
          });

          realtimeGateway.notifyUser(creatorId, {
            type: "notification:new",
            notification: {
              id: creatorNotification._id.toString(),
              type: "ticket_creator",
              actorId: order.userId.toString(),
              actorName: buyer?.name ?? null,
              actorUsername: buyer?.username ?? null,
              actorAvatarUrl: null,
              eventId,
              eventName,
              ticketName,
              isRead: false,
              createdAt: creatorNotification.createdAt.toISOString(),
            },
          });
        }
      }
    } catch {
      // Notification failure must not break payment processing
    }
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
        void this.dispatchTicketNotifications(updatedOrder);
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
      // Conditional update prevents double capacity release if webhook fires multiple times
      const updatedOrder = await this.repository.updatePaymentStatusIf(
        order._id.toString(),
        ["requires_payment", "processing"],
        { paymentStatus: "canceled", failedAt: new Date(), failureMessage: "Payment was canceled." },
      );

      if (updatedOrder && updatedOrder.kind === "ticket") {
        await this.releaseCapacityForOrder(updatedOrder);
      }

      return updatedOrder ?? order;
    }

    if (paymentIntent.status === "requires_payment_method") {
      // Conditional update prevents double capacity release if webhook fires multiple times
      const updatedOrder = await this.repository.updatePaymentStatusIf(
        order._id.toString(),
        ["requires_payment", "processing"],
        {
          paymentStatus: "failed",
          failedAt: new Date(),
          failureMessage: paymentIntent.last_payment_error?.message ?? "Payment failed.",
        },
      );

      if (updatedOrder && updatedOrder.kind === "ticket") {
        await this.releaseCapacityForOrder(updatedOrder);
      }

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
        paidQuantity: item.paidQuantity ?? item.quantity,
        freeQuantity: item.freeQuantity ?? 0,
        totalQuantity: item.totalQuantity ?? item.quantity,
        rewardId: item.rewardId ?? null,
        unitAmount: item.unitAmount,
        totalAmount: item.totalAmount,
      })),
      stripePaymentIntentId: order.stripePaymentIntentId ?? null,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };
  }

  private getWalletStatus(order: ICheckoutOrder, event: IEvent, ticketPasses: TicketWalletPass[]): TicketWalletStatus {
    if (order.paymentStatus === "refunded" || event.status === "cancelled") {
      return "cancelled";
    }

    if (ticketPasses.length > 0 && ticketPasses.every((ticketPass) => ticketPass.status === "used")) {
      return "used";
    }

    return "active";
  }

  private toTicketNo(order: ICheckoutOrder): string {
    return `MOM-${order.createdAt.getFullYear()}-${order._id.toString().slice(-4).toUpperCase()}`;
  }

  private toTicketPassNo(order: ICheckoutOrder, ticketIndex: number): string {
    return `${this.toTicketNo(order)}-${String(ticketIndex).padStart(2, "0")}`;
  }

  private toTicketQrCode(eventId: string, ticketId: string, orderId: string, ticketIndex: number, shareId?: string): string {
    return JSON.stringify({
      type: "event-ticket",
      eventId,
      ticketId,
      orderId,
      ticketIndex,
      shareId: shareId ?? undefined,
    });
  }

  private parseTicketQrCode(qrCode: string): {
    eventId: string;
    ticketId: string;
    orderId: string;
    ticketIndex: number;
    shareId?: string;
  } {
    let parsed: unknown;

    try {
      parsed = JSON.parse(qrCode);
    } catch {
      throw new AppError("Invalid ticket QR code", httpStatus.BAD_REQUEST);
    }

    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as { type?: unknown }).type !== "event-ticket" ||
      typeof (parsed as { eventId?: unknown }).eventId !== "string" ||
      typeof (parsed as { ticketId?: unknown }).ticketId !== "string" ||
      typeof (parsed as { orderId?: unknown }).orderId !== "string" ||
      !Number.isInteger((parsed as { ticketIndex?: unknown }).ticketIndex) ||
      (parsed as { ticketIndex: number }).ticketIndex < 1
    ) {
      throw new AppError("Invalid ticket QR code", httpStatus.BAD_REQUEST);
    }

    const shareId = typeof (parsed as { shareId?: unknown }).shareId === "string"
      ? (parsed as { shareId: string }).shareId
      : undefined;

    return {
      eventId: (parsed as { eventId: string }).eventId,
      ticketId: (parsed as { ticketId: string }).ticketId,
      orderId: (parsed as { orderId: string }).orderId,
      ticketIndex: (parsed as { ticketIndex: number }).ticketIndex,
      shareId,
    };
  }

  private getTicketPassKey(eventId: string, ticketId: string, orderId: string, ticketIndex: number): string {
    return `${eventId}:${ticketId}:${orderId}:${ticketIndex}`;
  }

  private buildTicketPasses(order: ICheckoutOrder, lineItem: CheckoutOrderLineItem, event: IEvent): TicketWalletPass[] {
    const eventId = lineItem.eventId ?? "";
    const ticketId = lineItem.itemId ?? "";
    const orderId = order._id.toString();
    const { totalQuantity } = this.getEffectiveTicketQuantities(event, lineItem);

    return Array.from({ length: totalQuantity }, (_, index) => {
      const ticketIndex = index + 1;

      return {
        orderId,
        ticketNo: this.toTicketPassNo(order, ticketIndex),
        ticketIndex,
        qrCode: this.toTicketQrCode(eventId, ticketId, orderId, ticketIndex),
        status: "active",
        usedAt: null,
        currentShare: null,
      };
    });
  }

  private applyUsageToTicketPass(ticketPass: TicketWalletPass, usage: ITicketUsage | null): void {
    ticketPass.status = usage ? "used" : "active";
    ticketPass.usedAt = usage?.usedAt ?? null;
  }

  private toTicketWalletItem(
    order: ICheckoutOrder,
    lineItem: CheckoutOrderLineItem,
    event: IEvent,
    host: IUser | null,
  ): TicketWalletItem {
    const { paidQuantity, freeQuantity, totalQuantity } = this.getEffectiveTicketQuantities(event, lineItem);
    const ticketPasses = this.buildTicketPasses(order, lineItem, event);

    return {
      id: `${order._id.toString()}-${lineItem.itemId}`,
      source: "owned",
      orderId: order._id.toString(),
      ticketNo: this.toTicketNo(order),
      ticketId: lineItem.itemId ?? "",
      ticketName: lineItem.name,
      quantity: totalQuantity,
      paidQuantity,
      freeQuantity,
      totalQuantity,
      unitAmount: lineItem.unitAmount,
      totalAmount: lineItem.totalAmount,
      currency: order.currency,
      paymentStatus: order.paymentStatus,
      walletStatus: this.getWalletStatus(order, event, ticketPasses),
      purchasedAt: order.paidAt ?? order.createdAt,
      ticketPasses,
      event: {
        id: event._id.toString(),
        name: event.name ?? null,
        bannerImageKey: event.bannerImageKey ?? null,
        bannerOriginalImageKey: event.bannerOriginalImageKey ?? null,
        scheduledAt: event.scheduledAt ?? null,
        endAt: event.endAt ?? null,
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
    usage: ITicketUsage | null,
  ): TicketWalletItem {
    const unitAmount = roundCurrency(ticket.type === "free" ? 0 : ticket.price);
    const ticketIndex = share.ticketIndex ?? 1;
    const orderId = share.orderId.toString();
    const qrCode = this.toTicketQrCode(share.eventId, share.ticketId, orderId, ticketIndex, share._id.toString());
    const ticketNo = `MOM-SHARE-${share._id.toString().slice(-4).toUpperCase()}-${String(ticketIndex).padStart(2, "0")}`;
    const ticketPasses: TicketWalletPass[] = [
      {
        orderId,
        ticketNo,
        ticketIndex,
        qrCode,
        status: usage ? "used" : "active",
        usedAt: usage?.usedAt ?? null,
        currentShare: null,
      },
    ];

    return {
      id: `share-${share._id.toString()}`,
      source: "shared",
      orderId,
      ticketNo,
      ticketId: share.ticketId,
      ticketName: ticket.name,
      quantity: 1,
      paidQuantity: 1,
      freeQuantity: 0,
      totalQuantity: 1,
      unitAmount,
      totalAmount: unitAmount,
      currency: env.STRIPE_CURRENCY.toLowerCase(),
      paymentStatus: "paid",
      walletStatus: this.getWalletStatus(
        {
          paymentStatus: "paid",
        } as ICheckoutOrder,
        event,
        ticketPasses,
      ),
      purchasedAt: share.sharedAt,
      ticketPasses,
      currentShare: null,
      sharedBy: owner ? this.toWalletUser(owner) : null,
      event: {
        id: event._id.toString(),
        name: event.name ?? null,
        bannerImageKey: event.bannerImageKey ?? null,
        bannerOriginalImageKey: event.bannerOriginalImageKey ?? null,
        scheduledAt: event.scheduledAt ?? null,
        endAt: event.endAt ?? null,
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
      ticketIndex: share.ticketIndex ?? 1,
      qrCode: this.toTicketQrCode(
        share.eventId,
        share.ticketId,
        share.orderId.toString(),
        share.ticketIndex ?? 1,
        share._id.toString(),
      ),
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
