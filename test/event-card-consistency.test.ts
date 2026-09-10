import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { EventService } from "../src/modules/events/event.service.js";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

// Event Card / Event Detail / Checkout data-consistency fixes:
//  - listMapEvents now carries publicGoingSummary (same source as Feed/Detail),
//    not a hardcoded 0 attendee count.
//  - every event response ticket carries a server-derived `salesEnded` flag
//    (Boolean(salesEndAt && salesEndAt <= serverNow)) — the exact rule
//    CheckoutPaymentService.resolveLineItems enforces — so surfaces stop
//    gating on the device clock. salesEndAt itself is untouched.

const SERVER_NOW = new Date("2026-06-15T12:00:00.000Z");
const hostId = new Types.ObjectId();
const eventId = new Types.ObjectId();

const host = { _id: hostId, name: "Host", username: "host", email: "host@example.com", avatarKey: null, bio: null };

const baseEvent = {
  _id: eventId,
  userId: hostId,
  status: "published",
  name: "Consistency Event",
  description: "desc",
  bannerImageKey: null,
  bannerOriginalImageKey: null,
  bannerImageDisplay: null,
  ageRestriction: "all_ages",
  category: "Live Music & Concerts",
  categories: ["Live Music & Concerts"],
  scheduledAt: new Date("2026-06-20T00:00:00.000Z"),
  endAt: new Date("2026-06-20T03:00:00.000Z"),
  location: { latitude: 40, longitude: -73, venue: "Venue", address: "Addr", searchLabel: "Venue", additionalInfo: null },
  tickets: [
    // sales already closed relative to SERVER_NOW
    { id: "past", name: "Early Bird", description: null, type: "free", price: 0, capacity: 10, availableCount: 5, salesEndAt: new Date("2026-06-01T00:00:00.000Z") },
    // sales still open
    { id: "future", name: "General", description: null, type: "pay", price: 20, capacity: 100, availableCount: 40, salesEndAt: new Date("2026-06-19T00:00:00.000Z") },
    // no explicit deadline
    { id: "none", name: "Door", description: null, type: "pay", price: 25, capacity: 50, availableCount: 50, salesEndAt: null },
  ],
  rewards: [],
  memberUserIds: [],
  joinRequests: [],
  publishedAt: new Date("2026-05-01T00:00:00.000Z"),
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
  createdAt: new Date("2026-05-01T00:00:00.000Z"),
  updatedAt: new Date("2026-05-01T00:00:00.000Z"),
};

const createService = (goingByEventId: Record<string, number> = {}) => {
  const eventRepository = {
    findMapEvents: async () => ({ events: [baseEvent], hasMore: false }),
    findPrivateMapEventsForUser: async () => ({ events: [], hasMore: false }),
    findPublicFeedEvents: async () => [baseEvent],
    findPrivateFeedEventsForUser: async () => [],
    findById: async () => baseEvent,
  };
  const userRepository = { findMany: async () => [host], findById: async () => host };
  const userFollowRepository = {
    findFollowingIds: async () => [],
    findMutualFriendIds: async () => [],
    isFollowing: async () => false,
  };
  const userBlockRepository = { findBlockedIds: async () => [], findBlockerIds: async () => [] };
  const momentRepository = {
    ensureEventAnnouncement: async (p: { eventId: string }) => ({ _id: new Types.ObjectId(), eventId: p.eventId }),
  };
  const countRepository = {
    countByMomentIds: async () => new Map(),
    findReposterUserIdsByMomentIds: async () => new Map<string, string[]>(),
  };
  const momentReactionRepository = {
    countByMomentIds: async () => new Map(),
    findLikedMomentIds: async () => new Set<string>(),
    findLikedUserIdsByMomentIds: async () => new Map<string, string[]>(),
  };
  const momentSaveRepository = { findSavedMomentIds: async () => new Set<string>() };
  const checkoutPaymentService = {
    getPublicEventGoingSummaries: async (refs: { id: string }[]) =>
      new Map(refs.map((ref) => [ref.id, { going: goingByEventId[ref.id] ?? 0, avatars: [] }])),
    getMutualAttendeeIdsByEventIds: async () => new Map<string, Set<string>>(),
  };
  const crowdStatusService = {
    getCrowdStatusByEventId: async () => new Map(),
    getCheckedInCountsByEventId: async () => new Map(),
  };
  const noop = {};

  return new EventService(
    eventRepository as never,
    userRepository as never,
    userFollowRepository as never,
    noop as never,
    noop as never,
    noop as never,
    noop as never,
    checkoutPaymentService as never,
    noop as never,
    noop as never,
    noop as never,
    userBlockRepository as never,
    noop as never,
    noop as never,
    momentRepository as never,
    momentReactionRepository as never,
    countRepository as never,
    noop as never,
    countRepository as never,
    momentSaveRepository as never,
    noop as never, // ticketUsageRepository
    noop as never, // eventHostReviewRepository
    noop as never, // eventWindowRepository
    crowdStatusService as never, // crowdStatusService
    () => SERVER_NOW, // getServerNow
    undefined, // eventCancellationRefundService
    { findReportedTargetIds: async () => new Set<string>(), hasReported: async () => false } as never,
  );
};

const user = { id: new Types.ObjectId().toString() } as never;

test("B — listMapEvents attaches publicGoingSummary from the same source as Feed/Detail", async () => {
  const service = createService({ [eventId.toString()]: 7 });
  const { events } = await service.listMapEvents(user, {} as never);
  const mapEvent = events.find((event) => event.id === eventId.toString());

  assert.ok(mapEvent);
  assert.deepEqual(mapEvent.publicGoingSummary, { going: 7, avatars: [] });
  // checkedInCount stays its own separate field (0 here) — never conflated.
  assert.equal(mapEvent.checkedInCount, 0);
});

test("B — a map event with no paid passes reports going 0 (not undefined)", async () => {
  const service = createService();
  const { events } = await service.listMapEvents(user, {} as never);

  assert.deepEqual(events[0]?.publicGoingSummary, { going: 0, avatars: [] });
});

test("F/I — response tickets carry server-derived salesEnded; salesEndAt is unchanged", async () => {
  const service = createService();
  const { events } = await service.listMapEvents(user, {} as never);
  const tickets = events[0]!.tickets;
  const byId = Object.fromEntries(tickets.map((ticket) => [ticket.id, ticket]));

  // past deadline (relative to injected SERVER_NOW) -> ended
  assert.equal(byId.past.salesEnded, true);
  // future deadline -> not ended
  assert.equal(byId.future.salesEnded, false);
  // null deadline -> no explicit deadline -> not ended
  assert.equal(byId.none.salesEnded, false);

  // salesEndAt itself is passed through untouched (not mutated / not derived).
  assert.equal(new Date(byId.past.salesEndAt as Date).toISOString(), "2026-06-01T00:00:00.000Z");
  assert.equal(byId.none.salesEndAt ?? null, null);
  // availableCount / capacity are untouched.
  assert.equal(byId.future.availableCount, 40);
  assert.equal(byId.future.capacity, 100);
});
