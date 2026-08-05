import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Types } from "mongoose";
import { MomentModel } from "../src/modules/moments/moment.model.js";
import { MomentMediaLifecycleService } from "../src/modules/moments/moment-media-lifecycle.service.js";
import { TranscodingJobModel } from "../src/modules/transcoding/transcoding-job.model.js";
import { TranscodingJobRepository } from "../src/modules/transcoding/transcoding-job.repository.js";
import { TranscodingCleanupService } from "../src/modules/transcoding/transcoding-cleanup.service.js";
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

const createFakeDeleteStorage = (behavior: "success" | "missing" | "retryable-error" = "success"): FakeDeleteStorage => {
  const deleteCalls: string[] = [];

  return {
    deleteCalls,
    deleteObject: async (key: string) => {
      deleteCalls.push(key);

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
 * Seeds a Moment already "ready" and repointed to a deterministic optimized
 * key, plus a matching TranscodingJob already `status:"completed"` — the
 * exact state Phase 3A leaves behind right after a successful finalize.
 * `sync` controls whether momentSyncStatus is additionally set to "synced"
 * (the normal, cleanup-eligible case) or left as-is (ineligible cases).
 */
const seedCompletedJob = async (
  label: string,
  options: { sync?: boolean; jobOverrides?: Record<string, unknown> } = {},
) => {
  const { userId, sourceKey } = identity(label);
  const momentId = new Types.ObjectId();
  const optimizedKey = `videos/optimized/${userId.toString()}/${label}-${new Types.ObjectId().toString()}.mp4`;
  const thumbnailKey = `videos/thumbnails/${userId.toString()}/${label}-${new Types.ObjectId().toString()}.jpg`;

  await MomentModel.create({
    _id: momentId,
    userId,
    mode: "feed",
    audience: "public",
    mediaItems: [{
      type: "video",
      source: "upload",
      storageKey: optimizedKey,
      thumbnailStorageKey: thumbnailKey,
      contentType: "video/mp4",
      processingStatus: "ready",
      width: 1280,
      height: 720,
      fileSize: 12345,
      processedAt: new Date(),
    }],
  });
  createdMomentIds.push(momentId);

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
    outputFileSize: 12345,
  });

  if (options.sync !== false) {
    await jobRepository.markMomentSynced(job._id.toString());
  }

  if (options.jobOverrides && Object.keys(options.jobOverrides).length > 0) {
    await TranscodingJobModel.updateOne({ _id: job._id }, { $set: options.jobOverrides });
  }

  return { momentId: momentId.toString(), userId: userId.toString(), sourceKey, optimizedKey, thumbnailKey, jobId: job._id.toString() };
};

/** Guarded claim, mirroring the established seedAndClaimMomentJob/claimFreshJob pattern — fails loudly instead of silently claiming a leftover job from another test. */
const claimAndAssert = async (expectedJobId: string) => {
  const claimed = await jobRepository.claimNextCleanup();

  if (!claimed || claimed._id.toString() !== expectedJobId) {
    throw new Error(`test setup failed: claimNextCleanup() did not claim the expected job (got ${claimed?._id.toString() ?? "null"})`);
  }

  return claimed;
};

// ---------------------------------------------------------------------------
// Cleanup eligibility
// ---------------------------------------------------------------------------

test("completed + synced + cleanup pending is eligible for cleanup claim", async () => {
  const seeded = await seedCompletedJob("eligible-basic");
  const claimed = await claimAndAssert(seeded.jobId);
  assert.ok(claimed.cleanupLeaseToken);

  await jobRepository.markCleanupCompleted(seeded.jobId, claimed.cleanupLeaseToken!);
});

test("completed + momentSyncStatus pending is not eligible", async () => {
  const seeded = await seedCompletedJob("not-synced-pending", { sync: false });

  const claimed = await jobRepository.claimNextCleanup();
  assert.notEqual(claimed?._id.toString(), seeded.jobId);
});

test("completed + momentSyncStatus stale is not eligible", async () => {
  const seeded = await seedCompletedJob("not-synced-stale", { sync: false });
  await jobRepository.markMomentSyncStale(seeded.jobId);

  const claimed = await jobRepository.claimNextCleanup();
  assert.notEqual(claimed?._id.toString(), seeded.jobId);
});

test("a queued (never-completed) job is not eligible for cleanup", async () => {
  const { userId, sourceKey } = identity("queued-not-eligible");
  const job = await jobRepository.createOrGet({ momentId: new Types.ObjectId().toString(), userId: userId.toString(), sourceStorageKey: sourceKey });
  createdJobIds.push(job._id);

  const claimed = await jobRepository.claimNextCleanup();
  assert.notEqual(claimed?._id.toString(), job._id.toString());

  await jobRepository.cancel(job._id.toString());
});

test("a processing job is not eligible for cleanup", async () => {
  const { userId, sourceKey } = identity("processing-not-eligible");
  const job = await jobRepository.createOrGet({ momentId: new Types.ObjectId().toString(), userId: userId.toString(), sourceStorageKey: sourceKey });
  createdJobIds.push(job._id);
  await jobRepository.claimNext();

  const claimed = await jobRepository.claimNextCleanup();
  assert.notEqual(claimed?._id.toString(), job._id.toString());
});

test("a permanently failed job is not eligible for cleanup", async () => {
  const { userId, sourceKey } = identity("failed-not-eligible");
  const job = await jobRepository.createOrGet({ momentId: new Types.ObjectId().toString(), userId: userId.toString(), sourceStorageKey: sourceKey });
  createdJobIds.push(job._id);
  const claimed = await jobRepository.claimNext();
  await jobRepository.markPermanentFailure(job._id.toString(), claimed!.leaseToken!, { errorCode: "source_invalid" });

  const cleanupClaim = await jobRepository.claimNextCleanup();
  assert.notEqual(cleanupClaim?._id.toString(), job._id.toString());
});

test("a cancelled job is not eligible for cleanup", async () => {
  const { userId, sourceKey } = identity("cancelled-not-eligible");
  const job = await jobRepository.createOrGet({ momentId: new Types.ObjectId().toString(), userId: userId.toString(), sourceStorageKey: sourceKey });
  createdJobIds.push(job._id);
  await jobRepository.cancel(job._id.toString());

  const claimed = await jobRepository.claimNextCleanup();
  assert.notEqual(claimed?._id.toString(), job._id.toString());
});

test("a job whose cleanup already completed is not eligible again", async () => {
  const seeded = await seedCompletedJob("already-completed-cleanup");
  const claimed = await claimAndAssert(seeded.jobId);
  await jobRepository.markCleanupCompleted(seeded.jobId, claimed.cleanupLeaseToken!);

  const reclaim = await jobRepository.claimNextCleanup();
  assert.notEqual(reclaim?._id.toString(), seeded.jobId);
});

test("a cleanup failure with a future retry time is not eligible yet", async () => {
  const seeded = await seedCompletedJob("future-retry-not-eligible");
  const claimed = await claimAndAssert(seeded.jobId);
  await jobRepository.markCleanupFailed(seeded.jobId, claimed.cleanupLeaseToken!, {
    errorCode: "delete_failed",
    retryDelayMs: 10 * 60 * 1000,
  });

  const reclaim = await jobRepository.claimNextCleanup();
  assert.notEqual(reclaim?._id.toString(), seeded.jobId);
});

test("exhausted cleanup attempts are not eligible", async () => {
  const seeded = await seedCompletedJob("exhausted-not-eligible", { jobOverrides: { cleanupAttempts: 5 } });

  const claimed = await jobRepository.claimNextCleanup();
  assert.notEqual(claimed?._id.toString(), seeded.jobId);
});

// ---------------------------------------------------------------------------
// Atomic cleanup claim
// ---------------------------------------------------------------------------

test("two simultaneous cleanup claims against the same due job produce exactly one winner", async () => {
  const seeded = await seedCompletedJob("claim-race");

  const [first, second] = await Promise.all([
    jobRepository.claimNextCleanup(),
    jobRepository.claimNextCleanup(),
  ]);

  const winners = [first, second].filter((result): result is NonNullable<typeof result> => (
    result !== null && result._id.toString() === seeded.jobId
  ));
  assert.equal(winners.length, 1);

  await jobRepository.markCleanupCompleted(seeded.jobId, winners[0]!.cleanupLeaseToken!);
});

test("an active cleanup lease blocks a second claim; an expired one can be reclaimed", async () => {
  const seeded = await seedCompletedJob("active-then-expired-lease");
  const first = await claimAndAssert(seeded.jobId);

  const blockedAttempt = await jobRepository.claimNextCleanup();
  assert.notEqual(blockedAttempt?._id.toString(), seeded.jobId);

  await TranscodingJobModel.updateOne({ _id: seeded.jobId }, { $set: { cleanupLeaseExpiresAt: new Date(Date.now() - 1000) } });

  const reclaimed = await jobRepository.claimNextCleanup();
  assert.equal(reclaimed?._id.toString(), seeded.jobId);
  assert.notEqual(reclaimed?.cleanupLeaseToken, first.cleanupLeaseToken);

  await jobRepository.markCleanupCompleted(seeded.jobId, reclaimed!.cleanupLeaseToken!);
});

test("cleanup attempt count increments exactly once per claim", async () => {
  const seeded = await seedCompletedJob("attempt-increment");
  const claimed = await claimAndAssert(seeded.jobId);

  assert.equal(claimed.cleanupAttempts, 1);

  await jobRepository.markCleanupCompleted(seeded.jobId, claimed.cleanupLeaseToken!);
});

test("wrong cleanup token cannot complete or fail the cleanup", async () => {
  const seeded = await seedCompletedJob("wrong-token");
  const claimed = await claimAndAssert(seeded.jobId);

  const completeAttempt = await jobRepository.markCleanupCompleted(seeded.jobId, "not-the-real-token");
  assert.equal(completeAttempt, null);

  const failAttempt = await jobRepository.markCleanupFailed(seeded.jobId, "not-the-real-token", { errorCode: "delete_failed" });
  assert.equal(failAttempt, null);

  const current = await jobRepository.findById(seeded.jobId);
  assert.equal(current?.cleanupLeaseToken, claimed.cleanupLeaseToken);

  await jobRepository.markCleanupCompleted(seeded.jobId, claimed.cleanupLeaseToken!);
});

test("an old cleanup token cannot commit after another worker reclaims", async () => {
  const seeded = await seedCompletedJob("old-token-after-reclaim");
  const firstClaim = await claimAndAssert(seeded.jobId);

  await TranscodingJobModel.updateOne({ _id: seeded.jobId }, { $set: { cleanupLeaseExpiresAt: new Date(Date.now() - 1000) } });
  const reclaimed = await jobRepository.claimNextCleanup();
  assert.equal(reclaimed?._id.toString(), seeded.jobId);

  const staleComplete = await jobRepository.markCleanupCompleted(seeded.jobId, firstClaim.cleanupLeaseToken!);
  assert.equal(staleComplete, null);

  const current = await jobRepository.findById(seeded.jobId);
  assert.equal(current?.cleanupLeaseToken, reclaimed?.cleanupLeaseToken);

  await jobRepository.markCleanupCompleted(seeded.jobId, reclaimed!.cleanupLeaseToken!);
});

// ---------------------------------------------------------------------------
// Moment revalidation (TranscodingCleanupService)
// ---------------------------------------------------------------------------

test("service: ready media pointing to the exact optimized key allows deletion", async () => {
  const seeded = await seedCompletedJob("revalidate-ok");
  const storage = createFakeDeleteStorage("success");
  const service = new TranscodingCleanupService(jobRepository, lifecycleService, storage);

  const outcome = await service.processNextCleanup();

  assert.equal(outcome.outcome, "completed");
  assert.deepEqual(storage.deleteCalls, [seeded.sourceKey]);
});

test("service: media still pointing to the original key blocks deletion", async () => {
  const seeded = await seedCompletedJob("revalidate-still-original");
  // Overwrite the ready media back to point at the original — simulates the
  // Moment never actually having been repointed despite momentSyncStatus
  // somehow already being "synced".
  await MomentModel.updateOne(
    { _id: seeded.momentId },
    { $set: { "mediaItems.0.storageKey": seeded.sourceKey, "mediaItems.0.processingStatus": "ready" } },
  );
  const storage = createFakeDeleteStorage("success");
  const service = new TranscodingCleanupService(jobRepository, lifecycleService, storage);

  const outcome = await service.processNextCleanup();

  assert.equal(outcome.outcome, "permanent_failure");
  assert.deepEqual(storage.deleteCalls, []);

  const job = await jobRepository.findById(seeded.jobId);
  assert.equal(job?.cleanupStatus, "failed");
  assert.equal(job?.cleanupNextRetryAt, null);
});

test("service: media pointing to another/replaced key blocks deletion", async () => {
  const seeded = await seedCompletedJob("revalidate-replaced");
  await MomentModel.updateOne(
    { _id: seeded.momentId },
    { $set: { "mediaItems.0.storageKey": "moments/other/video/replaced.mp4", "mediaItems.0.processingStatus": "ready" } },
  );
  const storage = createFakeDeleteStorage("success");
  const service = new TranscodingCleanupService(jobRepository, lifecycleService, storage);

  const outcome = await service.processNextCleanup();

  assert.equal(outcome.outcome, "permanent_failure");
  assert.deepEqual(storage.deleteCalls, []);
});

test("service: a missing Moment blocks deletion", async () => {
  const seeded = await seedCompletedJob("revalidate-missing-moment");
  await MomentModel.deleteOne({ _id: seeded.momentId });
  createdMomentIds.splice(createdMomentIds.findIndex((id) => id.toString() === seeded.momentId), 1);

  const storage = createFakeDeleteStorage("success");
  const service = new TranscodingCleanupService(jobRepository, lifecycleService, storage);

  const outcome = await service.processNextCleanup();

  assert.equal(outcome.outcome, "permanent_failure");
  assert.deepEqual(storage.deleteCalls, []);
});

test("service: missing media (item removed) blocks deletion", async () => {
  const seeded = await seedCompletedJob("revalidate-missing-media");
  await MomentModel.updateOne({ _id: seeded.momentId }, { $set: { mediaItems: [] } });

  const storage = createFakeDeleteStorage("success");
  const service = new TranscodingCleanupService(jobRepository, lifecycleService, storage);

  const outcome = await service.processNextCleanup();

  assert.equal(outcome.outcome, "permanent_failure");
  assert.deepEqual(storage.deleteCalls, []);
});

test("service: non-ready media (still processing) blocks deletion", async () => {
  const seeded = await seedCompletedJob("revalidate-not-ready");
  await MomentModel.updateOne(
    { _id: seeded.momentId },
    { $set: { "mediaItems.0.processingStatus": "processing" } },
  );

  const storage = createFakeDeleteStorage("success");
  const service = new TranscodingCleanupService(jobRepository, lifecycleService, storage);

  const outcome = await service.processNextCleanup();

  assert.equal(outcome.outcome, "permanent_failure");
  assert.deepEqual(storage.deleteCalls, []);
});

test("service: original key equal to optimized key blocks deletion (structural safety invariant)", async () => {
  const seeded = await seedCompletedJob("source-equals-optimized");
  await TranscodingJobModel.updateOne({ _id: seeded.jobId }, { $set: { sourceStorageKey: seeded.optimizedKey } });

  const storage = createFakeDeleteStorage("success");
  const service = new TranscodingCleanupService(jobRepository, lifecycleService, storage);

  const outcome = await service.processNextCleanup();

  assert.equal(outcome.outcome, "permanent_failure");
  assert.deepEqual(storage.deleteCalls, []);
});

// ---------------------------------------------------------------------------
// Original deletion
// ---------------------------------------------------------------------------

test("only the original source key is ever passed to deleteObject — never optimized or thumbnail", async () => {
  const seeded = await seedCompletedJob("only-source-deleted");
  const storage = createFakeDeleteStorage("success");
  const service = new TranscodingCleanupService(jobRepository, lifecycleService, storage);

  await service.processNextCleanup();

  assert.deepEqual(storage.deleteCalls, [seeded.sourceKey]);
  assert.ok(!storage.deleteCalls.includes(seeded.optimizedKey));
  assert.ok(!storage.deleteCalls.includes(seeded.thumbnailKey));
});

test("a successful delete marks cleanup completed, records the deletion timestamp, and leaves the job/Moment otherwise unchanged", async () => {
  const seeded = await seedCompletedJob("success-marks-completed");
  const storage = createFakeDeleteStorage("success");
  const service = new TranscodingCleanupService(jobRepository, lifecycleService, storage);

  const before = Date.now();
  const outcome = await service.processNextCleanup();
  assert.equal(outcome.outcome, "completed");

  const job = await jobRepository.findById(seeded.jobId);
  assert.equal(job?.cleanupStatus, "completed");
  assert.equal(job?.status, "completed");
  assert.ok(job?.originalDeletedAt);
  assert.ok(job!.originalDeletedAt!.getTime() >= before);
  assert.equal(job?.cleanupLeaseToken, null);

  const moment = await MomentModel.findById(seeded.momentId);
  assert.equal(moment?.mediaItems[0]?.processingStatus, "ready");
  assert.equal(moment?.mediaItems[0]?.storageKey, seeded.optimizedKey);
});

test("an already-missing original is treated as cleanup success", async () => {
  const seeded = await seedCompletedJob("already-missing-is-success");
  const storage = createFakeDeleteStorage("missing");
  const service = new TranscodingCleanupService(jobRepository, lifecycleService, storage);

  const outcome = await service.processNextCleanup();

  assert.equal(outcome.outcome, "completed");
  const job = await jobRepository.findById(seeded.jobId);
  assert.equal(job?.cleanupStatus, "completed");
  assert.ok(job?.originalDeletedAt);
});

// ---------------------------------------------------------------------------
// Retry behavior
// ---------------------------------------------------------------------------

test("a temporary S3 delete failure schedules a cleanup retry without changing job or Moment status", async () => {
  const seeded = await seedCompletedJob("retry-temporary-failure");
  const storage = createFakeDeleteStorage("retryable-error");
  const service = new TranscodingCleanupService(jobRepository, lifecycleService, storage);

  const outcome = await service.processNextCleanup();
  assert.equal(outcome.outcome, "retrying");

  const job = await jobRepository.findById(seeded.jobId);
  assert.equal(job?.status, "completed");
  assert.equal(job?.cleanupStatus, "failed");
  assert.ok(job?.cleanupNextRetryAt);
  assert.equal(job?.cleanupLeaseToken, null);

  const moment = await MomentModel.findById(seeded.momentId);
  assert.equal(moment?.mediaItems[0]?.processingStatus, "ready");
  assert.equal(moment?.mediaItems[0]?.storageKey, seeded.optimizedKey);
});

test("initial cleanup attempt plus four automatic retries equals exactly five total attempts, then the sixth claim is impossible", async () => {
  const seeded = await seedCompletedJob("five-attempts-total");
  const storage = createFakeDeleteStorage("retryable-error");
  const service = new TranscodingCleanupService(jobRepository, lifecycleService, storage);

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    // Force each retry immediately due so the loop doesn't wait on real backoff.
    await TranscodingJobModel.updateOne({ _id: seeded.jobId }, { $set: { cleanupNextRetryAt: new Date(Date.now() - 1000) } });
    const outcome = await service.processNextCleanup();
    assert.equal(outcome.outcome, "retrying", `attempt ${attempt} should be retrying`);

    const job = await jobRepository.findById(seeded.jobId);
    assert.equal(job?.cleanupAttempts, attempt);
  }

  const finalJob = await jobRepository.findById(seeded.jobId);
  assert.equal(finalJob?.cleanupAttempts, 5);
  assert.equal(finalJob?.cleanupNextRetryAt, null, "the 5th failure must be terminal — no further retry scheduled");

  // Even forcing nextRetryAt due again cannot resurrect an exhausted cleanup.
  await TranscodingJobModel.updateOne({ _id: seeded.jobId }, { $set: { cleanupNextRetryAt: new Date(Date.now() - 1000) } });
  const sixthClaim = await jobRepository.claimNextCleanup();
  assert.notEqual(sixthClaim?._id.toString(), seeded.jobId);
});

test("cleanup backoff is deterministic: the same attempt number always yields the same delay", async () => {
  const seededA = await seedCompletedJob("backoff-deterministic-a");
  const seededB = await seedCompletedJob("backoff-deterministic-b");
  const storage = createFakeDeleteStorage("retryable-error");
  const service = new TranscodingCleanupService(jobRepository, lifecycleService, storage);

  await service.processNextCleanup();
  await service.processNextCleanup();

  const jobA = await jobRepository.findById(seededA.jobId);
  const jobB = await jobRepository.findById(seededB.jobId);
  const delayA = jobA!.cleanupNextRetryAt!.getTime() - jobA!.updatedAt.getTime();
  const delayB = jobB!.cleanupNextRetryAt!.getTime() - jobB!.updatedAt.getTime();

  // Both were claimed on their first attempt, so both should compute the
  // exact same bounded backoff — deterministic, not random/jittered.
  assert.ok(Math.abs(delayA - delayB) < 1000);
});

// ---------------------------------------------------------------------------
// Crash recovery
// ---------------------------------------------------------------------------

test("crash recovery: delete succeeds, worker crashes before the DB update, the next attempt sees the object missing and completes cleanly", async () => {
  const seeded = await seedCompletedJob("crash-before-db-update");

  // First "worker": deletes successfully, then crashes before ever calling
  // markCleanupCompleted (never happens — we simulate the crash directly).
  const firstClaim = await claimAndAssert(seeded.jobId);
  const realDeleteStorage = createFakeDeleteStorage("success");
  await realDeleteStorage.deleteObject(seeded.sourceKey);
  void firstClaim; // the lease is simply left to expire, exactly like a real crash

  await TranscodingJobModel.updateOne({ _id: seeded.jobId }, { $set: { cleanupLeaseExpiresAt: new Date(Date.now() - 1000) } });

  // Second "worker": reclaims with a fresh token, attempts delete again, and
  // must see the object as already missing.
  const secondStorage = createFakeDeleteStorage("missing");
  const service = new TranscodingCleanupService(jobRepository, lifecycleService, secondStorage);
  const outcome = await service.processNextCleanup();

  assert.equal(outcome.outcome, "completed");
  const job = await jobRepository.findById(seeded.jobId);
  assert.equal(job?.cleanupStatus, "completed");
  assert.ok(job?.originalDeletedAt);
});

// ---------------------------------------------------------------------------
// Worker integration (structural — see runWorkerLoop's own tests for the
// atomic single-claim/lease-expiry guarantees this composes)
// ---------------------------------------------------------------------------

test("src/video-worker.ts integrates cleanup via TranscodingCleanupService, ordered before the transcoding claim each iteration", () => {
  const contents = readFileSync(new URL("../src/video-worker.ts", import.meta.url), "utf8");

  assert.match(contents, /TranscodingCleanupService/);
  const cleanupCallIndex = contents.indexOf("cleanupService.processNextCleanup");
  const transcodingClaimIndex = contents.indexOf("repository.claimNext()");
  assert.ok(cleanupCallIndex > -1 && transcodingClaimIndex > -1);
  assert.ok(cleanupCallIndex < transcodingClaimIndex, "cleanup must be attempted before the transcoding claim each loop iteration");
});

test("src/video-worker.ts never claims cleanup or transcoding work outside the shuttingDown-gated loop", () => {
  const contents = readFileSync(new URL("../src/video-worker.ts", import.meta.url), "utf8");
  const loopStart = contents.indexOf("while (!shuttingDown)");
  const cleanupCallIndex = contents.indexOf("cleanupService.processNextCleanup");

  assert.ok(loopStart > -1 && cleanupCallIndex > -1);
  assert.ok(cleanupCallIndex > loopStart, "cleanup claiming must happen inside the shutdown-gated while loop");
});

test("src/server.ts still does not import or start the standalone video worker", () => {
  const contents = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  assert.doesNotMatch(contents, /video-worker/);
  assert.doesNotMatch(contents, /TranscodingCleanupService/);
});
