import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { AppError } from "../src/core/errors/app-error.js";
import { MomentModel } from "../src/modules/moments/moment.model.js";
import { MomentRepository } from "../src/modules/moments/moment.repository.js";
import { MomentService } from "../src/modules/moments/moment.service.js";
import { MomentMediaLifecycleService } from "../src/modules/moments/moment-media-lifecycle.service.js";
import { createMomentVideoStorageKey, MomentVideoService } from "../src/modules/moments/moment-video.service.js";
import { TranscodingJobModel } from "../src/modules/transcoding/transcoding-job.model.js";
import { TranscodingJobRepository } from "../src/modules/transcoding/transcoding-job.repository.js";
import { TranscodingCleanupService } from "../src/modules/transcoding/transcoding-cleanup.service.js";
import { TranscodingMomentSyncService } from "../src/modules/transcoding/transcoding-moment-sync.service.js";
import type { StorageService } from "../src/modules/storage/storage.service.js";
import {
  connectTranscodingTestDb,
  disconnectTranscodingTestDb,
  TRANSCODING_TEST_MONGODB_URI,
} from "./helpers/transcoding-test-db.js";

process.env.NODE_ENV = "test";
// NOTE: video creation is temporarily disabled by default (ENABLE_VIDEO_UPLOADS
// in env.ts). This suite exercises Moment-deletion/job-cancellation logic
// and needs it enabled to run — set ENABLE_VIDEO_UPLOADS=true in the
// environment (e.g. this project's .env, or prefixed on the command line)
// before running this file. A `process.env.ENABLE_VIDEO_UPLOADS = "true"`
// line here would NOT work: ES module imports (including the ../src/...
// ones above) are evaluated — and env.ts's one-time parse along with them —
// before any of this file's own top-level statements run, regardless of
// textual order. See video-upload-disabled.test.ts for coverage of the
// actual disabled (default) state, which does not need this.
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const now = new Date("2026-08-07T00:00:00.000Z");
const jobRepository = new TranscodingJobRepository();
const syncService = new TranscodingMomentSyncService();
const lifecycleService = new MomentMediaLifecycleService();

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

/** Creates a real Moment (with a video media item) plus its matching TranscodingJob, via the real integration MomentService, then returns both ids. */
const createMomentWithVideoJob = async (label: string) => {
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

  return { userId, momentId: response.id, sourceKey: key, jobId: job._id.toString(), service };
};

const seedIndependentMoment = async (label: string) => {
  const userId = new Types.ObjectId();
  const momentId = new Types.ObjectId();
  const key = `moments/${userId.toString()}/video/${label}-${new Types.ObjectId().toString()}.mp4`;

  await MomentModel.create({
    _id: momentId,
    userId,
    mode: "feed",
    audience: "public",
    mediaItems: [{ type: "video", source: "upload", storageKey: key, contentType: "video/mp4", processingStatus: "queued" }],
  });
  createdMomentIds.push(momentId);

  const job = await jobRepository.createOrGet({ momentId: momentId.toString(), userId: userId.toString(), sourceStorageKey: key });
  createdJobIds.push(job._id);

  return { userId: userId.toString(), momentId: momentId.toString(), sourceKey: key, jobId: job._id.toString() };
};

// ---------------------------------------------------------------------------
// Authorization preservation
// ---------------------------------------------------------------------------

test("a non-owner cannot delete the Moment, and no job is cancelled", async () => {
  const seeded = await createMomentWithVideoJob("auth-non-owner");
  const otherUserId = new Types.ObjectId().toString();

  await assert.rejects(
    seeded.service.deleteMoment(seeded.momentId, makeUser(otherUserId) as never),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 403);
      return true;
    },
  );

  const job = await jobRepository.findById(seeded.jobId);
  assert.equal(job?.status, "queued");
  const moment = await MomentModel.findById(seeded.momentId);
  assert.ok(moment);
});

test("owner deletion behaves exactly as before: the Moment is hard-deleted and the response is unchanged", async () => {
  const seeded = await createMomentWithVideoJob("auth-owner-ok");

  await seeded.service.deleteMoment(seeded.momentId, makeUser(seeded.userId) as never);

  const moment = await MomentModel.findById(seeded.momentId);
  assert.equal(moment, null);
});

// ---------------------------------------------------------------------------
// Queued cancellation
// ---------------------------------------------------------------------------

test("a queued job becomes cancelled on Moment deletion, clears retry/lease fields, and cannot be claimed afterward", async () => {
  const seeded = await createMomentWithVideoJob("queued-cancel");

  await seeded.service.deleteMoment(seeded.momentId, makeUser(seeded.userId) as never);

  const job = await jobRepository.findById(seeded.jobId);
  assert.equal(job?.status, "cancelled");
  assert.ok(job?.cancelledAt);
  assert.equal(job?.leaseToken, null);
  assert.equal(job?.leaseExpiresAt, null);
  assert.equal(job?.nextRetryAt, null);

  const claimAttempt = await jobRepository.claimNext();
  assert.notEqual(claimAttempt?._id.toString(), seeded.jobId);
});

// ---------------------------------------------------------------------------
// Retryable cancellation
// ---------------------------------------------------------------------------

test("a failed-retryable job becomes cancelled on Moment deletion and cannot be reclaimed", async () => {
  const seeded = await seedIndependentMoment("retryable-cancel");
  const claimed = await jobRepository.claimNext();
  await jobRepository.recordFailure(seeded.jobId, claimed!.leaseToken!, { errorCode: "encode_failed" });

  const before = await jobRepository.findById(seeded.jobId);
  assert.equal(before?.status, "failed_retryable");
  assert.ok(before?.nextRetryAt);

  const result = await syncService.cancelForDeletedMoment(seeded.momentId);
  assert.equal(result.cancelledCount, 1);

  const after = await jobRepository.findById(seeded.jobId);
  assert.equal(after?.status, "cancelled");
  assert.equal(after?.nextRetryAt, null);

  await TranscodingJobModel.updateOne({ _id: seeded.jobId }, { $set: { nextRetryAt: new Date(Date.now() - 1000) } });
  const reclaim = await jobRepository.claimNext();
  assert.notEqual(reclaim?._id.toString(), seeded.jobId);
});

// ---------------------------------------------------------------------------
// Processing cancellation
// ---------------------------------------------------------------------------

test("an actively processing job becomes cancelled: old lease token can no longer renew, complete, or fail it", async () => {
  const seeded = await seedIndependentMoment("processing-cancel");
  const claimed = await jobRepository.claimNext();
  assert.equal(claimed?.status, "processing");
  const staleToken = claimed!.leaseToken!;

  const result = await syncService.cancelForDeletedMoment(seeded.momentId);
  assert.equal(result.cancelledCount, 1);

  const cancelled = await jobRepository.findById(seeded.jobId);
  assert.equal(cancelled?.status, "cancelled");
  assert.equal(cancelled?.leaseToken, null);

  const renewAttempt = await jobRepository.renewLease(seeded.jobId, staleToken);
  assert.equal(renewAttempt, null);

  const successAttempt = await jobRepository.markSuccess(seeded.jobId, staleToken, {
    optimizedStorageKey: "videos/optimized/x/should-not-apply.mp4",
    thumbnailStorageKey: "videos/thumbnails/x/should-not-apply.jpg",
  });
  assert.equal(successAttempt, null);

  const failureAttempt = await jobRepository.recordFailure(seeded.jobId, staleToken, { errorCode: "encode_failed" });
  assert.equal(failureAttempt, null);

  const permanentFailureAttempt = await jobRepository.markPermanentFailure(seeded.jobId, staleToken, { errorCode: "source_invalid" });
  assert.equal(permanentFailureAttempt, null);

  const finalState = await jobRepository.findById(seeded.jobId);
  assert.equal(finalState?.status, "cancelled");
  assert.equal(finalState?.optimizedStorageKey ?? null, null);
});

test("Moment synchronization is a no-op for a cancelled job", async () => {
  const seeded = await seedIndependentMoment("processing-cancel-sync-noop");
  await jobRepository.claimNext();
  await syncService.cancelForDeletedMoment(seeded.momentId);

  // Must not throw, must not touch anything (the Moment is gone anyway).
  await syncService.syncAfterJobAttempt(seeded.jobId);

  const job = await jobRepository.findById(seeded.jobId);
  assert.equal(job?.status, "cancelled");
});

// ---------------------------------------------------------------------------
// Completed pending-sync behavior
// ---------------------------------------------------------------------------

test("completed pending-sync: deleted Moment is not recreated, job becomes momentSyncStatus stale, sweep ignores it, output keys remain recorded", async () => {
  const seeded = await seedIndependentMoment("completed-pending-sync-stale");
  const claimed = await jobRepository.claimNext();
  const optimizedKey = `videos/optimized/x/${seeded.jobId}.mp4`;
  const thumbnailKey = `videos/thumbnails/x/${seeded.jobId}.jpg`;
  await jobRepository.markSuccess(seeded.jobId, claimed!.leaseToken!, {
    optimizedStorageKey: optimizedKey,
    thumbnailStorageKey: thumbnailKey,
    outputWidth: 1280,
    outputHeight: 720,
  });
  // Deliberately never synced yet — simulates the Moment being deleted in the
  // narrow window before Phase 3A's finalize step ever ran.

  // Delete the Moment, exactly as MomentService.deleteMoment() would before
  // invoking cancelForDeletedMoment().
  await MomentModel.deleteOne({ _id: seeded.momentId });
  createdMomentIds.splice(createdMomentIds.findIndex((id) => id.toString() === seeded.momentId), 1);

  const result = await syncService.cancelForDeletedMoment(seeded.momentId);
  assert.equal(result.staleCount, 1);

  const job = await jobRepository.findById(seeded.jobId);
  assert.equal(job?.status, "completed");
  assert.equal(job?.momentSyncStatus, "stale");
  assert.equal(job?.optimizedStorageKey, optimizedKey);
  assert.equal(job?.thumbnailStorageKey, thumbnailKey);

  const stillDeleted = await MomentModel.findById(seeded.momentId);
  assert.equal(stillDeleted, null);

  const pendingSweep = await jobRepository.findCompletedPendingMomentSync(50);
  assert.equal(pendingSweep.some((pendingJob) => pendingJob._id.toString() === seeded.jobId), false);

  const sweptCount = await syncService.finalizePendingCompletedJobs();
  const stillStale = await jobRepository.findById(seeded.jobId);
  assert.equal(stillStale?.momentSyncStatus, "stale");
  void sweptCount;
});

// ---------------------------------------------------------------------------
// Completed synced behavior
// ---------------------------------------------------------------------------

test("completed and synced: an already-synced job is left completely untouched by Moment deletion cancellation", async () => {
  const seeded = await seedIndependentMoment("completed-synced-untouched");
  const claimed = await jobRepository.claimNext();
  const optimizedKey = `videos/optimized/x/${seeded.jobId}.mp4`;
  await jobRepository.markSuccess(seeded.jobId, claimed!.leaseToken!, {
    optimizedStorageKey: optimizedKey,
    thumbnailStorageKey: `videos/thumbnails/x/${seeded.jobId}.jpg`,
  });
  await jobRepository.markMomentSynced(seeded.jobId);

  const result = await syncService.cancelForDeletedMoment(seeded.momentId);
  assert.equal(result.cancelledCount, 0);
  assert.equal(result.staleCount, 0);

  const job = await jobRepository.findById(seeded.jobId);
  assert.equal(job?.status, "completed");
  assert.equal(job?.momentSyncStatus, "synced");
  assert.equal(job?.optimizedStorageKey, optimizedKey);
});

// ---------------------------------------------------------------------------
// Cleanup interaction
// ---------------------------------------------------------------------------

test("cleanup interaction: cancelled and non-completed jobs are never cleanup-claimable", async () => {
  const seeded = await seedIndependentMoment("cleanup-excludes-cancelled");
  await jobRepository.claimNext();
  await syncService.cancelForDeletedMoment(seeded.momentId);

  const cleanupClaim = await jobRepository.claimNextCleanup();
  assert.notEqual(cleanupClaim?._id.toString(), seeded.jobId);
});

test("cleanup interaction: Moment deletion during an active cleanup lease causes fresh revalidation to fail, without a false completion", async () => {
  const seeded = await seedIndependentMoment("cleanup-revalidation-fails");
  const claimed = await jobRepository.claimNext();
  const optimizedKey = `videos/optimized/x/${seeded.jobId}.mp4`;
  await jobRepository.markSuccess(seeded.jobId, claimed!.leaseToken!, {
    optimizedStorageKey: optimizedKey,
    thumbnailStorageKey: `videos/thumbnails/x/${seeded.jobId}.jpg`,
  });
  await jobRepository.markMomentSynced(seeded.jobId);
  // Simulate Phase 3A having already repointed the Moment to "ready" at the optimized key.
  await MomentModel.updateOne(
    { _id: seeded.momentId },
    { $set: { "mediaItems.0.storageKey": optimizedKey, "mediaItems.0.processingStatus": "ready" } },
  );

  // Delete the Moment entirely — as MomentService.deleteMoment() would.
  await MomentModel.deleteOne({ _id: seeded.momentId });
  createdMomentIds.splice(createdMomentIds.findIndex((id) => id.toString() === seeded.momentId), 1);
  await syncService.cancelForDeletedMoment(seeded.momentId);

  const deleteCalls: string[] = [];
  const fakeStorage: Pick<StorageService, "deleteObject"> = {
    deleteObject: async (key: string) => {
      deleteCalls.push(key);
    },
  };
  const cleanupService = new TranscodingCleanupService(jobRepository, lifecycleService, fakeStorage);

  const outcome = await cleanupService.processNextCleanup();

  assert.equal(outcome.outcome, "permanent_failure");
  assert.deepEqual(deleteCalls, [], "the original must never be deleted once the Moment is gone");

  const job = await jobRepository.findById(seeded.jobId);
  assert.equal(job?.cleanupStatus, "failed");
  assert.notEqual(job?.cleanupStatus, "completed");
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test("repeating cancelForDeletedMoment for the same Moment is safe and matches nothing the second time", async () => {
  const seeded = await seedIndependentMoment("idempotent-repeat");
  await jobRepository.claimNext();

  const first = await syncService.cancelForDeletedMoment(seeded.momentId);
  assert.equal(first.cancelledCount, 1);

  const second = await syncService.cancelForDeletedMoment(seeded.momentId);
  assert.equal(second.cancelledCount, 0);
  assert.equal(second.staleCount, 0);

  const job = await jobRepository.findById(seeded.jobId);
  assert.equal(job?.status, "cancelled");
});

test("another Moment's jobs are never affected by an unrelated Moment's deletion", async () => {
  const target = await seedIndependentMoment("isolation-target");
  const bystander = await seedIndependentMoment("isolation-bystander");

  await syncService.cancelForDeletedMoment(target.momentId);

  const targetJob = await jobRepository.findById(target.jobId);
  const bystanderJob = await jobRepository.findById(bystander.jobId);
  assert.equal(targetJob?.status, "cancelled");
  assert.equal(bystanderJob?.status, "queued");

  await jobRepository.cancel(bystander.jobId);
});
