import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import { Types } from "mongoose";
import { AppError } from "../src/core/errors/app-error.js";
import { MomentModel } from "../src/modules/moments/moment.model.js";
import { MomentRepository } from "../src/modules/moments/moment.repository.js";
import { MomentService } from "../src/modules/moments/moment.service.js";
import { momentRoutes } from "../src/modules/moments/moment.route.js";
import { createMomentVideoStorageKey, MomentVideoService } from "../src/modules/moments/moment-video.service.js";
import { TranscodingJobModel } from "../src/modules/transcoding/transcoding-job.model.js";
import { TranscodingJobRepository } from "../src/modules/transcoding/transcoding-job.repository.js";
import { TranscodingMomentSyncService } from "../src/modules/transcoding/transcoding-moment-sync.service.js";
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

const now = new Date("2026-08-08T00:00:00.000Z");
const jobRepository = new TranscodingJobRepository();
const syncService = new TranscodingMomentSyncService();

const createdMomentIds: Types.ObjectId[] = [];
const createdJobIds: Types.ObjectId[] = [];

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

const fakeStorageService = {
  createDownloadUrl: async (key: string) => ({ key, expiresIn: 600, url: `https://storage.example/${key}` }),
  getObjectMetadata: async () => ({ contentLength: 1000, contentType: "video/mp4" }),
  getObject: async () => ({ body: (await import("node:stream")).Readable.from([Buffer.from("video")]), contentLength: 1000, contentType: "video/mp4" }),
  deleteObject: async () => undefined,
};

const createIntegrationMomentService = (momentVideoService: MomentVideoService) => new MomentService(
  new MomentRepository(),
  fakeStorageService as never,
  { findByIds: async () => [], findById: async () => null } as never,
  { deleteByMomentId: async () => undefined } as never,
  { findMutualFriendIds: async () => [] } as never,
  { findBlockedIds: async () => [] } as never,
  {
    countByMomentId: async () => 0,
    findLikedMomentIds: async () => new Set<string>(),
    deleteByMomentId: async () => undefined,
  } as never,
  {
    countByMomentId: async () => 0,
    findByMomentId: async () => [],
    deleteByMomentId: async () => undefined,
  } as never,
  { deleteByCommentIds: async () => undefined } as never,
  {
    findSavedMomentIds: async () => new Set<string>(),
    deleteByMomentId: async () => undefined,
  } as never,
  { findById: async () => null } as never,
  {} as never,
  {} as never,
  momentVideoService,
);

const createMomentPayload = (userId: string, videoKey?: string) => ({
  mode: "feed" as const,
  caption: "test",
  audience: "public" as const,
  taggedPeople: [],
  taggedFriendIds: [],
  mediaItems: videoKey
    ? [{ type: "video" as const, source: "upload" as const, storageKey: videoKey, contentType: "video/mp4", durationSeconds: 5 }]
    : [],
});

const trackMoment = (id: string): void => {
  createdMomentIds.push(new Types.ObjectId(id));
};

test.before(async () => {
  await connectTranscodingTestDb(TRANSCODING_TEST_MONGODB_URI);
});

test.after(async () => {
  if (createdMomentIds.length) {
    await MomentModel.deleteMany({ _id: { $in: createdMomentIds } });
  }
  if (createdJobIds.length) {
    await TranscodingJobModel.deleteMany({ _id: { $in: createdJobIds } });
  }
  await disconnectTranscodingTestDb();
});

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

/** Creates a real Moment+video job via the real integration MomentService, then drives the job (and its Moment media) to terminal "failed". */
const createFailedVideoMoment = async (label: string) => {
  const userId = new Types.ObjectId().toString();
  const key = createMomentVideoStorageKey(userId, "video/mp4");
  const service = createIntegrationMomentService(new MomentVideoService(fakeStorageService as never));

  const response = await service.createMoment(createMomentPayload(userId, key), makeUser(userId) as never);
  trackMoment(response.id);

  const job = await jobRepository.findByIdentity(response.id, key);
  if (!job) {
    throw new Error(`test setup failed: no job created for "${label}"`);
  }
  createdJobIds.push(job._id);

  const claimed = await jobRepository.claimNext();
  if (!claimed || claimed._id.toString() !== job._id.toString()) {
    throw new Error(`test setup failed: claimNext() did not claim the job just seeded for "${label}"`);
  }
  await jobRepository.markPermanentFailure(job._id.toString(), claimed.leaseToken!, { errorCode: "source_invalid", errorSummary: "no valid video stream" });
  await syncService.syncAfterJobAttempt(job._id.toString());

  const moment = await MomentModel.findById(response.id);
  if (moment?.mediaItems[0]?.processingStatus !== "failed") {
    throw new Error(`test setup failed: media did not reach failed state for "${label}"`);
  }

  return { userId, momentId: response.id, sourceKey: key, jobId: job._id.toString(), service };
};

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

test("owner can retry their failed video: job and media both become queued", async () => {
  const seeded = await createFailedVideoMoment("owner-retry");

  const response = await seeded.service.retryMomentVideoProcessing(seeded.momentId, makeUser(seeded.userId) as never);

  assert.equal(response.mediaItems[0]?.processingStatus, "queued");
  assert.equal(response.mediaItems[0]?.storageKey, seeded.sourceKey);
  const job = await jobRepository.findById(seeded.jobId);
  assert.equal(job?.status, "queued");

  // Left "queued" and immediately due — cancel it now that this test's own
  // assertions are done, so it cannot be picked up by a later test's
  // unrelated claimNext() call.
  await jobRepository.cancel(seeded.jobId);
});

test("a non-owner receives forbidden and neither the Moment nor the job is changed", async () => {
  const seeded = await createFailedVideoMoment("non-owner-forbidden");
  const otherUserId = new Types.ObjectId().toString();

  await assert.rejects(
    seeded.service.retryMomentVideoProcessing(seeded.momentId, makeUser(otherUserId) as never),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 403);
      return true;
    },
  );

  const job = await jobRepository.findById(seeded.jobId);
  assert.equal(job?.status, "failed");
  const moment = await MomentModel.findById(seeded.momentId);
  assert.equal(moment?.mediaItems[0]?.processingStatus, "failed");
});

test("a missing Moment follows the existing not-found behavior", async () => {
  const service = createIntegrationMomentService(new MomentVideoService(fakeStorageService as never));
  const missingId = new Types.ObjectId().toString();

  await assert.rejects(
    service.retryMomentVideoProcessing(missingId, makeUser(new Types.ObjectId().toString()) as never),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 404);
      return true;
    },
  );
});

test("an event-announcement Moment preserves the existing not-found restriction", async () => {
  const userId = new Types.ObjectId().toString();
  const momentId = new Types.ObjectId();
  await MomentModel.create({
    _id: momentId,
    userId,
    mode: "event",
    audience: "public",
    isEventAnnouncement: true,
    mediaItems: [],
  });
  createdMomentIds.push(momentId);
  const service = createIntegrationMomentService(new MomentVideoService(fakeStorageService as never));

  await assert.rejects(
    service.retryMomentVideoProcessing(momentId.toString(), makeUser(userId) as never),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 404);
      return true;
    },
  );
});

test("an unauthenticated request is rejected by the existing auth middleware", async () => {
  const app = express();
  app.use(express.json());
  app.use("/moments", momentRoutes);
  app.use((error: unknown, _req: unknown, res: { status: (status: number) => { json: (body: unknown) => void } }, _next: unknown) => {
    const appError = error as AppError;
    res.status(appError.statusCode ?? 500).json({ message: appError.message });
  });
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.notEqual(address, null);

  try {
    const port = typeof address === "object" && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/moments/${new Types.ObjectId().toString()}/retry-video-processing`, {
      method: "POST",
    });
    assert.equal(response.status, 401);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

test("a queued job's media is not eligible for retry", async () => {
  const userId = new Types.ObjectId().toString();
  const key = createMomentVideoStorageKey(userId, "video/mp4");
  const service = createIntegrationMomentService(new MomentVideoService(fakeStorageService as never));
  const response = await service.createMoment(createMomentPayload(userId, key), makeUser(userId) as never);
  trackMoment(response.id);
  const job = await jobRepository.findByIdentity(response.id, key);
  createdJobIds.push(job!._id);

  await assert.rejects(
    service.retryMomentVideoProcessing(response.id, makeUser(userId) as never),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 409);
      return true;
    },
  );

  const stillQueued = await jobRepository.findById(job!._id.toString());
  assert.equal(stillQueued?.status, "queued");
  assert.equal(stillQueued?.attempts, 0);

  // Left "queued" and immediately due, this job would otherwise be picked up
  // by the next unrelated claimNext() call in a later test — cancel it now
  // that this test's own assertions are done.
  await jobRepository.cancel(job!._id.toString());
});

test("a failed_retryable job is not reset by manual retry", async () => {
  const seeded = await createFailedVideoMoment("failed-retryable-not-eligible");
  // Force the job back to failed_retryable directly (simulating an in-flight automatic retry cycle).
  await TranscodingJobModel.updateOne({ _id: seeded.jobId }, { $set: { status: "failed_retryable", nextRetryAt: new Date(Date.now() + 60_000) } });

  const result = await syncService.retryFailedVideoProcessing(seeded.momentId, seeded.sourceKey, seeded.userId);
  assert.equal(result.outcome, "not_eligible");

  const job = await jobRepository.findById(seeded.jobId);
  assert.equal(job?.status, "failed_retryable");
});

test("a processing job is not reset by manual retry", async () => {
  const seeded = await createFailedVideoMoment("processing-not-eligible");
  await TranscodingJobModel.updateOne(
    { _id: seeded.jobId },
    { $set: { status: "processing", leaseToken: "some-active-token", leaseExpiresAt: new Date(Date.now() + 60_000) } },
  );

  const result = await syncService.retryFailedVideoProcessing(seeded.momentId, seeded.sourceKey, seeded.userId);
  assert.equal(result.outcome, "not_eligible");

  const job = await jobRepository.findById(seeded.jobId);
  assert.equal(job?.status, "processing");
  assert.equal(job?.leaseToken, "some-active-token");
});

test("a completed job is not reset by manual retry", async () => {
  const userId = new Types.ObjectId().toString();
  const key = createMomentVideoStorageKey(userId, "video/mp4");
  const service = createIntegrationMomentService(new MomentVideoService(fakeStorageService as never));
  const response = await service.createMoment(createMomentPayload(userId, key), makeUser(userId) as never);
  trackMoment(response.id);
  const job = await jobRepository.findByIdentity(response.id, key);
  createdJobIds.push(job!._id);
  const claimed = await jobRepository.claimNext();
  if (!claimed || claimed._id.toString() !== job!._id.toString()) {
    throw new Error("test setup failed: claimNext() did not claim the job just seeded for \"completed-not-eligible\"");
  }
  await jobRepository.markSuccess(job!._id.toString(), claimed.leaseToken!, {
    optimizedStorageKey: `videos/optimized/x/${job!._id.toString()}.mp4`,
    thumbnailStorageKey: `videos/thumbnails/x/${job!._id.toString()}.jpg`,
  });

  const result = await syncService.retryFailedVideoProcessing(response.id, key, userId);
  assert.equal(result.outcome, "not_eligible");

  const stillCompleted = await jobRepository.findById(job!._id.toString());
  assert.equal(stillCompleted?.status, "completed");
  assert.equal(stillCompleted?.attempts, 1);
});

test("a cancelled job is not revived by manual retry", async () => {
  const seeded = await createFailedVideoMoment("cancelled-not-eligible");
  await TranscodingJobModel.updateOne({ _id: seeded.jobId }, { $set: { status: "cancelled", cancelledAt: new Date() } });

  const result = await syncService.retryFailedVideoProcessing(seeded.momentId, seeded.sourceKey, seeded.userId);
  assert.equal(result.outcome, "not_eligible");

  const job = await jobRepository.findById(seeded.jobId);
  assert.equal(job?.status, "cancelled");
});

test("ready media produces no eligible retry target", async () => {
  const userId = new Types.ObjectId().toString();
  const momentId = new Types.ObjectId();
  const optimizedKey = `videos/optimized/${userId}/ready.mp4`;
  await MomentModel.create({
    _id: momentId,
    userId,
    mode: "feed",
    audience: "public",
    mediaItems: [{ type: "video", source: "upload", storageKey: optimizedKey, contentType: "video/mp4", processingStatus: "ready" }],
  });
  createdMomentIds.push(momentId);
  const service = createIntegrationMomentService(new MomentVideoService(fakeStorageService as never));

  await assert.rejects(
    service.retryMomentVideoProcessing(momentId.toString(), makeUser(userId) as never),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 409);
      return true;
    },
  );
});

test("image media produces no eligible retry target", async () => {
  const userId = new Types.ObjectId().toString();
  const momentId = new Types.ObjectId();
  await MomentModel.create({
    _id: momentId,
    userId,
    mode: "feed",
    audience: "public",
    mediaItems: [{ type: "image", source: "gallery", url: "https://cdn.example.com/a.jpg" }],
  });
  createdMomentIds.push(momentId);
  const service = createIntegrationMomentService(new MomentVideoService(fakeStorageService as never));

  await assert.rejects(
    service.retryMomentVideoProcessing(momentId.toString(), makeUser(userId) as never),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 409);
      return true;
    },
  );
});

test("a legacy failed-looking video with no matching TranscodingJob is handled safely (conflict, not a crash)", async () => {
  const userId = new Types.ObjectId().toString();
  const momentId = new Types.ObjectId();
  const key = `moments/${userId}/video/legacy-no-job.mp4`;
  await MomentModel.create({
    _id: momentId,
    userId,
    mode: "feed",
    audience: "public",
    mediaItems: [{ type: "video", source: "upload", storageKey: key, contentType: "video/mp4", processingStatus: "failed", processingErrorCode: "unknown" }],
  });
  createdMomentIds.push(momentId);
  const service = createIntegrationMomentService(new MomentVideoService(fakeStorageService as never));

  await assert.rejects(
    service.retryMomentVideoProcessing(momentId.toString(), makeUser(userId) as never),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 409);
      return true;
    },
  );

  const moment = await MomentModel.findById(momentId);
  assert.equal(moment?.mediaItems[0]?.processingStatus, "failed");
});

test("media already pointing to an optimized key is not reset even if a stray failed job shares the moment id", async () => {
  const seeded = await createFailedVideoMoment("already-optimized-not-eligible");
  const optimizedKey = `videos/optimized/x/${seeded.jobId}.mp4`;
  await MomentModel.updateOne(
    { _id: seeded.momentId },
    { $set: { "mediaItems.0.storageKey": optimizedKey, "mediaItems.0.processingStatus": "ready", "mediaItems.0.processingErrorCode": null } },
  );

  const result = await syncService.retryFailedVideoProcessing(seeded.momentId, seeded.sourceKey, seeded.userId);
  // The job itself is still "failed" and gets reset (job identity is by
  // original source key, independent of the Moment's current display key),
  // but the Moment write must fail to match — the media no longer says
  // "failed" at that original key — triggering safe compensation.
  assert.equal(result.outcome, "conflict");

  const job = await jobRepository.findById(seeded.jobId);
  assert.equal(job?.status, "cancelled");
  const moment = await MomentModel.findById(seeded.momentId);
  assert.equal(moment?.mediaItems[0]?.storageKey, optimizedKey);
  assert.equal(moment?.mediaItems[0]?.processingStatus, "ready");
});

// ---------------------------------------------------------------------------
// Job reset
// ---------------------------------------------------------------------------

test("job reset preserves the same job id, resets attempts to 0 with maxAttempts still 3, and clears retry/failure/lease fields", async () => {
  const seeded = await createFailedVideoMoment("job-reset-fields");
  const before = await jobRepository.findById(seeded.jobId);
  assert.equal(before?.status, "failed");
  assert.ok(before?.lastErrorCode);

  await seeded.service.retryMomentVideoProcessing(seeded.momentId, makeUser(seeded.userId) as never);

  const after = await jobRepository.findById(seeded.jobId);
  assert.equal(after?._id.toString(), seeded.jobId);
  assert.equal(after?.status, "queued");
  assert.equal(after?.attempts, 0);
  assert.equal(after?.maxAttempts, 3);
  assert.equal(after?.failedAt, null);
  assert.equal(after?.lastErrorCode, null);
  assert.equal(after?.lastErrorSummary, null);
  assert.equal(after?.leaseToken, null);
  assert.equal(after?.leaseExpiresAt, null);
  assert.ok(after?.nextRetryAt);

  const count = await TranscodingJobModel.countDocuments({ momentId: seeded.momentId, sourceStorageKey: seeded.sourceKey });
  assert.equal(count, 1);

  await jobRepository.cancel(seeded.jobId);
});

test("immutable identity fields are unchanged by the reset", async () => {
  const seeded = await createFailedVideoMoment("job-reset-immutable-identity");
  const before = await jobRepository.findById(seeded.jobId);

  await seeded.service.retryMomentVideoProcessing(seeded.momentId, makeUser(seeded.userId) as never);

  const after = await jobRepository.findById(seeded.jobId);
  assert.equal(after?.momentId.toString(), before?.momentId.toString());
  assert.equal(after?.userId.toString(), before?.userId.toString());
  assert.equal(after?.sourceStorageKey, before?.sourceStorageKey);
  assert.equal(after?.sourceContentType, before?.sourceContentType);

  await jobRepository.cancel(seeded.jobId);
});

test("a different user's id cannot reset the job even with the correct moment/source key", async () => {
  const seeded = await createFailedVideoMoment("wrong-owner-cannot-reset");
  const attackerUserId = new Types.ObjectId().toString();

  const result = await syncService.retryFailedVideoProcessing(seeded.momentId, seeded.sourceKey, attackerUserId);
  assert.equal(result.outcome, "not_eligible");

  const job = await jobRepository.findById(seeded.jobId);
  assert.equal(job?.status, "failed");
});

test("two concurrent retry calls produce at most one queued transition", async () => {
  const seeded = await createFailedVideoMoment("concurrent-retry");

  const [first, second] = await Promise.all([
    syncService.retryFailedVideoProcessing(seeded.momentId, seeded.sourceKey, seeded.userId),
    syncService.retryFailedVideoProcessing(seeded.momentId, seeded.sourceKey, seeded.userId),
  ]);

  const outcomes = [first.outcome, second.outcome].sort();
  assert.deepEqual(outcomes, ["not_eligible", "retried"]);

  const count = await TranscodingJobModel.countDocuments({ momentId: seeded.momentId, sourceStorageKey: seeded.sourceKey });
  assert.equal(count, 1);

  await jobRepository.cancel(seeded.jobId);
});

// ---------------------------------------------------------------------------
// Moment lifecycle
// ---------------------------------------------------------------------------

test("failed media becomes queued, error code clears, storageKey and other media items are unaffected", async () => {
  const userId = new Types.ObjectId().toString();
  const failedKey = createMomentVideoStorageKey(userId, "video/mp4");
  const momentId = new Types.ObjectId();
  await MomentModel.create({
    _id: momentId,
    userId,
    mode: "feed",
    audience: "public",
    mediaItems: [
      { type: "image", source: "gallery", url: "https://cdn.example.com/keep.jpg" },
      { type: "video", source: "upload", storageKey: failedKey, contentType: "video/mp4", processingStatus: "failed", processingErrorCode: "encode_failed" },
    ],
  });
  createdMomentIds.push(momentId);
  const job = await jobRepository.createOrGet({ momentId: momentId.toString(), userId, sourceStorageKey: failedKey });
  createdJobIds.push(job._id);
  await TranscodingJobModel.updateOne({ _id: job._id }, { $set: { status: "failed", failedAt: new Date(), lastErrorCode: "encode_failed" } });

  const service = createIntegrationMomentService(new MomentVideoService(fakeStorageService as never));
  const response = await service.retryMomentVideoProcessing(momentId.toString(), makeUser(userId) as never);

  assert.equal(response.mediaItems[0]?.url, "https://cdn.example.com/keep.jpg");
  assert.equal(response.mediaItems[1]?.processingStatus, "queued");
  // markQueuedForRetry explicitly clears this to null (the same convention
  // markReady() already uses for the same field), not merely leaves it unset.
  assert.equal(response.mediaItems[1]?.processingErrorCode, null);
  assert.equal(response.mediaItems[1]?.storageKey, failedKey);
  assert.equal(response.mediaItems[1]?.thumbnailStorageKey, undefined);
  assert.equal(response.mediaItems[1]?.processedAt, undefined);

  await jobRepository.cancel(job._id.toString());
});

// ---------------------------------------------------------------------------
// Public response safety
// ---------------------------------------------------------------------------

test("the response never exposes job id, lease, attempts, or internal error summary", async () => {
  const seeded = await createFailedVideoMoment("response-safety");

  const response = await seeded.service.retryMomentVideoProcessing(seeded.momentId, makeUser(seeded.userId) as never);
  const json = JSON.stringify(response);

  assert.doesNotMatch(json, new RegExp(seeded.jobId));
  assert.doesNotMatch(json, /leaseToken/);
  assert.doesNotMatch(json, /attempts/);
  assert.doesNotMatch(json, /lastErrorSummary/);
  assert.doesNotMatch(json, /no valid video stream/);

  await jobRepository.cancel(seeded.jobId);
});

// ---------------------------------------------------------------------------
// Worker compatibility
// ---------------------------------------------------------------------------

test("worker compatibility: a manually reset job can be claimed normally and its first post-reset claim sets attempts to 1", async () => {
  const seeded = await createFailedVideoMoment("worker-claim-after-reset");
  await seeded.service.retryMomentVideoProcessing(seeded.momentId, makeUser(seeded.userId) as never);

  const claimed = await jobRepository.claimNext();
  if (!claimed || claimed._id.toString() !== seeded.jobId) {
    throw new Error("test setup failed: claimNext() did not claim the manually reset job");
  }
  assert.equal(claimed.attempts, 1);
  assert.equal(claimed.status, "processing");

  await syncService.syncAfterClaim(claimed);
  const moment = await MomentModel.findById(seeded.momentId);
  assert.equal(moment?.mediaItems[0]?.processingStatus, "processing");

  await jobRepository.recordFailure(seeded.jobId, claimed!.leaseToken!, { errorCode: "encode_failed" });
  const afterFailure = await jobRepository.findById(seeded.jobId);
  assert.equal(afterFailure?.status, "failed_retryable");
});

test("worker compatibility: Moment deletion can still cancel a manually reset job", async () => {
  const seeded = await createFailedVideoMoment("worker-deletion-after-reset");
  await seeded.service.retryMomentVideoProcessing(seeded.momentId, makeUser(seeded.userId) as never);

  await seeded.service.deleteMoment(seeded.momentId, makeUser(seeded.userId) as never);

  const job = await jobRepository.findById(seeded.jobId);
  assert.equal(job?.status, "cancelled");
  const moment = await MomentModel.findById(seeded.momentId);
  assert.equal(moment, null);
});

// ---------------------------------------------------------------------------
// Route and controller
// ---------------------------------------------------------------------------

test("the route only accepts the exact Moment id param — no job id or storage key in the request", async () => {
  const { readFileSync } = await import("node:fs");
  const contents = readFileSync(new URL("../src/modules/moments/moment.route.ts", import.meta.url), "utf8");

  assert.match(contents, /retry-video-processing/);
  assert.match(contents, /momentValidation\.momentIdParam/);
});
