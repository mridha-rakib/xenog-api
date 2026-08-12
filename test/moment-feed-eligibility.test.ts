import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { EventModel } from "../src/modules/events/event.model.js";
import { MomentModel } from "../src/modules/moments/moment.model.js";
import { MomentRepository } from "../src/modules/moments/moment.repository.js";
import { MomentService } from "../src/modules/moments/moment.service.js";
import { EventRepository } from "../src/modules/events/event.repository.js";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

type MomentFixture = {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  mode: "feed" | "event";
  caption: string | null;
  hashtags: string[];
  audience: "public" | "friends" | "only_me";
  taggedPeople: string[];
  taggedFriendIds: Types.ObjectId[];
  eventTitle: string | null;
  eventId: Types.ObjectId | null;
  isEventAnnouncement?: boolean;
  eventCode: string | null;
  mediaItems: [];
  createdAt: Date;
  updatedAt: Date;
};

type EventFixture = {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  status: "draft" | "published" | "live" | "completed" | "cancelled";
  privacy: "public" | "locked" | "private";
  name: string;
  memberUserIds: string[];
  scheduledAt: Date;
  endAt: Date;
  publishedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

const viewerId = new Types.ObjectId();
const authorId = new Types.ObjectId();
const otherAuthorId = new Types.ObjectId();
const blockedAuthorId = new Types.ObjectId();
const publicEventId = new Types.ObjectId();
const privateEventId = new Types.ObjectId();
const hiddenEventId = new Types.ObjectId();
const now = new Date("2026-07-16T12:00:00.000Z");

const viewer = {
  id: viewerId.toString(),
  name: "Viewer",
  username: "viewer",
  email: "viewer@example.com",
  accountType: "personal",
  currentLocationSharingEnabled: false,
  notificationsEnabled: true,
  role: "user",
  isActive: true,
  emailVerified: true,
  createdAt: now,
  updatedAt: now,
};

const author = {
  _id: authorId,
  name: "Post Author",
  username: "author",
  email: "author@example.com",
  accountType: "personal",
  avatarKey: null,
  avatarUrl: null,
  role: "user",
  isActive: true,
  emailVerified: true,
  createdAt: now,
  updatedAt: now,
};

const makeMoment = (overrides: Partial<MomentFixture> = {}): MomentFixture => ({
  _id: overrides._id ?? new Types.ObjectId(),
  userId: overrides.userId ?? authorId,
  mode: overrides.mode ?? "feed",
  caption: overrides.caption ?? "Feed post",
  hashtags: overrides.hashtags ?? [],
  audience: overrides.audience ?? "public",
  taggedPeople: overrides.taggedPeople ?? [],
  taggedFriendIds: overrides.taggedFriendIds ?? [],
  eventTitle: overrides.eventTitle ?? null,
  eventId: overrides.eventId ?? null,
  isEventAnnouncement: overrides.isEventAnnouncement,
  eventCode: overrides.eventCode ?? null,
  mediaItems: [],
  createdAt: overrides.createdAt ?? now,
  updatedAt: overrides.updatedAt ?? now,
});

const makeEvent = (
  id: Types.ObjectId,
  privacy: "public" | "locked" | "private" = "public",
  overrides: Partial<EventFixture> = {},
): EventFixture => ({
  _id: id,
  userId: overrides.userId ?? authorId,
  status: overrides.status ?? "published",
  privacy,
  name: overrides.name ?? `${privacy} event`,
  memberUserIds: overrides.memberUserIds ?? [],
  scheduledAt: overrides.scheduledAt ?? now,
  endAt: overrides.endAt ?? new Date("2026-07-16T15:00:00.000Z"),
  publishedAt: overrides.publishedAt ?? now,
  createdAt: overrides.createdAt ?? now,
  updatedAt: overrides.updatedAt ?? now,
});

const getId = (value: unknown): string | null => {
  if (!value) return null;
  return typeof value === "string" ? value : (value as { toString: () => string }).toString();
};

const matchesBranch = (moment: MomentFixture, branch: Record<string, unknown>): boolean => {
  if (branch.mode && moment.mode !== branch.mode) return false;

  const eventFilter = branch.eventId as { $in?: unknown[] } | undefined;
  if (eventFilter?.$in && !eventFilter.$in.map(getId).includes(moment.eventId?.toString() ?? null)) {
    return false;
  }

  const announcementFilter = branch.isEventAnnouncement as { $ne?: boolean } | undefined;
  if (announcementFilter?.$ne === true && moment.isEventAnnouncement === true) {
    return false;
  }

  return true;
};

const matchesFilter = (moment: MomentFixture, filter: Record<string, unknown>): boolean => {
  if (filter.audience && moment.audience !== filter.audience) return false;

  const userFilter = filter.userId as { $nin?: unknown[] } | undefined;
  if (userFilter?.$nin?.map(getId).includes(moment.userId.toString())) return false;
  if (userFilter?.$in && !userFilter.$in.map(getId).includes(moment.userId.toString())) return false;

  const hashtagFilter = filter.hashtags as { $all?: string[] } | undefined;
  if (hashtagFilter?.$all?.some((hashtag) => !moment.hashtags.includes(hashtag))) return false;

  if (filter.mode && moment.mode !== filter.mode) return false;

  const eventFilter = filter.eventId as { $ne?: null } | undefined;
  if (eventFilter?.$ne === null && moment.eventId === null) return false;

  const announcementFilter = filter.isEventAnnouncement as { $ne?: boolean } | undefined;
  if (announcementFilter?.$ne === true && moment.isEventAnnouncement === true) return false;

  const branches = filter.$or as Record<string, unknown>[] | undefined;
  if (branches && !branches.some((branch) => matchesBranch(moment, branch))) return false;

  return true;
};

const withMockedMomentFind = async (
  moments: MomentFixture[],
  run: () => Promise<void>,
): Promise<void> => {
  const originalFind = MomentModel.find.bind(MomentModel);

  MomentModel.find = ((filter: Record<string, unknown>) => {
    const matched = moments.filter((moment) => matchesFilter(moment, filter));

    return {
      distinct(field: string) {
        if (field !== "eventId") return [];

        return [...new Set(matched.map((moment) => moment.eventId).filter(Boolean).map((eventId) => eventId!.toString()))];
      },
      sort() {
        const sorted = [...matched].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());

        return {
          limit(limit: number) {
            return limit ? sorted.slice(0, limit) : sorted;
          },
        };
      },
    };
  }) as typeof MomentModel.find;

  try {
    await run();
  } finally {
    MomentModel.find = originalFind as typeof MomentModel.find;
  }
};

const matchesEventField = (event: EventFixture, key: string, expected: unknown): boolean => {
  if (key === "_id") {
    const ids = (expected as { $in?: unknown[] }).$in;
    return Array.isArray(ids) && ids.map(getId).includes(event._id.toString());
  }

  if (key === "status") {
    const statuses = (expected as { $in?: unknown[] }).$in;
    return Array.isArray(statuses) && statuses.includes(event.status);
  }

  if (key === "privacy") {
    if (typeof expected === "string") return event.privacy === expected;

    const privacyValues = (expected as { $in?: unknown[] }).$in;
    return Array.isArray(privacyValues) && privacyValues.includes(event.privacy);
  }

  if (key === "userId") {
    if (typeof expected === "string") return event.userId.toString() === expected;

    const excludedIds = (expected as { $nin?: unknown[] }).$nin;
    if (Array.isArray(excludedIds)) return !excludedIds.map(getId).includes(event.userId.toString());
  }

  if (key === "memberUserIds") {
    return event.memberUserIds.includes(String(expected));
  }

  return true;
};

const matchesEventQuery = (event: EventFixture, query: Record<string, unknown>): boolean => {
  const andConditions = query.$and as Record<string, unknown>[] | undefined;
  if (andConditions && !andConditions.every((condition) => matchesEventQuery(event, condition))) return false;

  const orConditions = query.$or as Record<string, unknown>[] | undefined;
  if (orConditions && !orConditions.some((condition) => matchesEventQuery(event, condition))) return false;

  return Object.entries(query).every(([key, expected]) => (
    key === "$and" || key === "$or" || matchesEventField(event, key, expected)
  ));
};

const withMockedEventFind = async (
  events: EventFixture[],
  run: () => Promise<void>,
): Promise<void> => {
  const originalFind = EventModel.find.bind(EventModel);

  EventModel.find = ((query: Record<string, unknown>) => (
    events.filter((event) => matchesEventQuery(event, query))
  )) as typeof EventModel.find;

  try {
    await run();
  } finally {
    EventModel.find = originalFind as typeof EventModel.find;
  }
};

test("feed repository includes normal feed posts and eligible event-tagged posts before applying limit", async () => {
  const newestAnnouncement = makeMoment({
    mode: "event",
    eventId: publicEventId,
    isEventAnnouncement: true,
    caption: "Automatic event announcement",
    createdAt: new Date("2026-07-16T12:05:00.000Z"),
  });
  const hiddenEventPost = makeMoment({
    mode: "event",
    eventId: hiddenEventId,
    caption: "Hidden event post",
    createdAt: new Date("2026-07-16T12:04:00.000Z"),
  });
  const eligibleEventPost = makeMoment({
    mode: "event",
    eventId: publicEventId,
    eventTitle: "Public event",
    caption: "Public event post",
    createdAt: new Date("2026-07-16T12:03:00.000Z"),
  });
  const normalFeedPost = makeMoment({
    caption: "Normal feed post",
    createdAt: new Date("2026-07-16T12:02:00.000Z"),
  });
  const olderFeedPost = makeMoment({
    caption: "Older normal feed post",
    createdAt: new Date("2026-07-16T12:01:00.000Z"),
  });

  await withMockedMomentFind(
    [newestAnnouncement, hiddenEventPost, eligibleEventPost, normalFeedPost, olderFeedPost],
    async () => {
      const moments = await new MomentRepository().findFeed({
        visibleEventIds: [publicEventId.toString()],
        limit: 2,
      });

      assert.deepEqual(
        moments.map((moment) => moment._id.toString()),
        [eligibleEventPost._id.toString(), normalFeedPost._id.toString()],
      );
    },
  );
});

test("feed repository applies hashtag and blocked-user filtering to event-tagged posts", async () => {
  const matchingEventPost = makeMoment({
    mode: "event",
    eventId: publicEventId,
    caption: "Launch post",
    hashtags: ["launch"],
  });
  const blockedEventPost = makeMoment({
    userId: blockedAuthorId,
    mode: "event",
    eventId: publicEventId,
    caption: "Blocked launch post",
    hashtags: ["launch"],
    createdAt: new Date("2026-07-16T12:01:00.000Z"),
  });
  const nonMatchingNormalPost = makeMoment({
    caption: "Different topic",
    hashtags: ["other"],
    createdAt: new Date("2026-07-16T12:02:00.000Z"),
  });

  await withMockedMomentFind(
    [matchingEventPost, blockedEventPost, nonMatchingNormalPost],
    async () => {
      const moments = await new MomentRepository().findFeed({
        visibleEventIds: [publicEventId.toString()],
        excludeUserIds: [blockedAuthorId.toString()],
        hashtags: ["launch"],
      });

      assert.deepEqual(moments.map((moment) => moment._id.toString()), [matchingEventPost._id.toString()]);
    },
  );
});

test("feed service resolves event-tagged post visibility from candidate moment event IDs", async () => {
  const normalFeedPost = makeMoment({ caption: "Normal feed post" });
  const publicEventPost = makeMoment({
    mode: "event",
    eventId: publicEventId,
    eventTitle: "Public event",
    caption: "Public event post",
  });
  const privateEventPost = makeMoment({
    mode: "event",
    eventId: privateEventId,
    eventTitle: "Private event",
    caption: "Private event post",
  });
  const hiddenEventPost = makeMoment({
    mode: "event",
    eventId: hiddenEventId,
    eventTitle: "Draft event",
    caption: "Hidden event post",
  });
  const blockedEventPost = makeMoment({
    userId: blockedAuthorId,
    mode: "event",
    eventId: publicEventId,
    eventTitle: "Public event",
    caption: "Blocked author event post",
  });
  const service = createMomentService({
    momentRepository: new MomentRepository() as never,
    eventRepository: new EventRepository() as never,
    blockedUserIds: [blockedAuthorId.toString()],
  });

  await withMockedMomentFind(
    [normalFeedPost, publicEventPost, privateEventPost, hiddenEventPost, blockedEventPost],
    async () => {
      await withMockedEventFind(
        [
          makeEvent(publicEventId, "public"),
          makeEvent(privateEventId, "private", { memberUserIds: [viewerId.toString()] }),
          makeEvent(hiddenEventId, "public", { status: "draft" }),
        ],
        async () => {
          const moments = await service.listFeedMoments(viewer as never);

          assert.deepEqual(moments.map((moment) => moment.id), [
            normalFeedPost._id.toString(),
            publicEventPost._id.toString(),
            privateEventPost._id.toString(),
          ]);
        },
      );
    },
  );
});

test("friends feed moments use mutual friend authors for normal and event-tagged posts", async () => {
  const friendFeedPost = makeMoment({
    userId: authorId,
    caption: "Friend feed post",
    createdAt: new Date("2026-07-16T12:03:00.000Z"),
  });
  const friendEventPost = makeMoment({
    userId: authorId,
    mode: "event",
    eventId: publicEventId,
    eventTitle: "Public friend event",
    caption: "Friend event post",
    createdAt: new Date("2026-07-16T12:02:00.000Z"),
  });
  const discoverAuthorPost = makeMoment({
    userId: otherAuthorId,
    caption: "Discover-only author post",
    createdAt: new Date("2026-07-16T12:04:00.000Z"),
  });
  const service = createMomentService({
    momentRepository: new MomentRepository() as never,
    eventRepository: new EventRepository() as never,
    friendUserIds: [authorId.toString()],
  });

  await withMockedMomentFind(
    [discoverAuthorPost, friendFeedPost, friendEventPost],
    async () => {
      await withMockedEventFind([makeEvent(publicEventId, "public")], async () => {
        const moments = await service.listFeedMoments(viewer as never, { audience: "friends" });

        assert.deepEqual(moments.map((moment) => moment.id), [
          friendFeedPost._id.toString(),
          friendEventPost._id.toString(),
        ]);
      });
    },
  );
});

test("friends feed includes the viewer's own eligible Moments alongside mutual friends' Moments", async () => {
  const ownPost = makeMoment({
    userId: viewerId,
    caption: "My own post",
    createdAt: new Date("2026-07-16T12:05:00.000Z"),
  });
  const mutualFriendPost = makeMoment({
    userId: authorId,
    caption: "Mutual friend post",
    createdAt: new Date("2026-07-16T12:04:00.000Z"),
  });
  const oneWayFollowedOnlyPost = makeMoment({
    userId: otherAuthorId,
    caption: "One-way-followed-only post (A follows this author, they do not follow back)",
    createdAt: new Date("2026-07-16T12:03:00.000Z"),
  });
  const unrelatedPost = makeMoment({
    userId: blockedAuthorId,
    caption: "Unrelated author post",
    createdAt: new Date("2026-07-16T12:02:00.000Z"),
  });
  const service = createMomentService({
    momentRepository: new MomentRepository() as never,
    eventRepository: new EventRepository() as never,
    // Only authorId is a mutual friend — otherAuthorId/blockedAuthorId are
    // deliberately NOT mutual (simulating one-way-follow-only and unrelated
    // authors), proving Friends eligibility never widens to "everyone I follow".
    friendUserIds: [authorId.toString()],
  });

  await withMockedMomentFind(
    [ownPost, mutualFriendPost, oneWayFollowedOnlyPost, unrelatedPost],
    async () => {
      const moments = await service.listFeedMoments(viewer as never, { audience: "friends" });

      assert.deepEqual(
        moments.map((moment) => moment.id).sort(),
        [ownPost._id.toString(), mutualFriendPost._id.toString()].sort(),
      );
    },
  );
});

test("friends feed excludes a reverse one-way follow (B follows A, A does not follow B)", async () => {
  // From A's perspective, B following A but not vice versa is still not a
  // mutual relationship — findMutualFriendIds (reciprocal) intentionally
  // returns nothing for B here, exactly like any other one-way relationship.
  const reverseFollowerPost = makeMoment({
    userId: otherAuthorId,
    caption: "Reverse one-way follower's post",
  });
  const service = createMomentService({
    momentRepository: new MomentRepository() as never,
    eventRepository: new EventRepository() as never,
    friendUserIds: [],
  });

  await withMockedMomentFind([reverseFollowerPost], async () => {
    const moments = await service.listFeedMoments(viewer as never, { audience: "friends" });

    assert.deepEqual(moments, []);
  });
});

test("friends feed still ranks self and mutual-friend candidates through Smart Feed, not a fixed self-first order", async () => {
  // Smart Feed's freshnessScore is computed against the real wall clock
  // (calculateFreshnessScore(createdAt, new Date())), not this file's fixed
  // 2026-07-16 fixture "now" used elsewhere for query-matching only — so
  // this test uses the actual current time to represent "both posted just
  // now", the scenario the assertion below is about.
  const justNow = new Date();
  const freshOwnPost = makeMoment({
    userId: viewerId,
    caption: "Fresh own post",
    createdAt: justNow,
  });
  const sameInstantMutualPost = makeMoment({
    userId: authorId,
    caption: "Same-instant mutual friend post",
    createdAt: justNow,
  });
  const service = createMomentService({
    momentRepository: new MomentRepository() as never,
    eventRepository: new EventRepository() as never,
    friendUserIds: [authorId.toString()],
  });

  await withMockedMomentFind([freshOwnPost, sameInstantMutualPost], async () => {
    const moments = await service.listFeedMoments(viewer as never, { audience: "friends" });

    assert.equal(moments.length, 2);
    // Both are eligible (self + mutual friend) — self relevance legitimately
    // outranks a same-instant mutual-friend post with no other signals yet,
    // proving ranking (not a hardcoded self-first array append) placed it
    // there: the ordering is a consequence of smartFeedScore, not position.
    const own = moments.find((m) => m.id === freshOwnPost._id.toString());
    const mutual = moments.find((m) => m.id === sameInstantMutualPost._id.toString());
    assert.ok((own?.smartFeedScore ?? 0) > (mutual?.smartFeedScore ?? 0));
    assert.equal(moments[0]?.id, freshOwnPost._id.toString());
  });
});

test("discover feed is unaffected by the Friends self-eligibility change", async () => {
  const ownPost = makeMoment({ userId: viewerId, caption: "My own post" });
  const unrelatedPost = makeMoment({ userId: otherAuthorId, caption: "Unrelated post" });
  const service = createMomentService({
    momentRepository: new MomentRepository() as never,
    eventRepository: new EventRepository() as never,
  });

  await withMockedMomentFind([ownPost, unrelatedPost], async () => {
    const moments = await service.listFeedMoments(viewer as never, {});

    // Discover has no author restriction at all — both remain eligible,
    // exactly as before this change.
    assert.deepEqual(
      moments.map((moment) => moment.id).sort(),
      [ownPost._id.toString(), unrelatedPost._id.toString()].sort(),
    );
  });
});

test("friends feed shares keep only reposts created by mutual friends", async () => {
  const friendMoment = makeMoment({ caption: "Friend shared moment" });
  const discoverMoment = makeMoment({ userId: otherAuthorId, caption: "Discover shared moment" });
  const friendShare = {
    _id: new Types.ObjectId(),
    userId: authorId,
    momentId: friendMoment._id,
    caption: null,
    taggedFriendIds: [],
    originalType: "post",
    originalId: friendMoment._id,
    createdAt: new Date("2026-07-16T12:03:00.000Z"),
    updatedAt: new Date("2026-07-16T12:03:00.000Z"),
  };
  const discoverShare = {
    _id: new Types.ObjectId(),
    userId: otherAuthorId,
    momentId: discoverMoment._id,
    caption: null,
    taggedFriendIds: [],
    originalType: "post",
    originalId: discoverMoment._id,
    createdAt: new Date("2026-07-16T12:04:00.000Z"),
    updatedAt: new Date("2026-07-16T12:04:00.000Z"),
  };
  const service = createMomentService({
    momentRepository: {
      findByIds: async () => [friendMoment, discoverMoment],
    },
    momentShareRepository: {
      findRecent: async () => [discoverShare, friendShare],
    },
    friendUserIds: [authorId.toString()],
  });

  const shares = await service.listFeedShares(viewer as never, 50, "friends");

  assert.deepEqual(shares.map((share) => share.id), [friendShare._id.toString()]);
});

test("profile timeline keeps authored event-tagged posts", async () => {
  const eventPost = makeMoment({
    mode: "event",
    eventId: publicEventId,
    eventTitle: "Public event",
    caption: "Profile event post",
  });
  const momentRepository = {
    findByUserIdForProfile: async () => [eventPost],
    countByUserId: async () => 1,
    findByIds: async () => [],
  };
  const momentShareRepository = {
    findByUserId: async () => [],
    countByUserId: async () => 0,
    countByMomentIds: async () => new Map<string, number>(),
  };
  const service = createMomentService({ momentRepository, momentShareRepository });

  const timeline = await service.getProfileTimeline(authorId.toString(), viewer as never);

  assert.equal(timeline.items.length, 1);
  assert.equal(timeline.items[0]?.moment.id, eventPost._id.toString());
  assert.equal(timeline.items[0]?.moment.mode, "event");
  assert.equal(timeline.items[0]?.moment.eventId, publicEventId.toString());
});

test("feed marks hasReported true only for the viewer's own already-reported post, batched in a single query", async () => {
  const reportedPost = makeMoment({ caption: "Reported by viewer" });
  const otherPost = makeMoment({ caption: "Not reported by viewer" });
  const callCount = { findReportedTargetIds: 0 };
  const service = createMomentService({
    momentRepository: new MomentRepository() as never,
    eventRepository: new EventRepository() as never,
    reportedMomentIds: [reportedPost._id.toString()],
    reportRepositoryCallCount: callCount,
  });

  await withMockedMomentFind([reportedPost, otherPost], async () => {
    const moments = await service.listFeedMoments(viewer as never);
    const reportedResult = moments.find((moment) => moment.id === reportedPost._id.toString());
    const otherResult = moments.find((moment) => moment.id === otherPost._id.toString());

    assert.equal(reportedResult?.hasReported, true);
    assert.equal(otherResult?.hasReported, false);
    // One batched query for the whole page — never one query per Feed item
    // (no N+1), regardless of how many moments were returned.
    assert.equal(callCount.findReportedTargetIds, 1);
  });
});

test("another user's report of a post does not mark the current viewer as having reported it", async () => {
  const post = makeMoment({ caption: "Reported by someone else, not the viewer" });
  const service = createMomentService({
    momentRepository: new MomentRepository() as never,
    eventRepository: new EventRepository() as never,
    // Simulates a different reporter's Report row existing for this post —
    // the fake only returns ids for the id set explicitly passed in for
    // *this* viewer's own reported ids, so a non-empty reportedMomentIds
    // list scoped to a different id proves cross-viewer isolation.
    reportedMomentIds: [new Types.ObjectId().toString()],
  });

  await withMockedMomentFind([post], async () => {
    const moments = await service.listFeedMoments(viewer as never);

    assert.equal(moments[0]?.hasReported, false);
  });
});

function createMomentService(overrides: {
  momentRepository?: Record<string, unknown>;
  momentShareRepository?: Record<string, unknown>;
  eventRepository?: Record<string, unknown>;
  blockedUserIds?: string[];
  friendUserIds?: string[];
  reportedMomentIds?: string[];
  reportRepositoryCallCount?: { findReportedTargetIds: number };
} = {}): MomentService {
  const momentShareRepository = {
    findByUserId: async () => [],
    countByUserId: async () => 0,
    countByMomentIds: async () => new Map<string, number>(),
    findReposterUserIdsByMomentIds: async () => new Map<string, string[]>(),
    ...overrides.momentShareRepository,
  };

  return new MomentService(
    overrides.momentRepository as never,
    { createDownloadUrl: async () => ({ url: "" }) } as never,
    {
      findByIds: async () => [author],
      findById: async () => author,
    } as never,
    momentShareRepository as never,
    {
      findFollowingIds: async () => [],
      findMutualFriendIds: async () => overrides.friendUserIds ?? [],
    } as never,
    {
      findBlockedIds: async () => overrides.blockedUserIds ?? [],
      findBlockerIds: async () => [],
      isBlocked: async (blockerId: string, blockedId: string) =>
        blockerId === viewer.id && (overrides.blockedUserIds ?? []).includes(blockedId),
    } as never,
    {
      countByMomentIds: async () => new Map<string, number>(),
      countByMomentId: async () => 0,
      findLikedMomentIds: async () => new Set<string>(),
      findLikedUserIdsByMomentIds: async () => new Map<string, string[]>(),
    } as never,
    {
      countByMomentIds: async () => new Map<string, number>(),
      countByMomentId: async () => 0,
    } as never,
    {} as never,
    { findSavedMomentIds: async () => new Set<string>() } as never,
    overrides.eventRepository as never,
    {} as never,
    {} as never,
    undefined,
    undefined,
    {
      findReportedTargetIds: async () => {
        if (overrides.reportRepositoryCallCount) {
          overrides.reportRepositoryCallCount.findReportedTargetIds += 1;
        }
        return new Set(overrides.reportedMomentIds ?? []);
      },
      hasReported: async () => false,
    } as never,
  );
}
