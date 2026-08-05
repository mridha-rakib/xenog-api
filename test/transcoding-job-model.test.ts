import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { TranscodingJobModel } from "../src/modules/transcoding/transcoding-job.model.js";
import {
  TRANSCODING_JOB_MAX_ATTEMPTS,
  TRANSCODING_JOB_RETRY_BASE_DELAY_MS,
  computeTranscodingJobRetryDelayMs,
  transcodingJobStatuses,
} from "../src/modules/transcoding/transcoding-job.interface.js";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const requiredFields = () => ({
  momentId: new Types.ObjectId(),
  userId: new Types.ObjectId(),
  sourceStorageKey: "moments/507f1f77bcf86cd799439011/video/00000000-0000-4000-8000-000000000000.mp4",
});

test("a job with only the required identity fields validates and defaults are applied", async () => {
  const doc = new TranscodingJobModel(requiredFields());

  await doc.validate();

  assert.equal(doc.status, "queued");
  assert.equal(doc.attempts, 0);
  assert.equal(doc.maxAttempts, TRANSCODING_JOB_MAX_ATTEMPTS);
  assert.equal(doc.maxAttempts, 3);
  assert.equal(doc.cleanupAttempts, 0);
  assert.equal(doc.cleanupStatus, null);
  assert.equal(doc.leaseToken, null);
});

test("momentId, userId, and sourceStorageKey are required", async () => {
  await assert.rejects(() => new TranscodingJobModel({}).validate());
  await assert.rejects(() => new TranscodingJobModel({ momentId: new Types.ObjectId() }).validate());
  await assert.rejects(() => new TranscodingJobModel({
    momentId: new Types.ObjectId(),
    userId: new Types.ObjectId(),
  }).validate());
});

test("every documented job status is a valid enum value", async () => {
  assert.deepEqual([...transcodingJobStatuses], [
    "queued",
    "processing",
    "failed_retryable",
    "completed",
    "failed",
    "cancelled",
  ]);

  for (const status of transcodingJobStatuses) {
    const doc = new TranscodingJobModel({ ...requiredFields(), status });
    await doc.validate();
    assert.equal(doc.status, status);
  }
});

test("an invalid job status is rejected", async () => {
  const doc = new TranscodingJobModel({ ...requiredFields(), status: "done" });

  await assert.rejects(() => doc.validate());
});

test("an invalid cleanup status is rejected, but a valid one is accepted independent of job status", async () => {
  const invalid = new TranscodingJobModel({ ...requiredFields(), cleanupStatus: "in_progress" });
  await assert.rejects(() => invalid.validate());

  const valid = new TranscodingJobModel({ ...requiredFields(), status: "completed", cleanupStatus: "pending" });
  await valid.validate();
  assert.equal(valid.status, "completed");
  assert.equal(valid.cleanupStatus, "pending");
});

test("cleanup fields default independently of the main status field", async () => {
  const doc = new TranscodingJobModel({ ...requiredFields(), status: "processing" });

  await doc.validate();

  assert.equal(doc.cleanupStatus, null);
  assert.equal(doc.originalDeletedAt, null);
  assert.equal(doc.cleanupErrorCode, null);
});

test("optional output fields accept safe values and default to null when absent", async () => {
  const doc = new TranscodingJobModel({
    ...requiredFields(),
    status: "completed",
    optimizedStorageKey: "videos/optimized/abc.mp4",
    thumbnailStorageKey: "videos/thumbnails/abc.jpg",
    outputWidth: 1280,
    outputHeight: 720,
    outputFileSize: 4_200_000,
    outputDurationSeconds: 42.5,
  });

  await doc.validate();

  assert.equal(doc.optimizedStorageKey, "videos/optimized/abc.mp4");
  assert.equal(doc.outputWidth, 1280);

  const bare = new TranscodingJobModel(requiredFields());
  await bare.validate();
  assert.equal(bare.optimizedStorageKey, null);
  assert.equal(bare.outputWidth, null);
});

test("the compound (momentId, sourceStorageKey) index is declared unique", () => {
  const indexes = TranscodingJobModel.schema.indexes();
  const idempotencyIndex = indexes.find(([keys]) => "momentId" in keys && "sourceStorageKey" in keys);

  assert.ok(idempotencyIndex, "expected a (momentId, sourceStorageKey) index to be declared");
  assert.equal(idempotencyIndex?.[1]?.unique, true);
});

test("the claim index covers status, nextRetryAt, and leaseExpiresAt", () => {
  const indexes = TranscodingJobModel.schema.indexes();
  const claimIndex = indexes.find(([keys]) => "status" in keys && "nextRetryAt" in keys && "leaseExpiresAt" in keys);

  assert.ok(claimIndex, "expected a claim-support index on {status, nextRetryAt, leaseExpiresAt}");
});

test("computeTranscodingJobRetryDelayMs doubles per attempt and is capped", () => {
  assert.equal(computeTranscodingJobRetryDelayMs(1), TRANSCODING_JOB_RETRY_BASE_DELAY_MS);
  assert.equal(computeTranscodingJobRetryDelayMs(2), TRANSCODING_JOB_RETRY_BASE_DELAY_MS * 2);
  assert.equal(computeTranscodingJobRetryDelayMs(3), TRANSCODING_JOB_RETRY_BASE_DELAY_MS * 4);
  // Capped growth for any larger input, never negative, never zero.
  assert.ok(computeTranscodingJobRetryDelayMs(50) > 0);
  assert.ok(computeTranscodingJobRetryDelayMs(50) <= TRANSCODING_JOB_RETRY_BASE_DELAY_MS * 8);
  assert.equal(computeTranscodingJobRetryDelayMs(0), TRANSCODING_JOB_RETRY_BASE_DELAY_MS);
  assert.equal(computeTranscodingJobRetryDelayMs(-1), TRANSCODING_JOB_RETRY_BASE_DELAY_MS);
});

test("lastErrorSummary and cleanupErrorSummary are bounded and never required", async () => {
  const doc = new TranscodingJobModel(requiredFields());

  await doc.validate();

  assert.equal(doc.lastErrorSummary, null);
  assert.equal(doc.cleanupErrorSummary, null);
});
