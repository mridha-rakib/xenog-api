import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

test.afterEach(async () => {
  const { RedisClient } = await import("../src/config/redis.js");
  await RedisClient.disconnect().catch(() => undefined);
});

// Covers the fix for: the same canonical Event ("Neon Vibes Night" in the
// audited report) showing correct reaction/comment/share counts on the Main
// Feed and Event Details (already correct, untouched by this fix) but
// 0/0/0 on Own Timeline (Ticket Wallet) and Profile Hosted Events, because
// those two endpoints never enriched their EventResponse with the canonical
// Event -> Interaction Moment summary that Feed/Details already compute.
//
// This file tests the new EventInteractionSummaryService directly, and its
// two new call sites: EventService.listProfileEventsByUserId (Profile
// Hosted Events) and CheckoutPaymentService.getMyTicketWallet (Ticket
// Wallet / Own Timeline). It does not touch listFeedEvents or getEventById —
// those were audited as already correct and are deliberately left alone;
// their existing regression coverage (test/event-moments.test.ts) is
// unaffected, see that file for the untouched-getEventById proof.

const now = new Date("2026-08-18T12:00:00.000Z");

// ── EventInteractionSummaryService: direct unit coverage ──────────────────

test("EventInteractionSummaryService.buildForEvents resolves each event's interaction moment and aggregates counts/viewer state from it", async () => {
  const { EventInteractionSummaryService } = await import("../src/modules/events/event-interaction-summary.js");

  const eventAId = new Types.ObjectId().toString();
  const eventBId = new Types.ObjectId().toString();
  const momentAId = new Types.ObjectId().toString();
  const momentBId = new Types.ObjectId().toString();
  const viewerId = new Types.ObjectId().toString();
  const hostId = new Types.ObjectId().toString();

  const ensuredPayloads: Array<{ eventId: string; userId: string; eventTitle?: string | null; caption?: string | null }> = [];
  const momentRepository = {
    ensureEventAnnouncement: async (payload: { eventId: string; userId: string; eventTitle?: string | null; caption?: string | null }) => {
      ensuredPayloads.push(payload);
      return { _id: payload.eventId === eventAId ? momentAId : momentBId } as never;
    },
  };
  const momentReactionRepository = {
    countByMomentIds: async () => new Map([[momentAId, 1], [momentBId, 4]]),
    findLikedMomentIds: async (viewer: string) => (viewer === viewerId ? new Set([momentAId]) : new Set<string>()),
  };
  const momentCommentRepository = {
    countByMomentIds: async () => new Map([[momentAId, 1]]),
  };
  const momentShareRepository = {
    // Non-zero share count case — the audit explicitly warned not to skip
    // this because the reported sample event happened to have 0 shares.
    countByMomentIds: async () => new Map([[momentBId, 3]]),
  };
  const momentSaveRepository = {
    findSavedMomentIds: async () => new Set<string>(),
  };

  const service = new EventInteractionSummaryService(
    momentRepository as never,
    momentReactionRepository as never,
    momentCommentRepository as never,
    momentShareRepository as never,
    momentSaveRepository as never,
  );

  const summaries = await service.buildForEvents(
    [
      { id: eventAId, userId: hostId, name: "Neon Vibes Night", description: "desc a" },
      { id: eventBId, userId: hostId, name: "Second Event", description: "desc b" },
    ],
    viewerId,
  );

  assert.deepEqual(ensuredPayloads, [
    { eventId: eventAId, userId: hostId, eventTitle: "Neon Vibes Night", caption: "desc a" },
    { eventId: eventBId, userId: hostId, eventTitle: "Second Event", caption: "desc b" },
  ]);

  const summaryA = summaries.get(eventAId);
  assert.equal(summaryA?.interactionMomentId, momentAId);
  assert.equal(summaryA?.likesCount, 1);
  assert.equal(summaryA?.commentsCount, 1);
  assert.equal(summaryA?.sharesCount, 0);
  assert.equal(summaryA?.isLiked, true);

  const summaryB = summaries.get(eventBId);
  assert.equal(summaryB?.likesCount, 4);
  assert.equal(summaryB?.commentsCount, 0);
  assert.equal(summaryB?.sharesCount, 3, "non-zero share count must pass through, not just the common zero case");
  assert.equal(summaryB?.isLiked, false);
});

test("EventInteractionSummaryService.buildForEvents isLiked is viewer-specific while counts stay identical across viewers", async () => {
  const { EventInteractionSummaryService } = await import("../src/modules/events/event-interaction-summary.js");
  const eventId = new Types.ObjectId().toString();
  const momentId = new Types.ObjectId().toString();
  const hostId = new Types.ObjectId().toString();
  const viewerA = new Types.ObjectId().toString();
  const viewerB = new Types.ObjectId().toString();

  const service = new EventInteractionSummaryService(
    { ensureEventAnnouncement: async () => ({ _id: momentId }) } as never,
    {
      countByMomentIds: async () => new Map([[momentId, 5]]),
      findLikedMomentIds: async (viewer: string) => (viewer === viewerA ? new Set([momentId]) : new Set<string>()),
    } as never,
    { countByMomentIds: async () => new Map([[momentId, 2]]) } as never,
    { countByMomentIds: async () => new Map([[momentId, 0]]) } as never,
    { findSavedMomentIds: async () => new Set<string>() } as never,
  );

  const [forViewerA, forViewerB] = await Promise.all([
    service.buildForEvents([{ id: eventId, userId: hostId }], viewerA),
    service.buildForEvents([{ id: eventId, userId: hostId }], viewerB),
  ]);

  assert.equal(forViewerA.get(eventId)?.isLiked, true);
  assert.equal(forViewerB.get(eventId)?.isLiked, false);
  assert.equal(forViewerA.get(eventId)?.likesCount, forViewerB.get(eventId)?.likesCount);
  assert.equal(forViewerA.get(eventId)?.likesCount, 5);
});

test("EventInteractionSummaryService.buildForEvents short-circuits on an empty event list without touching any repository", async () => {
  const { EventInteractionSummaryService } = await import("../src/modules/events/event-interaction-summary.js");
  let touched = false;
  const failIfCalled = () => {
    touched = true;
    throw new Error("should not be called for an empty event list");
  };

  const service = new EventInteractionSummaryService(
    { ensureEventAnnouncement: failIfCalled } as never,
    { countByMomentIds: failIfCalled, findLikedMomentIds: failIfCalled } as never,
    { countByMomentIds: failIfCalled } as never,
    { countByMomentIds: failIfCalled } as never,
    { findSavedMomentIds: failIfCalled } as never,
  );

  const summaries = await service.buildForEvents([]);

  assert.equal(summaries.size, 0);
  assert.equal(touched, false);
});

// ── EventService.listProfileEventsByUserId (Profile Hosted Events) ────────

test("listMyProfileEvents (Profile Hosted Events) enriches every event with the canonical interaction summary", async () => {
  const { EventService } = await import("../src/modules/events/event.service.js");
  const hostId = new Types.ObjectId().toString();
  const activeEventId = new Types.ObjectId().toString();
  const pastEventId = new Types.ObjectId().toString();
  const host = { _id: hostId, name: "K Mbappe", username: "mbappe_10" };
  const activeEvent = {
    _id: activeEventId,
    userId: hostId,
    status: "published",
    name: "Neon Vibes Night",
    description: null,
    categories: [],
    tickets: [],
    rewards: [],
    memberUserIds: [],
    privacy: "public",
    createdAt: now,
    updatedAt: now,
  };
  const pastEvent = { ...activeEvent, _id: pastEventId, name: "Past Show" };

  let capturedViewerId: string | undefined;
  const eventInteractionSummaryService = {
    buildForEvents: async (events: Array<{ id: string }>, viewerId?: string) => {
      capturedViewerId = viewerId;
      return new Map(
        events.map((event) => [
          event.id,
          {
            interactionMomentId: `moment-${event.id}`,
            likesCount: event.id === activeEventId ? 1 : 0,
            commentsCount: event.id === activeEventId ? 1 : 0,
            sharesCount: 0,
            isLiked: event.id === activeEventId,
            isSaved: false,
          },
        ]),
      );
    },
  };

  const eventRepository = {
    findPublishedProfileEventsByUserId: async () => ({ active: [activeEvent], past: [pastEvent] }),
  };

  const eventService = new EventService(
    eventRepository as never,
    { findById: async () => host } as never,
    { countFollowers: async () => 0, isFollowing: async () => false } as never,
    { createDownloadUrl: async () => ({ url: "" }) } as never,
    {} as never,
    {} as never,
    {} as never,
    { getPublicEventGoingSummaries: async () => new Map() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { ensureById: async () => undefined } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { getCrowdStatusByEventId: async () => new Map() } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    eventInteractionSummaryService as never,
  );

  const groups = await eventService.listMyProfileEvents({ id: hostId } as never);

  assert.equal(capturedViewerId, hostId, "the profile owner must be threaded through as the viewer for isLiked");
  assert.equal(groups.active[0]?.likesCount, 1);
  assert.equal(groups.active[0]?.commentsCount, 1);
  assert.equal(groups.active[0]?.isLiked, true);
  assert.equal(groups.active[0]?.interactionMomentId, `moment-${activeEventId}`);
  assert.equal(groups.past[0]?.likesCount, 0);
  assert.equal(groups.past[0]?.isLiked, false);
});

test("listProfileEventsForUser (viewing someone else's hosted events) passes the viewer's own id, not the profile owner's, for isLiked", async () => {
  const { EventService } = await import("../src/modules/events/event.service.js");
  const hostId = new Types.ObjectId().toString();
  const viewerId = new Types.ObjectId().toString();
  const eventId = new Types.ObjectId().toString();
  const host = { _id: hostId, name: "K Mbappe", username: "mbappe_10" };
  const hostedEvent = {
    _id: eventId,
    userId: hostId,
    status: "published",
    name: "Neon Vibes Night",
    description: null,
    categories: [],
    tickets: [],
    rewards: [],
    memberUserIds: [],
    privacy: "public",
    createdAt: now,
    updatedAt: now,
  };

  let capturedViewerId: string | undefined;
  const eventInteractionSummaryService = {
    buildForEvents: async (events: Array<{ id: string }>, viewerId?: string) => {
      capturedViewerId = viewerId;
      return new Map(events.map((event) => [event.id, {
        interactionMomentId: `moment-${event.id}`,
        likesCount: 1,
        commentsCount: 1,
        sharesCount: 0,
        isLiked: true,
        isSaved: false,
      }]));
    },
  };

  const eventService = new EventService(
    { findPublishedProfileEventsByUserId: async () => ({ active: [hostedEvent], past: [] }) } as never,
    { findById: async () => host } as never,
    {} as never,
    { createDownloadUrl: async () => ({ url: "" }) } as never,
    {} as never,
    {} as never,
    {} as never,
    { getPublicEventGoingSummaries: async () => new Map() } as never,
    {} as never,
    {} as never,
    {} as never,
    { isBlocked: async () => false } as never,
    {} as never,
    { ensureById: async () => undefined } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { getCrowdStatusByEventId: async () => new Map() } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    eventInteractionSummaryService as never,
  );

  await eventService.listProfileEventsForUser({ id: viewerId } as never, hostId);

  assert.equal(capturedViewerId, viewerId);
  assert.notEqual(capturedViewerId, hostId);
});

test("listMyProfileEvents with a filter query (paginated branch) also enriches events with the interaction summary", async () => {
  const { EventService } = await import("../src/modules/events/event.service.js");
  const hostId = new Types.ObjectId().toString();
  const eventId = new Types.ObjectId().toString();
  const host = { _id: hostId, name: "K Mbappe", username: "mbappe_10" };
  const hostedEvent = {
    _id: eventId,
    userId: hostId,
    status: "published",
    name: "Neon Vibes Night",
    description: null,
    categories: [],
    tickets: [],
    rewards: [],
    memberUserIds: [],
    privacy: "public",
    createdAt: now,
    updatedAt: now,
  };

  const eventInteractionSummaryService = {
    buildForEvents: async (events: Array<{ id: string }>) =>
      new Map(events.map((event) => [event.id, {
        interactionMomentId: `moment-${event.id}`,
        likesCount: 9,
        commentsCount: 6,
        sharesCount: 2,
        isLiked: false,
        isSaved: false,
      }])),
  };

  const eventService = new EventService(
    {
      findProfileEventsByUserId: async () => [hostedEvent],
      countProfileEventsByUserId: async () => 1,
    } as never,
    { findById: async () => host } as never,
    {} as never,
    { createDownloadUrl: async () => ({ url: "" }) } as never,
    {} as never,
    {} as never,
    {} as never,
    { getPublicEventGoingSummaries: async () => new Map() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { ensureById: async () => undefined } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { getCrowdStatusByEventId: async () => new Map() } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    eventInteractionSummaryService as never,
  );

  const groups = await eventService.listProfileEventsByUserId(hostId, true, { filter: "active" });

  assert.equal(groups.active[0]?.likesCount, 9);
  assert.equal(groups.active[0]?.commentsCount, 6);
  assert.equal(groups.active[0]?.sharesCount, 2);
});

// ── CheckoutPaymentService.getMyTicketWallet (Ticket Wallet / Own Timeline) ─

test("getMyTicketWallet (Own Timeline) carries the same interaction summary for an owned ticket's event, including a non-zero share count", async () => {
  const { CheckoutPaymentService } = await import("../src/modules/payments/checkout-payment.service.js");
  const viewerId = new Types.ObjectId().toString();
  const hostId = new Types.ObjectId().toString();
  const eventId = new Types.ObjectId();
  const orderId = new Types.ObjectId();
  const ticketId = "standard";

  const event = {
    _id: eventId,
    userId: hostId,
    status: "published",
    name: "Neon Vibes Night",
    categories: [],
    scheduledAt: now,
    endAt: new Date(now.getTime() + 3 * 60 * 60 * 1000),
    location: null,
    tickets: [{ id: ticketId, name: "Standard", type: "pay", price: 20, capacity: 100 }],
    rewards: [],
  };
  const order = {
    _id: orderId,
    userId: viewerId,
    kind: "ticket",
    paymentStatus: "paid",
    currency: "usd",
    paidAt: now,
    createdAt: now,
    lineItems: [{
      itemType: "ticket",
      itemId: ticketId,
      eventId: eventId.toString(),
      name: "Standard",
      quantity: 1,
      paidQuantity: 1,
      freeQuantity: 0,
      totalQuantity: 1,
      unitAmount: 20,
      totalAmount: 20,
    }],
    ticketPasses: [{ eventId: eventId.toString(), ticketId, ticketIndex: 1, checkInCode: "MOM-26-TEST-01" }],
  };

  let capturedViewerId: string | undefined;
  const eventInteractionSummaryService = {
    buildForEvents: async (events: Array<{ id: string }>, viewerId2?: string) => {
      capturedViewerId = viewerId2;
      return new Map(events.map((e) => [e.id, {
        interactionMomentId: "moment-1",
        likesCount: 1,
        commentsCount: 1,
        sharesCount: 3,
        isLiked: true,
        isSaved: false,
      }]));
    },
  };

  const service = new CheckoutPaymentService(
    {
      findTicketWalletOrdersByUserId: async () => [order],
      findByIds: async () => [],
      findIssuedTicketOrdersByEventIds: async () => [order],
    } as never,
    { findManyByIds: async () => [event] } as never,
    {} as never,
    {} as never,
    {
      findMany: async () => [{ _id: hostId, name: "K Mbappe", username: "mbappe_10" }],
      findByIds: async () => [{ _id: hostId, name: "K Mbappe", username: "mbappe_10" }],
    } as never,
    { findFollowingIds: async () => [] } as never,
    {
      findActiveByOwnerId: async () => [],
      findActiveByRecipientId: async () => [],
      findCancelledByRecipientId: async () => [],
      findActiveByEventIds: async () => [],
    } as never,
    { findByEventIdsAndOrderIds: async () => [] } as never,
    {} as never,
    {} as never,
    { findRefundItemsByOrderIds: async () => [] } as never,
    undefined as never,
    { findByOrderIds: async () => [], findByEventIds: async () => [] } as never,
    undefined as never, // ticketCancellationService
    undefined as never, // taxService
    undefined as never, // invoiceService
    undefined as never, // ticketPassClaimRepository
    undefined as never, // crowdStatusService
    undefined as never, // rewardClaimRepository
    eventInteractionSummaryService as never,
  );

  const wallet = await service.getMyTicketWallet({ id: viewerId } as never);

  assert.equal(wallet.length, 1);
  const walletItem = wallet[0]!;
  assert.equal(capturedViewerId, viewerId, "isLiked must be resolved for the wallet viewer, not the event host");
  assert.equal(walletItem.event.interactionMomentId, "moment-1");
  assert.equal(walletItem.event.likesCount, 1);
  assert.equal(walletItem.event.commentsCount, 1);
  assert.equal(walletItem.event.sharesCount, 3, "non-zero share count must reach the wallet response");
  assert.equal(walletItem.event.isLiked, true);
});
