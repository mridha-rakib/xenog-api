import assert from "node:assert/strict";
import test from "node:test";
import { buildOptimizedVideoKey, buildThumbnailKey } from "../src/modules/transcoding/output-keys.js";

test("buildOptimizedVideoKey produces the expected deterministic structure", () => {
  const key = buildOptimizedVideoKey("507f1f77bcf86cd799439011", "608f1f77bcf86cd799439099");

  assert.equal(key, "videos/optimized/507f1f77bcf86cd799439011/608f1f77bcf86cd799439099.mp4");
});

test("buildThumbnailKey produces the expected deterministic structure", () => {
  const key = buildThumbnailKey("507f1f77bcf86cd799439011", "608f1f77bcf86cd799439099");

  assert.equal(key, "videos/thumbnails/507f1f77bcf86cd799439011/608f1f77bcf86cd799439099.jpg");
});

test("the same job id always resolves to the same keys (retry idempotency, no orphan accumulation)", () => {
  const first = buildOptimizedVideoKey("user-1", "job-1");
  const second = buildOptimizedVideoKey("user-1", "job-1");

  assert.equal(first, second);
});

test("different job ids never collide", () => {
  const jobA = buildOptimizedVideoKey("user-1", "job-1");
  const jobB = buildOptimizedVideoKey("user-1", "job-2");

  assert.notEqual(jobA, jobB);
});

test("different users' keys never collide even with the same job id (defense in depth)", () => {
  const userA = buildOptimizedVideoKey("user-1", "job-shared");
  const userB = buildOptimizedVideoKey("user-2", "job-shared");

  assert.notEqual(userA, userB);
});

test("rejects an unsafe userId or jobId rather than building an unvalidated key", () => {
  assert.throws(() => buildOptimizedVideoKey("../../etc", "job-1"));
  assert.throws(() => buildOptimizedVideoKey("user-1", "job/with/slashes"));
  assert.throws(() => buildThumbnailKey("user 1", "job-1"));
});

test("optimized and thumbnail keys for the same job never collide with each other", () => {
  const video = buildOptimizedVideoKey("user-1", "job-1");
  const thumbnail = buildThumbnailKey("user-1", "job-1");

  assert.notEqual(video, thumbnail);
});
