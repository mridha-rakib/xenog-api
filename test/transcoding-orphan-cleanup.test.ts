import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Types } from "mongoose";
import { MomentModel } from "../src/modules/moments/moment.model.js";
import { MomentMediaLifecycleService } from "../src/modules/moments/moment-media-lifecycle.service.js";
import { TranscodingJobModel } from "../src/modules/transcoding/transcoding-job.model.js";
import { TranscodingJobRepository } from "../src/modules/transcoding/transcoding-job.repository.js";
import { TranscodingOrphanCleanupService } from "../src/modules/transcoding/transcoding-orphan-cleanup.service.js";
import type { StorageService } from "../src/modules/storage/storage.service.js";
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

const jobRepository = new TranscodingJobRepository();
const lifecycleService = new MomentMediaLifecycleService();

const createdMomentIds: Types.ObjectId[] = [];
const createdJobIds: Types.ObjectId[] = [];

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
// Fake storage
// ---------------------------------------------------------------------------

interface FakeDeleteStorage extends Pick<StorageService, "deleteObject"> {
  deleteCalls: string[];
}

type KeyBehavior = "success" | "missing" | "retryable-error";

const createFakeDeleteStorage = (behaviorByKey: (key: string) => KeyBehavior = () => "success"): FakeDeleteStorage => {
  const deleteCalls: string[] = [];

  return {
    deleteCalls,
    deleteObject: async (key: string) => {
      deleteCalls.push(key);
      const behavior = behaviorByKey(key);

      if (behavior === "missing") {
        const error = new Error("not found") as Error & { $metadata?: { httpStatusCode?: number }; Code?: string };
        error.$metadata = { httpStatusCode: 404 };
        error.Code = "NoSuchKey";
        throw error;
      }

      if (behavior === "retryable-error") {
        const error = new Error("service unavailable") as Error & { $metadata?: { httpStatusCode?: number }; Code?: string };
        error.$metadata = { httpStatusCode: 503 };
        error.Code = "ServiceUnavailable";
        throw error;
      }
    },
  };
};

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

const identity = (label: string) => ({
  userId: new Types.ObjectId(),
  sourceKey: `moments/test-user/video/${label}-${new Types.ObjectId().toString()}.mp4`,
});

/**
 * Seeds a TranscodingJob already `status:"completed"` with verified output
 * keys, and already `momentSyncStatus:"stale"` — the exact state Phase 3A's
 * finalize (or Phase 3B2A's Moment-deletion cancellation) leaves behind when
 * a completed job's Moment/media could not be repointed. Deliberately does
 * NOT create a Moment for this job's own momentId — orphan cleanup must work
 * correctly even when the originating feed video post never existed again.
 */
const seedStaleJobWithOutputs = async (
  label: string,
  options: { jobOverrides?: Record<string, unknown> } = {},
) => {
  const { userId, sourceKey } = identity(label);
  const momentId = new Types.ObjectId();
  const optimizedKey = `videos/optimized/${userId.toString()}/${label}-${new Types.ObjectId().toString()}.mp4`;
  const thumbnailKey = `videos/thumbnails/${userId.toString()}/${label}-${new Types.ObjectId().toString()}.jpg`;

  const job = await jobRepository.createOrGet({ momentId: momentId.toString(), userId: userId.toString(), sourceStorageKey: sourceKey });
  createdJobIds.push(job._id);

  const claimed = await jobRepository.claimNext();
  if (!claimed || claimed._id.toString() !== job._id.toString()) {
    throw new Error(`test setup failed: claimNext() did not claim the job just seeded for "${label}"`);
  }

  await jobRepository.markSuccess(claimed._id.toString(), claimed.leaseToken!, {
    optimizedStorageKey: optimizedKey,
    thumbnailStorageKey: thumbnailKey,
    outputWidth: 1280,
    outputHeight: 720,
  });
  await TranscodingJobModel.updateOne({ _id: job._id }, { $set: { momentSyncStatus: "stale" } });

  if (options.jobOverrides && Object.keys(options.jobOverrides).length > 0) {
    await TranscodingJobModel.updateOne({ _id: job._id }, { $set: options.jobOverrides });
  }

  return { userId: userId.toString(), momentId: momentId.toString(), sourceKey, optimizedKey, thumbnailKey, jobId: job._id.toString() };
};

/** Guarded claim, mirroring the established pattern from every prior phase's test suite — fails loudly instead of silently claiming a leftover job from another test. */
const claimAndAssert = async (expectedJobId: string) => {
  const claimed = await jobRepository.claimNextOrphanCleanup();

  if (!claimed || claimed._id.toString() !== expectedJobId) {
    throw new Error(`test setup failed: claimNextOrphanCleanup() did not claim the expected job (got ${claimed?._id.toString() ?? "null"})`);
  }

  return claimed;
};

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

test("completed + stale + verified output keys is eligible for orphan cleanup", async () => {
  const seeded = await seedStaleJobWithOutputs("eligible-basic");
  const claimed = await claimAndAssert(seeded.jobId);
  assert.ok(claimed.orphanCleanupLeaseToken);
  assert.equal(claimed.orphanCleanupStatus, "processing");

  await jobRepository.markOrphanCleanupCompleted(seeded.jobId, claimed.orphanCleanupLeaseToken!);
});

test("momentSyncStatus pending is not eligible for orphan cleanup", async () => {
  const seeded = await seedStaleJobWithOutputs("not-eligible-pending");
  await TranscodingJobModel.updateOne({ _id: seeded.jobId }, { $set: { momentSyncStatus: "pending" } });

  const claimed = await jobRepository.claimNextOrphanCleanup();
  assert.notEqual(claimed?._id.toString(), seeded.jobId);
});

test("momentSyncStatus synced is not eligible for orphan cleanup", async () => {
  const seeded = await seedStaleJobWithOutputs("not-eligible-synced");
  await TranscodingJobModel.updateOne({ _id: seeded.jobId }, { $set: { momentSyncStatus: "synced" } });

  const claimed = await jobRepository.claimNextOrphanCleanup();
  assert.notEqual(claimed?._id.toString(), seeded.jobId);
});

test("a queued job is not eligible for orphan cleanup", async () => {
  const { userId, sourceKey } = identity("queued-not-eligible");
  const job = await jobRepository.createOrGet({ momentId: new Types.ObjectId().toString(), userId: userId.toString(), sourceStorageKey: sourceKey });
  createdJobIds.push(job._id);

  const claimed = await jobRepository.claimNextOrphanCleanup();
  assert.notEqual(claimed?._id.toString(), job._id.toString());

  await jobRepository.cancel(job._id.toString());
});

test("a processing job is not eligible for orphan cleanup", async () => {
  const { userId, sourceKey } = identity("processing-not-eligible");
  const job = await jobRepository.createOrGet({ momentId: new Types.ObjectId().toString(), userId: userId.toString(), sourceStorageKey: sourceKey });
  createdJobIds.push(job._id);
  await jobRepository.claimNext();

  const claimed = await jobRepository.claimNextOrphanCleanup();
  assert.notEqual(claimed?._id.toString(), job._id.toString());
});

test("failed_retryable, failed, and cancelled jobs are not eligible for orphan cleanup", async () => {
  const { userId, sourceKey } = identity("failed-cancelled-not-eligible");
  const job = await jobRepository.createOrGet({ momentId: new Types.ObjectId().toString(), userId: userId.toString(), sourceStorageKey: sourceKey });
  createdJobIds.push(job._id);
  const claimed = await jobRepository.claimNext();
  await jobRepository.recordFailure(job._id.toString(), claimed!.leaseToken!, { errorCode: "encode_failed" });

  let attempt = await jobRepository.claimNextOrphanCleanup();
  assert.notEqual(attempt?._id.toString(), job._id.toString());

  await TranscodingJobModel.updateOne({ _id: job._id }, { $set: { status: "failed" } });
  attempt = await jobRepository.claimNextOrphanCleanup();
  assert.notEqual(attempt?._id.toString(), job._id.toString());

  await TranscodingJobModel.updateOne({ _id: job._id }, { $set: { status: "cancelled" } });
  attempt = await jobRepository.claimNextOrphanCleanup();
  assert.notEqual(attempt?._id.toString(), job._id.toString());
});

test("a missing optimized key is not eligible for orphan cleanup", async () => {
  const seeded = await seedStaleJobWithOutputs("missing-optimized-key");
  await TranscodingJobModel.updateOne({ _id: seeded.jobId }, { $set: { optimizedStorageKey: null } });

  const claimed = await jobRepository.claimNextOrphanCleanup();
  assert.notEqual(claimed?._id.toString(), seeded.jobId);
});

test("a missing thumbnail key is not eligible for orphan cleanup", async () => {
  const seeded = await seedStaleJobWithOutputs("missing-thumbnail-key");
  await TranscodingJobModel.updateOne({ _id: seeded.jobId }, { $set: { thumbnailStorageKey: null } });

  const claimed = await jobRepository.claimNextOrphanCleanup();
  assert.notEqual(claimed?._id.toString(), seeded.jobId);
});

test("a completed orphan cleanup is not eligible again", async () => {
  const seeded = await seedStaleJobWithOutputs("already-completed-orphan-cleanup");
  const claimed = await claimAndAssert(seeded.jobId);
  await jobRepository.markOrphanCleanupCompleted(seeded.jobId, claimed.orphanCleanupLeaseToken!);

  const reclaim = await jobRepository.claimNextOrphanCleanup();
  assert.notEqual(reclaim?._id.toString(), seeded.jobId);
});

test("a blocked orphan cleanup is not eligible again", async () => {
  const seeded = await seedStaleJobWithOutputs("already-blocked-orphan-cleanup");
  const claimed = await claimAndAssert(seeded.jobId);
  await jobRepository.markOrphanCleanupBlocked(seeded.jobId, claimed.orphanCleanupLeaseToken!, { errorCode: "verification_failed" });

  const reclaim = await jobRepository.claimNextOrphanCleanup();
  assert.notEqual(reclaim?._id.toString(), seeded.jobId);
});

test("a future orphan-cleanup retry time is not eligible yet", async () => {
  const seeded = await seedStaleJobWithOutputs("future-retry-not-eligible");
  const claimed = await claimAndAssert(seeded.jobId);
  await jobRepository.markOrphanCleanupFailed(seeded.jobId, claimed.orphanCleanupLeaseToken!, {
    errorCode: "delete_failed",
    retryDelayMs: 10 * 60 * 1000,
  });

  const reclaim = await jobRepository.claimNextOrphanCleanup();
  assert.notEqual(reclaim?._id.toString(), seeded.jobId);
});

test("exhausted orphan-cleanup attempts are not eligible", async () => {
  const seeded = await seedStaleJobWithOutputs("exhausted-not-eligible", { jobOverrides: { orphanCleanupAttempts: 5 } });

  const claimed = await jobRepository.claimNextOrphanCleanup();
  assert.notEqual(claimed?._id.toString(), seeded.jobId);
});

// ---------------------------------------------------------------------------
// Atomic claim
// ---------------------------------------------------------------------------

test("two simultaneous orphan-cleanup claims against the same due job produce exactly one winner", async () => {
  const seeded = await seedStaleJobWithOutputs("claim-race");

  const [first, second] = await Promise.all([
    jobRepository.claimNextOrphanCleanup(),
    jobRepository.claimNextOrphanCleanup(),
  ]);

  const winners = [first, second].filter((result): result is NonNullable<typeof result> => (
    result !== null && result._id.toString() === seeded.jobId
  ));
  assert.equal(winners.length, 1);

  await jobRepository.markOrphanCleanupCompleted(seeded.jobId, winners[0]!.orphanCleanupLeaseToken!);
});

test("an active orphan-cleanup lease blocks a second claim; an expired one can be reclaimed", async () => {
  const seeded = await seedStaleJobWithOutputs("active-then-expired-lease");
  const first = await claimAndAssert(seeded.jobId);

  const blockedAttempt = await jobRepository.claimNextOrphanCleanup();
  assert.notEqual(blockedAttempt?._id.toString(), seeded.jobId);

  await TranscodingJobModel.updateOne({ _id: seeded.jobId }, { $set: { orphanCleanupLeaseExpiresAt: new Date(Date.now() - 1000) } });

  const reclaimed = await jobRepository.claimNextOrphanCleanup();
  assert.equal(reclaimed?._id.toString(), seeded.jobId);
  assert.notEqual(reclaimed?.orphanCleanupLeaseToken, first.orphanCleanupLeaseToken);

  await jobRepository.markOrphanCleanupCompleted(seeded.jobId, reclaimed!.orphanCleanupLeaseToken!);
});

test("orphan-cleanup attempt count increments exactly once per claim", async () => {
  const seeded = await seedStaleJobWithOutputs("attempt-increment");
  const claimed = await claimAndAssert(seeded.jobId);

  assert.equal(claimed.orphanCleanupAttempts, 1);

  await jobRepository.markOrphanCleanupCompleted(seeded.jobId, claimed.orphanCleanupLeaseToken!);
});

test("wrong orphan-cleanup token cannot complete, fail, or block the cleanup", async () => {
  const seeded = await seedStaleJobWithOutputs("wrong-token");
  const claimed = await claimAndAssert(seeded.jobId);

  const completeAttempt = await jobRepository.markOrphanCleanupCompleted(seeded.jobId, "not-the-real-token");
  assert.equal(completeAttempt, null);

  const failAttempt = await jobRepository.markOrphanCleanupFailed(seeded.jobId, "not-the-real-token", { errorCode: "delete_failed" });
  assert.equal(failAttempt, null);

  const blockAttempt = await jobRepository.markOrphanCleanupBlocked(seeded.jobId, "not-the-real-token", { errorCode: "verification_failed" });
  assert.equal(blockAttempt, null);

  const current = await jobRepository.findById(seeded.jobId);
  assert.equal(current?.orphanCleanupLeaseToken, claimed.orphanCleanupLeaseToken);

  await jobRepository.markOrphanCleanupCompleted(seeded.jobId, claimed.orphanCleanupLeaseToken!);
});

test("an old orphan-cleanup token cannot commit after another worker reclaims", async () => {
  const seeded = await seedStaleJobWithOutputs("old-token-after-reclaim");
  const firstClaim = await claimAndAssert(seeded.jobId);

  await TranscodingJobModel.updateOne({ _id: seeded.jobId }, { $set: { orphanCleanupLeaseExpiresAt: new Date(Date.now() - 1000) } });
  const reclaimed = await jobRepository.claimNextOrphanCleanup();
  assert.equal(reclaimed?._id.toString(), seeded.jobId);

  const staleComplete = await jobRepository.markOrphanCleanupCompleted(seeded.jobId, firstClaim.orphanCleanupLeaseToken!);
  assert.equal(staleComplete, null);

  const current = await jobRepository.findById(seeded.jobId);
  assert.equal(current?.orphanCleanupLeaseToken, reclaimed?.orphanCleanupLeaseToken);

  await jobRepository.markOrphanCleanupCompleted(seeded.jobId, reclaimed!.orphanCleanupLeaseToken!);
});

// ---------------------------------------------------------------------------
// Reference safety
// ---------------------------------------------------------------------------

test("service: unreferenced optimized and thumbnail keys allow cleanup", async () => {
  const seeded = await seedStaleJobWithOutputs("reference-safety-ok");
  const storage = createFakeDeleteStorage();
  const service = new TranscodingOrphanCleanupService(jobRepository, lifecycleService, storage);

  const outcome = await service.processNextOrphanCleanup();

  assert.equal(outcome.outcome, "completed");
  assert.deepEqual(new Set(storage.deleteCalls), new Set([seeded.optimizedKey, seeded.thumbnailKey]));
});

test("service: an existing feed video post referencing the optimized key blocks all deletion", async () => {
  const seeded = await seedStaleJobWithOutputs("reference-blocks-optimized");
  const referencingMomentId = new Types.ObjectId();
  await MomentModel.create({
    _id: referencingMomentId,
    userId: new Types.ObjectId(seeded.userId),
    mode: "feed",
    audience: "public",
    mediaItems: [{ type: "video", source: "upload", storageKey: seeded.optimizedKey, contentType: "video/mp4", processingStatus: "ready" }],
  });
  createdMomentIds.push(referencingMomentId);

  const storage = createFakeDeleteStorage();
  const service = new TranscodingOrphanCleanupService(jobRepository, lifecycleService, storage);

  const outcome = await service.processNextOrphanCleanup();

  assert.equal(outcome.outcome, "blocked");
  assert.deepEqual(storage.deleteCalls, []);

  const job = await jobRepository.findById(seeded.jobId);
  assert.equal(job?.orphanCleanupStatus, "blocked");
  assert.equal(job?.status, "completed");
  assert.equal(job?.momentSyncStatus, "stale");

  const referencing = await MomentModel.findById(referencingMomentId);
  assert.equal(referencing?.mediaItems[0]?.storageKey, seeded.optimizedKey);
});

test("service: an existing feed video post referencing the thumbnail key blocks all deletion", async () => {
  const seeded = await seedStaleJobWithOutputs("reference-blocks-thumbnail");
  const referencingMomentId = new Types.ObjectId();
  await MomentModel.create({
    _id: referencingMomentId,
    userId: new Types.ObjectId(seeded.userId),
    mode: "feed",
    audience: "public",
    mediaItems: [{
      type: "video",
      source: "upload",
      storageKey: "videos/optimized/unrelated/other.mp4",
      thumbnailStorageKey: seeded.thumbnailKey,
      contentType: "video/mp4",
      processingStatus: "ready",
    }],
  });
  createdMomentIds.push(referencingMomentId);

  const storage = createFakeDeleteStorage();
  const service = new TranscodingOrphanCleanupService(jobRepository, lifecycleService, storage);

  const outcome = await service.processNextOrphanCleanup();

  assert.equal(outcome.outcome, "blocked");
  assert.deepEqual(storage.deleteCalls, []);
});

test("service: another (unrelated) Moment referencing either key blocks deletion — never scoped only to the job's own momentId", async () => {
  const seeded = await seedStaleJobWithOutputs("reference-blocks-unrelated-moment");
  // Deliberately a completely different owner/moment than the job's own momentId.
  const unrelatedMomentId = new Types.ObjectId();
  await MomentModel.create({
    _id: unrelatedMomentId,
    userId: new Types.ObjectId(),
    mode: "feed",
    audience: "public",
    mediaItems: [{ type: "video", source: "upload", storageKey: seeded.optimizedKey, contentType: "video/mp4", processingStatus: "ready" }],
  });
  createdMomentIds.push(unrelatedMomentId);
  assert.notEqual(unrelatedMomentId.toString(), seeded.momentId);

  const storage = createFakeDeleteStorage();
  const service = new TranscodingOrphanCleanupService(jobRepository, lifecycleService, storage);

  const outcome = await service.processNextOrphanCleanup();

  assert.equal(outcome.outcome, "blocked");
  assert.deepEqual(storage.deleteCalls, []);
});

test("service: the job's own (deleted) originating Moment is not enough proof by itself — the system-wide query still runs and finds no reference, so cleanup proceeds", async () => {
  const seeded = await seedStaleJobWithOutputs("system-wide-check-runs");
  // No Moment exists anywhere referencing either key — including seeded.momentId, which was never created.
  const stillMissing = await MomentModel.findById(seeded.momentId);
  assert.equal(stillMissing, null);

  const storage = createFakeDeleteStorage();
  const service = new TranscodingOrphanCleanupService(jobRepository, lifecycleService, storage);

  const outcome = await service.processNextOrphanCleanup();

  assert.equal(outcome.outcome, "completed");
});

test("a blocked orphan cleanup never changes any feed video post", async () => {
  const seeded = await seedStaleJobWithOutputs("blocked-does-not-change-moment");
  const referencingMomentId = new Types.ObjectId();
  await MomentModel.create({
    _id: referencingMomentId,
    userId: new Types.ObjectId(seeded.userId),
    mode: "feed",
    audience: "public",
    mediaItems: [{ type: "video", source: "upload", storageKey: seeded.optimizedKey, contentType: "video/mp4", processingStatus: "ready", width: 1280, height: 720 }],
  });
  createdMomentIds.push(referencingMomentId);
  const before = await MomentModel.findById(referencingMomentId);

  const storage = createFakeDeleteStorage();
  const service = new TranscodingOrphanCleanupService(jobRepository, lifecycleService, storage);
  await service.processNextOrphanCleanup();

  const after = await MomentModel.findById(referencingMomentId);
  assert.deepEqual(after?.toObject().mediaItems, before?.toObject().mediaItems);
});

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

test("only optimized and thumbnail keys are ever passed to deleteObject — never the original source key", async () => {
  const seeded = await seedStaleJobWithOutputs("only-output-keys-deleted");
  const storage = createFakeDeleteStorage();
  const service = new TranscodingOrphanCleanupService(jobRepository, lifecycleService, storage);

  await service.processNextOrphanCleanup();

  assert.ok(!storage.deleteCalls.includes(seeded.sourceKey));
  assert.deepEqual(new Set(storage.deleteCalls), new Set([seeded.optimizedKey, seeded.thumbnailKey]));
});

test("both successful deletes mark orphan cleanup completed and record the completion timestamp", async () => {
  const seeded = await seedStaleJobWithOutputs("both-succeed");
  const storage = createFakeDeleteStorage();
  const service = new TranscodingOrphanCleanupService(jobRepository, lifecycleService, storage);

  const before = Date.now();
  const outcome = await service.processNextOrphanCleanup();
  assert.equal(outcome.outcome, "completed");

  const job = await jobRepository.findById(seeded.jobId);
  assert.equal(job?.orphanCleanupStatus, "completed");
  assert.ok(job?.orphanCleanupCompletedAt);
  assert.ok(job!.orphanCleanupCompletedAt!.getTime() >= before);
  assert.equal(job?.orphanCleanupLeaseToken, null);
  assert.equal(job?.status, "completed");
});

test("an already-missing optimized object is treated as success", async () => {
  const seeded = await seedStaleJobWithOutputs("optimized-already-missing");
  const storage = createFakeDeleteStorage((key) => (key === seeded.optimizedKey ? "missing" : "success"));
  const service = new TranscodingOrphanCleanupService(jobRepository, lifecycleService, storage);

  const outcome = await service.processNextOrphanCleanup();

  assert.equal(outcome.outcome, "completed");
});

test("an already-missing thumbnail object is treated as success", async () => {
  const seeded = await seedStaleJobWithOutputs("thumbnail-already-missing");
  const storage = createFakeDeleteStorage((key) => (key === seeded.thumbnailKey ? "missing" : "success"));
  const service = new TranscodingOrphanCleanupService(jobRepository, lifecycleService, storage);

  const outcome = await service.processNextOrphanCleanup();

  assert.equal(outcome.outcome, "completed");
});

test("both objects already missing is success", async () => {
  const seeded = await seedStaleJobWithOutputs("both-already-missing");
  const storage = createFakeDeleteStorage(() => "missing");
  const service = new TranscodingOrphanCleanupService(jobRepository, lifecycleService, storage);

  const outcome = await service.processNextOrphanCleanup();

  assert.equal(outcome.outcome, "completed");
});

// ---------------------------------------------------------------------------
// Partial failure and retries
// ---------------------------------------------------------------------------

test("optimized delete succeeds and thumbnail delete fails: a retry is scheduled, job stays completed/stale", async () => {
  const seeded = await seedStaleJobWithOutputs("optimized-ok-thumbnail-fails");
  const storage = createFakeDeleteStorage((key) => (key === seeded.thumbnailKey ? "retryable-error" : "success"));
  const service = new TranscodingOrphanCleanupService(jobRepository, lifecycleService, storage);

  const outcome = await service.processNextOrphanCleanup();

  assert.equal(outcome.outcome, "retrying");
  const job = await jobRepository.findById(seeded.jobId);
  assert.equal(job?.status, "completed");
  assert.equal(job?.momentSyncStatus, "stale");
  assert.equal(job?.orphanCleanupStatus, "failed");
  assert.ok(job?.orphanCleanupNextRetryAt);
  assert.equal(job?.orphanCleanupLeaseToken, null);
});

test("thumbnail delete succeeds and optimized delete fails: a retry is scheduled, job stays completed/stale", async () => {
  const seeded = await seedStaleJobWithOutputs("thumbnail-ok-optimized-fails");
  const storage = createFakeDeleteStorage((key) => (key === seeded.optimizedKey ? "retryable-error" : "success"));
  const service = new TranscodingOrphanCleanupService(jobRepository, lifecycleService, storage);

  const outcome = await service.processNextOrphanCleanup();

  assert.equal(outcome.outcome, "retrying");
  const job = await jobRepository.findById(seeded.jobId);
  assert.equal(job?.orphanCleanupStatus, "failed");
  assert.ok(job?.orphanCleanupNextRetryAt);
});

test("on retry, the already-deleted object's missing response is treated as success and only the remaining object matters", async () => {
  const seeded = await seedStaleJobWithOutputs("retry-treats-first-as-missing");
  const firstAttemptStorage = createFakeDeleteStorage((key) => (key === seeded.thumbnailKey ? "retryable-error" : "success"));
  const service = new TranscodingOrphanCleanupService(jobRepository, lifecycleService, firstAttemptStorage);
  const firstOutcome = await service.processNextOrphanCleanup();
  assert.equal(firstOutcome.outcome, "retrying");

  await TranscodingJobModel.updateOne({ _id: seeded.jobId }, { $set: { orphanCleanupNextRetryAt: new Date(Date.now() - 1000) } });

  // On retry: the optimized video (already deleted last attempt) is now
  // reported "missing" by the fake, and the thumbnail finally succeeds.
  const retryStorage = createFakeDeleteStorage((key) => (key === seeded.optimizedKey ? "missing" : "success"));
  const retryService = new TranscodingOrphanCleanupService(jobRepository, lifecycleService, retryStorage);
  const retryOutcome = await retryService.processNextOrphanCleanup();

  assert.equal(retryOutcome.outcome, "completed");
  const job = await jobRepository.findById(seeded.jobId);
  assert.equal(job?.orphanCleanupStatus, "completed");
});

test("initial orphan-cleanup attempt plus four automatic retries equals exactly five total attempts, then the sixth claim is impossible", async () => {
  const seeded = await seedStaleJobWithOutputs("five-attempts-total");
  const storage = createFakeDeleteStorage(() => "retryable-error");
  const service = new TranscodingOrphanCleanupService(jobRepository, lifecycleService, storage);

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await TranscodingJobModel.updateOne({ _id: seeded.jobId }, { $set: { orphanCleanupNextRetryAt: new Date(Date.now() - 1000) } });
    const outcome = await service.processNextOrphanCleanup();
    assert.equal(outcome.outcome, "retrying", `attempt ${attempt} should be retrying`);

    const job = await jobRepository.findById(seeded.jobId);
    assert.equal(job?.orphanCleanupAttempts, attempt);
  }

  const finalJob = await jobRepository.findById(seeded.jobId);
  assert.equal(finalJob?.orphanCleanupAttempts, 5);
  assert.equal(finalJob?.orphanCleanupNextRetryAt, null, "the 5th failure must be terminal — no further retry scheduled");
  assert.equal(finalJob?.status, "completed");
  assert.equal(finalJob?.momentSyncStatus, "stale");

  await TranscodingJobModel.updateOne({ _id: seeded.jobId }, { $set: { orphanCleanupNextRetryAt: new Date(Date.now() - 1000) } });
  const sixthClaim = await jobRepository.claimNextOrphanCleanup();
  assert.notEqual(sixthClaim?._id.toString(), seeded.jobId);
});

// ---------------------------------------------------------------------------
// Crash recovery
// ---------------------------------------------------------------------------

test("crash recovery: both objects delete successfully, the worker crashes before the DB update, and a fresh reclaim sees them missing and completes", async () => {
  const seeded = await seedStaleJobWithOutputs("crash-before-db-update");
  const firstClaim = await claimAndAssert(seeded.jobId);

  const realDeleteStorage = createFakeDeleteStorage();
  await realDeleteStorage.deleteObject(seeded.optimizedKey);
  await realDeleteStorage.deleteObject(seeded.thumbnailKey);
  void firstClaim; // the lease is simply left to expire, exactly like a real crash

  await TranscodingJobModel.updateOne({ _id: seeded.jobId }, { $set: { orphanCleanupLeaseExpiresAt: new Date(Date.now() - 1000) } });

  const secondStorage = createFakeDeleteStorage(() => "missing");
  const service = new TranscodingOrphanCleanupService(jobRepository, lifecycleService, secondStorage);
  const outcome = await service.processNextOrphanCleanup();

  assert.equal(outcome.outcome, "completed");
  const job = await jobRepository.findById(seeded.jobId);
  assert.equal(job?.orphanCleanupStatus, "completed");
  assert.ok(job?.orphanCleanupCompletedAt);
});

// ---------------------------------------------------------------------------
// Worker integration (structural)
// ---------------------------------------------------------------------------

test("src/video-worker.ts integrates orphan cleanup after original-source cleanup and before the transcoding claim", () => {
  const contents = readFileSync(new URL("../src/video-worker.ts", import.meta.url), "utf8");

  assert.match(contents, /TranscodingOrphanCleanupService/);

  const originalCleanupIndex = contents.indexOf("cleanupService.processNextCleanup");
  const orphanCleanupIndex = contents.indexOf("orphanCleanupService.processNextOrphanCleanup");
  const transcodingClaimIndex = contents.indexOf("repository.claimNext()");

  assert.ok(originalCleanupIndex > -1 && orphanCleanupIndex > -1 && transcodingClaimIndex > -1);
  assert.ok(originalCleanupIndex < orphanCleanupIndex, "original-source cleanup must run before orphan cleanup each iteration");
  assert.ok(orphanCleanupIndex < transcodingClaimIndex, "orphan cleanup must be attempted before the transcoding claim each iteration");
});

test("src/video-worker.ts never claims orphan-cleanup work outside the shuttingDown-gated loop", () => {
  const contents = readFileSync(new URL("../src/video-worker.ts", import.meta.url), "utf8");
  const loopStart = contents.indexOf("while (!shuttingDown)");
  const orphanCleanupIndex = contents.indexOf("orphanCleanupService.processNextOrphanCleanup");

  assert.ok(loopStart > -1 && orphanCleanupIndex > -1);
  assert.ok(orphanCleanupIndex > loopStart, "orphan-cleanup claiming must happen inside the shutdown-gated while loop");
});

test("src/server.ts still does not import or start the standalone video worker or orphan-cleanup service", () => {
  const contents = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  assert.doesNotMatch(contents, /video-worker/);
  assert.doesNotMatch(contents, /TranscodingOrphanCleanupService/);
});
