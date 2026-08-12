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

const momentServiceModulePromise = import("../src/modules/moments/moment.service.js");
const eventServiceModulePromise = import("../src/modules/events/event.service.js");

const now = new Date("2026-08-11T12:00:00.000Z");

const viewerId = new Types.ObjectId();
const selfMomentId = new Types.ObjectId();
const followedAuthorId = new Types.ObjectId();
const followedMomentId = new Types.ObjectId();
const mutualFriendId = new Types.ObjectId();
const mutualMomentId = new Types.ObjectId();
const unrelatedAuthorId = new Types.ObjectId();
const unrelatedMomentId = new Types.ObjectId();
const oldSelfMomentId = new Types.ObjectId();

const viewer = { id: viewerId.toString(), name: "Viewer" };

const makeMoment = (id: Types.ObjectId, userId: Types.ObjectId, createdAt: Date) => ({
  _id: id,
  userId,
  mode: "feed" as const,
  caption: "post",
  hashtags: [] as string[],
  audience: "public" as const,
  taggedPeople: [] as string[],
  taggedFriendIds: [] as Types.ObjectId[],
  eventTitle: null,
  eventId: null,
  eventCode: null,
  mediaItems: [] as never[],
  location: null,
  createdAt,
  updatedAt: createdAt,
});

const makeUserDoc = (id: Types.ObjectId, name: string) => ({
  _id: id,
  name,
  username: name.toLowerCase(),
  email: `${name.toLowerCase()}@example.com`,
  accountType: "personal",
  avatarKey: null,
  avatarUrl: null,
  role: "user",
  isActive: true,
  emailVerified: true,
  createdAt: now,
  updatedAt: now,
});

type CallCounts = { findReposterUserIdsByMomentIds: number; findLikedUserIdsByMomentIds: number };

const createMomentService = async (options: {
  moments: ReturnType<typeof makeMoment>[];
  followingIds?: string[];
  mutualFriendIds?: string[];
  reactedUserIdsByMomentId?: Map<string, string[]>;
  reposterUserIdsByMomentId?: Map<string, string[]>;
  callCounts?: Partial<CallCounts>;
}) => {
  const { MomentService } = await momentServiceModulePromise;
  const callCounts: CallCounts = {
    findReposterUserIdsByMomentIds: 0,
    findLikedUserIdsByMomentIds: 0,
    ...options.callCounts,
  };
  const authorIds = [...new Set(options.moments.map((m) => m.userId.toString()))];
  const authors = authorIds.map((id) => makeUserDoc(new Types.ObjectId(id), `user-${id.slice(-4)}`));

  const service = new MomentService(
    {
      findFeedCandidateEventIds: async () => [],
      findFeed: async () => options.moments,
    } as never,
    { createDownloadUrl: async () => ({ url: "" }) } as never,
    {
      findByIds: async () => authors,
      findById: async () => null,
      findActiveUsersByIds: async () => [],
    } as never,
    {
      findReposterUserIdsByMomentIds: async (momentIds: string[], userIds: string[]) => {
        callCounts.findReposterUserIdsByMomentIds += 1;
        if (userIds.length === 0) return new Map<string, string[]>();
        const map = options.reposterUserIdsByMomentId ?? new Map<string, string[]>();
        const filtered = new Map<string, string[]>();
        for (const momentId of momentIds) {
          if (map.has(momentId)) filtered.set(momentId, map.get(momentId)!);
        }
        return filtered;
      },
      countByMomentIds: async () => new Map<string, number>(),
    } as never,
    {
      findFollowingIds: async () => options.followingIds ?? [],
      findMutualFriendIds: async () => options.mutualFriendIds ?? [],
    } as never,
    {
      findBlockedIds: async () => [],
      findBlockerIds: async () => [],
    } as never,
    {
      findLikedUserIdsByMomentIds: async (momentIds: string[], userIds: string[]) => {
        callCounts.findLikedUserIdsByMomentIds += 1;
        if (userIds.length === 0) return new Map<string, string[]>();
        const map = options.reactedUserIdsByMomentId ?? new Map<string, string[]>();
        const filtered = new Map<string, string[]>();
        for (const momentId of momentIds) {
          if (map.has(momentId)) filtered.set(momentId, map.get(momentId)!);
        }
        return filtered;
      },
      countByMomentIds: async () => new Map<string, number>(),
      findLikedMomentIds: async () => new Set<string>(),
    } as never,
    { countByMomentIds: async () => new Map<string, number>() } as never,
    {} as never,
    { findSavedMomentIds: async () => new Set<string>() } as never,
    { findFeedVisibleByIdsForUser: async () => [] } as never,
    {} as never,
    {} as never,
    undefined,
    undefined,
    { findReportedTargetIds: async () => new Set<string>(), hasReported: async () => false } as never,
    { lookup: async () => null } as never,
  );

  return { service, callCounts };
};

test("fresh own Moment gets a very strong lift in its author's own feed", async () => {
  const otherFresh = makeMoment(unrelatedMomentId, unrelatedAuthorId, now);
  const ownFresh = makeMoment(selfMomentId, new Types.ObjectId(viewerId), now);
  const { service } = await createMomentService({ moments: [otherFresh, ownFresh] });

  const results = await service.listFeedMoments(viewer as never, {});
  const own = results.find((r) => r.id === selfMomentId.toString());
  const other = results.find((r) => r.id === unrelatedMomentId.toString());

  assert.ok(own && other);
  assert.ok((own!.smartFeedScore ?? 0) > (other!.smartFeedScore ?? 0));
  // Same-instant, no other signals for either — the only difference is
  // authorship, proving the lift is real and not accidental.
  assert.ok((own!.smartFeedScore ?? 0) > 0.5);
});

test("own content is not fixed to position 1 — a strongly-favored other item can still outrank stale own content", async () => {
  const staleOwn = makeMoment(oldSelfMomentId, new Types.ObjectId(viewerId), new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000));
  const freshMutual = makeMoment(mutualMomentId, mutualFriendId, now);
  const reactedUserIdsByMomentId = new Map([[mutualMomentId.toString(), [mutualFriendId.toString()]]]);
  const { service } = await createMomentService({
    moments: [staleOwn, freshMutual],
    mutualFriendIds: [mutualFriendId.toString()],
    reactedUserIdsByMomentId,
  });

  const results = await service.listFeedMoments(viewer as never, {});

  assert.equal(results[0]?.id, mutualMomentId.toString());
  assert.equal(results[1]?.id, oldSelfMomentId.toString());
});

test("old own content is not permanently pinned — self boost fades to ~0 as freshness decays", async () => {
  const veryStaleOwn = makeMoment(oldSelfMomentId, new Types.ObjectId(viewerId), new Date("2020-01-01T00:00:00.000Z"));
  const { service } = await createMomentService({ moments: [veryStaleOwn] });

  const results = await service.listFeedMoments(viewer as never, {});

  assert.ok((results[0]?.smartFeedScore ?? 1) < 0.05);
});

test("A follows B (one-way, not mutual): B's fresh Moment gets a strong relationship boost over an unrelated author", async () => {
  const followedPost = makeMoment(followedMomentId, followedAuthorId, now);
  const unrelatedPost = makeMoment(unrelatedMomentId, unrelatedAuthorId, now);
  const { service } = await createMomentService({
    moments: [followedPost, unrelatedPost],
    followingIds: [followedAuthorId.toString()],
  });

  const results = await service.listFeedMoments(viewer as never, {});
  const followed = results.find((r) => r.id === followedMomentId.toString());
  const unrelated = results.find((r) => r.id === unrelatedMomentId.toString());

  assert.ok((followed!.smartFeedScore ?? 0) > (unrelated!.smartFeedScore ?? 0));
});

test("mutual friend authorship still outranks a one-way follow", async () => {
  const followedPost = makeMoment(followedMomentId, followedAuthorId, now);
  const mutualPost = makeMoment(mutualMomentId, mutualFriendId, now);
  const { service } = await createMomentService({
    moments: [followedPost, mutualPost],
    followingIds: [followedAuthorId.toString(), mutualFriendId.toString()],
    mutualFriendIds: [mutualFriendId.toString()],
  });

  const results = await service.listFeedMoments(viewer as never, {});
  const followed = results.find((r) => r.id === followedMomentId.toString());
  const mutual = results.find((r) => r.id === mutualMomentId.toString());

  assert.ok((mutual!.smartFeedScore ?? 0) > (followed!.smartFeedScore ?? 0));
});

test("an unrelated author gets no relationship boost", async () => {
  const unrelatedPost = makeMoment(unrelatedMomentId, unrelatedAuthorId, now);
  const { service } = await createMomentService({ moments: [unrelatedPost] });

  const results = await service.listFeedMoments(viewer as never, {});

  // With no nearby/social signal at all, score is freshness-only (~0.2 at t=0).
  assert.ok((results[0]?.smartFeedScore ?? 0) <= 0.2 + 1e-6);
});

test("followed user's repost of a Moment gives the ORIGINAL Moment a medium relevance boost, in one batched query", async () => {
  const rankedPost = makeMoment(unrelatedMomentId, unrelatedAuthorId, now);
  const otherPost = makeMoment(mutualMomentId, new Types.ObjectId(), now);
  const reposterUserIdsByMomentId = new Map([[unrelatedMomentId.toString(), [followedAuthorId.toString()]]]);
  const { service, callCounts } = await createMomentService({
    moments: [rankedPost, otherPost],
    followingIds: [followedAuthorId.toString()],
    reposterUserIdsByMomentId,
  });

  const results = await service.listFeedMoments(viewer as never, {});
  const boosted = results.find((r) => r.id === unrelatedMomentId.toString());
  const plain = results.find((r) => r.id === mutualMomentId.toString());

  assert.ok((boosted!.smartFeedScore ?? 0) > (plain!.smartFeedScore ?? 0));
  // Exactly one batched repost lookup for the whole page, never one per candidate.
  assert.equal(callCounts.findReposterUserIdsByMomentIds, 1);
});

test("reaction lookup also stays a single batched call regardless of candidate count", async () => {
  const moments = Array.from({ length: 12 }, (_, index) => makeMoment(new Types.ObjectId(), unrelatedAuthorId, now));
  const { service, callCounts } = await createMomentService({ moments });

  await service.listFeedMoments(viewer as never, {});

  assert.equal(callCounts.findLikedUserIdsByMomentIds, 1);
});

test("repost card API contract is unchanged — no smartFeedScore/smartFeed field is added to shares", async () => {
  const { MomentService } = await momentServiceModulePromise;
  const sharedMoment = makeMoment(unrelatedMomentId, unrelatedAuthorId, now);
  const share = {
    _id: new Types.ObjectId(),
    userId: followedAuthorId,
    momentId: unrelatedMomentId,
    caption: null,
    taggedFriendIds: [] as Types.ObjectId[],
    originalType: "post" as const,
    originalId: unrelatedMomentId,
    createdAt: now,
    updatedAt: now,
  };
  const service = new MomentService(
    { findByIds: async () => [sharedMoment] } as never,
    { createDownloadUrl: async () => ({ url: "" }) } as never,
    { findByIds: async () => [makeUserDoc(unrelatedAuthorId, "author")], findById: async () => null } as never,
    { findRecent: async () => [share], countByMomentIds: async () => new Map<string, number>() } as never,
    { findFollowingIds: async () => [], findMutualFriendIds: async () => [] } as never,
    { findBlockedIds: async () => [], findBlockerIds: async () => [] } as never,
    { countByMomentIds: async () => new Map<string, number>(), findLikedMomentIds: async () => new Set<string>() } as never,
    { countByMomentIds: async () => new Map<string, number>() } as never,
    {} as never,
    { findSavedMomentIds: async () => new Set<string>() } as never,
    { findFeedVisibleByIdsForUser: async () => [], findById: async () => null } as never,
    {} as never,
    {} as never,
    undefined,
    undefined,
    { findReportedTargetIds: async () => new Set<string>(), hasReported: async () => false } as never,
    { lookup: async () => null } as never,
  );

  const shares = await service.listFeedShares(viewer as never, 50);

  assert.equal(shares.length, 1);
  assert.equal(shares[0]?.moment.smartFeedScore, undefined);
  assert.equal((shares[0]?.moment as { smartFeed?: unknown }).smartFeed, undefined);
});

// --- Event/Moment relationship parity ---

const createEventService = async (options: {
  events: Record<string, unknown>[];
  followingIds?: string[];
  mutualFriendIds?: string[];
}) => {
  const { EventService } = await eventServiceModulePromise;
  const hostIds = [...new Set(options.events.map((e) => (e.userId as Types.ObjectId).toString()))];
  const hostById = new Map(hostIds.map((id) => [id, makeUserDoc(new Types.ObjectId(id), `host-${id.slice(-4)}`)]));

  const noop = {};

  return new EventService(
    {
      findPublicFeedEvents: async () => options.events,
      findPrivateFeedEventsForUser: async () => [],
    } as never,
    { findMany: async () => [...hostById.values()], findById: async (id: string) => hostById.get(id) ?? null } as never,
    { findFollowingIds: async () => options.followingIds ?? [], findMutualFriendIds: async () => options.mutualFriendIds ?? [] } as never,
    noop as never,
    noop as never,
    noop as never,
    noop as never,
    {
      getPublicEventGoingSummaries: async () => new Map(),
      getMutualAttendeeIdsByEventIds: async () => new Map<string, Set<string>>(),
    } as never,
    noop as never,
    noop as never,
    noop as never,
    { findBlockedIds: async () => [], findBlockerIds: async () => [] } as never,
    noop as never,
    noop as never,
    { ensureEventAnnouncement: async (payload: { eventId: string }) => ({ _id: new Types.ObjectId(), eventId: payload.eventId }) } as never,
    { findLikedUserIdsByMomentIds: async () => new Map<string, string[]>(), countByMomentIds: async () => new Map(), findLikedMomentIds: async () => new Set() } as never,
    { countByMomentIds: async () => new Map() } as never,
    noop as never,
    { findReposterUserIdsByMomentIds: async () => new Map<string, string[]>(), countByMomentIds: async () => new Map() } as never,
    { findSavedMomentIds: async () => new Set<string>() } as never,
    noop as never,
    noop as never,
    noop as never,
    { getCrowdStatusByEventId: async () => new Map(), getCheckedInCountsByEventId: async () => new Map() } as never,
    undefined,
    undefined,
    { findReportedTargetIds: async () => new Set<string>(), hasReported: async () => false } as never,
    { lookup: async () => null } as never,
  );
};

const makeEvent = (id: Types.ObjectId, userId: Types.ObjectId, createdAt: Date) => ({
  _id: id,
  userId,
  status: "published",
  privacy: "public",
  name: "Event",
  categories: [],
  hashtags: [],
  memberUserIds: [],
  location: null,
  scheduledAt: createdAt,
  endAt: new Date(createdAt.getTime() + 60 * 60 * 1000),
  publishedAt: createdAt,
  createdAt,
  updatedAt: createdAt,
});

test("Event scoring now receives an author-relationship term (parity with Moments) — followed host outranks unrelated host", async () => {
  const followedHostEvent = makeEvent(new Types.ObjectId(), followedAuthorId, now);
  const unrelatedHostEvent = makeEvent(new Types.ObjectId(), unrelatedAuthorId, now);
  const service = await createEventService({
    events: [followedHostEvent, unrelatedHostEvent],
    followingIds: [followedAuthorId.toString()],
  });

  const results = await service.listFeedEvents(viewer as never, {});
  const followed = results.find((r) => r.userId === followedAuthorId.toString());
  const unrelated = results.find((r) => r.userId === unrelatedAuthorId.toString());

  assert.ok((followed!.smartFeedScore ?? 0) > (unrelated!.smartFeedScore ?? 0));
});

test("fresh own Event also gets a very strong self-relevance lift", async () => {
  const ownEvent = makeEvent(new Types.ObjectId(), new Types.ObjectId(viewerId), now);
  const otherEvent = makeEvent(new Types.ObjectId(), unrelatedAuthorId, now);
  const service = await createEventService({ events: [ownEvent, otherEvent] });

  const results = await service.listFeedEvents(viewer as never, {});
  const own = results.find((r) => r.userId === viewerId.toString());
  const other = results.find((r) => r.userId === unrelatedAuthorId.toString());

  assert.ok((own!.smartFeedScore ?? 0) > (other!.smartFeedScore ?? 0));
});

test("mutual friend host still outranks a one-way-followed host for Events", async () => {
  const followedHostEvent = makeEvent(new Types.ObjectId(), followedAuthorId, now);
  const mutualHostEvent = makeEvent(new Types.ObjectId(), mutualFriendId, now);
  const service = await createEventService({
    events: [followedHostEvent, mutualHostEvent],
    followingIds: [followedAuthorId.toString(), mutualFriendId.toString()],
    mutualFriendIds: [mutualFriendId.toString()],
  });

  const results = await service.listFeedEvents(viewer as never, {});
  const followed = results.find((r) => r.userId === followedAuthorId.toString());
  const mutual = results.find((r) => r.userId === mutualFriendId.toString());

  assert.ok((mutual!.smartFeedScore ?? 0) > (followed!.smartFeedScore ?? 0));
});
