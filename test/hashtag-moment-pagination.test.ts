import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { MomentService } from "../src/modules/moments/moment.service.js";
import type { IMoment } from "../src/modules/moments/moment.interface.js";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";
// Paginated hashtag detail path does not use Smart Feed re-sorting.
process.env.ENABLE_SMART_FEED = "false";

test.afterEach(async () => {
  const { RedisClient } = await import("../src/config/redis.js");
  await RedisClient.disconnect().catch(() => undefined);
});

const viewerId = new Types.ObjectId();
const user = { id: viewerId.toString(), role: "user" } as never;

// A deterministic corpus: newest first, `_id` as the stable tiebreak. Two rows
// share a `createdAt` so the tiebreak is actually exercised.
const authorId = new Types.ObjectId();
const mk = (isoOrDate: string, idHex: string): IMoment =>
  ({
    _id: new Types.ObjectId(idHex),
    userId: authorId,
    mode: "feed",
    caption: "post #party",
    hashtags: ["party"],
    audience: "public",
    taggedPeople: [],
    taggedFriendIds: [],
    isEventAnnouncement: false,
    mediaItems: [],
    location: null,
    createdAt: new Date(isoOrDate),
    updatedAt: new Date(isoOrDate),
  }) as IMoment;

const CORPUS: IMoment[] = [
  mk("2026-03-01T00:00:00.000Z", "ffffffffffffffffffffff05"),
  mk("2026-02-01T00:00:00.000Z", "ffffffffffffffffffffff04"),
  mk("2026-01-01T00:00:00.000Z", "ffffffffffffffffffffff03"), // same createdAt as next
  mk("2026-01-01T00:00:00.000Z", "ffffffffffffffffffffff02"),
  mk("2025-12-01T00:00:00.000Z", "ffffffffffffffffffffff01"),
];

type FindArgs = { limit: number; excludeUserIds: string[]; cursor?: { createdAt: Date; id: string } };

const createService = (options: {
  corpus?: IMoment[];
  inactiveAuthorIds?: string[];
  blockedIds?: string[];
  blockerIds?: string[];
  capture?: (args: FindArgs) => void;
} = {}) => {
  const corpus = options.corpus ?? CORPUS;
  const inactive = new Set(options.inactiveAuthorIds ?? []);
  const unusedStub = new Proxy({}, { get: () => () => { throw new Error("Unexpected dependency call"); } });

  const momentRepository = {
    // Faithful mini-implementation of the real repo contract: cursor + limit
    // over the stable createdAt DESC, _id DESC order.
    findPublicByHashtag: async (
      _hashtag: string,
      limit: number,
      excludeUserIds: string[] = [],
      cursor?: { createdAt: Date; id: string },
    ) => {
      options.capture?.({ limit, excludeUserIds, cursor });
      const sorted = [...corpus].sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() ||
          b._id.toString().localeCompare(a._id.toString()),
      );
      const afterCursor = cursor
        ? sorted.filter((m) => {
            if (m.createdAt.getTime() !== cursor.createdAt.getTime()) {
              return m.createdAt.getTime() < cursor.createdAt.getTime();
            }
            return m._id.toString().localeCompare(cursor.id) < 0;
          })
        : sorted;
      return afterCursor
        .filter((m) => !excludeUserIds.includes(m.userId.toString()))
        .slice(0, limit);
    },
  };

  const userRepository = {
    findByIds: async (ids: string[]) =>
      ids.map((id) => ({ _id: new Types.ObjectId(id), name: "A", username: "a", avatarKey: null, isActive: !inactive.has(id) })),
    findActiveUsersByIds: async () => [],
  };
  const userFollowRepository = {
    findMutualFriendIds: async () => [],
    findFollowingIds: async () => [],
  };
  const userBlockRepository = {
    findBlockedIds: async () => options.blockedIds ?? [],
    findBlockerIds: async () => options.blockerIds ?? [],
  };
  const emptyMap = async () => new Map();
  const momentReactionRepository = {
    countByMomentIds: emptyMap,
    findLikedMomentIds: async () => new Set<string>(),
    findLikedUserIdsByMomentIds: emptyMap,
  };
  const momentCommentRepository = { countByMomentIds: emptyMap };
  const momentShareRepository = { countByMomentIds: emptyMap, findReposterUserIdsByMomentIds: emptyMap };
  const momentSaveRepository = { findSavedMomentIds: async () => new Set<string>() };
  const reportRepository = { findReportedTargetIds: async () => new Set<string>() };
  const geoIpService = { lookup: async () => null };

  return new MomentService(
    momentRepository as never,
    unusedStub as never,
    userRepository as never,
    momentShareRepository as never,
    userFollowRepository as never,
    userBlockRepository as never,
    momentReactionRepository as never,
    momentCommentRepository as never,
    unusedStub as never,
    momentSaveRepository as never,
    unusedStub as never,
    unusedStub as never,
    unusedStub as never,
    unusedStub as never,
    unusedStub as never,
    reportRepository as never,
    geoIpService as never,
  );
};

test("page 1 returns the first deterministic page + a nextCursor when more remain", async () => {
  const service = createService();
  const page1 = await service.listHashtagMoments("party", user, 2, {}, { paginate: true });

  assert.deepEqual(
    page1.moments.map((m) => m.id),
    ["ffffffffffffffffffffff05", "ffffffffffffffffffffff04"],
  );
  assert.equal(typeof page1.nextCursor, "string");
});

test("the nextCursor walks to the following page with NO duplicate ids, then ends", async () => {
  const service = createService();
  const page1 = await service.listHashtagMoments("party", user, 2, {}, { paginate: true });
  const page2 = await service.listHashtagMoments("party", user, 2, {}, {
    paginate: true,
    cursor: page1.nextCursor,
  });
  const page3 = await service.listHashtagMoments("party", user, 2, {}, {
    paginate: true,
    cursor: page2.nextCursor,
  });

  assert.deepEqual(page2.moments.map((m) => m.id), [
    "ffffffffffffffffffffff03",
    "ffffffffffffffffffffff02",
  ]);
  assert.deepEqual(page3.moments.map((m) => m.id), ["ffffffffffffffffffffff01"]);
  assert.equal(page3.nextCursor, null);

  const seen = [...page1.moments, ...page2.moments, ...page3.moments].map((m) => m.id);
  assert.equal(new Set(seen).size, seen.length, "no id repeats across pages");
  assert.equal(seen.length, 5, "every eligible row reachable");
});

test("_id tiebreak keeps equal-createdAt rows in a stable, non-overlapping order across pages", async () => {
  const service = createService();
  // page size 3 splits the two equal-createdAt rows across the page boundary.
  const p1 = await service.listHashtagMoments("party", user, 3, {}, { paginate: true });
  const p2 = await service.listHashtagMoments("party", user, 3, {}, { paginate: true, cursor: p1.nextCursor });

  assert.deepEqual(p1.moments.map((m) => m.id), [
    "ffffffffffffffffffffff05",
    "ffffffffffffffffffffff04",
    "ffffffffffffffffffffff03",
  ]);
  // ...02 shares createdAt with ...03 but sorts after it and is not repeated.
  assert.deepEqual(p2.moments.map((m) => m.id), [
    "ffffffffffffffffffffff02",
    "ffffffffffffffffffffff01",
  ]);
});

test("both block directions are unioned and passed to the repository as $nin ids", async () => {
  let captured: FindArgs | undefined;
  const service = createService({
    blockedIds: ["blocked-by-viewer"],
    blockerIds: ["blocked-the-viewer"],
    capture: (args) => { captured = args; },
  });
  await service.listHashtagMoments("party", user, 2, {}, { paginate: true });

  assert.ok(captured);
  assert.deepEqual(
    [...captured!.excludeUserIds].sort(),
    ["blocked-by-viewer", "blocked-the-viewer"].sort(),
  );
});

test("an inactive author's rows are dropped from the page but the cursor still advances past them", async () => {
  const service = createService({ inactiveAuthorIds: [authorId.toString()] });
  const page1 = await service.listHashtagMoments("party", user, 2, {}, { paginate: true });

  // Every row in the corpus belongs to the (now inactive) author => none render,
  // but the request still reports there is more and hands back a usable cursor.
  assert.deepEqual(page1.moments, []);
  assert.equal(typeof page1.nextCursor, "string");
});
