import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { AppError } from "../src/core/errors/app-error.js";
import { MomentModel } from "../src/modules/moments/moment.model.js";
import { MomentShareModel } from "../src/modules/moments/moment-share.model.js";
import { MomentShareRepository } from "../src/modules/moments/moment-share.repository.js";
import { MomentService } from "../src/modules/moments/moment.service.js";
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
const shareRepository = new MomentShareRepository();
const createdMomentIds: Types.ObjectId[] = [];
const createdShareIds: Types.ObjectId[] = [];

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

const seedShareScenario = async (options: { originalType?: "post" | "event" } = {}) => {
  const originalAuthorId = new Types.ObjectId();
  const reposterId = new Types.ObjectId();
  const moment = await MomentModel.create({
    userId: originalAuthorId,
    mode: "feed",
    caption: "Beautiful day",
    hashtags: [],
    audience: "public",
    mediaItems: [],
  });
  createdMomentIds.push(moment._id);

  const share = await MomentShareModel.create({
    userId: reposterId,
    momentId: moment._id,
    caption: "Everyone should see this",
    taggedFriendIds: [],
    originalType: options.originalType ?? "post",
    originalId: moment._id,
    clientRequestId: null,
  });
  createdShareIds.push(share._id);

  return {
    originalAuthorId: originalAuthorId.toString(),
    reposterId: reposterId.toString(),
    momentId: moment._id.toString(),
    shareId: share._id.toString(),
  };
};

test.before(async () => {
  await connectTranscodingTestDb(TRANSCODING_TEST_MONGODB_URI);
});

test.after(async () => {
  if (createdShareIds.length) {
    await MomentShareModel.deleteMany({ _id: { $in: createdShareIds } });
  }
  if (createdMomentIds.length) {
    await MomentModel.deleteMany({ _id: { $in: createdMomentIds } });
  }
  await disconnectTranscodingTestDb();
});

// ---------------------------------------------------------------------------
// Validation contract
// ---------------------------------------------------------------------------

test("updateMomentShare validation accepts caption-only and tags-only bodies, and rejects unknown fields", () => {
  const shareId = new Types.ObjectId().toString();
  const friendId = new Types.ObjectId().toString();
  const accepted = momentValidation.updateMomentShare.safeParse({
    params: { shareId },
    body: { caption: "Really worth checking out" },
  });
  assert.equal(accepted.success, true);

  const acceptedTags = momentValidation.updateMomentShare.safeParse({
    params: { shareId },
    body: { taggedFriendIds: [friendId] },
  });
  assert.equal(acceptedTags.success, true);

  const rejected = momentValidation.updateMomentShare.safeParse({
    params: { shareId },
    body: { caption: "x", unexpected: true },
  });
  assert.equal(rejected.success, false);
});

// ---------------------------------------------------------------------------
// Authorization — the SHARE owner, never the original content's author
// ---------------------------------------------------------------------------

test("the share owner can edit their own repost commentary", async () => {
  const seeded = await seedShareScenario();
  const updated = await service.updateMomentShare(
    seeded.shareId,
    makeUser(seeded.reposterId) as never,
    { caption: "Really worth checking out" },
  );
  assert.equal(updated.repostCaption, "Really worth checking out");
});

test("a non-owner cannot edit someone else's repost commentary, and it is left unchanged", async () => {
  const seeded = await seedShareScenario();
  const otherUserId = new Types.ObjectId().toString();

  await assert.rejects(
    service.updateMomentShare(seeded.shareId, makeUser(otherUserId) as never, { caption: "hijacked" }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 403);
      return true;
    },
  );

  const stillOriginal = await MomentShareModel.findById(seeded.shareId);
  assert.equal(stillOriginal?.caption, "Everyone should see this");
});

test("the original Post author cannot edit someone else's repost of their post merely by owning the original content", async () => {
  const seeded = await seedShareScenario();

  await assert.rejects(
    service.updateMomentShare(
      seeded.shareId,
      makeUser(seeded.originalAuthorId) as never,
      { caption: "hijacked by original author" },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 403);
      return true;
    },
  );
});

test("editing an unknown share throws not found", async () => {
  const missingId = new Types.ObjectId().toString();

  await assert.rejects(
    service.updateMomentShare(missingId, makeUser(new Types.ObjectId().toString()) as never, { caption: "x" }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 404);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Original content is immutable through this operation
// ---------------------------------------------------------------------------

test("editing repost commentary never changes the original Moment's caption", async () => {
  const seeded = await seedShareScenario();
  await service.updateMomentShare(seeded.shareId, makeUser(seeded.reposterId) as never, { caption: "Really worth checking out" });

  const originalMoment = await MomentModel.findById(seeded.momentId);
  assert.equal(originalMoment?.caption, "Beautiful day");
});

// ---------------------------------------------------------------------------
// Untouched fields
// ---------------------------------------------------------------------------

test("taggedFriendIds, originalType, originalId, momentId, and userId are preserved by a commentary edit", async () => {
  const friendId = new Types.ObjectId();
  const seeded = await seedShareScenario();
  await MomentShareModel.updateOne({ _id: seeded.shareId }, { $set: { taggedFriendIds: [friendId] } });

  await service.updateMomentShare(seeded.shareId, makeUser(seeded.reposterId) as never, { caption: "Looks amazing" });

  const stored = await MomentShareModel.findById(seeded.shareId);
  assert.deepEqual(stored?.taggedFriendIds?.map(String), [friendId.toString()]);
  assert.equal(stored?.originalType, "post");
  assert.equal(stored?.originalId?.toString(), seeded.momentId);
  assert.equal(stored?.momentId.toString(), seeded.momentId);
  assert.equal(stored?.userId.toString(), seeded.reposterId);
});

test("createdAt is unchanged and updatedAt advances on a commentary edit", async () => {
  const seeded = await seedShareScenario();
  const before = await MomentShareModel.findById(seeded.shareId);
  await new Promise((resolve) => setTimeout(resolve, 5));

  await service.updateMomentShare(seeded.shareId, makeUser(seeded.reposterId) as never, { caption: "new commentary" });

  const after = await MomentShareModel.findById(seeded.shareId);
  assert.equal(after?.createdAt.getTime(), before?.createdAt.getTime());
  assert.ok(after!.updatedAt.getTime() >= before!.updatedAt.getTime());
});

// ---------------------------------------------------------------------------
// Caption semantics + response shape
// ---------------------------------------------------------------------------

test("caption trims and normalizes empty to null, matching create-time semantics", async () => {
  const seeded = await seedShareScenario();

  const emptied = await service.updateMomentShare(seeded.shareId, makeUser(seeded.reposterId) as never, { caption: "   " });
  assert.equal(emptied.repostCaption, null);

  const padded = await service.updateMomentShare(seeded.shareId, makeUser(seeded.reposterId) as never, { caption: "  padded caption  " });
  assert.equal(padded.repostCaption, "padded caption");
});

test("the response exposes the updated commentary as repostCaption", async () => {
  const seeded = await seedShareScenario();
  const updated = await service.updateMomentShare(seeded.shareId, makeUser(seeded.reposterId) as never, { caption: "final text" });
  assert.equal(updated.repostCaption, "final text");
  assert.equal(updated.type, "share");
});

// ---------------------------------------------------------------------------
// Post repost and Event repost share the same update path
// ---------------------------------------------------------------------------

test("editing works for a repost of a Post", async () => {
  const seeded = await seedShareScenario({ originalType: "post" });
  const updated = await service.updateMomentShare(seeded.shareId, makeUser(seeded.reposterId) as never, { caption: "post repost edited" });
  assert.equal(updated.repostCaption, "post repost edited");
  assert.equal(updated.originalItem?.type, "post");
});

test("editing works for a repost of an Event through the same endpoint/service", async () => {
  const seeded = await seedShareScenario({ originalType: "event" });
  const updated = await service.updateMomentShare(seeded.shareId, makeUser(seeded.reposterId) as never, { caption: "event repost edited" });
  assert.equal(updated.repostCaption, "event repost edited");
  assert.equal(updated.originalItem?.type, "event");
});

// ---------------------------------------------------------------------------
// The create/share endpoint's upsert remains untouched by this feature
// ---------------------------------------------------------------------------

test("the create-repost upsert path still does not modify an existing share's caption (regression guard)", async () => {
  const seeded = await seedShareScenario();

  const result = await shareRepository.share(seeded.reposterId, seeded.momentId, {
    caption: "attempted overwrite via create",
    taggedFriendIds: [],
    originalType: "post",
    originalId: seeded.momentId,
    clientRequestId: null,
  });

  assert.equal(result.share.caption, "Everyone should see this");
});
