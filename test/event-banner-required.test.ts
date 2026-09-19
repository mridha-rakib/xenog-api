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

// EVT-005 (narrow scope): a banner is required to save a draft, and required
// to publish. An UPDATE that omits the banner fields entirely must preserve
// whatever banner the record already has — only an update that would leave
// the record with NO effective banner is rejected.

const now = new Date("2026-07-15T10:00:00.000Z");
const eventId = new Types.ObjectId();
const ownerId = new Types.ObjectId();

const owner = {
  id: ownerId.toString(),
  name: "Owner",
  username: "owner",
  email: "owner@example.com",
  accountType: "business",
  currentLocationSharingEnabled: false,
  notificationsEnabled: true,
  role: "user",
  isActive: true,
  emailVerified: true,
  createdAt: now,
  updatedAt: now,
};

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
  createdAt: now,
  updatedAt: now,
};

const BANNER_KEY = "events/banners/fixture-banner.jpg";

const createEvent = (overrides: Record<string, unknown> = {}) => ({
  _id: eventId,
  userId: ownerId,
  status: "draft",
  name: "Banner Rule Event",
  description: "desc",
  bannerImageKey: BANNER_KEY,
  bannerOriginalImageKey: null,
  bannerImageDisplay: null,
  ageRestriction: "all_ages",
  category: "Live Music & Concerts",
  categories: ["Live Music & Concerts"],
  hashtags: [],
  scheduledAt: now,
  endAt: new Date("2026-07-15T12:00:00.000Z"),
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
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

// Positional constructor — matches EventService's parameter order exactly
// (see api/src/modules/events/event.service.ts constructor) so overrides land
// on the right dependency.
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
    () => now, // 25 getServerNow
    undefined, // 26 eventCancellationRefundService
    { findReportedTargetIds: async () => new Set<string>(), hasReported: async () => false } as never, // 27 reportRepository
  );

const assertBadRequestBannerError = async (action: Promise<unknown>) => {
  await assert.rejects(action, (error: unknown) => {
    assert.equal((error as { statusCode?: number }).statusCode, 400);
    assert.match((error as { message?: string }).message ?? "", /banner/i);
    return true;
  });
};

test("new draft without a banner is rejected", async () => {
  const service = createEventService({
    eventRepository: { create: async () => { throw new Error("should not be called"); } },
  });

  await assertBadRequestBannerError(
    service.saveDraft(owner as never, { name: "No Banner" } as never),
  );
});

test("new draft with a banner is accepted", async () => {
  let created: Record<string, unknown> | null = null;
  const service = createEventService({
    eventRepository: {
      create: async (payload: Record<string, unknown>) => {
        created = payload;
        return { ...createEvent(), ...payload };
      },
    },
  });

  await service.saveDraft(
    owner as never,
    { name: "Has Banner", bannerImageKey: BANNER_KEY } as never,
  );

  assert.equal(created?.bannerImageKey, BANNER_KEY);
});

test("updating a draft without resending banner fields preserves the existing banner", async () => {
  let updatePayload: Record<string, unknown> | null = null;
  const service = createEventService({
    eventRepository: {
      findByIdForUser: async () => createEvent(),
      updateDraftByIdForUser: async (_id: string, _userId: string, payload: Record<string, unknown>) => {
        updatePayload = payload;
        return { ...createEvent(), ...payload };
      },
    },
  });

  await service.saveDraft(owner as never, { description: "Updated copy" } as never, eventId.toString());

  assert.equal(Object.prototype.hasOwnProperty.call(updatePayload ?? {}, "bannerImageKey"), false);
});

test("updating a draft to explicitly clear its only banner is rejected", async () => {
  const service = createEventService({
    eventRepository: {
      findByIdForUser: async () => createEvent(),
      updateDraftByIdForUser: async () => { throw new Error("should not be called"); },
    },
  });

  await assertBadRequestBannerError(
    service.saveDraft(owner as never, { bannerImageKey: null } as never, eventId.toString()),
  );
});

test("publishing a brand-new event without a banner is rejected", async () => {
  const service = createEventService({
    eventRepository: { create: async () => { throw new Error("should not be called"); } },
  });

  await assertBadRequestBannerError(
    service.publish(owner as never, {
      name: "No Banner Publish",
      ageRestriction: "all_ages",
      categories: ["Live Music & Concerts"],
      scheduledAt: now,
      endAt: new Date("2026-07-15T12:00:00.000Z"),
      location: { venue: "Test Venue" },
      tickets: [],
      privacy: "public",
    } as never),
  );
});

test("publishing an existing draft without resending the banner preserves it", async () => {
  let publishPayload: Record<string, unknown> | null = null;
  const service = createEventService({
    eventRepository: {
      findByIdForUser: async () => createEvent(),
      publishDraftByIdForUser: async (_id: string, _userId: string, payload: Record<string, unknown>) => {
        publishPayload = payload;
        return { ...createEvent(), ...payload, status: "published" };
      },
    },
  });

  await service.publish(
    owner as never,
    {
      name: "Existing Draft Publish",
      ageRestriction: "all_ages",
      categories: ["Live Music & Concerts"],
      scheduledAt: now,
      endAt: new Date("2026-07-15T12:00:00.000Z"),
      location: { venue: "Test Venue" },
      tickets: [],
      privacy: "public",
    } as never,
    eventId.toString(),
  );

  assert.equal(Object.prototype.hasOwnProperty.call(publishPayload ?? {}, "bannerImageKey"), false);
});

test("editing a published event without resending the banner preserves it", async () => {
  let updatePayload: Record<string, unknown> | null = null;
  const service = createEventService({
    eventRepository: {
      findByIdForUser: async () => createEvent({ status: "published", publishedAt: now }),
      updateByIdForUser: async (_id: string, _userId: string, payload: Record<string, unknown>) => {
        updatePayload = payload;
        return { ...createEvent({ status: "published" }), ...payload };
      },
    },
  });

  await service.updateEvent(owner as never, eventId.toString(), { description: "New copy" } as never);

  assert.equal(Object.prototype.hasOwnProperty.call(updatePayload ?? {}, "bannerImageKey"), false);
});

test("clearing the only banner on a published event is rejected", async () => {
  const service = createEventService({
    eventRepository: {
      findByIdForUser: async () => createEvent({ status: "published", publishedAt: now }),
      updateByIdForUser: async () => { throw new Error("should not be called"); },
    },
  });

  await assertBadRequestBannerError(
    service.updateEvent(owner as never, eventId.toString(), { bannerImageKey: null } as never),
  );
});
