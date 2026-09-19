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

test.afterEach(async () => {
  const { RedisClient } = await import("../src/config/redis.js");
  await RedisClient.disconnect().catch(() => undefined);
});

// EVT-008 (P0 fix): a brand-new Event must not be able to publish with a
// start already in the past — enforced authoritatively in EventService.publish(),
// scoped ONLY to "this Event has never been live before" (no eventId, or an
// eventId whose existing status is still "draft"). Re-publishing/editing an
// ALREADY-published Event through publish() (existingEvent.status !== "draft")
// is deliberately NOT subject to this rule — that's an active-event edit,
// governed by assertOngoingEventScheduleUpdateAllowed instead (EVT-009,
// unchanged by this batch). Save Draft is also deliberately unaffected.

const NOW = new Date("2026-09-15T12:00:00.000Z");
const PAST = new Date("2026-09-15T10:00:00.000Z"); // 2h before NOW
const FUTURE = new Date("2026-09-20T18:00:00.000Z");
const FUTURE_PLUS_2H = new Date("2026-09-20T20:00:00.000Z");

const eventId = new Types.ObjectId();
const ownerId = new Types.ObjectId();

const owner = { id: ownerId.toString(), name: "Owner", role: "user" } as never;

const host = {
  _id: ownerId,
  name: "Owner",
  username: "owner",
  email: "owner@example.com",
  accountType: "business",
  avatarKey: null,
  role: "user",
  isActive: true,
  emailVerified: true,
  createdAt: NOW,
  updatedAt: NOW,
};

const BANNER_KEY = "events/banners/fixture-banner.jpg";

const createEventFixture = (overrides: Record<string, unknown> = {}) => ({
  _id: eventId,
  userId: ownerId,
  status: "draft",
  name: "Schedule Rule Event",
  description: "desc",
  bannerImageKey: BANNER_KEY,
  bannerOriginalImageKey: null,
  bannerImageDisplay: null,
  ageRestriction: "all_ages",
  category: "Live Music & Concerts",
  categories: ["Live Music & Concerts"],
  hashtags: [],
  scheduledAt: FUTURE,
  endAt: FUTURE_PLUS_2H,
  timezone: null,
  location: { venue: "Test Venue" },
  tickets: [],
  rewards: [],
  privacy: "public",
  memberUserIds: [],
  joinRequests: [],
  publishedAt: null,
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

// Positional constructor — matches EventService's parameter order exactly
// (see api/src/modules/events/event.service.ts constructor) so overrides
// land on the right dependency. Mirrors api/test/event-banner-required.test.ts.
const createEventService = (overrides: { eventRepository?: Record<string, unknown> } = {}) =>
  new EventService(
    overrides.eventRepository as never, // 1 eventRepository
    { findById: async () => host } as never, // 2 userRepository
    { countFollowers: async () => 0, isFollowing: async () => false } as never, // 3 userFollowRepository
    { createDownloadUrl: async () => ({ url: "" }) } as never, // 4 storageService
    {} as never, // 5 productRepository
    {} as never, // 6 rewardClaimRepository
    { hasUserPaidTicketForEvent: async () => false } as never, // 7 checkoutPaymentRepository
    {} as never, // 8 checkoutPaymentService
    {} as never, // 9 creatorEarningRepository
    { hasActiveShareForRecipientAtEvent: async () => false } as never, // 10 ticketShareRepository
    {} as never, // 11 notificationRepository
    {} as never, // 12 userBlockRepository
    {} as never, // 13 eventSaveRepository
    {} as never, // 14 liveRoomRepository
    {} as never, // 15 momentRepository
    {} as never, // 16 momentReactionRepository
    {} as never, // 17 momentCommentRepository
    {} as never, // 18 momentCommentReactionRepository
    {} as never, // 19 momentShareRepository
    {} as never, // 20 momentSaveRepository
    {} as never, // 21 ticketUsageRepository
    {} as never, // 22 eventHostReviewRepository
    { findConflictingForEventSchedule: async () => [] } as never, // 23 eventWindowRepository
    {} as never, // 24 crowdStatusService
    () => NOW, // 25 getServerNow
    undefined, // 26 eventCancellationRefundService
    { findReportedTargetIds: async () => new Set<string>(), hasReported: async () => false } as never, // 27 reportRepository
  );

const assertPastStartRejection = async (action: Promise<unknown>) => {
  await assert.rejects(action, (error: unknown) => {
    assert.equal((error as { statusCode?: number }).statusCode, 400);
    assert.match((error as { message?: string }).message ?? "", /cannot be in the past/i);
    return true;
  });
};

const publishBasePayload = (overrides: Record<string, unknown> = {}) => ({
  name: "Schedule Rule Event",
  description: "desc",
  bannerImageKey: BANNER_KEY,
  ageRestriction: "all_ages",
  categories: ["Live Music & Concerts"],
  scheduledAt: FUTURE,
  endAt: FUTURE_PLUS_2H,
  location: { venue: "Test Venue" },
  tickets: [],
  privacy: "public",
  ...overrides,
});

// ── 1/2: brand-new Event (no eventId) ───────────────────────────────────────

test("new Event (no prior draft) publishing with a future start is allowed", async () => {
  const service = createEventService({
    eventRepository: { create: async (payload: Record<string, unknown>) => ({ ...createEventFixture(), ...payload }) },
  });

  const event = await service.publish(owner, publishBasePayload() as never);

  assert.equal(event.status, "published");
});

test("new Event (no prior draft) publishing with a past start is rejected", async () => {
  const service = createEventService({
    eventRepository: { create: async () => { throw new Error("should not be called"); } },
  });

  await assertPastStartRejection(
    service.publish(owner, publishBasePayload({ scheduledAt: PAST, endAt: NOW }) as never),
  );
});

// ── 3/4: first-time publish of an existing draft (eventId, status draft) ───

test("first-time publish of an existing draft with a future start is allowed", async () => {
  const service = createEventService({
    eventRepository: {
      findByIdForUser: async () => createEventFixture({ status: "draft" }),
      publishDraftByIdForUser: async (_id: string, _userId: string, payload: Record<string, unknown>) => ({
        ...createEventFixture(),
        ...payload,
        status: "published",
      }),
    },
  });

  const event = await service.publish(owner, publishBasePayload() as never, eventId.toString());

  assert.equal(event.status, "published");
});

test("first-time publish of an existing draft with a past start is rejected (direct-API bypass of the frontend gate is also blocked)", async () => {
  const service = createEventService({
    eventRepository: {
      findByIdForUser: async () => createEventFixture({ status: "draft", scheduledAt: PAST, endAt: NOW }),
      publishDraftByIdForUser: async () => { throw new Error("should not be called"); },
    },
  });

  await assertPastStartRejection(
    service.publish(owner, publishBasePayload({ scheduledAt: PAST, endAt: NOW }) as never, eventId.toString()),
  );
});

// ── 5: Save Draft semantics are unaffected — a temporarily-past schedule may
// still be saved as a draft (drafts remain allowed to be incomplete/invalid) ─

test("Save Draft with a past schedule is unaffected by the new publish-only rule (new draft)", async () => {
  let created: Record<string, unknown> | null = null;
  const service = createEventService({
    eventRepository: {
      create: async (payload: Record<string, unknown>) => {
        created = payload;
        return { ...createEventFixture(), ...payload };
      },
    },
  });

  await service.saveDraft(owner, {
    name: "Draft Event",
    bannerImageKey: BANNER_KEY,
    scheduledAt: PAST,
    endAt: NOW,
  } as never);

  assert.equal((created as unknown as { scheduledAt: Date } | null)?.scheduledAt?.getTime(), PAST.getTime());
});

test("Save Draft with a past schedule is unaffected by the new publish-only rule (updating an existing draft)", async () => {
  let updatePayload: Record<string, unknown> | null = null;
  const service = createEventService({
    eventRepository: {
      findByIdForUser: async () => createEventFixture({ status: "draft" }),
      updateDraftByIdForUser: async (_id: string, _userId: string, payload: Record<string, unknown>) => {
        updatePayload = payload;
        return { ...createEventFixture(), ...payload };
      },
    },
  });

  // Only move scheduledAt into the past; leave endAt untouched so this
  // doesn't also cross the unrelated ticket-creation-cutoff rule.
  await service.saveDraft(
    owner,
    { scheduledAt: PAST } as never,
    eventId.toString(),
  );

  assert.equal((updatePayload as unknown as { scheduledAt: Date } | null)?.scheduledAt?.getTime(), PAST.getTime());
});

// ── 6: end-before-start remains rejected (unchanged, coexists with the new
// rule). EventService.publish() only re-checks ordering post-conversion
// inside the timezone-resolution tiers of applyEventTimeZone (which don't
// fire here — no coordinates, no existing zone) — the authoritative check
// for this shape of request is the Zod schema itself (validateEventDateRange,
// wired into publishBody), exercised directly here exactly as
// event-taxonomy.test.ts exercises other publish-schema rules. This is
// confirming existing behavior, not adding a new rule. ─────────────────────

test("end-before-start is still rejected by the publish schema even when the start itself is safely in the future", async () => {
  const { eventValidation } = await import("../src/modules/events/event.validation.js");

  const result = eventValidation.publish.safeParse({
    body: publishBasePayload({ scheduledAt: FUTURE, endAt: FUTURE }),
  });

  assert.equal(result.success, false);
});

test("end < start is also rejected by the publish schema", async () => {
  const { eventValidation } = await import("../src/modules/events/event.validation.js");

  const result = eventValidation.publish.safeParse({
    body: publishBasePayload({ scheduledAt: FUTURE, endAt: PAST }),
  });

  assert.equal(result.success, false);
});

test("end > start passes the publish schema's ordering check", async () => {
  const { eventValidation } = await import("../src/modules/events/event.validation.js");

  const result = eventValidation.publish.safeParse({
    body: publishBasePayload({ scheduledAt: FUTURE, endAt: FUTURE_PLUS_2H }),
  });

  assert.equal(result.success, true);
});

// ── 7: re-publishing/editing an ALREADY-published Event via publish() is NOT
// subject to the new-Event past-start rule — that Event has a real historical
// start once it's live, and this is governed by the active-event guard, not
// this one. Here the existing Event is published with a schedule that is
// entirely in the future (a normal "update a not-yet-started Event" case). ──

test("editing an already-published, not-yet-started Event's schedule via publish() remains allowed", async () => {
  let updatePayload: Record<string, unknown> | null = null;
  const service = createEventService({
    eventRepository: {
      findByIdForUser: async () => createEventFixture({ status: "published", publishedAt: NOW }),
      updateByIdForUser: async (_id: string, _userId: string, payload: Record<string, unknown>) => {
        updatePayload = payload;
        return { ...createEventFixture({ status: "published" }), ...payload };
      },
    },
  });

  const event = await service.publish(
    owner,
    publishBasePayload({ scheduledAt: FUTURE, endAt: FUTURE_PLUS_2H }) as never,
    eventId.toString(),
  );

  assert.equal(event.status, "published");
  assert.ok(updatePayload, "expected updateByIdForUser to have been called");
});

// ── 8: active Event end-time edit is NOT broken by the new rule — the Event's
// start is genuinely historical (it already started), publish() is used to
// save an end-time-only change, and this must succeed exactly as before.

test("active Event (already started) end-time-only edit via publish() is not broken by the new past-start rule", async () => {
  const activeStart = new Date("2026-09-15T11:00:00.000Z"); // 1h before NOW — already started
  const activeEndOriginal = new Date("2026-09-15T13:00:00.000Z"); // 1h after NOW — not yet ended
  const activeEndExtended = new Date("2026-09-15T14:00:00.000Z");

  let updatePayload: Record<string, unknown> | null = null;
  const service = createEventService({
    eventRepository: {
      findByIdForUser: async () =>
        createEventFixture({ status: "published", scheduledAt: activeStart, endAt: activeEndOriginal }),
      updateByIdForUser: async (_id: string, _userId: string, payload: Record<string, unknown>) => {
        updatePayload = payload;
        return { ...createEventFixture({ status: "published" }), ...payload };
      },
    },
  });

  const event = await service.publish(
    owner,
    publishBasePayload({ scheduledAt: activeStart, endAt: activeEndExtended }) as never,
    eventId.toString(),
  );

  assert.equal(event.status, "published");
  assert.equal((updatePayload as unknown as { endAt: Date } | null)?.endAt?.getTime(), activeEndExtended.getTime());
});

// ── 9: the comparison is instant-vs-instant (UTC), never a device-local
// string comparison — proven by driving the check through venue-local wall-
// clock -> resolved-timezone conversion rather than passing a raw Date. ────

test("past-start comparison operates on the normalized absolute instant, not a raw/local string", async () => {
  // NOW is 2026-09-15T12:00:00.000Z. A venue-local wall-clock time that
  // converts to an instant AFTER NOW must be allowed; one that converts to
  // BEFORE NOW must be rejected — regardless of how the local date/time
  // strings alone might compare.
  const service = createEventService({
    eventRepository: { create: async (payload: Record<string, unknown>) => ({ ...createEventFixture(), ...payload }) },
  });

  // A Date object is itself always an absolute instant — construct one that
  // is unambiguously 10 minutes after NOW and confirm it's accepted.
  const justAfterNow = new Date(NOW.getTime() + 10 * 60 * 1000);
  const event = await service.publish(
    owner,
    publishBasePayload({ scheduledAt: justAfterNow, endAt: new Date(justAfterNow.getTime() + 60 * 60 * 1000) }) as never,
  );
  assert.equal(event.status, "published");
});

test("an instant 1 second before NOW is rejected (precise boundary, no invented grace period)", async () => {
  const service = createEventService({
    eventRepository: { create: async () => { throw new Error("should not be called"); } },
  });
  const justBeforeNow = new Date(NOW.getTime() - 1000);

  await assertPastStartRejection(
    service.publish(owner, publishBasePayload({ scheduledAt: justBeforeNow, endAt: NOW }) as never),
  );
});

test("an instant exactly equal to NOW is allowed (rule is strictly-less-than, matching the frontend's own comparison)", async () => {
  const service = createEventService({
    eventRepository: { create: async (payload: Record<string, unknown>) => ({ ...createEventFixture(), ...payload }) },
  });

  const event = await service.publish(
    owner,
    publishBasePayload({ scheduledAt: NOW, endAt: new Date(NOW.getTime() + 60 * 60 * 1000) }) as never,
  );
  assert.equal(event.status, "published");
});

// NOW = 2026-09-15T12:00:00.000Z. New York is UTC-4 (EDT) in September, so
// 09:00 local -> 13:00Z (after NOW) and 07:00 local -> 11:00Z (before NOW).
// These payloads send venue-local wall-clock parts + coordinates rather than
// a raw scheduledAt, so the past-start check only sees whatever
// applyEventTimeZone's real coordinate-based resolution produces — proving
// the rule is applied AFTER Event-local -> UTC normalization, per the task's
// explicit requirement not to compare naive local strings.
const NY_COORDS = { latitude: 40.7128, longitude: -74.006 };

test("a venue-local wall-clock time that resolves (via real coordinate-based timezone resolution) to an instant after NOW is allowed", async () => {
  const service = createEventService({
    eventRepository: { create: async (payload: Record<string, unknown>) => ({ ...createEventFixture(), ...payload }) },
  });

  const event = await service.publish(
    owner,
    publishBasePayload({
      location: { venue: "MSG", ...NY_COORDS },
      scheduledAt: new Date("2026-09-15T09:00:00.000Z"), // device-naive placeholder the client would also send
      endAt: new Date("2026-09-15T11:00:00.000Z"),
      scheduledLocalDate: "2026-09-15",
      scheduledLocalTime: "09:00",
      endLocalDate: "2026-09-15",
      endLocalTime: "11:00",
    }) as never,
  );

  assert.equal(event.status, "published");
});

test("a venue-local wall-clock time that resolves (via real coordinate-based timezone resolution) to an instant before NOW is rejected", async () => {
  const service = createEventService({
    eventRepository: { create: async () => { throw new Error("should not be called"); } },
  });

  await assertPastStartRejection(
    service.publish(
      owner,
      publishBasePayload({
        location: { venue: "MSG", ...NY_COORDS },
        scheduledAt: new Date("2026-09-15T20:00:00.000Z"), // device-naive placeholder — would look "future" read literally
        endAt: new Date("2026-09-15T22:00:00.000Z"),
        scheduledLocalDate: "2026-09-15",
        scheduledLocalTime: "07:00", // 07:00 EDT = 11:00Z, before NOW (12:00Z)
        endLocalDate: "2026-09-15",
        endLocalTime: "09:00",
      }) as never,
    ),
  );
});
