import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const now = new Date("2026-07-08T12:00:00.000Z");
const viewerId = new Types.ObjectId();
const hostId = new Types.ObjectId();
const ownerId = new Types.ObjectId();

const makeEvent = (name: string) => {
  const eventId = new Types.ObjectId();
  const ticketId = `ticket-${eventId.toString()}`;

  return {
    event: {
      _id: eventId,
      userId: hostId,
      status: "published",
      name,
      bannerImageKey: "events/banner.jpg",
      bannerOriginalImageKey: "events/banner-original.jpg",
      category: "Food & Drinks",
      categories: ["Food & Drinks", "Food Trucks", "Social Meetups"],
      scheduledAt: now,
      endAt: new Date("2026-07-09T12:00:00.000Z"),
      location: { venue: "Test Venue", address: "Test Address" },
      tickets: [{ id: ticketId, name: "Standard", type: "pay", price: 20, capacity: 100 }],
      rewards: [],
    },
    ticketId,
  };
};

const makeLineItem = (eventId: string, ticketId: string, quantity = 1) => ({
  itemType: "ticket" as const,
  itemId: ticketId,
  eventId,
  name: "Standard",
  quantity,
  paidQuantity: quantity,
  freeQuantity: 0,
  totalQuantity: quantity,
  unitAmount: 20,
  totalAmount: quantity * 20,
});

const makeOrder = (
  orderId: Types.ObjectId,
  userId: Types.ObjectId,
  eventTickets: Array<{ eventId: string; ticketId: string; quantity?: number }>,
) => ({
  _id: orderId,
  userId,
  kind: "ticket",
  paymentStatus: "paid",
  currency: "usd",
  paidAt: now,
  createdAt: now,
  lineItems: eventTickets.map(({ eventId, ticketId, quantity }) => makeLineItem(eventId, ticketId, quantity ?? 1)),
  ticketPasses: eventTickets.flatMap(({ eventId, ticketId, quantity = 1 }, eventIndex) =>
    Array.from({ length: quantity }, (_, passIndex) => ({
      eventId,
      ticketId,
      ticketIndex: passIndex + 1,
      checkInCode: `MOM-26-TEST-${String(eventIndex + 1).padStart(2, "0")}-${String(passIndex + 1).padStart(2, "0")}`,
    })),
  ),
});

type WalletFixtureOptions = {
  followedHostIds?: string[];
  ownedEventCount?: number;
  ownedTicketQuantity?: number;
  includeSharedTicket?: boolean;
};

const createWalletFixture = async ({
  followedHostIds = [],
  ownedEventCount = 1,
  ownedTicketQuantity = 1,
  includeSharedTicket = false,
}: WalletFixtureOptions = {}) => {
  const { CheckoutPaymentService } = await import("../src/modules/payments/checkout-payment.service.js");
  const ownedEvents = Array.from({ length: ownedEventCount }, (_, index) => makeEvent(`Owned Event ${index + 1}`));
  const sharedEvent = includeSharedTicket ? makeEvent("Shared Event") : null;
  const ownedOrderId = new Types.ObjectId();
  const sharedOrderId = new Types.ObjectId();
  const ownedOrder = makeOrder(
    ownedOrderId,
    viewerId,
    ownedEvents.map(({ event, ticketId }) => ({
      eventId: event._id.toString(),
      ticketId,
      quantity: ownedTicketQuantity,
    })),
  );
  const sharedOrder = sharedEvent
    ? makeOrder(sharedOrderId, ownerId, [{ eventId: sharedEvent.event._id.toString(), ticketId: sharedEvent.ticketId }])
    : null;
  const receivedShares = sharedEvent
    ? [{
        _id: new Types.ObjectId(),
        ownerUserId: ownerId,
        recipientUserId: viewerId,
        orderId: sharedOrderId,
        eventId: sharedEvent.event._id.toString(),
        ticketId: sharedEvent.ticketId,
        ticketIndex: 1,
        status: "active",
        sharedAt: now,
        createdAt: now,
        updatedAt: now,
      }]
    : [];
  const events = [...ownedEvents.map(({ event }) => event), ...(sharedEvent ? [sharedEvent.event] : [])];
  let followingLookupCount = 0;

  const repository = {
    findTicketWalletOrdersByUserId: async () => ownedEventCount > 0 ? [ownedOrder] : [],
    findByIds: async () => sharedOrder ? [sharedOrder] : [],
    findIssuedTicketOrdersByEventIds: async (ids: string[]) =>
      [ownedOrder, sharedOrder]
        .filter((order): order is ReturnType<typeof makeOrder> => Boolean(order))
        .filter((order) => order.lineItems.some((item) => item.eventId && ids.includes(item.eventId))),
  };
  const eventRepository = {
    findManyByIds: async () => events,
  };
  const userRepository = {
    findMany: async () => [
      { _id: viewerId, name: "Wallet Viewer", username: "wallet_viewer", avatarKey: "users/viewer.jpg" },
      { _id: hostId, name: "Event Host", username: "event_host", avatarKey: "users/host.jpg" },
      { _id: ownerId, name: "Ticket Owner", username: "ticket_owner", avatarKey: null },
    ],
    findByIds: async (ids: string[]) => [
      { _id: viewerId, name: "Wallet Viewer", username: "wallet_viewer", avatarKey: "users/viewer.jpg" },
      { _id: hostId, name: "Event Host", username: "event_host", avatarKey: "users/host.jpg" },
      { _id: ownerId, name: "Ticket Owner", username: "ticket_owner", avatarKey: null },
    ].filter((user) => ids.includes(user._id.toString())),
  };
  const userFollowRepository = {
    findFollowingIds: async (followerId: string) => {
      followingLookupCount += 1;
      assert.equal(followerId, viewerId.toString());
      return followedHostIds;
    },
  };
  const ticketShareRepository = {
    findActiveByOwnerId: async () => [],
    findActiveByRecipientId: async () => receivedShares,
    findActiveByEventIds: async (ids: string[]) => receivedShares.filter((share) => ids.includes(share.eventId)),
  };
  const ticketUsageRepository = {
    findByEventIdsAndOrderIds: async () => [],
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
    {} as never,
    { findRefundItemsByOrderIds: async () => [] } as never,
  );

  return {
    service,
    followingLookupCount: () => followingLookupCount,
  };
};

test("owned wallet events include followed host state with one batched relationship lookup", async () => {
  const fixture = await createWalletFixture({
    followedHostIds: [hostId.toString()],
    ownedEventCount: 2,
  });
  const wallet = await fixture.service.getMyTicketWallet({ id: viewerId.toString() } as never);

  assert.equal(wallet.length, 2);
  assert.equal(fixture.followingLookupCount(), 1);
  assert.ok(wallet.every((item) => item.source === "owned"));
  assert.ok(wallet.every((item) => item.event.host?.isFollowing === true));
  assert.ok(wallet.every((item) => item.event.host?.id === hostId.toString()));
  assert.ok(wallet.every((item) => item.event.bannerImageKey === "events/banner.jpg"));
  assert.ok(wallet.every((item) => item.ticketName === "Standard"));
  assert.ok(wallet.every((item) => item.ticketPasses.length === 1));
});

test("owned wallet event includes canonical categories and public going summary for profile cards", async () => {
  const fixture = await createWalletFixture({
    ownedEventCount: 1,
    ownedTicketQuantity: 2,
  });
  const [walletItem] = await fixture.service.getMyTicketWallet({ id: viewerId.toString() } as never);

  assert.deepEqual(walletItem?.event.categories, ["Food & Drinks", "Food Trucks", "Social Meetups"]);
  assert.equal(walletItem?.event.category, "Food & Drinks");
  assert.equal(walletItem?.event.publicGoingSummary?.going, 2);
  assert.deepEqual(walletItem?.event.publicGoingSummary?.avatars, [{
    userId: viewerId.toString(),
    name: "Wallet Viewer",
    avatarKey: "users/viewer.jpg",
  }]);
});

test("owned wallet events include false when the viewer does not follow the host", async () => {
  const fixture = await createWalletFixture({ followedHostIds: [] });
  const [walletItem] = await fixture.service.getMyTicketWallet({ id: viewerId.toString() } as never);

  assert.equal(fixture.followingLookupCount(), 1);
  assert.equal(walletItem?.event.host?.isFollowing, false);
});

test("shared-ticket wallet events include the viewer relationship to the event host", async () => {
  const fixture = await createWalletFixture({
    followedHostIds: [hostId.toString()],
    ownedEventCount: 0,
    includeSharedTicket: true,
  });
  const [walletItem] = await fixture.service.getMyTicketWallet({ id: viewerId.toString() } as never);

  assert.equal(fixture.followingLookupCount(), 1);
  assert.equal(walletItem?.source, "shared");
  assert.equal(walletItem?.event.host?.isFollowing, true);
  assert.equal(walletItem?.sharedBy?.id, ownerId.toString());
  assert.equal(walletItem?.event.name, "Shared Event");
  assert.equal(walletItem?.paymentStatus, "paid");
});

test("shared-ticket wallet event uses active recipient in public going summary", async () => {
  const fixture = await createWalletFixture({
    ownedEventCount: 0,
    includeSharedTicket: true,
  });
  const [walletItem] = await fixture.service.getMyTicketWallet({ id: viewerId.toString() } as never);

  assert.deepEqual(walletItem?.event.categories, ["Food & Drinks", "Food Trucks", "Social Meetups"]);
  assert.equal(walletItem?.event.publicGoingSummary?.going, 1);
  assert.deepEqual(walletItem?.event.publicGoingSummary?.avatars, [{
    userId: viewerId.toString(),
    name: "Wallet Viewer",
    avatarKey: "users/viewer.jpg",
  }]);
});
