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
process.env.ENABLE_SMART_FEED = "false";

test.afterEach(async () => {
  const { RedisClient } = await import("../src/config/redis.js");
  await RedisClient.disconnect().catch(() => undefined);
});

const viewerId = new Types.ObjectId();
const user = { id: viewerId.toString(), role: "user" } as never;

const goodAuthor = new Types.ObjectId();
const viewerBlockedAuthor = new Types.ObjectId();
const blockerAuthor = new Types.ObjectId();
const inactiveAuthor = new Types.ObjectId();

const mk = (author: Types.ObjectId, idHex: string): IMoment =>
  ({
    _id: new Types.ObjectId(idHex),
    userId: author,
    mode: "feed",
    caption: "#party",
    hashtags: ["party"],
    audience: "public",
    taggedPeople: [],
    taggedFriendIds: [],
    isEventAnnouncement: false,
    mediaItems: [],
    location: null,
    createdAt: new Date("2026-02-01T00:00:00.000Z"),
    updatedAt: new Date("2026-02-01T00:00:00.000Z"),
  }) as IMoment;

const CORPUS = [
  mk(goodAuthor, "bbbbbbbbbbbbbbbbbbbbbb01"),
  mk(viewerBlockedAuthor, "bbbbbbbbbbbbbbbbbbbbbb02"),
  mk(blockerAuthor, "bbbbbbbbbbbbbbbbbbbbbb03"),
  mk(inactiveAuthor, "bbbbbbbbbbbbbbbbbbbbbb04"),
];

const buildService = () => {
  const unusedStub = new Proxy({}, { get: () => () => { throw new Error("Unexpected dependency call"); } });
  const momentRepository = {
    findPublicByHashtag: async (_h: string, limit: number, excludeUserIds: string[] = []) =>
      CORPUS.filter((m) => !excludeUserIds.includes(m.userId.toString())).slice(0, limit),
  };
  const userRepository = {
    findByIds: async (ids: string[]) =>
      ids.map((id) => ({
        _id: new Types.ObjectId(id),
        name: "A",
        username: "a",
        avatarKey: null,
        isActive: id !== inactiveAuthor.toString(),
      })),
    findActiveUsersByIds: async () => [],
  };
  const userFollowRepository = { findMutualFriendIds: async () => [], findFollowingIds: async () => [] };
  const userBlockRepository = {
    findBlockedIds: async () => [viewerBlockedAuthor.toString()],
    findBlockerIds: async () => [blockerAuthor.toString()],
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

test("hashtag Moments exclude blocked (either direction) and inactive authors; keep the eligible one", async () => {
  const service = buildService();
  const { moments } = await service.listHashtagMoments("party", user, 50);
  const ids = moments.map((m) => m.id);

  assert.deepEqual(ids, ["bbbbbbbbbbbbbbbbbbbbbb01"]);
  assert.ok(!ids.includes("bbbbbbbbbbbbbbbbbbbbbb02"), "viewer-blocked author excluded");
  assert.ok(!ids.includes("bbbbbbbbbbbbbbbbbbbbbb03"), "author-blocked-viewer excluded");
  assert.ok(!ids.includes("bbbbbbbbbbbbbbbbbbbbbb04"), "inactive author excluded");
});
