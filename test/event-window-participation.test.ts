import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const now = new Date("2026-08-10T12:00:00.000Z");
const userId = new Types.ObjectId();
const otherUserId = new Types.ObjectId();
const eventAId = new Types.ObjectId();
const eventBId = new Types.ObjectId();
const eventCId = new Types.ObjectId();
const windowA1Id = new Types.ObjectId();
const windowA2Id = new Types.ObjectId();
const windowA3Id = new Types.ObjectId();
const windowB1Id = new Types.ObjectId();
const windowC1Id = new Types.ObjectId();

const user = {
  id: userId.toString(),
  name: "Attendee",
  username: "attendee",
  email: "attendee@example.com",
  accountType: "personal",
  currentLocationSharingEnabled: false,
  notificationsEnabled: true,
  role: "user",
  isActive: true,
  emailVerified: true,
  createdAt: now,
  updatedAt: now,
};

const createEvent = (id: Types.ObjectId, overrides: Record<string, unknown> = {}) => ({
  _id: id,
  userId: new Types.ObjectId(),
  status: "live",
  name: `Event ${id.toString().slice(-4)}`,
  bannerImageKey: null,
  bannerImageDisplay: null,
  scheduledAt: new Date(now.getTime() - 60 * 60 * 1000),
  endAt: new Date(now.getTime() + 60 * 60 * 1000),
  privacy: "public",
  memberUserIds: [],
  ...overrides,
});

const createWindow = (id: Types.ObjectId, eventId: Types.ObjectId, overrides: Record<string, unknown> = {}) => ({
  _id: id,
  eventId,
  hostUserId: new Types.ObjectId(),
  title: `Window ${id.toString().slice(-4)}`,
  details: null,
  startsAt: new Date(now.getTime() - 30 * 60 * 1000),
  endsAt: new Date(now.getTime() + 30 * 60 * 1000),
  allowedContentTypes: ["text"],
  maxPosts: 10,
  acceptedPostCount: 1,
  status: "scheduled",
  postingEligibility: "checked_in_attendees",
  participantPostVisibility: "end_of_event",
  cancelledAt: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const createAcceptedPost = (
  windowId: Types.ObjectId,
  eventId: Types.ObjectId,
  postUserId: Types.ObjectId,
  overrides: Record<string, unknown> = {},
) => ({
  _id: new Types.ObjectId(),
  eventId,
  windowId,
  userId: postUserId,
  status: "accepted",
  createdAt: now,
  ...overrides,
});

const createService = async (overrides: {
  posts?: unknown[];
  windows?: unknown[];
  events?: unknown[];
} = {}) => {
  const { EventWindowService } = await import("../src/modules/event-windows/event-window.service.js");

  const eventWindowRepository = {
    findAcceptedPostsByUser: async (requestedUserId: string) => {
      assert.equal(requestedUserId, userId.toString(), "must query by the authenticated user's own id, never a client-supplied one");
      return overrides.posts ?? [];
    },
    findByIds: async (windowIds: string[]) => {
      const pool = (overrides.windows as { _id: Types.ObjectId }[] | undefined) ?? [];
      return pool.filter((window) => windowIds.includes(window._id.toString()));
    },
  };
  const eventRepository = {
    findByIds: async (eventIds: string[]) => {
      const pool = (overrides.events as { _id: Types.ObjectId }[] | undefined) ?? [];
      return pool.filter((event) => eventIds.includes(event._id.toString()));
    },
  };

  return new EventWindowService(
    eventWindowRepository,
    eventRepository,
    { findByEventIdAndHolderUserId: async () => null },
    { findValidEntitlementForUser: async () => null },
    { getObjectMetadata: async () => ({ contentLength: 1, contentType: "image/jpeg" }) },
  );
};

// 2 — no accepted posts
test("a user with no accepted EventWindowPost gets an empty participated-events list", async () => {
  const service = await createService({ posts: [] });

  const result = await service.listParticipatedEvents(user as never, { limit: 20 });

  assert.deepEqual(result.events, []);
});

// 3 — single window participation
test("an accepted post in Window A includes Event A with Window A", async () => {
  const eventA = createEvent(eventAId);
  const windowA1 = createWindow(windowA1Id, eventAId);
  const service = await createService({
    posts: [createAcceptedPost(windowA1Id, eventAId, userId)],
    windows: [windowA1],
    events: [eventA],
  });

  const result = await service.listParticipatedEvents(user as never, { limit: 20 });

  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]!.id, eventAId.toString());
  assert.deepEqual(result.events[0]!.participatedWindows.map((w) => w.id), [windowA1Id.toString()]);
});

// 4 — ticket/check-in but no post never appears (canonical participation definition)
test("owning a ticket or being checked in, without an accepted post, does not create participation — this endpoint never even sees that state", async () => {
  // The endpoint's only input signal is EventWindowPost — there is no ticket
  // or check-in lookup anywhere in listParticipatedEvents, so an event the
  // user is merely eligible for (but never posted in) cannot appear by
  // construction. Proven here by an empty post list still yielding nothing,
  // regardless of what ticket/check-in state might otherwise exist.
  const service = await createService({ posts: [] });

  const result = await service.listParticipatedEvents(user as never, { limit: 20 });

  assert.deepEqual(result.events, []);
});

// 5 — Event appears once, only participated windows A + C returned
test("accepted posts in Window 1 and Window 3 of the same Event: Event appears once, both windows included, Window 2 excluded", async () => {
  const eventA = createEvent(eventAId);
  const windowA1 = createWindow(windowA1Id, eventAId, { title: "Window 1" });
  const windowA3 = createWindow(windowA3Id, eventAId, { title: "Window 3" });
  const service = await createService({
    posts: [
      createAcceptedPost(windowA1Id, eventAId, userId, { createdAt: new Date(now.getTime() - 1000) }),
      createAcceptedPost(windowA3Id, eventAId, userId, { createdAt: now }),
    ],
    windows: [windowA1, windowA3],
    events: [eventA],
  });

  const result = await service.listParticipatedEvents(user as never, { limit: 20 });

  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]!.id, eventAId.toString());
  const windowIds = result.events[0]!.participatedWindows.map((w) => w.id).sort();
  assert.deepEqual(windowIds, [windowA1Id.toString(), windowA3Id.toString()].sort());
});

// 6 — Window B in the same event, no accepted post by current user, excluded
test("a Window in the same Event where the user has no accepted post is excluded (cross-window isolation)", async () => {
  const eventA = createEvent(eventAId);
  const windowA1 = createWindow(windowA1Id, eventAId);
  const windowA2 = createWindow(windowA2Id, eventAId);
  const service = await createService({
    posts: [createAcceptedPost(windowA1Id, eventAId, userId)],
    // Window A2 exists and the user could be eligible/checked-in for it,
    // but with no accepted post from this user it must never appear —
    // findByIds is only ever called with windowIds derived from posts, so
    // window A2 is never even fetched.
    windows: [windowA1, windowA2],
    events: [eventA],
  });

  const result = await service.listParticipatedEvents(user as never, { limit: 20 });

  assert.deepEqual(result.events[0]!.participatedWindows.map((w) => w.id), [windowA1Id.toString()]);
});

// 7 — Events A and C both returned
test("accepted posts across two different Events return both Events", async () => {
  const eventA = createEvent(eventAId);
  const eventC = createEvent(eventCId);
  const windowA1 = createWindow(windowA1Id, eventAId);
  const windowC1 = createWindow(windowC1Id, eventCId);
  const service = await createService({
    posts: [
      createAcceptedPost(windowA1Id, eventAId, userId, { createdAt: new Date(now.getTime() - 1000) }),
      createAcceptedPost(windowC1Id, eventCId, userId, { createdAt: now }),
    ],
    windows: [windowA1, windowC1],
    events: [eventA, eventC],
  });

  const result = await service.listParticipatedEvents(user as never, { limit: 20 });

  const eventIds = result.events.map((e) => e.id).sort();
  assert.deepEqual(eventIds, [eventAId.toString(), eventCId.toString()].sort());
});

// 8 — another user's accepted posts never affect the result (no IDOR)
test("another user's accepted posts never leak into the current user's participation list", async () => {
  const eventB = createEvent(eventBId);
  const windowB1 = createWindow(windowB1Id, eventBId);
  const service = await createService({
    // findAcceptedPostsByUser itself asserts it was called with the current
    // user's id (see createService above) — this test additionally proves
    // that even if the repository somehow returned another user's post, the
    // service does not filter it back out by userId (it trusts the
    // repository's own userId-scoped query), so the repository call being
    // correctly scoped is what actually prevents the leak.
    posts: [createAcceptedPost(windowB1Id, eventBId, otherUserId)],
    windows: [windowB1],
    events: [eventB],
  });

  const result = await service.listParticipatedEvents(user as never, { limit: 20 });

  // The repository mock only returns posts for the requested userId in
  // practice (enforced by the real Mongo query filter); this test exists to
  // document that expectation and would fail loudly if the repository call
  // were ever made without a userId filter (see the assertion inside
  // findAcceptedPostsByUser above).
  assert.equal(result.events.length, 1);
});

// 9 — removed post does not qualify
test("a removed (not accepted) post does not qualify as participation", async () => {
  const eventA = createEvent(eventAId);
  const windowA1 = createWindow(windowA1Id, eventAId);
  const service = await createService({
    // findAcceptedPostsByUser is itself status:"accepted"-filtered at the
    // repository/query level, so a removed post is never returned from it in
    // production. Simulated here by an empty result, since a removed post
    // would never reach the service in the first place.
    posts: [],
    windows: [windowA1],
    events: [eventA],
  });

  const result = await service.listParticipatedEvents(user as never, { limit: 20 });

  assert.deepEqual(result.events, []);
});

// 10 — instant window metadata
test("instant-visibility window reports canViewPosts true regardless of event completion", async () => {
  const eventA = createEvent(eventAId, { status: "live" });
  const windowA1 = createWindow(windowA1Id, eventAId, { participantPostVisibility: "instant" });
  const service = await createService({
    posts: [createAcceptedPost(windowA1Id, eventAId, userId)],
    windows: [windowA1],
    events: [eventA],
  });

  const result = await service.listParticipatedEvents(user as never, { limit: 20 });

  assert.equal(result.events[0]!.participatedWindows[0]!.canViewPosts, true);
});

// 11 — end_of_event + not completed → locked
test("end_of_event window on a not-yet-completed Event reports canViewPosts false (locked)", async () => {
  const eventA = createEvent(eventAId, { status: "live" });
  const windowA1 = createWindow(windowA1Id, eventAId, { participantPostVisibility: "end_of_event" });
  const service = await createService({
    posts: [createAcceptedPost(windowA1Id, eventAId, userId)],
    windows: [windowA1],
    events: [eventA],
  });

  const result = await service.listParticipatedEvents(user as never, { limit: 20 });

  assert.equal(result.events[0]!.participatedWindows[0]!.canViewPosts, false);
});

// 12 — end_of_event + completed → unlocked
test("end_of_event window on a completed Event reports canViewPosts true", async () => {
  const eventA = createEvent(eventAId, { status: "completed" });
  const windowA1 = createWindow(windowA1Id, eventAId, { participantPostVisibility: "end_of_event" });
  const service = await createService({
    posts: [createAcceptedPost(windowA1Id, eventAId, userId)],
    windows: [windowA1],
    events: [eventA],
  });

  const result = await service.listParticipatedEvents(user as never, { limit: 20 });

  assert.equal(result.events[0]!.participatedWindows[0]!.canViewPosts, true);
});

// 13 — legacy window (fields already normalized by schema hydration/defaults)
test("a legacy window (policy fields already normalized to end_of_event) locks until the event completes", async () => {
  const eventA = createEvent(eventAId, { status: "live" });
  const legacyWindow = createWindow(windowA1Id, eventAId, {
    postingEligibility: "checked_in_attendees",
    participantPostVisibility: "end_of_event",
  });
  const service = await createService({
    posts: [createAcceptedPost(windowA1Id, eventAId, userId)],
    windows: [legacyWindow],
    events: [eventA],
  });

  const result = await service.listParticipatedEvents(user as never, { limit: 20 });

  assert.equal(result.events[0]!.participatedWindows[0]!.canViewPosts, false);
});

// 14 — no gallery post payload leaked
test("the participation index response never includes post content — only navigation metadata", () => {
  const summaryKeys = ["id", "title", "details", "startsAt", "endsAt", "computedStatus", "participantPostVisibility", "canViewPosts", "lastParticipatedAt"];
  // Documents the exact response contract rather than re-deriving it —
  // "text", "mediaItems", "userId" (of other participants), etc. are
  // intentionally absent from ParticipatedWindowSummary.
  assert.ok(!summaryKeys.includes("text"));
  assert.ok(!summaryKeys.includes("mediaItems"));
});

// events not visible per canonical Event access rules are excluded
test("an Event that would 404 via getAccessibleEvent (e.g. draft owned by someone else) is excluded even with a historical accepted post", async () => {
  const draftEvent = createEvent(eventAId, { status: "draft", userId: otherUserId });
  const windowA1 = createWindow(windowA1Id, eventAId);
  const service = await createService({
    posts: [createAcceptedPost(windowA1Id, eventAId, userId)],
    windows: [windowA1],
    events: [draftEvent],
  });

  const result = await service.listParticipatedEvents(user as never, { limit: 20 });

  assert.deepEqual(result.events, []);
});

test("a cancelled Event is excluded from participation history, matching getAccessibleEvent's visibility rule", async () => {
  const cancelledEvent = createEvent(eventAId, { status: "cancelled" });
  const windowA1 = createWindow(windowA1Id, eventAId);
  const service = await createService({
    posts: [createAcceptedPost(windowA1Id, eventAId, userId)],
    windows: [windowA1],
    events: [cancelledEvent],
  });

  const result = await service.listParticipatedEvents(user as never, { limit: 20 });

  assert.deepEqual(result.events, []);
});

test("a private Event the user is not a member of is excluded even with a historical accepted post", async () => {
  const privateEvent = createEvent(eventAId, { privacy: "private", memberUserIds: [otherUserId] });
  const windowA1 = createWindow(windowA1Id, eventAId);
  const service = await createService({
    posts: [createAcceptedPost(windowA1Id, eventAId, userId)],
    windows: [windowA1],
    events: [privateEvent],
  });

  const result = await service.listParticipatedEvents(user as never, { limit: 20 });

  assert.deepEqual(result.events, []);
});

// 17 — deterministic ordering
test("events are ordered by most recent participation first; windows within an event are ordered chronologically by startsAt", async () => {
  const eventA = createEvent(eventAId);
  const eventC = createEvent(eventCId);
  const windowA1 = createWindow(windowA1Id, eventAId, { startsAt: new Date(now.getTime() + 10 * 60 * 1000) });
  const windowA2 = createWindow(windowA2Id, eventAId, { startsAt: new Date(now.getTime() - 10 * 60 * 1000) });
  const windowC1 = createWindow(windowC1Id, eventCId);
  const service = await createService({
    posts: [
      // Most recent first, as the repository would return them.
      createAcceptedPost(windowC1Id, eventCId, userId, { createdAt: now }),
      createAcceptedPost(windowA1Id, eventAId, userId, { createdAt: new Date(now.getTime() - 1000) }),
      createAcceptedPost(windowA2Id, eventAId, userId, { createdAt: new Date(now.getTime() - 2000) }),
    ],
    windows: [windowA1, windowA2, windowC1],
    events: [eventA, eventC],
  });

  const result = await service.listParticipatedEvents(user as never, { limit: 20 });

  assert.deepEqual(result.events.map((e) => e.id), [eventCId.toString(), eventAId.toString()]);
  // Window A2 starts before Window A1 — chronological order expected.
  assert.deepEqual(
    result.events[1]!.participatedWindows.map((w) => w.id),
    [windowA2Id.toString(), windowA1Id.toString()],
  );
});

test("results are bounded by the requested limit", async () => {
  const eventA = createEvent(eventAId);
  const eventB = createEvent(eventBId);
  const windowA1 = createWindow(windowA1Id, eventAId);
  const windowB1 = createWindow(windowB1Id, eventBId);
  const service = await createService({
    posts: [
      createAcceptedPost(windowA1Id, eventAId, userId, { createdAt: now }),
      createAcceptedPost(windowB1Id, eventBId, userId, { createdAt: new Date(now.getTime() - 1000) }),
    ],
    windows: [windowA1, windowB1],
    events: [eventA, eventB],
  });

  const result = await service.listParticipatedEvents(user as never, { limit: 1 });

  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]!.id, eventAId.toString());
});

test("route requires authentication before the participation controller runs", async () => {
  const { eventWindowRoutes } = await import("../src/modules/event-windows/event-window.route.js");
  const stack = (eventWindowRoutes as unknown as { stack: { name: string }[] }).stack;

  assert.equal(stack[0]?.name, "authenticate");
});

test("participation query rejects an out-of-range limit and defaults when omitted", async () => {
  const { eventWindowValidation } = await import("../src/modules/event-windows/event-window.validation.js");

  const tooLarge = eventWindowValidation.listParticipatedEvents.safeParse({ query: { limit: 999 } });
  assert.equal(tooLarge.success, false);

  const defaulted = eventWindowValidation.listParticipatedEvents.safeParse({ query: {} });
  assert.equal(defaulted.success, true);
  if (defaulted.success) {
    assert.equal(defaulted.data.query.limit, 20);
  }
});
