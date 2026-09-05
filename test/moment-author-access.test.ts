import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import type { AuthUser } from "../src/modules/auth/auth.interface.js";
import { MomentService } from "../src/modules/moments/moment.service.js";

// ── Part 4: a viewer must not read or interact with another user's
// (non-event) Moment when either side has blocked the other, or the author
// is suspended / deleted. Pure stubs, no DB. ─────────────────────────────

process.env.NODE_ENV = "test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const viewerId = new Types.ObjectId().toString();

const makeViewer = (id = viewerId): AuthUser => ({
  id,
  name: "Viewer",
  username: "viewer",
  email: "viewer@example.test",
  accountType: "personal",
  currentLocationSharingEnabled: false,
  notificationsEnabled: true,
  role: "user",
  isActive: true,
  emailVerified: true,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
});

type AuthorOverrides = { isActive?: boolean; role?: string; deletedAt?: Date | null };

const makeMoment = (authorId: string, overrides: { audience?: "public" | "friends" | "only_me"; isEventAnnouncement?: boolean } = {}) => ({
  _id: new Types.ObjectId(),
  userId: new Types.ObjectId(authorId),
  mode: "feed",
  caption: "Hello",
  hashtags: [],
  audience: overrides.audience ?? "public",
  taggedPeople: [],
  taggedFriendIds: [],
  isEventAnnouncement: overrides.isEventAnnouncement ?? false,
  eventId: null,
  mediaItems: [],
  location: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
});

const makeAuthorUser = (authorId: string, overrides: AuthorOverrides = {}) => ({
  _id: new Types.ObjectId(authorId),
  name: "Author",
  username: "author",
  avatarKey: null,
  role: overrides.role ?? "user",
  isActive: overrides.isActive ?? true,
  deletedAt: overrides.deletedAt ?? null,
});

const createService = (options: {
  moment: ReturnType<typeof makeMoment>;
  author: ReturnType<typeof makeAuthorUser> | null;
  blocks?: Array<{ blockerId: string; blockedId: string }>;
}) => {
  const blocks = options.blocks ?? [];
  const emptyMap = async () => new Map<string, number>();

  const momentRepository = { findById: async () => options.moment };
  const storageService = { createDownloadUrl: async () => ({ url: "" }) };
  const userRepository = {
    findById: async (id: string) =>
      options.author && options.author._id.toString() === id ? options.author : null,
    findByIds: async () => (options.author ? [options.author] : []),
  };
  const momentShareRepository = {
    countByMomentIds: emptyMap,
    findReposterUserIdsByMomentIds: async () => new Map<string, string[]>(),
  };
  const userFollowRepository = { findFollowingIds: async () => [], findMutualFriendIds: async () => [] };
  const userBlockRepository = {
    isBlocked: async (blockerId: string, blockedId: string) =>
      blocks.some((b) => b.blockerId === blockerId && b.blockedId === blockedId),
    findBlockedIds: async (blockerId: string) => blocks.filter((b) => b.blockerId === blockerId).map((b) => b.blockedId),
    findBlockerIds: async (blockedId: string) => blocks.filter((b) => b.blockedId === blockedId).map((b) => b.blockerId),
  };
  const momentReactionRepository = {
    countByMomentIds: emptyMap,
    countByMomentId: async () => 0,
    findLikedMomentIds: async () => new Set<string>(),
    findLikedUserIdsByMomentIds: async () => new Map<string, string[]>(),
  };
  const momentCommentRepository = { countByMomentIds: emptyMap, countByMomentId: async () => 0 };
  const momentSaveRepository = {
    findSavedMomentIds: async () => new Set<string>(),
    toggleSave: async () => ({ isSaved: true }),
  };
  const reportRepository = { findReportedTargetIds: async () => new Set<string>(), hasReported: async () => false };

  return new MomentService(
    momentRepository as never,
    storageService as never,
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
    undefined,
    undefined,
    reportRepository as never,
  );
};

// ---------------------------------------------------------------------------
// toggleMomentSave (routes through getViewableMoment)
// ---------------------------------------------------------------------------

test("toggleMomentSave succeeds for a normal public post by an active author", async () => {
  const authorId = new Types.ObjectId().toString();
  const moment = makeMoment(authorId);
  const service = createService({ moment, author: makeAuthorUser(authorId) });

  const result = await service.toggleMomentSave(moment._id.toString(), makeViewer());
  assert.equal(result.isSaved, true);
});

test("toggleMomentSave 404s when the viewer has blocked the author", async () => {
  const authorId = new Types.ObjectId().toString();
  const moment = makeMoment(authorId);
  const service = createService({
    moment,
    author: makeAuthorUser(authorId),
    blocks: [{ blockerId: viewerId, blockedId: authorId }],
  });

  await assert.rejects(() => service.toggleMomentSave(moment._id.toString(), makeViewer()), /Moment not found/);
});

test("toggleMomentSave 404s when the author has blocked the viewer", async () => {
  const authorId = new Types.ObjectId().toString();
  const moment = makeMoment(authorId);
  const service = createService({
    moment,
    author: makeAuthorUser(authorId),
    blocks: [{ blockerId: authorId, blockedId: viewerId }],
  });

  await assert.rejects(() => service.toggleMomentSave(moment._id.toString(), makeViewer()), /Moment not found/);
});

test("toggleMomentSave 404s when the author is suspended", async () => {
  const authorId = new Types.ObjectId().toString();
  const moment = makeMoment(authorId);
  const service = createService({ moment, author: makeAuthorUser(authorId, { isActive: false }) });

  await assert.rejects(() => service.toggleMomentSave(moment._id.toString(), makeViewer()), /Moment not found/);
});

test("toggleMomentSave 404s when the author is deleted", async () => {
  const authorId = new Types.ObjectId().toString();
  const moment = makeMoment(authorId);
  const service = createService({ moment, author: makeAuthorUser(authorId, { deletedAt: new Date() }) });

  await assert.rejects(() => service.toggleMomentSave(moment._id.toString(), makeViewer()), /Moment not found/);
});

test("the author can still interact with their own post while suspended-looking data is irrelevant", async () => {
  const moment = makeMoment(viewerId);
  const service = createService({ moment, author: makeAuthorUser(viewerId) });

  const result = await service.toggleMomentSave(moment._id.toString(), makeViewer());
  assert.equal(result.isSaved, true);
});

// ---------------------------------------------------------------------------
// getMoment
// ---------------------------------------------------------------------------

test("getMoment 404s across a block in either direction", async () => {
  const authorId = new Types.ObjectId().toString();
  const moment = makeMoment(authorId);

  const blockedByViewer = createService({
    moment,
    author: makeAuthorUser(authorId),
    blocks: [{ blockerId: viewerId, blockedId: authorId }],
  });
  await assert.rejects(() => blockedByViewer.getMoment(moment._id.toString(), makeViewer()), /Moment not found/);

  const blockedViewer = createService({
    moment,
    author: makeAuthorUser(authorId),
    blocks: [{ blockerId: authorId, blockedId: viewerId }],
  });
  await assert.rejects(() => blockedViewer.getMoment(moment._id.toString(), makeViewer()), /Moment not found/);
});

test("getMoment 404s for a suspended author", async () => {
  const authorId = new Types.ObjectId().toString();
  const moment = makeMoment(authorId);
  const service = createService({ moment, author: makeAuthorUser(authorId, { isActive: false }) });

  await assert.rejects(() => service.getMoment(moment._id.toString(), makeViewer()), /Moment not found/);
});
