import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import type { AuthUser } from "../src/modules/auth/auth.interface.js";
import { StoryService } from "../src/modules/stories/story.service.js";

// ── Part 6: Stories privacy — blocked (either direction) or suspended /
// deleted authors are hidden from lists and rejected on direct access.
// Pure stubs, no DB. ──────────────────────────────────────────────────────

process.env.NODE_ENV = "test";

const viewerId = new Types.ObjectId().toString();

const makeViewer = (): AuthUser => ({
  id: viewerId,
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

const makeStory = (authorId: string, authorName: string, authorOverrides: AuthorOverrides = {}) => ({
  _id: new Types.ObjectId(),
  userId: {
    _id: new Types.ObjectId(authorId),
    name: authorName,
    username: authorName.toLowerCase(),
    avatarKey: null,
    isActive: authorOverrides.isActive ?? true,
    role: authorOverrides.role ?? "user",
    deletedAt: authorOverrides.deletedAt ?? null,
  },
  mediaType: "image" as const,
  mediaSource: "gallery" as const,
  storageKey: null,
  contentType: null,
  durationSeconds: 5,
  caption: null,
  textContent: null,
  textBackground: null,
  textOverlay: null,
  imageTransform: null,
  audience: "connections" as const,
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
});

const createService = (options: {
  stories: ReturnType<typeof makeStory>[];
  blockedIds?: string[];
  blockerIds?: string[];
}) => {
  const storyById = new Map(options.stories.map((story) => [story._id.toString(), story]));

  const storyRepository = {
    findAllActive: async () => options.stories,
    findActiveByUserId: async (userId: string) =>
      options.stories.filter((story) => story.userId._id.toString() === userId),
    findActiveByViewerNetwork: async (userIds: string[]) =>
      options.stories.filter((story) => userIds.includes(story.userId._id.toString())),
    findActiveById: async (id: string) => storyById.get(id) ?? null,
    getInteraction: async () => ({ viewsCount: 0, reactionsCount: 0, commentsCount: 0, isReacted: false }),
    recordView: async () => undefined,
    toggleReaction: async () => true,
    findComments: async () => [],
  };

  const userBlockRepository = {
    findBlockedIds: async () => options.blockedIds ?? [],
    findBlockerIds: async () => options.blockerIds ?? [],
    isBlocked: async (blockerId: string, blockedId: string) =>
      (blockerId === viewerId && (options.blockedIds ?? []).includes(blockedId))
      || (blockedId === viewerId && (options.blockerIds ?? []).includes(blockerId)),
  };

  const service = new StoryService(
    storyRepository as never,
    { findFollowingIds: async () => [], findMutualFriendIds: async () => [] } as never,
    { createDownloadUrl: async (key: string) => ({ url: `https://cdn.example.test/${key}` }) } as never,
    {} as never,
    userBlockRepository as never,
    { findById: async () => null } as never,
  );

  return service;
};

// ---------------------------------------------------------------------------
// Discover feed
// ---------------------------------------------------------------------------

test("listDiscoverStories hides stories from a user the viewer blocked", async () => {
  const blockedAuthorId = new Types.ObjectId().toString();
  const okAuthorId = new Types.ObjectId().toString();
  const service = createService({
    stories: [makeStory(blockedAuthorId, "Blocked Author"), makeStory(okAuthorId, "Ok Author")],
    blockedIds: [blockedAuthorId],
  });

  const stories = await service.listDiscoverStories(makeViewer());

  assert.deepEqual(stories.map((s) => s.userId), [okAuthorId]);
});

test("listDiscoverStories hides stories from a user who blocked the viewer", async () => {
  const blockerAuthorId = new Types.ObjectId().toString();
  const okAuthorId = new Types.ObjectId().toString();
  const service = createService({
    stories: [makeStory(blockerAuthorId, "Blocker Author"), makeStory(okAuthorId, "Ok Author")],
    blockerIds: [blockerAuthorId],
  });

  const stories = await service.listDiscoverStories(makeViewer());

  assert.deepEqual(stories.map((s) => s.userId), [okAuthorId]);
});

test("listDiscoverStories hides stories from a suspended / deleted author", async () => {
  const suspendedId = new Types.ObjectId().toString();
  const deletedId = new Types.ObjectId().toString();
  const okId = new Types.ObjectId().toString();
  const service = createService({
    stories: [
      makeStory(suspendedId, "Suspended", { isActive: false }),
      makeStory(deletedId, "Deleted", { deletedAt: new Date() }),
      makeStory(okId, "Ok"),
    ],
  });

  const stories = await service.listDiscoverStories(makeViewer());

  assert.deepEqual(stories.map((s) => s.userId), [okId]);
});

test("listUserStories rejects nothing but returns empty for a blocked author", async () => {
  const blockedAuthorId = new Types.ObjectId().toString();
  const service = createService({
    stories: [makeStory(blockedAuthorId, "Blocked Author")],
    blockedIds: [blockedAuthorId],
  });

  const stories = await service.listUserStories(blockedAuthorId, makeViewer());

  assert.deepEqual(stories, []);
});

// ---------------------------------------------------------------------------
// Direct by-id access + interactions
// ---------------------------------------------------------------------------

test("getStoryDetails 404s when the viewer blocked the author", async () => {
  const blockedAuthorId = new Types.ObjectId().toString();
  const story = makeStory(blockedAuthorId, "Blocked Author");
  const service = createService({ stories: [story], blockedIds: [blockedAuthorId] });

  await assert.rejects(() => service.getStoryDetails(story._id.toString(), makeViewer()), /not found or expired/i);
});

test("getStoryDetails 404s when the author blocked the viewer", async () => {
  const blockerAuthorId = new Types.ObjectId().toString();
  const story = makeStory(blockerAuthorId, "Blocker Author");
  const service = createService({ stories: [story], blockerIds: [blockerAuthorId] });

  await assert.rejects(() => service.getStoryDetails(story._id.toString(), makeViewer()), /not found or expired/i);
});

test("getStoryDetails 404s when the author is suspended", async () => {
  const suspendedId = new Types.ObjectId().toString();
  const story = makeStory(suspendedId, "Suspended", { isActive: false });
  const service = createService({ stories: [story] });

  await assert.rejects(() => service.getStoryDetails(story._id.toString(), makeViewer()), /not found or expired/i);
});

test("recordView / toggleReaction / createComment are blocked across a block", async () => {
  const blockedAuthorId = new Types.ObjectId().toString();
  const story = makeStory(blockedAuthorId, "Blocked Author");
  const service = createService({ stories: [story], blockedIds: [blockedAuthorId] });
  const id = story._id.toString();
  const viewer = makeViewer();

  await assert.rejects(() => service.recordView(id, viewer), /not found or expired/i);
  await assert.rejects(() => service.toggleReaction(id, viewer), /not found or expired/i);
  await assert.rejects(() => service.createComment(id, viewer, { text: "hi" }), /not found or expired/i);
  await assert.rejects(() => service.listComments(id, viewer), /not found or expired/i);
});

test("getStoryDetails still succeeds for an active, unblocked author (regression)", async () => {
  const okAuthorId = new Types.ObjectId().toString();
  const story = makeStory(okAuthorId, "Ok Author");
  const service = createService({ stories: [story] });

  const detail = await service.getStoryDetails(story._id.toString(), makeViewer());
  assert.equal(detail.userId, okAuthorId);
});

test("an author can always view / interact with their own story", async () => {
  const story = makeStory(viewerId, "Me");
  const service = createService({ stories: [story] });

  const detail = await service.getStoryDetails(story._id.toString(), makeViewer());
  assert.equal(detail.isOwner, true);
});
