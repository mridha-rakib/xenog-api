import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { AppError } from "../src/core/errors/app-error.js";
import { MomentModel } from "../src/modules/moments/moment.model.js";
import { MomentService } from "../src/modules/moments/moment.service.js";
import { MomentCommentRepository } from "../src/modules/moments/moment-comment.repository.js";
import { MomentReactionRepository } from "../src/modules/moments/moment-reaction.repository.js";
import { momentValidation } from "../src/modules/moments/moment.validation.js";
import {
  connectTranscodingTestDb,
  disconnectTranscodingTestDb,
  TRANSCODING_TEST_MONGODB_URI,
} from "./helpers/transcoding-test-db.js";

process.env.NODE_ENV = "test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const now = new Date("2026-08-11T00:00:00.000Z");
const service = new MomentService();
const reactionRepository = new MomentReactionRepository();
const commentRepository = new MomentCommentRepository();
const createdMomentIds: Types.ObjectId[] = [];

const makeUser = (id: string) => ({
  id,
  name: "Tester",
  username: "tester",
  email: "tester@example.com",
  accountType: "personal",
  currentLocationSharingEnabled: false,
  notificationsEnabled: true,
  role: "user",
  isActive: true,
  emailVerified: true,
  createdAt: now,
  updatedAt: now,
});

const seedMoment = async (overrides: Record<string, unknown> = {}) => {
  const userId = new Types.ObjectId();
  const doc = await MomentModel.create({
    userId,
    mode: "feed",
    caption: "Going to #music #party",
    hashtags: ["music", "party"],
    audience: "public",
    taggedPeople: ["Alex"],
    taggedFriendIds: [],
    mediaItems: [],
    location: { source: "gps", latitude: 12.34, longitude: 56.78 },
    ...overrides,
  });
  createdMomentIds.push(doc._id);
  return { userId: userId.toString(), momentId: doc._id.toString(), doc };
};

test.before(async () => {
  await connectTranscodingTestDb(TRANSCODING_TEST_MONGODB_URI);
});

test.after(async () => {
  if (createdMomentIds.length) {
    await MomentModel.deleteMany({ _id: { $in: createdMomentIds } });
  }
  await disconnectTranscodingTestDb();
});

// ---------------------------------------------------------------------------
// Validation contract
// ---------------------------------------------------------------------------

test("updateMoment validation accepts a caption-only body and rejects unknown fields", () => {
  const momentId = new Types.ObjectId().toString();
  const accepted = momentValidation.updateMoment.safeParse({
    params: { id: momentId },
    body: { caption: "Hello #travel" },
  });
  assert.equal(accepted.success, true);

  const rejected = momentValidation.updateMoment.safeParse({
    params: { id: momentId },
    body: { caption: "x", mediaItems: [] },
  });
  assert.equal(rejected.success, false);
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

test("owner can edit their own Post caption", async () => {
  const seeded = await seedMoment();
  const updated = await service.updateMoment(seeded.momentId, makeUser(seeded.userId) as never, { caption: "Hello #travel" });
  assert.equal(updated.caption, "Hello #travel");
});

test("a non-owner cannot edit another user's Post, and the Post is left unchanged", async () => {
  const seeded = await seedMoment();
  const otherUserId = new Types.ObjectId().toString();

  await assert.rejects(
    service.updateMoment(seeded.momentId, makeUser(otherUserId) as never, { caption: "hijacked" }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 403);
      return true;
    },
  );

  const stillOriginal = await MomentModel.findById(seeded.momentId);
  assert.equal(stillOriginal?.caption, "Going to #music #party");
});

test("editing an unknown Moment throws not found", async () => {
  const missingId = new Types.ObjectId().toString();

  await assert.rejects(
    service.updateMoment(missingId, makeUser(new Types.ObjectId().toString()) as never, { caption: "x" }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 404);
      return true;
    },
  );
});

test("a synthetic Event announcement Moment cannot be edited through the Post-edit path", async () => {
  const seeded = await seedMoment({ isEventAnnouncement: true, eventId: new Types.ObjectId(), mode: "event" });

  await assert.rejects(
    service.updateMoment(seeded.momentId, makeUser(seeded.userId) as never, { caption: "hijack the announcement" }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 404);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Caption + hashtag behavior
// ---------------------------------------------------------------------------

test("caption is trimmed according to existing semantics", async () => {
  const seeded = await seedMoment();
  const updated = await service.updateMoment(seeded.momentId, makeUser(seeded.userId) as never, { caption: "   spaced out   " });
  assert.equal(updated.caption, "spaced out");
});

test("hashtags are re-derived from the updated caption — stale hashtags do not remain", async () => {
  const seeded = await seedMoment(); // seeded caption/hashtags are #music/#party
  const updated = await service.updateMoment(seeded.momentId, makeUser(seeded.userId) as never, { caption: "Going to #travel" });
  assert.deepEqual([...updated.hashtags].sort(), ["travel"]);
});

test("a caption with no hashtags results in an empty hashtags array", async () => {
  const seeded = await seedMoment();
  const updated = await service.updateMoment(seeded.momentId, makeUser(seeded.userId) as never, { caption: "no tags here" });
  assert.deepEqual(updated.hashtags, []);
});

test("editing caption to empty on a caption-only post (no media) is rejected, preserving create-time domain rules", async () => {
  const seeded = await seedMoment({ mediaItems: [] });

  await assert.rejects(
    service.updateMoment(seeded.momentId, makeUser(seeded.userId) as never, { caption: "   " }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 400);
      return true;
    },
  );
});

test("editing caption to empty is allowed when the post already has media", async () => {
  const seeded = await seedMoment({
    mediaItems: [{ type: "image", source: "gallery", storageKey: "moments/a/b.jpg" }],
  });
  const updated = await service.updateMoment(seeded.momentId, makeUser(seeded.userId) as never, { caption: null });
  assert.equal(updated.caption, null);
});

// ---------------------------------------------------------------------------
// Untouched fields
// ---------------------------------------------------------------------------

test("media items remain unchanged by a caption edit", async () => {
  const seeded = await seedMoment({
    mediaItems: [{ type: "image", source: "gallery", storageKey: "moments/a/b.jpg" }],
  });
  const updated = await service.updateMoment(seeded.momentId, makeUser(seeded.userId) as never, { caption: "new caption" });
  assert.equal(updated.mediaItems.length, 1);
  assert.equal(updated.mediaItems[0]?.storageKey, "moments/a/b.jpg");
});

test("audience, tagged people, and location remain unchanged by a caption edit", async () => {
  const seeded = await seedMoment({
    audience: "friends",
    taggedPeople: ["Sam"],
    location: { source: "gps", latitude: 1, longitude: 2 },
  });
  const updated = await service.updateMoment(seeded.momentId, makeUser(seeded.userId) as never, { caption: "new caption" });
  assert.equal(updated.audience, "friends");
  assert.deepEqual(updated.taggedPeople, ["Sam"]);
  assert.equal(updated.location?.latitude, 1);
});

test("createdAt is unchanged and updatedAt advances", async () => {
  const seeded = await seedMoment();
  const before = await MomentModel.findById(seeded.momentId);
  await new Promise((resolve) => setTimeout(resolve, 5));

  const updated = await service.updateMoment(seeded.momentId, makeUser(seeded.userId) as never, { caption: "new caption" });

  assert.equal(new Date(updated.createdAt).getTime(), before!.createdAt.getTime());
  assert.ok(new Date(updated.updatedAt).getTime() >= before!.updatedAt.getTime());
});

test("likes and comments are not deleted or reset by a caption edit", async () => {
  const seeded = await seedMoment();
  const likerUserId = new Types.ObjectId().toString();

  await reactionRepository.toggleLike(likerUserId, seeded.momentId);
  await commentRepository.create({ userId: likerUserId, momentId: seeded.momentId, text: "nice" });

  const updated = await service.updateMoment(seeded.momentId, makeUser(seeded.userId) as never, { caption: "new caption" });

  assert.equal(updated.likesCount, 1);
  assert.equal(updated.commentsCount, 1);
});

test("the response shape matches the standard Moment response (id, caption, hashtags, createdAt, updatedAt)", async () => {
  const seeded = await seedMoment();
  const updated = await service.updateMoment(seeded.momentId, makeUser(seeded.userId) as never, { caption: "new caption" });

  assert.equal(updated.id, seeded.momentId);
  assert.equal(updated.userId, seeded.userId);
  assert.equal(typeof updated.caption, "string");
  assert.ok(Array.isArray(updated.hashtags));
  assert.ok(updated.createdAt);
  assert.ok(updated.updatedAt);
});
