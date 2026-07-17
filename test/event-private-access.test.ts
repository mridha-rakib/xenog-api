import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { EventService } from "../src/modules/events/event.service.js";
import { CheckoutPaymentService } from "../src/modules/payments/checkout-payment.service.js";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const now = new Date();
const hostId = new Types.ObjectId();
const memberId = new Types.ObjectId();
const nonMemberId = new Types.ObjectId();
const publicEventId = new Types.ObjectId();
const privateEventId = new Types.ObjectId();
const ticketId = "private-general";

const host = {
  _id: hostId,
  name: "Host",
  username: "host",
  email: "host@example.com",
  avatarKey: null,
  bio: null,
};

const member = {
  id: memberId.toString(),
  name: "Member",
  username: "member",
  email: "member@example.com",
  role: "user",
  accountType: "personal",
  currentLocationSharingEnabled: false,
  notificationsEnabled: true,
  isActive: true,
  emailVerified: true,
  createdAt: now,
  updatedAt: now,
};

const nonMember = {
  ...member,
  id: nonMemberId.toString(),
  name: "Non Member",
  username: "nonmember",
  email: "nonmember@example.com",
};

const createEvent = (overrides: Record<string, unknown> = {}) => ({
  _id: overrides._id ?? publicEventId,
  userId: hostId,
  status: "published",
  name: "Visible Event",
  description: "Event description",
  bannerImageKey: null,
  bannerOriginalImageKey: null,
  bannerImageDisplay: null,
  ageRestriction: "all_ages",
  category: "Music",
  categories: ["Music"],
  scheduledAt: new Date(now.getTime() + 60 * 60 * 1000),
  endAt: new Date(now.getTime() + 3 * 60 * 60 * 1000),
  location: {
    latitude: 40,
    longitude: -73,
    venue: "Venue",
    address: "Address",
    searchLabel: "Venue",
    additionalInfo: null,
  },
  tickets: [],
  rewards: [],
  privacy: "public",
  memberUserIds: [],
  joinRequests: [],
  publishedAt: now,
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const publicEvent = createEvent({ _id: publicEventId, name: "Public Event" });
const privateEvent = createEvent({
  _id: privateEventId,
  name: "Private Event",
  privacy: "private",
  memberUserIds: [memberId],
  tickets: [{
    id: ticketId,
    name: "General",
    description: null,
    type: "free",
    price: 0,
    capacity: 10,
    availableCount: 10,
    salesEndAt: null,
  }],
});

const createEventService = (privateEventsForUser: Record<string, unknown[]> = {}) => {
  const eventRepository = {
    findPublicFeedEvents: async () => [publicEvent],
    findPrivateFeedEventsForUser: async (userId: string) => privateEventsForUser[userId] ?? [],
    findMapEvents: async () => [publicEvent],
    findPrivateMapEventsForUser: async (userId: string) => privateEventsForUser[userId] ?? [],
    findById: async (eventId: string) => eventId === privateEventId.toString() ? privateEvent : null,
  };
  const userRepository = {
    findMany: async () => [host],
    findById: async () => host,
  };
  const userFollowRepository = {
    findFollowingIds: async () => [],
    isFollowing: async () => false,
  };
  const userBlockRepository = {
    findBlockedIds: async () => [],
  };
  const momentRepository = {
    ensureEventAnnouncement: async (payload: { eventId: string }) => ({
      _id: new Types.ObjectId(),
      eventId: payload.eventId,
    }),
  };
  const countRepository = {
    countByMomentIds: async () => new Map(),
  };
  const momentReactionRepository = {
    countByMomentIds: async () => new Map(),
    findLikedMomentIds: async () => new Set<string>(),
  };
  const momentSaveRepository = {
    findSavedMomentIds: async () => new Set<string>(),
  };
  const checkoutPaymentService = {
    getPublicEventGoingSummaries: async () => new Map(),
  };
  const noopRepository = {};

  return new EventService(
    eventRepository as never,
    userRepository as never,
    userFollowRepository as never,
    noopRepository as never,
    noopRepository as never,
    noopRepository as never,
    noopRepository as never,
    checkoutPaymentService as never,
    noopRepository as never,
    noopRepository as never,
    noopRepository as never,
    userBlockRepository as never,
    noopRepository as never,
    noopRepository as never,
    momentRepository as never,
    momentReactionRepository as never,
    countRepository as never,
    noopRepository as never,
    countRepository as never,
    momentSaveRepository as never,
    noopRepository as never,
    noopRepository as never,
  );
};

test("private event appears in feed and map only for added private members", async () => {
  const service = createEventService({
    [member.id]: [privateEvent],
    [nonMember.id]: [],
  });

  const memberFeed = await service.listFeedEvents(member as never, {});
  const nonMemberFeed = await service.listFeedEvents(nonMember as never, {});
  const memberMap = await service.listMapEvents(member as never, {});
  const nonMemberMap = await service.listMapEvents(nonMember as never, {});

  assert.ok(memberFeed.some((event) => event.id === privateEventId.toString()));
  assert.ok(memberMap.some((event) => event.id === privateEventId.toString()));
  assert.equal(nonMemberFeed.some((event) => event.id === privateEventId.toString()), false);
  assert.equal(nonMemberMap.some((event) => event.id === privateEventId.toString()), false);
});

test("private event details are blocked for non-members", async () => {
  const service = createEventService();

  await assert.rejects(
    () => service.getEventById(nonMember as never, privateEventId.toString()),
    { statusCode: 404 },
  );
});

const createCheckoutService = () => {
  const eventRepository = {
    findById: async () => privateEvent,
  };

  return new CheckoutPaymentService(
    {} as never,
    eventRepository as never,
  );
};

test("private event ticket purchase is blocked for non-members and allowed for added members", async () => {
  const service = createCheckoutService() as unknown as {
    resolveLineItems: (user: typeof member, payload: Record<string, unknown>) => Promise<Array<{ eventId?: string | null }>>;
  };
  const payload = {
    kind: "ticket",
    paymentMethod: "card",
    eventId: privateEventId.toString(),
    ticketId,
    quantity: 1,
    acceptedTerms: true,
  };

  await assert.rejects(
    () => service.resolveLineItems(nonMember, payload),
    { statusCode: 403 },
  );

  const lineItems = await service.resolveLineItems(member, payload);

  assert.equal(lineItems[0]?.eventId, privateEventId.toString());
});
