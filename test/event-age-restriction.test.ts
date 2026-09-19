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

// EVT-010A — end-to-end persistence round-trip for all three supported age
// restriction values, exercised against the real EventService (mocked
// repository), matching the established convention in this test suite.
// Display-side consistency (Feed/Search/Map/Event Detail) is covered by
// app/test/eventAgeRestriction*.test.ts; this file proves the value itself
// survives Save Draft / Publish / Update unchanged for each of the 3 values.

const NOW = new Date("2026-09-15T12:00:00.000Z");
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
  name: "Age Restriction Event",
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
// (see api/src/modules/events/event.service.ts constructor), mirroring
// api/test/event-banner-required.test.ts / event-publish-schedule.test.ts.
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

const publishBasePayload = (overrides: Record<string, unknown> = {}) => ({
  name: "Age Restriction Event",
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

const AGE_VALUES = ["all_ages", "18_plus", "21_plus"] as const;

// ── 2/3/4: Save Draft preserves each of the three supported values ─────────

for (const ageRestriction of AGE_VALUES) {
  test(`Save Draft (new draft) preserves ageRestriction = ${ageRestriction}`, async () => {
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
      ageRestriction,
    } as never);

    assert.equal((created as unknown as { ageRestriction: string } | null)?.ageRestriction, ageRestriction);
  });
}

// ── 5: Publish preserves all three supported values ─────────────────────────

for (const ageRestriction of AGE_VALUES) {
  test(`Publish (brand-new Event) preserves ageRestriction = ${ageRestriction}`, async () => {
    const service = createEventService({
      eventRepository: {
        create: async (payload: Record<string, unknown>) => ({ ...createEventFixture(), ...payload }),
      },
    });

    const event = await service.publish(owner, publishBasePayload({ ageRestriction }) as never);

    assert.equal(event.status, "published");
    assert.equal(event.ageRestriction, ageRestriction);
  });
}

// ── 6: reopened Draft restores the selected value (persistence-level proof —
// the picker-side restoration itself is covered by a source-text check in
// app/test/eventAgeRestrictionDisplayWiring.test.ts, since eventDraftStore.ts
// can't be imported at runtime here) ─────────────────────────────────────

for (const ageRestriction of AGE_VALUES) {
  test(`reopening a draft (getEventById) returns the persisted ageRestriction = ${ageRestriction} unchanged`, async () => {
    const service = createEventService({
      eventRepository: {
        findById: async () => createEventFixture({ ageRestriction }),
        countByUserId: async () => 0,
      },
    });

    const event = await service.getEventById(owner, eventId.toString());

    assert.equal(event.ageRestriction, ageRestriction);
  });
}

// ── 7: Edit Published Event restores/preserves the selected value across an
// unrelated field update (omitting ageRestriction from the payload) ────────

for (const ageRestriction of AGE_VALUES) {
  test(`editing an unrelated field on a published Event preserves ageRestriction = ${ageRestriction}`, async () => {
    let updatePayload: Record<string, unknown> | null = null;
    const service = createEventService({
      eventRepository: {
        findByIdForUser: async () =>
          createEventFixture({ status: "published", publishedAt: NOW, ageRestriction }),
        updateByIdForUser: async (_id: string, _userId: string, payload: Record<string, unknown>) => {
          updatePayload = payload;
          return { ...createEventFixture({ status: "published", ageRestriction }), ...payload };
        },
      },
    });

    const event = await service.updateEvent(owner, eventId.toString(), {
      description: "Updated description only",
    } as never);

    assert.equal(event.ageRestriction, ageRestriction);
    // ageRestriction was never sent in the payload — proves it was preserved
    // from the existing record, not silently reset to a default.
    assert.equal(Object.prototype.hasOwnProperty.call(updatePayload ?? {}, "ageRestriction"), false);
  });
}

// ── legacy/null safety at the persistence boundary — a legacy Event with no
// ageRestriction at all must still round-trip without throwing. ───────────

test("a legacy Event with ageRestriction unset (null) does not crash on read", async () => {
  const service = createEventService({
    eventRepository: {
      findById: async () => createEventFixture({ ageRestriction: null }),
      countByUserId: async () => 0,
    },
  });

  const event = await service.getEventById(owner, eventId.toString());

  assert.equal(event.ageRestriction, null);
});
