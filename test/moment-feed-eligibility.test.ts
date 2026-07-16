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

function createMomentService(overrides: {
  momentRepository?: Record<string, unknown>;
  momentShareRepository?: Record<string, unknown>;
  eventRepository?: Record<string, unknown>;
  blockedUserIds?: string[];
} = {}): MomentService {
  const momentShareRepository = {
    findByUserId: async () => [],
    countByUserId: async () => 0,
    countByMomentIds: async () => new Map<string, number>(),
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
    { findFollowingIds: async () => [] } as never,
    { findBlockedIds: async () => overrides.blockedUserIds ?? [] } as never,
    {
      countByMomentIds: async () => new Map<string, number>(),
      countByMomentId: async () => 0,
      findLikedMomentIds: async () => new Set<string>(),
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
  );
}
