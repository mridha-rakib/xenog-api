import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { MomentService } from "../src/modules/moments/moment.service.js";
import { MomentRepository } from "../src/modules/moments/moment.repository.js";
import type { IMoment } from "../src/modules/moments/moment.interface.js";

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

const now = new Date("2026-08-10T12:00:00.000Z");
const viewerId = new Types.ObjectId();
const mutualFriendId = new Types.ObjectId();
const followedOnlyId = new Types.ObjectId();
const unrelatedId = new Types.ObjectId();
const user = { id: viewerId.toString(), role: "user" } as never;

// Identical createdAt (freshness) and zero reactions/reposts (social) for every fixture —
// isolates the author-relationship signal so ordering unambiguously reflects the desired
// qualitative priority (self > mutual > followed > unrelated) rather than being muddied by
// freshness/social differences that are already covered by smart-feed-ranking.test.ts.
const makeMoment = (authorId: Types.ObjectId, suffix: string): IMoment =>
  ({
    _id: new Types.ObjectId(),
    userId: authorId,
    mode: "feed",
    caption: `Testing #bd ${suffix}`,
    hashtags: ["bd"],
    audience: "public",
    taggedPeople: [],
    taggedFriendIds: [],
    isEventAnnouncement: false,
    mediaItems: [],
    location: null,
    createdAt: now,
    updatedAt: now,
  }) as IMoment;

const selfMoment = makeMoment(viewerId, "self");
const mutualMoment = makeMoment(mutualFriendId, "mutual");
const followedMoment = makeMoment(followedOnlyId, "followed");
const unrelatedMoment = makeMoment(unrelatedId, "unrelated");

const emptyMapPromise = () => Promise.resolve(new Map());

const createService = () => {
  const unusedStub = new Proxy(
    {},
    { get: () => () => { throw new Error("Unexpected dependency call in this test"); } },
  );

  const momentRepository = {
    findPublicByHashtag: async () => [selfMoment, mutualMoment, followedMoment, unrelatedMoment],
  };
  const makeUser = (id: Types.ObjectId, name: string) => ({
    _id: id,
    name,
    username: name.toLowerCase(),
    avatarKey: null,
  });
  const authors = [
    makeUser(viewerId, "Self"),
    makeUser(mutualFriendId, "Mutual"),
    makeUser(followedOnlyId, "Followed"),
    makeUser(unrelatedId, "Unrelated"),
  ];
  const userRepository = {
    findByIds: async () => authors,
    findActiveUsersByIds: async () => [],
  };
  const userFollowRepository = {
    findMutualFriendIds: async () => [mutualFriendId.toString()],
    findFollowingIds: async () => [mutualFriendId.toString(), followedOnlyId.toString()],
  };
  const userBlockRepository = {
    findBlockedIds: async () => [],
    findBlockerIds: async () => [],
  };
  const momentReactionRepository = {
    countByMomentIds: emptyMapPromise,
    findLikedMomentIds: async () => new Set<string>(),
    findLikedUserIdsByMomentIds: emptyMapPromise,
  };
  const momentCommentRepository = { countByMomentIds: emptyMapPromise };
  const momentShareRepository = {
    countByMomentIds: emptyMapPromise,
    findReposterUserIdsByMomentIds: emptyMapPromise,
  };
  const momentSaveRepository = { findSavedMomentIds: async () => new Set<string>() };
  const reportRepository = { findReportedTargetIds: async () => new Set<string>() };
  const geoIpService = { lookup: async () => null };

  return new MomentService(
    momentRepository as never,
    {} as never,
    userRepository as never,
    momentShareRepository as never,
    userFollowRepository as never,
    userBlockRepository as never,
    momentReactionRepository as never,
    momentCommentRepository as never,
    {} as never,
    momentSaveRepository as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    reportRepository as never,
    geoIpService as never,
  );
};

test("hashtag-matching posts remain eligible regardless of author relationship (match-first)", async () => {
  const service = createService();
  const results = await service.listHashtagMoments("bd", user);
  const authorIds = results.map((r) => r.author?.id).sort();

  assert.deepEqual(
    authorIds,
    [viewerId.toString(), mutualFriendId.toString(), followedOnlyId.toString(), unrelatedId.toString()].sort(),
  );
});

test("hashtag-matching posts are ranked by existing Smart Feed relationship signal: self > mutual > followed > unrelated", async () => {
  const service = createService();
  const results = await service.listHashtagMoments("bd", user);

  assert.deepEqual(
    results.map((r) => r.author?.id),
    [viewerId.toString(), mutualFriendId.toString(), followedOnlyId.toString(), unrelatedId.toString()],
  );
  // smartFeedScore is populated using the existing scoring architecture — not a new field,
  // not a new weight, just the already-established optional MomentResponse field.
  assert.ok(results.every((r) => typeof r.smartFeedScore === "number"));
});

test("hashtag search does not widen eligibility beyond the exact match set returned by findPublicByHashtag", async () => {
  const service = createService();
  const results = await service.listHashtagMoments("bd", user);

  assert.equal(results.length, 4);
});

test("hashtag moment lookup query still excludes synthetic Event announcement Moments (unchanged, pre-existing behavior)", async () => {
  const repository = new MomentRepository();
  const originalFind = (await import("../src/modules/moments/moment.model.js")).MomentModel.find;
  let capturedQuery: Record<string, unknown> | undefined;
  const { MomentModel } = await import("../src/modules/moments/moment.model.js");

  MomentModel.find = ((query: Record<string, unknown>) => {
    capturedQuery = query;
    return { sort: () => ({ limit: () => Promise.resolve([]) }) };
  }) as typeof MomentModel.find;

  try {
    await repository.findPublicByHashtag("bd", 100);
  } finally {
    MomentModel.find = originalFind;
  }

  assert.deepEqual(capturedQuery?.isEventAnnouncement, { $ne: true });
  assert.equal(capturedQuery?.audience, "public");
  assert.equal(capturedQuery?.hashtags, "bd");
});
