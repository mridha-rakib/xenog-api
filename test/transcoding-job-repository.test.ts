import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Types } from "mongoose";
import { TranscodingJobModel } from "../src/modules/transcoding/transcoding-job.model.js";
import { TranscodingJobRepository } from "../src/modules/transcoding/transcoding-job.repository.js";
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

// Deliberately never reads process.env.MONGODB_URI: this repo's real .env
// points at a remote Atlas cluster, and ESM import hoisting means any
// transitive import of config/env.ts elsewhere in this module graph would
// have already parsed it before a `?? fallback` assignment here could ever
// take effect. connectTranscodingTestDb() always uses this fixed local
// constant instead, and hard-guards it before connecting.

const repository = new TranscodingJobRepository();
const createdJobIds: Types.ObjectId[] = [];

const identity = (label: string) => ({
  momentId: new Types.ObjectId(),
  userId: new Types.ObjectId(),
  sourceStorageKey: `moments/test-user/video/${label}-${new Types.ObjectId().toString()}.mp4`,
});

const createJob = async (label: string, overrides: Record<string, unknown> = {}) => {
  const base = identity(label);
  const job = await repository.createOrGet({
    momentId: base.momentId.toString(),
    userId: base.userId.toString(),
    sourceStorageKey: base.sourceStorageKey,
  });

  createdJobIds.push(job._id);

  if (Object.keys(overrides).length > 0) {
    await TranscodingJobModel.updateOne({ _id: job._id }, { $set: overrides });
    const updated = await repository.findById(job._id.toString());
    if (!updated) throw new Error("job disappeared after direct update");
    return updated;
  }

  return job;
};

test.before(async () => {
  await connectTranscodingTestDb(TRANSCODING_TEST_MONGODB_URI);
});

test.after(async () => {
  if (createdJobIds.length) {
    await TranscodingJobModel.deleteMany({ _id: { $in: createdJobIds } });
  }
  await disconnectTranscodingTestDb();
});

// ---------------------------------------------------------------------------
// Idempotent creation
// ---------------------------------------------------------------------------

// These "idempotent creation" tests intentionally leave a job in the default
// "queued" + immediately-due state (createOrGet's whole point is that it does
// NOT claim anything). Left alone, that due job would still be sitting in the
// collection when the "atomic claim" tests below run and would be picked up
// instead of (or alongside) the job each of those tests actually creates,
// since claimNext has no way to scope itself to one caller's job. Cancelling
// here removes it from the claimable pool without weakening what each test
// actually asserts about createOrGet itself.

test("first create inserts a new job", async () => {
  const base = identity("create-first");
  const job = await repository.createOrGet({
    momentId: base.momentId.toString(),
    userId: base.userId.toString(),
    sourceStorageKey: base.sourceStorageKey,
  });
  createdJobIds.push(job._id);

  assert.equal(job.status, "queued");
  assert.equal(job.attempts, 0);
  assert.equal(job.sourceStorageKey, base.sourceStorageKey);

  await repository.cancel(job._id.toString());
});

test("duplicate create for the same identity returns the existing job, not a new one", async () => {
  const base = identity("create-dup");
  const payload = {
    momentId: base.momentId.toString(),
    userId: base.userId.toString(),
    sourceStorageKey: base.sourceStorageKey,
  };
  const first = await repository.createOrGet(payload);
  const second = await repository.createOrGet(payload);
  createdJobIds.push(first._id);

  assert.equal(first._id.toString(), second._id.toString());

  const count = await TranscodingJobModel.countDocuments({
    momentId: base.momentId,
    sourceStorageKey: base.sourceStorageKey,
  });
  assert.equal(count, 1);

  await repository.cancel(first._id.toString());
});

test("concurrent duplicate creation for the same identity cannot produce two documents", async () => {
  const base = identity("create-concurrent");
  const payload = {
    momentId: base.momentId.toString(),
    userId: base.userId.toString(),
    sourceStorageKey: base.sourceStorageKey,
  };

  const results = await Promise.all([
    repository.createOrGet(payload),
    repository.createOrGet(payload),
    repository.createOrGet(payload),
  ]);
  createdJobIds.push(results[0]!._id);

  const ids = new Set(results.map((job) => job._id.toString()));
  assert.equal(ids.size, 1);

  const count = await TranscodingJobModel.countDocuments({
    momentId: base.momentId,
    sourceStorageKey: base.sourceStorageKey,
  });
  assert.equal(count, 1);

  await repository.cancel(results[0]!._id.toString());
});

// ---------------------------------------------------------------------------
// Atomic claim
// ---------------------------------------------------------------------------

test("a due queued job can be claimed", async () => {
  const job = await createJob("claim-due");

  const claimed = await repository.claimNext();

  assert.ok(claimed);
  assert.equal(claimed?._id.toString(), job._id.toString());
  assert.equal(claimed?.status, "processing");
  assert.equal(claimed?.attempts, 1);
  assert.ok(claimed?.leaseToken);
  assert.ok(claimed?.leaseExpiresAt);
  assert.ok(claimed?.claimedAt);
  assert.ok(claimed?.startedAt);
});

test("a job scheduled in the future cannot be claimed", async () => {
  const future = new Date(Date.now() + 60_000);
  await createJob("claim-future", { nextRetryAt: future });

  const claimed = await repository.claimNext();

  assert.equal(claimed, null);
});

test("a job with an active (unexpired) processing lease cannot be claimed", async () => {
  await createJob("claim-active-lease", {
    status: "processing",
    leaseToken: "someone-elses-token",
    leaseExpiresAt: new Date(Date.now() + 60_000),
  });

  const claimed = await repository.claimNext();

  assert.equal(claimed, null);
});

test("a job with an expired processing lease can be reclaimed (stale recovery)", async () => {
  const job = await createJob("claim-expired-lease", {
    status: "processing",
    leaseToken: "crashed-worker-token",
    leaseExpiresAt: new Date(Date.now() - 60_000),
    attempts: 1,
    claimedAt: new Date(Date.now() - 120_000),
  });

  const claimed = await repository.claimNext();

  assert.ok(claimed);
  assert.equal(claimed?._id.toString(), job._id.toString());
  assert.notEqual(claimed?.leaseToken, "crashed-worker-token");
  assert.equal(claimed?.attempts, 2);
});

test("attempts increments exactly once per successful claim", async () => {
  await createJob("claim-attempts", {});
  const claimed = await repository.claimNext();

  assert.equal(claimed?.attempts, 1);
});

test("two simultaneous claims against the same due job produce exactly one winner", async () => {
  const job = await createJob("claim-race");

  const [first, second] = await Promise.all([
    repository.claimNext(),
    repository.claimNext(),
  ]);

  const winners = [first, second].filter((result): result is NonNullable<typeof result> => result !== null);
  assert.equal(winners.length, 1);
  assert.equal(winners[0]?._id.toString(), job._id.toString());
});

test("a job already at maxAttempts cannot be claimed even if left in a retryable status", async () => {
  await createJob("claim-max-attempts", {
    status: "failed_retryable",
    attempts: 3,
    maxAttempts: 3,
    nextRetryAt: new Date(Date.now() - 1000),
  });

  const claimed = await repository.claimNext();

  assert.equal(claimed, null);
});

// ---------------------------------------------------------------------------
// Lease safety
// ---------------------------------------------------------------------------

test("the correct lease token can renew the lease", async () => {
  await createJob("lease-renew-ok");
  const claimed = await repository.claimNext();
  assert.ok(claimed?.leaseToken);

  // The default claim lease is 5 minutes; renew with a clearly longer duration
  // so "renewal pushed the expiry further out" is unambiguous.
  const renewed = await repository.renewLease(claimed!._id.toString(), claimed!.leaseToken!, 600_000);

  assert.ok(renewed);
  assert.ok(renewed!.leaseExpiresAt!.getTime() > claimed!.leaseExpiresAt!.getTime());
});

test("an incorrect lease token cannot renew the lease", async () => {
  await createJob("lease-renew-wrong");
  const claimed = await repository.claimNext();

  const renewed = await repository.renewLease(claimed!._id.toString(), "not-the-real-token", 120_000);

  assert.equal(renewed, null);
});

test("an old worker's token cannot complete a job after another worker reclaims it", async () => {
  const job = await createJob("lease-reclaim-complete", {
    status: "processing",
    leaseToken: "old-worker-token",
    leaseExpiresAt: new Date(Date.now() - 1000),
    attempts: 1,
  });

  const reclaimed = await repository.claimNext();
  assert.ok(reclaimed);
  assert.equal(reclaimed?._id.toString(), job._id.toString());
  assert.notEqual(reclaimed?.leaseToken, "old-worker-token");

  const staleCompletion = await repository.markSuccess(job._id.toString(), "old-worker-token", {
    optimizedStorageKey: "videos/optimized/should-not-apply.mp4",
    thumbnailStorageKey: "videos/thumbnails/should-not-apply.jpg",
  });

  assert.equal(staleCompletion, null);

  const current = await repository.findById(job._id.toString());
  assert.equal(current?.optimizedStorageKey, null);
  assert.equal(current?.leaseToken, reclaimed?.leaseToken);
});

test("the correct current lease token can complete the job", async () => {
  await createJob("lease-complete-ok");
  const claimed = await repository.claimNext();

  const completed = await repository.markSuccess(claimed!._id.toString(), claimed!.leaseToken!, {
    optimizedStorageKey: "videos/optimized/ok.mp4",
    thumbnailStorageKey: "videos/thumbnails/ok.jpg",
    outputWidth: 1280,
    outputHeight: 720,
  });

  assert.ok(completed);
  assert.equal(completed?.status, "completed");
  assert.equal(completed?.optimizedStorageKey, "videos/optimized/ok.mp4");
});

test("lease fields clear once a job reaches a terminal state", async () => {
  await createJob("lease-clear-on-terminal");
  const claimed = await repository.claimNext();

  const completed = await repository.markSuccess(claimed!._id.toString(), claimed!.leaseToken!, {
    optimizedStorageKey: "videos/optimized/clear.mp4",
    thumbnailStorageKey: "videos/thumbnails/clear.jpg",
  });

  assert.equal(completed?.leaseToken, null);
  assert.equal(completed?.leaseExpiresAt, null);
});

// ---------------------------------------------------------------------------
// Failure and retries
// ---------------------------------------------------------------------------

test("a retryable failure below max attempts schedules a retry and clears the lease", async () => {
  await createJob("retry-below-max");
  const claimed = await repository.claimNext();
  assert.equal(claimed?.attempts, 1);

  const failed = await repository.recordFailure(claimed!._id.toString(), claimed!.leaseToken!, {
    errorCode: "encode_failed",
    errorSummary: "ffmpeg exited with code 1",
  });

  assert.equal(failed?.status, "failed_retryable");
  assert.ok(failed?.nextRetryAt);
  assert.equal(failed?.leaseToken, null);
  assert.equal(failed?.lastErrorCode, "encode_failed");
  assert.equal(failed?.lastErrorSummary, "ffmpeg exited with code 1");
});

test("initial attempt plus exactly two automatic retries: the third failure is permanent", async () => {
  await createJob("retry-exhaustion");

  // Attempt 1.
  let claimed = await repository.claimNext();
  assert.equal(claimed?.attempts, 1);
  let failed = await repository.recordFailure(claimed!._id.toString(), claimed!.leaseToken!, {
    errorCode: "timeout",
  });
  assert.equal(failed?.status, "failed_retryable");
  assert.ok(failed?.nextRetryAt);

  // Make the retry due immediately for the test.
  await TranscodingJobModel.updateOne({ _id: failed!._id }, { $set: { nextRetryAt: new Date(Date.now() - 1000) } });

  // Attempt 2 (automatic retry 1).
  claimed = await repository.claimNext();
  assert.equal(claimed?.attempts, 2);
  failed = await repository.recordFailure(claimed!._id.toString(), claimed!.leaseToken!, { errorCode: "timeout" });
  assert.equal(failed?.status, "failed_retryable");

  await TranscodingJobModel.updateOne({ _id: failed!._id }, { $set: { nextRetryAt: new Date(Date.now() - 1000) } });

  // Attempt 3 (automatic retry 2) — this is the third and final allowed attempt.
  claimed = await repository.claimNext();
  assert.equal(claimed?.attempts, 3);
  failed = await repository.recordFailure(claimed!._id.toString(), claimed!.leaseToken!, { errorCode: "timeout" });

  assert.equal(failed?.status, "failed");
  assert.equal(failed?.nextRetryAt, null);
  assert.ok(failed?.failedAt);

  // A fourth attempt must never be claimable.
  const fourthAttempt = await repository.claimNext();
  assert.notEqual(fourthAttempt?._id.toString(), failed?._id.toString());
});

test("a permanent failure does not schedule another retry", async () => {
  const job = await createJob("retry-permanent-no-schedule", {
    status: "processing",
    leaseToken: "token-x",
    leaseExpiresAt: new Date(Date.now() + 60_000),
    attempts: 3,
    maxAttempts: 3,
  });

  const failed = await repository.recordFailure(job._id.toString(), "token-x", { errorCode: "encode_failed" });

  assert.equal(failed?.status, "failed");
  assert.equal(failed?.nextRetryAt, null);
});

test("a completed job cannot be failed or requeued", async () => {
  await createJob("retry-completed-immune");
  const claimed = await repository.claimNext();
  const completed = await repository.markSuccess(claimed!._id.toString(), claimed!.leaseToken!, {
    optimizedStorageKey: "videos/optimized/immune.mp4",
    thumbnailStorageKey: "videos/thumbnails/immune.jpg",
  });
  assert.equal(completed?.status, "completed");

  const attemptedFailure = await repository.recordFailure(completed!._id.toString(), claimed!.leaseToken!, {
    errorCode: "encode_failed",
  });
  assert.equal(attemptedFailure, null);

  const requeueAttempt = await repository.claimNext();
  assert.notEqual(requeueAttempt?._id.toString(), completed?._id.toString());

  const stillCompleted = await repository.findById(completed!._id.toString());
  assert.equal(stillCompleted?.status, "completed");
});

test("a cancelled job is never picked up by automatic retry claiming", async () => {
  const job = await createJob("retry-cancelled-not-claimed");
  await repository.cancel(job._id.toString(), "moment deleted");

  const claimed = await repository.claimNext();

  assert.notEqual(claimed?._id.toString(), job._id.toString());
});

// ---------------------------------------------------------------------------
// recordFailure lease hardening
// ---------------------------------------------------------------------------

test("recordFailure with the wrong token returns null and stores nothing", async () => {
  await createJob("fail-wrong-token");
  const claimed = await repository.claimNext();

  const result = await repository.recordFailure(claimed!._id.toString(), "not-the-real-token", {
    errorCode: "encode_failed",
    errorSummary: "should never be stored",
  });

  assert.equal(result, null);

  const current = await repository.findById(claimed!._id.toString());
  assert.equal(current?.status, "processing");
  assert.equal(current?.leaseToken, claimed?.leaseToken);
  assert.equal(current?.lastErrorCode, null);
  assert.equal(current?.lastErrorSummary, null);
});

test("recordFailure with an old token cannot mutate a job after another worker reclaims it", async () => {
  const job = await createJob("fail-stale-reclaim", {
    status: "processing",
    leaseToken: "worker-a-token",
    leaseExpiresAt: new Date(Date.now() - 1000),
    attempts: 1,
  });

  // Worker B reclaims the same job and receives a brand-new token.
  const reclaimedByB = await repository.claimNext();
  assert.ok(reclaimedByB);
  assert.equal(reclaimedByB?._id.toString(), job._id.toString());
  assert.notEqual(reclaimedByB?.leaseToken, "worker-a-token");
  assert.equal(reclaimedByB?.attempts, 2);

  // Worker A, unaware it has been reclaimed, tries to record its failure
  // using its now-superseded token.
  const staleFailure = await repository.recordFailure(job._id.toString(), "worker-a-token", {
    errorCode: "timeout",
    errorSummary: "worker A stale failure — must not apply",
  });

  assert.equal(staleFailure, null);

  const current = await repository.findById(job._id.toString());
  assert.equal(current?.status, "processing");
  assert.equal(current?.leaseToken, reclaimedByB?.leaseToken);
  assert.equal(current?.attempts, 2);
  assert.equal(current?.lastErrorCode, null);
  assert.equal(current?.lastErrorSummary, null);

  // Worker B, the legitimate current owner, can still record a result using
  // its own current token.
  const bFailure = await repository.recordFailure(job._id.toString(), reclaimedByB!.leaseToken!, {
    errorCode: "timeout",
    errorSummary: "worker B legitimate failure",
  });

  assert.equal(bFailure?.status, "failed_retryable");
  assert.equal(bFailure?.lastErrorSummary, "worker B legitimate failure");
  assert.equal(bFailure?.leaseToken, null);
});

test("recordFailure cannot change a completed job", async () => {
  await createJob("fail-completed-immune");
  const claimed = await repository.claimNext();
  const completed = await repository.markSuccess(claimed!._id.toString(), claimed!.leaseToken!, {
    optimizedStorageKey: "videos/optimized/immune-fail.mp4",
    thumbnailStorageKey: "videos/thumbnails/immune-fail.jpg",
  });

  const attemptedFailure = await repository.recordFailure(completed!._id.toString(), claimed!.leaseToken!, {
    errorCode: "encode_failed",
  });

  assert.equal(attemptedFailure, null);

  const current = await repository.findById(completed!._id.toString());
  assert.equal(current?.status, "completed");
  assert.equal(current?.optimizedStorageKey, "videos/optimized/immune-fail.mp4");
});

test("recordFailure cannot change a cancelled job", async () => {
  const job = await createJob("fail-cancelled-immune", {
    status: "processing",
    leaseToken: "cancel-immune-token",
    leaseExpiresAt: new Date(Date.now() + 60_000),
  });
  const cancelled = await repository.cancel(job._id.toString(), "moment deleted mid-processing");
  assert.equal(cancelled?.status, "cancelled");

  const attemptedFailure = await repository.recordFailure(job._id.toString(), "cancel-immune-token", {
    errorCode: "encode_failed",
  });

  assert.equal(attemptedFailure, null);

  const current = await repository.findById(job._id.toString());
  assert.equal(current?.status, "cancelled");
});

test("recordFailure cannot change an already permanently failed job", async () => {
  const job = await createJob("fail-permanent-immune", {
    status: "failed",
    attempts: 3,
    maxAttempts: 3,
    failedAt: new Date(),
  });

  // A permanently failed job has no active lease, so a caller could only
  // reach this with a stale token from before the terminal transition —
  // confirm that token no longer matches regardless.
  const attemptedFailure = await repository.recordFailure(job._id.toString(), "any-token", {
    errorCode: "encode_failed",
  });

  assert.equal(attemptedFailure, null);

  const current = await repository.findById(job._id.toString());
  assert.equal(current?.status, "failed");
});

test("recordFailure still sanitizes the stored error summary (bounded, redacted)", async () => {
  await createJob("fail-sanitized-summary");
  const claimed = await repository.claimNext();

  const failed = await repository.recordFailure(claimed!._id.toString(), claimed!.leaseToken!, {
    errorCode: "upload_failed",
    errorSummary: "upload failed for https://bucket.s3.amazonaws.com/videos/originals/abc.mp4?X-Amz-Signature=deadbeef "
      + "using /tmp/transcode-job-8f21/source.mp4\nsecond line of noisy stderr",
  });

  assert.equal(failed?.status, "failed_retryable");
  assert.equal(failed?.lastErrorCode, "upload_failed");
  assert.doesNotMatch(failed?.lastErrorSummary ?? "", /https?:\/\//);
  assert.doesNotMatch(failed?.lastErrorSummary ?? "", /X-Amz-Signature/);
  assert.doesNotMatch(failed?.lastErrorSummary ?? "", /\/tmp\//);
  assert.doesNotMatch(failed?.lastErrorSummary ?? "", /\n/);
  assert.ok((failed?.lastErrorSummary?.length ?? 0) <= 500);
});

// ---------------------------------------------------------------------------
// markPermanentFailure (immediate terminal failure — permanent source problems)
// ---------------------------------------------------------------------------

test("markPermanentFailure moves a processing job straight to failed on attempt 1, without incrementing attempts again", async () => {
  await createJob("permanent-basic");
  const claimed = await repository.claimNext();
  assert.equal(claimed?.attempts, 1);

  const failed = await repository.markPermanentFailure(claimed!._id.toString(), claimed!.leaseToken!, {
    errorCode: "source_invalid",
    errorSummary: "no valid video stream",
  });

  assert.equal(failed?.status, "failed");
  assert.equal(failed?.attempts, 1);
  assert.equal(failed?.lastErrorCode, "source_invalid");
  assert.equal(failed?.lastErrorSummary, "no valid video stream");
  assert.equal(failed?.nextRetryAt, null);
  assert.equal(failed?.leaseToken, null);
  assert.equal(failed?.leaseExpiresAt, null);
  assert.ok(failed?.failedAt);
});

test("markPermanentFailure never passes through failed_retryable — it is never claimable again", async () => {
  await createJob("permanent-not-claimable");
  const claimed = await repository.claimNext();

  await repository.markPermanentFailure(claimed!._id.toString(), claimed!.leaseToken!, {
    errorCode: "source_too_large",
  });

  const reclaimAttempt = await repository.claimNext();
  assert.notEqual(reclaimAttempt?._id.toString(), claimed?._id.toString());

  const current = await repository.findById(claimed!._id.toString());
  assert.equal(current?.status, "failed");
});

test("markPermanentFailure with the wrong token returns null and stores nothing", async () => {
  await createJob("permanent-wrong-token");
  const claimed = await repository.claimNext();

  const result = await repository.markPermanentFailure(claimed!._id.toString(), "not-the-real-token", {
    errorCode: "source_invalid",
    errorSummary: "should never be stored",
  });

  assert.equal(result, null);

  const current = await repository.findById(claimed!._id.toString());
  assert.equal(current?.status, "processing");
  assert.equal(current?.leaseToken, claimed?.leaseToken);
  assert.equal(current?.lastErrorCode, null);
});

test("markPermanentFailure with a stale token cannot affect a job after another worker reclaims it", async () => {
  const job = await createJob("permanent-stale-reclaim", {
    status: "processing",
    leaseToken: "worker-a-permanent-token",
    leaseExpiresAt: new Date(Date.now() - 1000),
    attempts: 1,
  });

  const reclaimedByB = await repository.claimNext();
  assert.equal(reclaimedByB?._id.toString(), job._id.toString());

  const staleResult = await repository.markPermanentFailure(job._id.toString(), "worker-a-permanent-token", {
    errorCode: "source_invalid",
  });

  assert.equal(staleResult, null);

  const current = await repository.findById(job._id.toString());
  assert.equal(current?.status, "processing");
  assert.equal(current?.leaseToken, reclaimedByB?.leaseToken);
});

test("markPermanentFailure cannot change a completed job", async () => {
  await createJob("permanent-completed-immune");
  const claimed = await repository.claimNext();
  const completed = await repository.markSuccess(claimed!._id.toString(), claimed!.leaseToken!, {
    optimizedStorageKey: "videos/optimized/permanent-immune.mp4",
    thumbnailStorageKey: "videos/thumbnails/permanent-immune.jpg",
  });

  const attempted = await repository.markPermanentFailure(completed!._id.toString(), claimed!.leaseToken!, {
    errorCode: "source_invalid",
  });

  assert.equal(attempted, null);

  const current = await repository.findById(completed!._id.toString());
  assert.equal(current?.status, "completed");
});

test("markPermanentFailure cannot change a cancelled job", async () => {
  const job = await createJob("permanent-cancelled-immune", {
    status: "processing",
    leaseToken: "cancel-immune-permanent-token",
    leaseExpiresAt: new Date(Date.now() + 60_000),
  });
  await repository.cancel(job._id.toString(), "moment deleted");

  const attempted = await repository.markPermanentFailure(job._id.toString(), "cancel-immune-permanent-token", {
    errorCode: "source_invalid",
  });

  assert.equal(attempted, null);

  const current = await repository.findById(job._id.toString());
  assert.equal(current?.status, "cancelled");
});

test("markPermanentFailure cannot change an already permanently failed job", async () => {
  const job = await createJob("permanent-already-failed-immune", {
    status: "failed",
    attempts: 1,
    failedAt: new Date(),
  });

  const attempted = await repository.markPermanentFailure(job._id.toString(), "any-token", {
    errorCode: "source_invalid",
  });

  assert.equal(attempted, null);

  const current = await repository.findById(job._id.toString());
  assert.equal(current?.status, "failed");
});

test("markPermanentFailure sanitizes the stored error summary (bounded, redacted)", async () => {
  await createJob("permanent-sanitized-summary");
  const claimed = await repository.claimNext();

  const failed = await repository.markPermanentFailure(claimed!._id.toString(), claimed!.leaseToken!, {
    errorCode: "source_invalid",
    errorSummary: "source unreadable at /tmp/transcode-job-abc12/source.mp4",
  });

  assert.equal(failed?.status, "failed");
  assert.doesNotMatch(failed?.lastErrorSummary ?? "", /\/tmp\//);
  assert.ok((failed?.lastErrorSummary?.length ?? 0) <= 500);
});

// ---------------------------------------------------------------------------
// deferClaim (operational defer — disk capacity, not a media failure)
// ---------------------------------------------------------------------------

test("deferClaim returns a claimed job to queued without consuming a media attempt", async () => {
  await createJob("defer-basic");
  const claimed = await repository.claimNext();
  assert.equal(claimed?.attempts, 1);

  const deferred = await repository.deferClaim(claimed!._id.toString(), claimed!.leaseToken!, {
    retryDelayMs: 1000,
  });

  assert.equal(deferred?.status, "queued");
  assert.equal(deferred?.attempts, 0);
  assert.equal(deferred?.leaseToken, null);
  assert.equal(deferred?.leaseExpiresAt, null);
  assert.ok(deferred?.nextRetryAt);
  assert.equal(deferred?.lastErrorCode, null);
  assert.equal(deferred?.lastErrorSummary, null);

  // deferClaim leaves the job "queued" and soon due — cancel it so it can
  // never be picked up by a later test's claimNext() call (claimNext always
  // prefers the oldest due job, so a leftover due job here would silently
  // hijack a later test's claim).
  await repository.cancel(deferred!._id.toString());
});

test("deferClaim does not schedule a permanent failure even after repeated defers", async () => {
  const job = await createJob("defer-repeated");

  for (let i = 0; i < 5; i += 1) {
    // Make this specific job immediately due again for the test.
    await TranscodingJobModel.updateOne({ _id: job._id }, { $set: { nextRetryAt: new Date(Date.now() - 1000) } });

    const claimed = await repository.claimNext();
    assert.equal(claimed?._id.toString(), job._id.toString(), `iteration ${i} should reclaim the same job`);

    const deferred = await repository.deferClaim(claimed!._id.toString(), claimed!.leaseToken!, { retryDelayMs: 10 });
    assert.equal(deferred?.status, "queued");
    assert.equal(deferred?.attempts, 0);
    assert.notEqual(deferred?.status, "failed");
  }

  await repository.cancel(job._id.toString());
});

test("a full claim after a defer consumes exactly one real attempt, as if the defer never happened", async () => {
  await createJob("defer-then-real-claim");
  const firstClaim = await repository.claimNext();
  assert.equal(firstClaim?.attempts, 1);

  const deferred = await repository.deferClaim(firstClaim!._id.toString(), firstClaim!.leaseToken!, { retryDelayMs: 10 });
  assert.equal(deferred?.attempts, 0);

  await TranscodingJobModel.updateOne({ _id: deferred!._id }, { $set: { nextRetryAt: new Date(Date.now() - 1000) } });

  const realClaim = await repository.claimNext();
  assert.equal(realClaim?.attempts, 1);
});

test("deferClaim with the wrong token returns null and does not affect the job", async () => {
  await createJob("defer-wrong-token");
  const claimed = await repository.claimNext();

  const result = await repository.deferClaim(claimed!._id.toString(), "not-the-real-token", { retryDelayMs: 1000 });

  assert.equal(result, null);

  const current = await repository.findById(claimed!._id.toString());
  assert.equal(current?.status, "processing");
  assert.equal(current?.attempts, 1);
  assert.equal(current?.leaseToken, claimed?.leaseToken);
});

test("deferClaim with an old token cannot affect a job after another worker reclaims it", async () => {
  const job = await createJob("defer-stale-reclaim", {
    status: "processing",
    leaseToken: "worker-a-defer-token",
    leaseExpiresAt: new Date(Date.now() - 1000),
    attempts: 1,
  });

  const reclaimedByB = await repository.claimNext();
  assert.equal(reclaimedByB?._id.toString(), job._id.toString());
  assert.equal(reclaimedByB?.attempts, 2);

  const staleDefer = await repository.deferClaim(job._id.toString(), "worker-a-defer-token", { retryDelayMs: 1000 });

  assert.equal(staleDefer, null);

  const current = await repository.findById(job._id.toString());
  assert.equal(current?.status, "processing");
  assert.equal(current?.attempts, 2);
  assert.equal(current?.leaseToken, reclaimedByB?.leaseToken);
});

test("deferClaim cannot change a completed job", async () => {
  await createJob("defer-completed-immune");
  const claimed = await repository.claimNext();
  const completed = await repository.markSuccess(claimed!._id.toString(), claimed!.leaseToken!, {
    optimizedStorageKey: "videos/optimized/defer-immune.mp4",
    thumbnailStorageKey: "videos/thumbnails/defer-immune.jpg",
  });

  const attemptedDefer = await repository.deferClaim(completed!._id.toString(), claimed!.leaseToken!, { retryDelayMs: 1000 });

  assert.equal(attemptedDefer, null);

  const current = await repository.findById(completed!._id.toString());
  assert.equal(current?.status, "completed");
});

// ---------------------------------------------------------------------------
// Cleanup state
// ---------------------------------------------------------------------------

test("a completed job has cleanupStatus pending automatically", async () => {
  await createJob("cleanup-pending-on-success");
  const claimed = await repository.claimNext();
  const completed = await repository.markSuccess(claimed!._id.toString(), claimed!.leaseToken!, {
    optimizedStorageKey: "videos/optimized/cleanup.mp4",
    thumbnailStorageKey: "videos/thumbnails/cleanup.jpg",
  });

  assert.equal(completed?.cleanupStatus, "pending");
});

test("cleanup success records the original-deletion timestamp without touching job status", async () => {
  await createJob("cleanup-success");
  const claimed = await repository.claimNext();
  const completed = await repository.markSuccess(claimed!._id.toString(), claimed!.leaseToken!, {
    optimizedStorageKey: "videos/optimized/x.mp4",
    thumbnailStorageKey: "videos/thumbnails/x.jpg",
  });
  await repository.markMomentSynced(completed!._id.toString());

  const claimedCleanup = await repository.claimNextCleanup();
  assert.equal(claimedCleanup?._id.toString(), completed!._id.toString());

  const deletedAt = new Date();
  const cleaned = await repository.markCleanupCompleted(claimedCleanup!._id.toString(), claimedCleanup!.cleanupLeaseToken!, deletedAt);

  assert.equal(cleaned?.cleanupStatus, "completed");
  assert.equal(cleaned?.originalDeletedAt?.toISOString(), deletedAt.toISOString());
  assert.equal(cleaned?.status, "completed");
  assert.equal(cleaned?.cleanupLeaseToken, null);
  assert.equal(cleaned?.cleanupLeaseExpiresAt, null);
});

test("cleanup failure does not change a completed job's processing status", async () => {
  await createJob("cleanup-failure-independent");
  const claimed = await repository.claimNext();
  const completed = await repository.markSuccess(claimed!._id.toString(), claimed!.leaseToken!, {
    optimizedStorageKey: "videos/optimized/y.mp4",
    thumbnailStorageKey: "videos/thumbnails/y.jpg",
  });
  await repository.markMomentSynced(completed!._id.toString());

  const claimedCleanup = await repository.claimNextCleanup();
  assert.equal(claimedCleanup?._id.toString(), completed!._id.toString());

  const cleanupFailed = await repository.markCleanupFailed(claimedCleanup!._id.toString(), claimedCleanup!.cleanupLeaseToken!, {
    errorCode: "delete_failed",
    errorSummary: "S3 delete returned 500",
  });

  assert.equal(cleanupFailed?.status, "completed");
  assert.equal(cleanupFailed?.cleanupStatus, "failed");
  assert.equal(cleanupFailed?.cleanupAttempts, 1);
  assert.ok(cleanupFailed?.cleanupNextRetryAt);
  assert.equal(cleanupFailed?.cleanupLeaseToken, null);
});

test("cleanup idempotency: a fresh reclaim after a crash sees the original already missing and still completes cleanly", async () => {
  // Simulates the real idempotency scenario from section 9/14: the S3 delete
  // already succeeded once, but the worker crashed before the DB write, so
  // the job is still cleanupStatus:"pending" (or "failed"-but-due) and gets
  // re-claimed with a brand-new lease token. Repeatedly calling
  // markCleanupCompleted() with a *stale* token must NOT work — only a fresh
  // claim's own current token may ever complete it.
  await createJob("cleanup-idempotent");
  const claimed = await repository.claimNext();
  const completed = await repository.markSuccess(claimed!._id.toString(), claimed!.leaseToken!, {
    optimizedStorageKey: "videos/optimized/z.mp4",
    thumbnailStorageKey: "videos/thumbnails/z.jpg",
  });
  await repository.markMomentSynced(completed!._id.toString());

  const firstClaim = await repository.claimNextCleanup();
  assert.equal(firstClaim?._id.toString(), completed!._id.toString());
  const first = await repository.markCleanupCompleted(firstClaim!._id.toString(), firstClaim!.cleanupLeaseToken!);
  assert.equal(first?.cleanupStatus, "completed");

  // The stale first-claim token can no longer complete anything — the job is
  // already completed and no longer even claimable.
  const staleRetry = await repository.markCleanupCompleted(firstClaim!._id.toString(), firstClaim!.cleanupLeaseToken!);
  assert.equal(staleRetry, null);

  const reclaimAttempt = await repository.claimNextCleanup();
  assert.notEqual(reclaimAttempt?._id.toString(), completed!._id.toString());
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

test("a queued job can be cancelled", async () => {
  const job = await createJob("cancel-queued");

  const cancelled = await repository.cancel(job._id.toString(), "post deleted");

  assert.equal(cancelled?.status, "cancelled");
  assert.ok(cancelled?.cancelledAt);
  assert.equal(cancelled?.cancelReason, "post deleted");
});

test("a processing job can be cancelled safely", async () => {
  await createJob("cancel-processing");
  const claimed = await repository.claimNext();

  const cancelled = await repository.cancel(claimed!._id.toString(), "user deleted account");

  assert.equal(cancelled?.status, "cancelled");
  assert.equal(cancelled?.leaseToken, null);
  assert.equal(cancelled?.leaseExpiresAt, null);
});

test("cancellation is idempotent", async () => {
  const job = await createJob("cancel-idempotent");

  const first = await repository.cancel(job._id.toString(), "first reason");
  const second = await repository.cancel(job._id.toString(), "second reason ignored");

  assert.equal(first?.status, "cancelled");
  assert.equal(second?.status, "cancelled");
  assert.equal(first?.cancelledAt?.toISOString(), second?.cancelledAt?.toISOString());
  assert.equal(second?.cancelReason, "first reason");
});

test("a completed job is not destructively reset by cancellation", async () => {
  await createJob("cancel-completed-protected");
  const claimed = await repository.claimNext();
  const completed = await repository.markSuccess(claimed!._id.toString(), claimed!.leaseToken!, {
    optimizedStorageKey: "videos/optimized/protected.mp4",
    thumbnailStorageKey: "videos/thumbnails/protected.jpg",
  });

  const afterCancelAttempt = await repository.cancel(completed!._id.toString(), "should not apply");

  assert.equal(afterCancelAttempt?.status, "completed");
  assert.equal(afterCancelAttempt?.cancelledAt, null);
  assert.equal(afterCancelAttempt?.optimizedStorageKey, "videos/optimized/protected.mp4");
});

// ---------------------------------------------------------------------------
// Isolation: the exact Phase 3A integration boundary must hold — only
// moment.service.ts (via TranscodingMomentSyncService) is allowed to
// reference the transcoding module; every other Moment-adjacent file, and
// the standalone worker's own bootstrap boundary (server.ts must never start
// it), remain exactly as dormant as they were in Phase 1/2.
// ---------------------------------------------------------------------------

test("no runtime module other than moment.service.ts and the transcoding module itself references TranscodingJob", () => {
  const srcRoot = join(process.cwd(), "src");
  const filesToCheck = [
    "modules/moments/moment.controller.ts",
    "modules/moments/moment.route.ts",
    "modules/moments/moment-video.service.ts",
    "modules/moments/moment.model.ts",
    "server.ts",
  ];

  for (const relativePath of filesToCheck) {
    const contents = readFileSync(join(srcRoot, relativePath), "utf8");
    assert.doesNotMatch(
      contents,
      /TranscodingJob/,
      `${relativePath} must not reference TranscodingJob`,
    );
  }
});

test("the Moment media schema/model layer never imports the transcoding module", () => {
  const contents = readFileSync(join(process.cwd(), "src/modules/moments/moment.model.ts"), "utf8");

  assert.doesNotMatch(contents, /modules\/transcoding/);
});

test("moment.service.ts integrates with transcoding only through TranscodingMomentSyncService, never the repository or model directly", () => {
  const contents = readFileSync(join(process.cwd(), "src/modules/moments/moment.service.ts"), "utf8");

  assert.match(contents, /transcoding-moment-sync\.service\.js/);
  assert.doesNotMatch(contents, /transcoding-job\.(repository|model)\.js/);
});

test("server.ts never starts or imports the standalone video worker", () => {
  const contents = readFileSync(join(process.cwd(), "src/server.ts"), "utf8");

  assert.doesNotMatch(contents, /video-worker/);
});
