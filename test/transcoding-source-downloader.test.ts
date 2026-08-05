import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import type { StorageObject, StorageObjectMetadata, StorageService } from "../src/modules/storage/storage.service.js";
import {
  checkSourceHead,
  downloadSourceToFile,
  isMissingObjectError,
  isRetryableStorageError,
  redactStorageKey,
} from "../src/modules/transcoding/source-downloader.js";

const MAX_BYTES = 1024;

const fakeStorageService = (overrides: {
  getObjectMetadata?: (key: string) => Promise<StorageObjectMetadata>;
  getObject?: (key: string, range?: string, abortSignal?: AbortSignal) => Promise<StorageObject>;
}): StorageService => {
  return {
    getObjectMetadata: overrides.getObjectMetadata ?? (async () => ({ contentLength: 10, contentType: "video/mp4" })),
    getObject: overrides.getObject
      ?? (async () => ({ body: Readable.from([Buffer.from("hello")]), contentLength: 5, contentType: "video/mp4" })),
  } as unknown as StorageService;
};

const notFoundError = (): Error => {
  const error = new Error("not found") as Error & { $metadata?: { httpStatusCode?: number } };
  error.$metadata = { httpStatusCode: 404 };
  return error;
};

const serviceUnavailableError = (): Error => {
  const error = new Error("service unavailable") as Error & { $metadata?: { httpStatusCode?: number } };
  error.$metadata = { httpStatusCode: 503 };
  return error;
};

let workDir = "";

test.beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "xenog-source-downloader-test-"));
});

test.afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

test("checkSourceHead: returns ok with contentLength and contentType when within the limit", async () => {
  const storageService = fakeStorageService({
    getObjectMetadata: async () => ({ contentLength: 500, contentType: "video/mp4" }),
  });

  const result = await checkSourceHead(storageService, "moments/user1/video.mp4", MAX_BYTES);

  assert.deepEqual(result, { ok: true, contentLength: 500, contentType: "video/mp4" });
});

test("checkSourceHead: reason content_length_unavailable when contentLength is missing", async () => {
  const storageService = fakeStorageService({
    getObjectMetadata: async () => ({ contentType: "video/mp4" }),
  });

  const result = await checkSourceHead(storageService, "moments/user1/video.mp4", MAX_BYTES);

  assert.deepEqual(result, { ok: false, reason: "content_length_unavailable" });
});

test("checkSourceHead: reason content_length_unavailable when contentLength is zero or negative", async () => {
  const storageService = fakeStorageService({
    getObjectMetadata: async () => ({ contentLength: 0, contentType: "video/mp4" }),
  });

  const result = await checkSourceHead(storageService, "moments/user1/video.mp4", MAX_BYTES);

  assert.deepEqual(result, { ok: false, reason: "content_length_unavailable" });
});

test("checkSourceHead: reason too_large when contentLength exceeds the configured maximum", async () => {
  const storageService = fakeStorageService({
    getObjectMetadata: async () => ({ contentLength: MAX_BYTES + 1, contentType: "video/mp4" }),
  });

  const result = await checkSourceHead(storageService, "moments/user1/video.mp4", MAX_BYTES);

  assert.deepEqual(result, { ok: false, reason: "too_large" });
});

test("checkSourceHead: reason missing on a 404-shaped error", async () => {
  const storageService = fakeStorageService({
    getObjectMetadata: async () => {
      throw notFoundError();
    },
  });

  const result = await checkSourceHead(storageService, "moments/user1/video.mp4", MAX_BYTES);

  assert.deepEqual(result, { ok: false, reason: "missing" });
});

test("checkSourceHead: reason storage_unavailable on an unrelated error", async () => {
  const storageService = fakeStorageService({
    getObjectMetadata: async () => {
      throw new Error("network blip");
    },
  });

  const result = await checkSourceHead(storageService, "moments/user1/video.mp4", MAX_BYTES);

  assert.deepEqual(result, { ok: false, reason: "storage_unavailable" });
});

test("downloadSourceToFile: streams the object to disk and reports the exact byte count", async () => {
  const payload = Buffer.from("a".repeat(200));
  const storageService = fakeStorageService({
    getObject: async () => ({ body: Readable.from([payload.subarray(0, 100), payload.subarray(100)]) }),
  });
  const destinationPath = join(workDir, "source.mp4");

  const result = await downloadSourceToFile({
    storageService,
    key: "moments/user1/video.mp4",
    destinationPath,
    maxBytes: MAX_BYTES,
  });

  assert.deepEqual(result, { ok: true, downloadedBytes: 200 });
  await assert.doesNotReject(access(destinationPath));
});

test("downloadSourceToFile: aborts and removes the partial file once the byte ceiling is exceeded", async () => {
  const oversized = Buffer.alloc(MAX_BYTES + 500, "b");
  const storageService = fakeStorageService({
    getObject: async () => ({
      body: Readable.from([oversized.subarray(0, MAX_BYTES), oversized.subarray(MAX_BYTES)]),
    }),
  });
  const destinationPath = join(workDir, "source.mp4");

  const result = await downloadSourceToFile({
    storageService,
    key: "moments/user1/video.mp4",
    destinationPath,
    maxBytes: MAX_BYTES,
  });

  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "too_large");
  await assert.rejects(access(destinationPath));
});

test("downloadSourceToFile: reason missing when the object no longer exists, and removes any partial file", async () => {
  const storageService = fakeStorageService({
    getObject: async () => {
      throw notFoundError();
    },
  });
  const destinationPath = join(workDir, "source.mp4");

  const result = await downloadSourceToFile({
    storageService,
    key: "moments/user1/video.mp4",
    destinationPath,
    maxBytes: MAX_BYTES,
  });

  assert.deepEqual(result, { ok: false, reason: "missing", downloadedBytes: 0 });
  await assert.rejects(access(destinationPath));
});

test("downloadSourceToFile: reason storage_unavailable on a retryable S3 error", async () => {
  const storageService = fakeStorageService({
    getObject: async () => {
      throw serviceUnavailableError();
    },
  });
  const destinationPath = join(workDir, "source.mp4");

  const result = await downloadSourceToFile({
    storageService,
    key: "moments/user1/video.mp4",
    destinationPath,
    maxBytes: MAX_BYTES,
  });

  assert.deepEqual(result, { ok: false, reason: "storage_unavailable", downloadedBytes: 0 });
});

test("downloadSourceToFile: reason download_failed on an unclassified error", async () => {
  const storageService = fakeStorageService({
    getObject: async () => {
      throw new Error("unexpected");
    },
  });
  const destinationPath = join(workDir, "source.mp4");

  const result = await downloadSourceToFile({
    storageService,
    key: "moments/user1/video.mp4",
    destinationPath,
    maxBytes: MAX_BYTES,
  });

  assert.deepEqual(result, { ok: false, reason: "download_failed", downloadedBytes: 0 });
});

test("downloadSourceToFile: a stream error partway through still removes the partial file", async () => {
  const streamWithError = new Readable({
    read() {
      this.push(Buffer.from("partial"));
      process.nextTick(() => this.destroy(new Error("connection reset")));
    },
  });
  const storageService = fakeStorageService({
    getObject: async () => ({ body: streamWithError }),
  });
  const destinationPath = join(workDir, "source.mp4");

  const result = await downloadSourceToFile({
    storageService,
    key: "moments/user1/video.mp4",
    destinationPath,
    maxBytes: MAX_BYTES,
  });

  assert.equal(result.ok, false);
  await assert.rejects(access(destinationPath));
});

test("isMissingObjectError / isRetryableStorageError: classify status codes and AWS error codes correctly", () => {
  assert.equal(isMissingObjectError(notFoundError()), true);
  assert.equal(isMissingObjectError({ code: "NoSuchKey" }), true);
  assert.equal(isMissingObjectError(new Error("plain")), false);

  assert.equal(isRetryableStorageError(serviceUnavailableError()), true);
  assert.equal(isRetryableStorageError({ code: "SlowDown" }), true);
  assert.equal(isRetryableStorageError(new Error("plain")), false);
});

test("redactStorageKey: deterministic 12-char hex digest that does not contain the raw key", () => {
  const key = `moments/${randomUUID()}/video-source.mp4`;

  const first = redactStorageKey(key);
  const second = redactStorageKey(key);

  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{12}$/);
  assert.equal(first.includes(key), false);
});

test("redactStorageKey: different keys produce different digests", () => {
  const a = redactStorageKey("moments/user1/a.mp4");
  const b = redactStorageKey("moments/user1/b.mp4");

  assert.notEqual(a, b);
});
