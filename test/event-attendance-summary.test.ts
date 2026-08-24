import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { createCheckoutTicketPasses } from "../src/modules/payments/ticket-check-in-code.js";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const now = new Date("2026-07-18T00:00:00.000Z");
const eventId = new Types.ObjectId();
const hostId = new Types.ObjectId();
const ticketId = "standard";

type PaymentStatus = "paid" | "refunded" | "canceled" | "failed" | "processing" | "requires_payment";

const lineItem = (quantity: number) => ({
  itemType: "ticket" as const,
  itemId: ticketId,
  eventId: eventId.toString(),
  name: "Standard",
  quantity,
  paidQuantity: quantity,
  freeQuantity: 0,
  totalQuantity: quantity,
  unitAmount: 10,
  totalAmount: quantity * 10,
});

const createOrder = ({
  quantity = 1,
  paymentStatus = "paid",
  orderId = new Types.ObjectId(),
  userId = new Types.ObjectId(),
  anonymous = false,
}: {
  quantity?: number;
  paymentStatus?: PaymentStatus;
  orderId?: Types.ObjectId;
  userId?: Types.ObjectId;
  anonymous?: boolean;
} = {}) => ({
  _id: orderId,
  userId,
  kind: "ticket",
  paymentStatus,
  anonymous,
  lineItems: [lineItem(quantity)],
  ticketPasses: createCheckoutTicketPasses([lineItem(quantity)], now),
  paidAt: now,
  createdAt: now,
});

const passUsage = (order: ReturnType<typeof createOrder>, ticketIndex = 1, holderUserId = order.userId) => ({
  _id: new Types.ObjectId(),
  ownerUserId: order.userId,
  holderUserId,
  usedByUserId: hostId,
  shareId: null,
  orderId: order._id,
  eventId: eventId.toString(),
  ticketId,
  ticketIndex,
  source: "owned",
  usedAt: now,
});

const activeShare = (
  order: ReturnType<typeof createOrder>,
  recipientUserId: Types.ObjectId,
  ticketIndex = 1,
) => ({
  _id: new Types.ObjectId(),
  ownerUserId: order.userId,
  recipientUserId,
  orderId: order._id,
  eventId: eventId.toString(),
  ticketId,
  ticketIndex,
  status: "active",
  sharedAt: now,
  cancelledAt: null,
  createdAt: now,
  updatedAt: now,
});

const passId = (order: ReturnType<typeof createOrder>, ticketIndex = 1) =>
  `${eventId.toString()}:${ticketId}:${order._id.toString()}:${ticketIndex}`;

const createUser = (id: Types.ObjectId, name = id.toString(), avatarKey?: string | null) => ({
  _id: id,
  name,
  username: name.toLowerCase(),
  avatarKey: avatarKey ?? null,
});

const createSummaryService = async ({
  orders,
  usages = [],
  shares = [],
  users = [],
  eventStatus = "published",
  endAt = new Date("2099-07-19T00:00:00.000Z"),
  eventTickets = [{ id: ticketId, name: "Standard", type: "pay", price: 10, capacity: 100, availableCount: 100 }],
  failAvatarUrl = false,
  followingIds = [],
  cancellations = [],
}: {
  orders: Array<ReturnType<typeof createOrder>>;
  usages?: Array<ReturnType<typeof passUsage>>;
  shares?: Array<ReturnType<typeof activeShare>>;
  users?: Array<ReturnType<typeof createUser>>;
  eventStatus?: string;
  endAt?: Date | null;
  eventTickets?: Array<{
    id: string;
    name: string;
    type: string;
    price: number;
    capacity: number;
    availableCount: number;
  }>;
  failAvatarUrl?: boolean;
  followingIds?: string[];
  cancellations?: Array<{
    eventId: Types.ObjectId | string;
    ticketId: string;
    orderId: Types.ObjectId | string;
    ticketIndex: number;
  }>;
}) => {
  const { CheckoutPaymentService } = await import("../src/modules/payments/checkout-payment.service.js");
  const event = {
    _id: eventId,
    userId: hostId,
    status: eventStatus,
    privacy: "public",
    memberUserIds: [],
    endAt,
    tickets: eventTickets,
    rewards: [],
  };
  const repository = {
    findTicketStatOrdersByEventId: async () => orders,
    findIssuedTicketOrdersByEventIds: async (ids: string[]) =>
      orders.filter((order) =>
        order.paymentStatus === "paid" &&
        order.lineItems.some((item) => item.eventId && ids.includes(item.eventId)),
      ),
  };
  const eventRepository = {
    findByIdForUser: async (id: string, userId: string) =>
      id === eventId.toString() && userId === hostId.toString() ? event : null,
    findById: async (id: string) =>
      id === eventId.toString() ? event : null,
  };
  const ticketShareRepository = {
    findActiveByEventId: async () => shares,
    findActiveByEventIds: async (ids: string[]) => shares.filter((share) => ids.includes(share.eventId)),
  };
  const ticketUsageRepository = {
    findByEventIdsAndOrderIds: async () => usages,
  };
  const ticketCancellationRepository = {
    findByEventId: async () => cancellations,
    findByEventIds: async () => cancellations,
  };
  const userRepository = {
    findByIds: async (ids: string[]) => users.filter((user) => ids.includes(user._id.toString())),
  };
  const userFollowRepository = {
    findFollowingIds: async () => followingIds,
  };
  const storageService = {
    createDownloadUrl: async (key: string) => {
      if (failAvatarUrl) {
        throw new Error("storage unavailable");
      }

      return { url: `https://cdn.test/${key}` };
    },
  };
  const service = new CheckoutPaymentService(
    repository as never,
    eventRepository as never,
    {} as never,
    {} as never,
    userRepository as never,
    userFollowRepository as never,
    ticketShareRepository as never,
    ticketUsageRepository as never,
    {} as never,
    storageService as never,
    undefined as never,
    undefined as never,
    ticketCancellationRepository as never,
  );

  return service;
};

const host = {
  id: hostId.toString(),
  name: "Host",
  email: "host@example.com",
  accountType: "business",
  currentLocationSharingEnabled: false,
  notificationsEnabled: true,
  role: "user",
  isActive: true,
  emailVerified: true,
  createdAt: now,
  updatedAt: now,
};

test("one paid order with multiple passes counts every individual pass", async () => {
  const order = createOrder({ quantity: 3 });
  const service = await createSummaryService({ orders: [order] });
  const summary = await service.getEventAttendanceSummary(host as never, eventId.toString());

  assert.equal(summary.going, 3);
});

test("zero-ticket events return zero attendance summary values", async () => {
  const service = await createSummaryService({ orders: [], eventTickets: [] });
  const summary = await service.getEventAttendanceSummary(host as never, eventId.toString());

  assert.deepEqual(summary, {
    going: 0,
    attended: 0,
    canceled: 0,
    noShow: 0,
    avatars: [],
  });
});

test("going counts ticket quantity, not purchaser or order count", async () => {
  const order = createOrder({ quantity: 4 });
  const service = await createSummaryService({ orders: [order] });
  const summary = await service.getEventAttendanceSummary(host as never, eventId.toString());

  assert.equal(summary.going, 4);
});

test("a checked-in paid ticket counts as attended", async () => {
  const order = createOrder();
  const service = await createSummaryService({ orders: [order], usages: [passUsage(order)] });
  const summary = await service.getEventAttendanceSummary(host as never, eventId.toString());

  assert.equal(summary.attended, 1);
});

test("duplicate usage records for the same pass do not increase attended", async () => {
  const order = createOrder();
  const service = await createSummaryService({ orders: [order], usages: [passUsage(order), passUsage(order)] });
  const summary = await service.getEventAttendanceSummary(host as never, eventId.toString());

  assert.equal(summary.attended, 1);
});

test("a user-refunded paid ticket counts as going and canceled", async () => {
  const order = createOrder({ paymentStatus: "refunded" });
  const service = await createSummaryService({ orders: [order] });
  const summary = await service.getEventAttendanceSummary(host as never, eventId.toString());

  assert.deepEqual({ going: summary.going, canceled: summary.canceled }, { going: 1, canceled: 1 });
});

test("creator event cancellation refunds paid passes into canceled", async () => {
  const order = createOrder({ quantity: 2, paymentStatus: "refunded" });
  const service = await createSummaryService({ orders: [order], eventStatus: "cancelled" });
  const summary = await service.getEventAttendanceSummary(host as never, eventId.toString());

  assert.deepEqual(
    { going: summary.going, attended: summary.attended, canceled: summary.canceled, noShow: summary.noShow },
    { going: 2, attended: 0, canceled: 2, noShow: 0 },
  );
});

test("refunded passes are not classified as attended or no-show", async () => {
  const order = createOrder({ paymentStatus: "refunded" });
  const service = await createSummaryService({
    orders: [order],
    usages: [passUsage(order)],
    eventStatus: "completed",
    endAt: new Date("2026-07-17T00:00:00.000Z"),
  });
  const summary = await service.getEventAttendanceSummary(host as never, eventId.toString());

  assert.deepEqual(
    { attended: summary.attended, canceled: summary.canceled, noShow: summary.noShow },
    { attended: 0, canceled: 1, noShow: 0 },
  );
});

test("unpaid canceled reservations are excluded", async () => {
  const service = await createSummaryService({ orders: [createOrder({ paymentStatus: "canceled" })] });
  const summary = await service.getEventAttendanceSummary(host as never, eventId.toString());

  assert.equal(summary.going, 0);
});

test("failed payments are excluded", async () => {
  const service = await createSummaryService({ orders: [createOrder({ paymentStatus: "failed" })] });
  const summary = await service.getEventAttendanceSummary(host as never, eventId.toString());

  assert.equal(summary.going, 0);
});

test("processing and requires_payment orders are excluded", async () => {
  const service = await createSummaryService({
    orders: [createOrder({ paymentStatus: "processing" }), createOrder({ paymentStatus: "requires_payment" })],
  });
  const summary = await service.getEventAttendanceSummary(host as never, eventId.toString());

  assert.equal(summary.going, 0);
});

test("no-show is zero before the event ends", async () => {
  const service = await createSummaryService({ orders: [createOrder()] });
  const summary = await service.getEventAttendanceSummary(host as never, eventId.toString());

  assert.equal(summary.noShow, 0);
});

test("valid unchecked tickets become no-show after the event ends", async () => {
  const service = await createSummaryService({
    orders: [createOrder({ quantity: 2 })],
    eventStatus: "completed",
    endAt: new Date("2026-07-17T00:00:00.000Z"),
  });
  const summary = await service.getEventAttendanceSummary(host as never, eventId.toString());

  assert.equal(summary.noShow, 2);
});

test("a canceled event does not classify refunded tickets as no-show", async () => {
  const service = await createSummaryService({
    orders: [createOrder({ paymentStatus: "refunded" })],
    eventStatus: "cancelled",
    endAt: new Date("2026-07-17T00:00:00.000Z"),
  });
  const summary = await service.getEventAttendanceSummary(host as never, eventId.toString());

  assert.equal(summary.noShow, 0);
});

test("an active shared ticket is counted once and attributed to the recipient avatar", async () => {
  const recipientId = new Types.ObjectId();
  const order = createOrder();
  const service = await createSummaryService({
    orders: [order],
    shares: [activeShare(order, recipientId)],
    users: [createUser(order.userId, "Owner"), createUser(recipientId, "Recipient", "recipient.png")],
  });
  const summary = await service.getEventAttendanceSummary(host as never, eventId.toString());

  assert.equal(summary.going, 1);
  assert.equal(summary.avatars[0]?.userId, recipientId.toString());
});

test("a cancelled TicketShare is not a canceled ticket", async () => {
  const ownerId = new Types.ObjectId();
  const order = createOrder({ userId: ownerId });
  const service = await createSummaryService({
    orders: [order],
    shares: [],
    users: [createUser(ownerId, "Owner")],
  });
  const summary = await service.getEventAttendanceSummary(host as never, eventId.toString());

  assert.equal(summary.canceled, 0);
  assert.equal(summary.avatars[0]?.userId, ownerId.toString());
});

test("avatar users are unique and limited to three", async () => {
  const users = [new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()];
  const orders = [
    createOrder({ userId: users[0] }),
    createOrder({ userId: users[0] }),
    createOrder({ userId: users[1] }),
    createOrder({ userId: users[2] }),
    createOrder({ userId: users[3] }),
  ];
  const service = await createSummaryService({
    orders,
    users: users.map((id, index) => createUser(id, `User ${index + 1}`, `avatar-${index + 1}.png`)),
  });
  const summary = await service.getEventAttendanceSummary(host as never, eventId.toString());

  assert.equal(summary.avatars.length, 3);
  assert.equal(new Set(summary.avatars.map((avatar) => avatar.userId)).size, 3);
});

test("avatar URL generation failure does not fail the summary response", async () => {
  const ownerId = new Types.ObjectId();
  const order = createOrder({ userId: ownerId });
  const service = await createSummaryService({
    orders: [order],
    users: [createUser(ownerId, "Owner", "owner.png")],
    failAvatarUrl: true,
  });
  const summary = await service.getEventAttendanceSummary(host as never, eventId.toString());

  assert.equal(summary.going, 1);
  assert.deepEqual(summary.avatars, [{ userId: ownerId.toString(), name: "Owner", avatarUrl: null }]);
});

test("unauthorized users cannot access another creator's summary", async () => {
  const service = await createSummaryService({ orders: [createOrder()] });
  const stranger = { ...host, id: new Types.ObjectId().toString() };

  await assert.rejects(
    () => service.getEventAttendanceSummary(stranger as never, eventId.toString()),
    { message: "Event not found", statusCode: 404 },
  );
});

test("after an event ends, going equals attended plus canceled plus no-show", async () => {
  const paidOrder = createOrder({ quantity: 3 });
  const refundedOrder = createOrder({ quantity: 2, paymentStatus: "refunded" });
  const service = await createSummaryService({
    orders: [paidOrder, refundedOrder],
    usages: [passUsage(paidOrder, 1)],
    eventStatus: "completed",
    endAt: new Date("2026-07-17T00:00:00.000Z"),
  });
  const summary = await service.getEventAttendanceSummary(host as never, eventId.toString());

  assert.equal(summary.going, summary.attended + summary.canceled + summary.noShow);
});

test("going list returns all paid and refunded issued ticket passes", async () => {
  const paidOrder = createOrder({ quantity: 2 });
  const refundedOrder = createOrder({ paymentStatus: "refunded" });
  const unpaidOrder = createOrder({ paymentStatus: "canceled" });
  const service = await createSummaryService({ orders: [paidOrder, refundedOrder, unpaidOrder] });
  const result = await service.getEventTicketStatItems(host as never, eventId.toString(), { status: "going" });

  assert.equal(result.tickets.length, 3);
  assert.equal(result.tickets.filter((item) => item.status === "refunded").length, 1);
});

test("going list excludes unpaid, failed, and pending payment records", async () => {
  const paidOrder = createOrder();
  const service = await createSummaryService({
    orders: [
      paidOrder,
      createOrder({ paymentStatus: "canceled" }),
      createOrder({ paymentStatus: "failed" }),
      createOrder({ paymentStatus: "processing" }),
      createOrder({ paymentStatus: "requires_payment" }),
    ],
  });
  const result = await service.getEventTicketStatItems(host as never, eventId.toString(), { status: "going" });

  assert.deepEqual(result.tickets.map((item) => item.id), [passId(paidOrder)]);
});

test("attended list returns only checked-in non-refunded passes", async () => {
  const checkedInOrder = createOrder();
  const uncheckedOrder = createOrder();
  const refundedOrder = createOrder({ paymentStatus: "refunded" });
  const service = await createSummaryService({
    orders: [checkedInOrder, uncheckedOrder, refundedOrder],
    usages: [passUsage(checkedInOrder), passUsage(refundedOrder)],
  });
  const result = await service.getEventTicketStatItems(host as never, eventId.toString(), { status: "attended" });

  assert.deepEqual(result.tickets.map((item) => item.id), [passId(checkedInOrder)]);
});

test("canceled list returns only refunded issued passes and excludes unpaid canceled reservations", async () => {
  const refundedOrder = createOrder({ quantity: 2, paymentStatus: "refunded" });
  const unpaidCanceledOrder = createOrder({ paymentStatus: "canceled" });
  const service = await createSummaryService({ orders: [refundedOrder, unpaidCanceledOrder] });
  const result = await service.getEventTicketStatItems(host as never, eventId.toString(), { status: "canceled" });

  assert.equal(result.tickets.length, 2);
  assert.ok(result.tickets.every((item) => item.status === "refunded"));
});

test("no-show list is empty before event end and returns unchecked paid passes after event end", async () => {
  const order = createOrder({ quantity: 2 });
  const upcomingService = await createSummaryService({ orders: [order] });
  const upcoming = await upcomingService.getEventTicketStatItems(host as never, eventId.toString(), { status: "noShow" });

  assert.equal(upcoming.tickets.length, 0);

  const endedService = await createSummaryService({
    orders: [order],
    usages: [passUsage(order, 1)],
    eventStatus: "completed",
    endAt: new Date("2026-07-17T00:00:00.000Z"),
  });
  const ended = await endedService.getEventTicketStatItems(host as never, eventId.toString(), { status: "noShow" });

  assert.deepEqual(ended.tickets.map((item) => item.id), [passId(order, 2)]);
});

test("active shared ticket list row uses the recipient once", async () => {
  const ownerId = new Types.ObjectId();
  const recipientId = new Types.ObjectId();
  const order = createOrder({ userId: ownerId });
  const service = await createSummaryService({
    orders: [order],
    shares: [activeShare(order, recipientId)],
    users: [createUser(ownerId, "Owner"), createUser(recipientId, "Recipient")],
  });
  const result = await service.getEventTicketStatItems(host as never, eventId.toString(), { status: "going" });

  assert.equal(result.tickets.length, 1);
  assert.equal(result.tickets[0]?.attendee?.id, recipientId.toString());
});

test("canceled share list row falls back to owner and is not a canceled ticket", async () => {
  const ownerId = new Types.ObjectId();
  const order = createOrder({ userId: ownerId });
  const service = await createSummaryService({
    orders: [order],
    shares: [],
    users: [createUser(ownerId, "Owner")],
  });
  const going = await service.getEventTicketStatItems(host as never, eventId.toString(), { status: "going" });
  const canceled = await service.getEventTicketStatItems(host as never, eventId.toString(), { status: "canceled" });

  assert.equal(going.tickets[0]?.attendee?.id, ownerId.toString());
  assert.equal(canceled.tickets.length, 0);
});

test("one user with two passes appears as two ticket-pass rows with synchronized follow state", async () => {
  const ownerId = new Types.ObjectId();
  const order = createOrder({ quantity: 2, userId: ownerId });
  const service = await createSummaryService({
    orders: [order],
    users: [createUser(ownerId, "Owner")],
    followingIds: [ownerId.toString()],
  });
  const result = await service.getEventTicketStatItems(host as never, eventId.toString(), { status: "going" });

  assert.equal(result.tickets.length, 2);
  assert.ok(result.tickets.every((item) => item.attendee?.id === ownerId.toString()));
  assert.ok(result.tickets.every((item) => item.attendee?.isFollowing === true));
});

test("ticket stat items include followed and unfollowed attendee state", async () => {
  const followedUserId = new Types.ObjectId();
  const unfollowedUserId = new Types.ObjectId();
  const followedOrder = createOrder({ userId: followedUserId });
  const unfollowedOrder = createOrder({ userId: unfollowedUserId });
  const service = await createSummaryService({
    orders: [followedOrder, unfollowedOrder],
    users: [createUser(followedUserId, "Followed"), createUser(unfollowedUserId, "Unfollowed")],
    followingIds: [followedUserId.toString()],
  });
  const result = await service.getEventTicketStatItems(host as never, eventId.toString(), { status: "going" });
  const followByUserId = new Map(result.tickets.map((item) => [item.attendee?.id, item.attendee?.isFollowing]));

  assert.equal(followByUserId.get(followedUserId.toString()), true);
  assert.equal(followByUserId.get(unfollowedUserId.toString()), false);
});

test("ticket stat item pagination does not duplicate pass rows across pages", async () => {
  const order = createOrder({ quantity: 3 });
  const service = await createSummaryService({ orders: [order] });
  const pageOne = await service.getEventTicketStatItems(host as never, eventId.toString(), {
    status: "going",
    page: 1,
    limit: 2,
  });
  const pageTwo = await service.getEventTicketStatItems(host as never, eventId.toString(), {
    status: "going",
    page: 2,
    limit: 2,
  });
  const ids = [...pageOne.tickets, ...pageTwo.tickets].map((item) => item.id);

  assert.equal(pageOne.pagination?.total, 3);
  assert.equal(new Set(ids).size, 3);
});

test("public going summary counts paid issued passes only", async () => {
  const paidOrder = createOrder({ quantity: 2 });
  const service = await createSummaryService({
    orders: [
      paidOrder,
      createOrder({ paymentStatus: "refunded" }),
      createOrder({ paymentStatus: "canceled" }),
      createOrder({ paymentStatus: "failed" }),
      createOrder({ paymentStatus: "processing" }),
      createOrder({ paymentStatus: "requires_payment" }),
    ],
    users: [createUser(paidOrder.userId, "Paid User", "paid.png")],
  });
  const summaries = await service.getPublicEventGoingSummaries([
    { id: eventId.toString(), status: "published" },
  ]);
  const summary = summaries.get(eventId.toString());

  assert.equal(summary?.going, 2);
  assert.deepEqual(summary?.avatars, [{
    userId: paidOrder.userId.toString(),
    name: "Paid User",
    avatarKey: "paid.png",
  }]);
});

test("public going summary uses active share recipient and canceled share fallback owner", async () => {
  const ownerId = new Types.ObjectId();
  const recipientId = new Types.ObjectId();
  const sharedOrder = createOrder({ userId: ownerId });
  const ownerOrder = createOrder({ userId: ownerId });
  const service = await createSummaryService({
    orders: [sharedOrder, ownerOrder],
    shares: [activeShare(sharedOrder, recipientId)],
    users: [createUser(ownerId, "Owner"), createUser(recipientId, "Recipient")],
  });
  const summaries = await service.getPublicEventGoingSummaries([
    { id: eventId.toString(), status: "published" },
  ]);
  const summary = summaries.get(eventId.toString());

  assert.equal(summary?.going, 2);
  assert.equal(summary?.avatars[0]?.userId, recipientId.toString());
  assert.equal(summary?.avatars[1]?.userId, ownerId.toString());
});

test("public going summary is zero for cancelled events", async () => {
  const service = await createSummaryService({
    orders: [createOrder({ quantity: 2 })],
    eventStatus: "cancelled",
  });
  const summaries = await service.getPublicEventGoingSummaries([
    { id: eventId.toString(), status: "cancelled" },
  ]);

  assert.deepEqual(summaries.get(eventId.toString()), { going: 0, avatars: [] });
});

test("public going list groups multiple passes for the same holder with synchronized follow state", async () => {
  const ownerId = new Types.ObjectId();
  const order = createOrder({ quantity: 2, userId: ownerId });
  const service = await createSummaryService({
    orders: [order],
    users: [createUser(ownerId, "Owner")],
    followingIds: [ownerId.toString()],
  });
  const result = await service.getPublicEventGoingItems(host as never, eventId.toString(), {
    page: 1,
    limit: 30,
  });

  assert.deepEqual(result.tickets.map((item) => item.id), [passId(order, 1)]);
  assert.equal(result.tickets[0]?.attendee?.id, ownerId.toString());
  assert.equal(result.tickets[0]?.attendee?.isFollowing, true);
  assert.equal(result.tickets[0]?.ticketCount, 2);
  assert.equal(result.pagination?.total, 1);
});

test("public going list keeps different holders as separate rows", async () => {
  const ownerId = new Types.ObjectId();
  const otherId = new Types.ObjectId();
  const ownerOrder = createOrder({ userId: ownerId });
  const otherOrder = createOrder({ userId: otherId });
  const service = await createSummaryService({
    orders: [ownerOrder, otherOrder],
    users: [createUser(ownerId, "Owner"), createUser(otherId, "Other")],
  });
  const result = await service.getPublicEventGoingItems(host as never, eventId.toString(), {
    page: 1,
    limit: 30,
  });

  assert.equal(result.tickets.length, 2);
  assert.deepEqual(result.tickets.map((item) => item.attendee?.id), [ownerId.toString(), otherId.toString()]);
  assert.ok(result.tickets.every((item) => item.ticketCount === 1));
});

test("public going summary masks anonymous attendee previews without changing counts", async () => {
  const normalUserId = new Types.ObjectId();
  const anonymousUserId = new Types.ObjectId();
  const normalOrder = createOrder({ userId: normalUserId });
  const anonymousOrder = createOrder({ userId: anonymousUserId, anonymous: true });
  const service = await createSummaryService({
    orders: [normalOrder, anonymousOrder],
    users: [
      createUser(normalUserId, "Visible User", "visible.png"),
      createUser(anonymousUserId, "Hidden User", "hidden.png"),
    ],
  });
  const summaries = await service.getPublicEventGoingSummaries([
    { id: eventId.toString(), status: "published" },
  ]);
  const summary = summaries.get(eventId.toString());

  assert.equal(summary?.going, 2);
  assert.deepEqual(summary?.avatars[0], {
    userId: normalUserId.toString(),
    name: "Visible User",
    avatarKey: "visible.png",
  });
  assert.equal(summary?.avatars[1]?.name, "Anonymous");
  assert.equal(summary?.avatars[1]?.anonymous, true);
  assert.notEqual(summary?.avatars[1]?.userId, anonymousUserId.toString());
  assert.equal(summary?.avatars[1]?.avatarKey, undefined);
});

test("public going summary shows an anonymous attendee their own real preview avatar", async () => {
  const anonymousUserId = new Types.ObjectId();
  const anonymousOrder = createOrder({ quantity: 2, userId: anonymousUserId, anonymous: true });
  const service = await createSummaryService({
    orders: [anonymousOrder],
    users: [createUser(anonymousUserId, "Hidden User", "hidden.png")],
  });
  const summaries = await service.getPublicEventGoingSummaries([
    { id: eventId.toString(), status: "published", hostUserId: hostId.toString() },
  ], anonymousUserId.toString());
  const summary = summaries.get(eventId.toString());

  assert.equal(summary?.going, 2);
  assert.deepEqual(summary?.avatars, [{
    userId: anonymousUserId.toString(),
    name: "Hidden User",
    avatarKey: "hidden.png",
  }]);
});

test("public going summary shows anonymous attendee real preview avatar to the event host", async () => {
  const anonymousUserId = new Types.ObjectId();
  const anonymousOrder = createOrder({ userId: anonymousUserId, anonymous: true });
  const service = await createSummaryService({
    orders: [anonymousOrder],
    users: [createUser(anonymousUserId, "Hidden User", "hidden.png")],
  });
  const summaries = await service.getPublicEventGoingSummaries([
    { id: eventId.toString(), status: "published", hostUserId: hostId.toString() },
  ], hostId.toString());
  const summary = summaries.get(eventId.toString());

  assert.equal(summary?.going, 1);
  assert.deepEqual(summary?.avatars, [{
    userId: anonymousUserId.toString(),
    name: "Hidden User",
    avatarKey: "hidden.png",
  }]);
});

test("public going summary masks anonymous and preserves normal preview per viewer", async () => {
  const anonymousUserId = new Types.ObjectId();
  const normalUserId = new Types.ObjectId();
  const viewerId = new Types.ObjectId();
  const service = await createSummaryService({
    orders: [
      createOrder({ userId: anonymousUserId, anonymous: true }),
      createOrder({ userId: normalUserId }),
    ],
    users: [
      createUser(anonymousUserId, "Hidden User", "hidden.png"),
      createUser(normalUserId, "Visible User", "visible.png"),
    ],
  });
  const otherViewerSummaries = await service.getPublicEventGoingSummaries([
    { id: eventId.toString(), status: "published", hostUserId: hostId.toString() },
  ], viewerId.toString());
  const selfSummaries = await service.getPublicEventGoingSummaries([
    { id: eventId.toString(), status: "published", hostUserId: hostId.toString() },
  ], anonymousUserId.toString());
  const otherViewerSummary = otherViewerSummaries.get(eventId.toString());
  const selfSummary = selfSummaries.get(eventId.toString());

  assert.equal(otherViewerSummary?.going, 2);
  assert.equal(otherViewerSummary?.avatars[0]?.name, "Anonymous");
  assert.equal(otherViewerSummary?.avatars[0]?.anonymous, true);
  assert.equal(otherViewerSummary?.avatars[0]?.avatarKey, undefined);
  assert.deepEqual(otherViewerSummary?.avatars[1], {
    userId: normalUserId.toString(),
    name: "Visible User",
    avatarKey: "visible.png",
  });
  assert.deepEqual(selfSummary?.avatars[0], {
    userId: anonymousUserId.toString(),
    name: "Hidden User",
    avatarKey: "hidden.png",
  });
  assert.deepEqual(selfSummary?.avatars[1], {
    userId: normalUserId.toString(),
    name: "Visible User",
    avatarKey: "visible.png",
  });
});

test("public going list masks anonymous attendees for other viewers while preserving normal rows and totals", async () => {
  const normalUserId = new Types.ObjectId();
  const anonymousUserId = new Types.ObjectId();
  const viewerId = new Types.ObjectId();
  const normalOrder = createOrder({ userId: normalUserId });
  const anonymousOrder = createOrder({ userId: anonymousUserId, anonymous: true });
  const service = await createSummaryService({
    orders: [normalOrder, anonymousOrder],
    users: [
      createUser(normalUserId, "Visible User", "visible.png"),
      createUser(anonymousUserId, "Hidden User", "hidden.png"),
    ],
    followingIds: [normalUserId.toString(), anonymousUserId.toString()],
  });
  const result = await service.getPublicEventGoingItems({ ...host, id: viewerId.toString() } as never, eventId.toString(), {
    page: 1,
    limit: 30,
  });
  const normal = result.tickets.find((item) => item.attendee?.id === normalUserId.toString());
  const anonymous = result.tickets.find((item) => item.attendee?.anonymous === true);

  assert.equal(result.pagination?.total, 2);
  assert.equal(result.tickets.length, 2);
  assert.equal(normal?.ticketCount, 1);
  assert.equal(anonymous?.ticketCount, 1);
  assert.equal(normal?.attendee?.name, "Visible User");
  assert.equal(normal?.attendee?.username, "visible user");
  assert.equal(normal?.attendee?.avatarKey, "visible.png");
  assert.equal(normal?.attendee?.isFollowing, true);
  assert.equal(anonymous?.attendee?.name, "Anonymous");
  assert.notEqual(anonymous?.attendee?.id, anonymousUserId.toString());
  assert.equal(anonymous?.attendee?.username, undefined);
  assert.equal(anonymous?.attendee?.avatarKey, undefined);
  assert.equal(anonymous?.attendee?.isFollowing, undefined);
});

test("public going list keeps different anonymous holders separate after masking", async () => {
  const anonymousAId = new Types.ObjectId();
  const anonymousBId = new Types.ObjectId();
  const viewerId = new Types.ObjectId();
  const orderA = createOrder({ userId: anonymousAId, anonymous: true });
  const orderB = createOrder({ userId: anonymousBId, anonymous: true });
  const service = await createSummaryService({
    orders: [orderA, orderB],
    users: [createUser(anonymousAId, "Hidden A"), createUser(anonymousBId, "Hidden B")],
  });
  const result = await service.getPublicEventGoingItems({ ...host, id: viewerId.toString() } as never, eventId.toString(), {
    page: 1,
    limit: 30,
  });

  assert.equal(result.tickets.length, 2);
  assert.ok(result.tickets.every((item) => item.attendee?.name === "Anonymous"));
  assert.ok(result.tickets.every((item) => item.attendee?.anonymous === true));
  assert.notEqual(result.tickets[0]?.attendee?.id, anonymousAId.toString());
  assert.notEqual(result.tickets[1]?.attendee?.id, anonymousBId.toString());
  assert.notEqual(result.tickets[0]?.attendee?.id, result.tickets[1]?.attendee?.id);
  assert.ok(result.tickets.every((item) => item.ticketCount === 1));
});

test("anonymous buyer sees their own real identity in the public going list", async () => {
  const anonymousUserId = new Types.ObjectId();
  const order = createOrder({ quantity: 2, userId: anonymousUserId, anonymous: true });
  const service = await createSummaryService({
    orders: [order],
    users: [createUser(anonymousUserId, "Hidden User", "hidden.png")],
  });
  const result = await service.getPublicEventGoingItems({ ...host, id: anonymousUserId.toString() } as never, eventId.toString(), {
    page: 1,
    limit: 30,
  });

  assert.equal(result.tickets.length, 1);
  assert.equal(result.tickets[0]?.attendee?.id, anonymousUserId.toString());
  assert.equal(result.tickets[0]?.attendee?.name, "Hidden User");
  assert.equal(result.tickets[0]?.attendee?.username, "hidden user");
  assert.equal(result.tickets[0]?.attendee?.avatarKey, "hidden.png");
  assert.equal(result.tickets[0]?.attendee?.anonymous, undefined);
  assert.equal(result.tickets[0]?.ticketCount, 2);
});

test("event host sees anonymous buyer real identity in the public going list", async () => {
  const anonymousUserId = new Types.ObjectId();
  const order = createOrder({ userId: anonymousUserId, anonymous: true });
  const service = await createSummaryService({
    orders: [order],
    users: [createUser(anonymousUserId, "Hidden User", "hidden.png")],
  });
  const result = await service.getPublicEventGoingItems(host as never, eventId.toString(), {
    page: 1,
    limit: 30,
  });

  assert.equal(result.tickets.length, 1);
  assert.equal(result.tickets[0]?.attendee?.id, anonymousUserId.toString());
  assert.equal(result.tickets[0]?.attendee?.name, "Hidden User");
  assert.equal(result.tickets[0]?.attendee?.anonymous, undefined);
});

test("public going list groups current holders after sharing one of two passes", async () => {
  const ownerId = new Types.ObjectId();
  const recipientId = new Types.ObjectId();
  const order = createOrder({ quantity: 2, userId: ownerId });
  const service = await createSummaryService({
    orders: [order],
    shares: [activeShare(order, recipientId, 2)],
    users: [createUser(ownerId, "Owner"), createUser(recipientId, "Recipient")],
  });
  const result = await service.getPublicEventGoingItems(host as never, eventId.toString(), {
    page: 1,
    limit: 30,
  });

  assert.equal(result.tickets.length, 2);
  assert.deepEqual(result.tickets.map((item) => item.attendee?.id), [ownerId.toString(), recipientId.toString()]);
  assert.ok(result.tickets.every((item) => item.ticketCount === 1));
});

test("anonymous buyer sharing one of two passes masks only the retained buyer row for other viewers", async () => {
  const ownerId = new Types.ObjectId();
  const recipientId = new Types.ObjectId();
  const viewerId = new Types.ObjectId();
  const order = createOrder({ quantity: 2, userId: ownerId, anonymous: true });
  const service = await createSummaryService({
    orders: [order],
    shares: [activeShare(order, recipientId, 2)],
    users: [createUser(ownerId, "Owner"), createUser(recipientId, "Recipient")],
  });
  const result = await service.getPublicEventGoingItems({ ...host, id: viewerId.toString() } as never, eventId.toString(), {
    page: 1,
    limit: 30,
  });
  const anonymous = result.tickets.find((item) => item.attendee?.anonymous === true);
  const recipient = result.tickets.find((item) => item.attendee?.id === recipientId.toString());

  assert.equal(result.tickets.length, 2);
  assert.equal(anonymous?.attendee?.name, "Anonymous");
  assert.equal(anonymous?.ticketCount, 1);
  assert.equal(recipient?.attendee?.name, "Recipient");
  assert.equal(recipient?.ticketCount, 1);
});

test("anonymous buyer sharing one of two passes sees their own retained row", async () => {
  const ownerId = new Types.ObjectId();
  const recipientId = new Types.ObjectId();
  const order = createOrder({ quantity: 2, userId: ownerId, anonymous: true });
  const service = await createSummaryService({
    orders: [order],
    shares: [activeShare(order, recipientId, 2)],
    users: [createUser(ownerId, "Owner"), createUser(recipientId, "Recipient")],
  });
  const result = await service.getPublicEventGoingItems({ ...host, id: ownerId.toString() } as never, eventId.toString(), {
    page: 1,
    limit: 30,
  });

  assert.equal(result.tickets.length, 2);
  assert.deepEqual(result.tickets.map((item) => item.attendee?.id), [ownerId.toString(), recipientId.toString()]);
  assert.ok(result.tickets.every((item) => item.attendee?.anonymous !== true));
});

test("mutual attendee identity signals exclude anonymous public passes", async () => {
  const normalUserId = new Types.ObjectId();
  const anonymousUserId = new Types.ObjectId();
  const normalOrder = createOrder({ userId: normalUserId });
  const anonymousOrder = createOrder({ userId: anonymousUserId, anonymous: true });
  const service = await createSummaryService({
    orders: [normalOrder, anonymousOrder],
  });
  const result = await service.getMutualAttendeeIdsByEventIds([
    { id: eventId.toString(), status: "published" },
  ], [
    normalUserId.toString(),
    anonymousUserId.toString(),
  ]);

  assert.deepEqual([...(result.get(eventId.toString()) ?? [])], [normalUserId.toString()]);
});

test("host ticket stat items keep real identity for anonymous orders", async () => {
  const anonymousUserId = new Types.ObjectId();
  const order = createOrder({ userId: anonymousUserId, anonymous: true });
  const service = await createSummaryService({
    orders: [order],
    users: [createUser(anonymousUserId, "Hidden User", "hidden.png")],
  });
  const result = await service.getEventTicketStatItems(host as never, eventId.toString(), { status: "going" });

  assert.equal(result.tickets.length, 1);
  assert.equal(result.tickets[0]?.attendee?.id, anonymousUserId.toString());
  assert.equal(result.tickets[0]?.attendee?.name, "Hidden User");
  assert.equal(result.tickets[0]?.attendee?.username, "hidden user");
  assert.equal(result.tickets[0]?.attendee?.avatarKey, "hidden.png");
  assert.equal(result.tickets[0]?.attendee?.anonymous, undefined);
});
