import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import test from "node:test";
import { Types } from "mongoose";
import type { DiskCapacityResult } from "../src/modules/transcoding/disk-guard.js";
import type { FfmpegRunOutcome } from "../src/modules/transcoding/ffmpeg-runner.js";
import { resolveEffectiveDimensions, planTranscodeResolution } from "../src/modules/transcoding/resolution-plan.js";
import { TranscodingJobModel } from "../src/modules/transcoding/transcoding-job.model.js";
import { TranscodingJobRepository } from "../src/modules/transcoding/transcoding-job.repository.js";
import type { VideoProcessorDependencies } from "../src/modules/transcoding/video-processor.js";
import { processClaimedJob } from "../src/modules/transcoding/video-processor.js";
import type { VideoProbeOutcome } from "../src/modules/transcoding/video-probe.js";
import type { StorageObject, StorageObjectMetadata, StorageService } from "../src/modules/storage/storage.service.js";
import { connectTranscodingTestDb, disconnectTranscodingTestDb, TRANSCODING_TEST_MONGODB_URI } from "./helpers/transcoding-test-db.js";

// Phase 2 completion hardening: this file covers only what the original
// test/transcoding-video-processor.test.ts suite did not — permanent vs
// retryable failure routing at the processor level, the genuine 200MB
// rejection boundary, the streaming-upload contract, and local/S3 output
// validation. It intentionally stays self-contained (its own small fakes)
// rather than reaching into the other file's locals.

process.env.NODE_ENV = "test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const repository = new TranscodingJobRepository();
const createdJobIds: Types.ObjectId[] = [];

const FAKE_SOURCE_BYTES = Buffer.from("fake-source-video-bytes");
const PRODUCTION_MAX_SOURCE_BYTES = 209_715_200; // documented production default: 200 * 1024 * 1024

interface FakeStoredObject {
  body: Buffer;
  contentType: string;
}

const readStreamToBuffer = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

const createFakeStorage = (options: { sourceKey: string; sourceContentLength?: number }) => {
  const objects = new Map<string, FakeStoredObject>();
  objects.set(options.sourceKey, { body: FAKE_SOURCE_BYTES, contentType: "video/mp4" });
  const uploadCalls: Array<{ key: string; bodyKind: "buffer" | "stream"; contentType: string; contentLength?: number }> = [];
  const calls = { getObject: 0, getObjectMetadata: 0 };

  const storageService: Pick<StorageService, "getObject" | "getObjectMetadata" | "uploadObject" | "deleteObject"> = {
    getObjectMetadata: async (key: string): Promise<StorageObjectMetadata> => {
      calls.getObjectMetadata += 1;

      if (key === options.sourceKey && options.sourceContentLength !== undefined) {
        return { contentLength: options.sourceContentLength, contentType: "video/mp4" };
      }

      const stored = objects.get(key);
      if (!stored) {
        const error = new Error("not found") as Error & { $metadata?: { httpStatusCode?: number } };
        error.$metadata = { httpStatusCode: 404 };
        throw error;
      }
      return { contentLength: stored.body.length, contentType: stored.contentType };
    },
    getObject: async (key: string): Promise<StorageObject> => {
      calls.getObject += 1;
      const stored = objects.get(key);
      if (!stored) {
        const error = new Error("not found") as Error & { $metadata?: { httpStatusCode?: number } };
        error.$metadata = { httpStatusCode: 404 };
        throw error;
      }
      return { body: Readable.from([stored.body]), contentLength: stored.body.length, contentType: stored.contentType };
    },
    uploadObject: async (payload: { body: Buffer | Readable; contentType: string; key: string; contentLength?: number }) => {
      const isStream = !Buffer.isBuffer(payload.body);
      uploadCalls.push({ key: payload.key, bodyKind: isStream ? "stream" : "buffer", contentType: payload.contentType, contentLength: payload.contentLength });
      const body = Buffer.isBuffer(payload.body) ? payload.body : await readStreamToBuffer(payload.body);
      objects.set(payload.key, { body, contentType: payload.contentType });
      return { key: payload.key };
    },
    deleteObject: async (key: string) => {
      objects.delete(key);
    },
  };

  return { storageService: storageService as StorageService, objects, uploadCalls, calls };
};

const okDiskCapacity = async (): Promise<DiskCapacityResult> => ({ ok: true, freeBytes: 50 * 1024 * 1024 * 1024, totalBytes: 100 * 1024 * 1024 * 1024 });

type ValidProbeVideoOverrides = Partial<{ width: number; height: number; rotationDegrees: number; codecName: string }>;

const validProbeOutcome = (
  overrides: { durationSeconds?: number; video?: ValidProbeVideoOverrides; hasAudioStream?: boolean; audioCodecName?: string } = {},
): VideoProbeOutcome => ({
  ok: true,
  probe: {
    formatName: "mov,mp4,m4a,3gp,3g2,mj2",
    durationSeconds: overrides.durationSeconds ?? 5,
    hasVideoStream: true,
    hasAudioStream: overrides.hasAudioStream ?? true,
    audio: (overrides.hasAudioStream ?? true) ? { codecName: overrides.audioCodecName ?? "aac" } : null,
    video: {
      codecName: overrides.video?.codecName ?? "h264",
      width: 1920,
      height: 1080,
      rotationDegrees: 0,
      frameRate: 30,
      ...overrides.video,
    },
  },
});

/** Path-aware valid probe fn, matching the pattern in the main processor test suite: source path gets the source-shaped probe, the produced output path gets a correctly output-shaped probe. */
const makeValidProbeFn = (sourceOverrides: { durationSeconds?: number; video?: ValidProbeVideoOverrides; hasAudioStream?: boolean } = {}) => {
  const source = validProbeOutcome(sourceOverrides);
  const sourceVideo = source.probe.video!;
  const effective = resolveEffectiveDimensions(sourceVideo.width!, sourceVideo.height!, sourceVideo.rotationDegrees);
  const resolution = planTranscodeResolution(effective.width, effective.height);
  const output = validProbeOutcome({
    durationSeconds: source.probe.durationSeconds ?? undefined,
    hasAudioStream: source.probe.hasAudioStream,
    video: { width: resolution.width, height: resolution.height, rotationDegrees: 0 },
  });

  return async (filePath: string): Promise<VideoProbeOutcome> => (filePath.endsWith("source") ? source : output);
};

/** Same as makeValidProbeFn, but the OUTPUT probe is overridden/broken while the source probe stays valid — for exercising local output-validation rejection. */
const makeBrokenOutputProbeFn = (brokenOutput: VideoProbeOutcome, sourceOverrides: { durationSeconds?: number } = {}) => {
  const source = validProbeOutcome(sourceOverrides);
  return async (filePath: string): Promise<VideoProbeOutcome> => (filePath.endsWith("source") ? source : brokenOutput);
};

const VALID_JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
  Buffer.alloc(10, 0),
  Buffer.from([0xff, 0xd9]),
]);

const successfulFfmpegRunner = async (_executablePath: string, args: string[]): Promise<FfmpegRunOutcome> => {
  const outputPath = args[args.length - 1];
  const bytes = outputPath.endsWith(".jpg") ? VALID_JPEG_BYTES : Buffer.from("fake-encoded-output");
  await writeFile(outputPath, bytes);
  return { ok: true };
};

const identity = (label: string) => ({
  momentId: new Types.ObjectId(),
  userId: new Types.ObjectId(),
  sourceStorageKey: `moments/test-user/video/${label}-${new Types.ObjectId().toString()}.mp4`,
});

const claimFreshJob = async (label: string) => {
  const base = identity(label);
  const job = await repository.createOrGet({
    momentId: base.momentId.toString(),
    userId: base.userId.toString(),
    sourceStorageKey: base.sourceStorageKey,
  });
  createdJobIds.push(job._id);

  const claimed = await repository.claimNext();
  if (!claimed || claimed._id.toString() !== job._id.toString()) {
    throw new Error("test setup failed: claimNext did not claim the job this test just created");
  }

  return claimed;
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
// Genuine 200MB processor-level rejection
// ---------------------------------------------------------------------------

test("processClaimedJob: a source one byte over the configured maximum is rejected at HEAD time, before any download/probe/encode/upload", async () => {
  const job = await claimFreshJob("oversize-200mb");
  const { storageService, calls, uploadCalls } = createFakeStorage({
    sourceKey: job.sourceStorageKey,
    sourceContentLength: PRODUCTION_MAX_SOURCE_BYTES + 1,
  });

  let ffmpegInvoked = false;
  let ffprobeInvoked = false;

  const deps: VideoProcessorDependencies = {
    repository,
    storageService,
    maxSourceBytes: PRODUCTION_MAX_SOURCE_BYTES,
    runFfmpeg: async (): Promise<FfmpegRunOutcome> => {
      ffmpegInvoked = true;
      return { ok: true };
    },
    probeVideoFile: async (): Promise<VideoProbeOutcome> => {
      ffprobeInvoked = true;
      return validProbeOutcome();
    },
    checkDiskCapacity: okDiskCapacity,
  };

  const result = await processClaimedJob(job, job.leaseToken!, deps);

  assert.equal(result.outcome, "failed");
  assert.equal((result as { errorCode: string }).errorCode, "source_too_large");

  // Download never starts: getObject is the only way bytes would move, and it was never called.
  assert.equal(calls.getObject, 0);
  assert.equal(ffprobeInvoked, false);
  assert.equal(ffmpegInvoked, false);
  assert.equal(uploadCalls.length, 0);

  const stored = await repository.findById(job._id.toString());
  assert.equal(stored?.status, "failed");
  assert.equal(stored?.lastErrorCode, "source_too_large");
  assert.equal(stored?.nextRetryAt, null);

  const reclaimAttempt = await repository.claimNext();
  assert.notEqual(reclaimAttempt?._id.toString(), job._id.toString());
});

test("processClaimedJob: a source exactly at the configured maximum is accepted at HEAD time (boundary is exclusive above, not below)", async () => {
  const job = await claimFreshJob("exact-boundary");
  const { storageService } = createFakeStorage({
    sourceKey: job.sourceStorageKey,
    sourceContentLength: PRODUCTION_MAX_SOURCE_BYTES,
  });

  const deps: VideoProcessorDependencies = {
    repository,
    storageService,
    maxSourceBytes: PRODUCTION_MAX_SOURCE_BYTES,
    runFfmpeg: successfulFfmpegRunner,
    probeVideoFile: makeValidProbeFn(),
    checkDiskCapacity: okDiskCapacity,
  };

  const result = await processClaimedJob(job, job.leaseToken!, deps);

  // A HEAD content-length exactly at the limit must not be rejected as too_large.
  assert.equal(result.outcome, "completed");
});

// ---------------------------------------------------------------------------
// Permanent vs retryable failure routing at the processor level
// ---------------------------------------------------------------------------

test("processClaimedJob: an over-duration source is terminal failed on attempt 1, not failed_retryable", async () => {
  const job = await claimFreshJob("permanent-over-duration");
  const { storageService } = createFakeStorage({ sourceKey: job.sourceStorageKey });

  const deps: VideoProcessorDependencies = {
    repository,
    storageService,
    runFfmpeg: successfulFfmpegRunner,
    probeVideoFile: async () => validProbeOutcome({ durationSeconds: 9999 }),
    checkDiskCapacity: okDiskCapacity,
  };

  const result = await processClaimedJob(job, job.leaseToken!, deps);

  assert.equal(result.outcome, "failed");
  const stored = await repository.findById(job._id.toString());
  assert.equal(stored?.status, "failed");
  assert.equal(stored?.nextRetryAt, null);
  assert.equal(stored?.attempts, 1);

  const reclaimAttempt = await repository.claimNext();
  assert.notEqual(reclaimAttempt?._id.toString(), job._id.toString());
});

test("processClaimedJob: a no-video-stream source is terminal failed on attempt 1", async () => {
  const job = await claimFreshJob("permanent-no-video-stream");
  const { storageService } = createFakeStorage({ sourceKey: job.sourceStorageKey });

  const deps: VideoProcessorDependencies = {
    repository,
    storageService,
    runFfmpeg: successfulFfmpegRunner,
    probeVideoFile: async () => ({
      ok: true,
      probe: { formatName: null, durationSeconds: null, hasVideoStream: false, hasAudioStream: false, video: null, audio: null },
    }),
    checkDiskCapacity: okDiskCapacity,
  };

  const result = await processClaimedJob(job, job.leaseToken!, deps);

  assert.equal(result.outcome, "failed");
  const stored = await repository.findById(job._id.toString());
  assert.equal(stored?.status, "failed");
  assert.equal(stored?.nextRetryAt, null);
});

test("processClaimedJob: invalid (zero) dimensions are terminal failed on attempt 1", async () => {
  const job = await claimFreshJob("permanent-invalid-dimensions");
  const { storageService } = createFakeStorage({ sourceKey: job.sourceStorageKey });

  const deps: VideoProcessorDependencies = {
    repository,
    storageService,
    runFfmpeg: successfulFfmpegRunner,
    probeVideoFile: async () => validProbeOutcome({ video: { width: 0, height: 0 } }),
    checkDiskCapacity: okDiskCapacity,
  };

  const result = await processClaimedJob(job, job.leaseToken!, deps);

  assert.equal(result.outcome, "failed");
  const stored = await repository.findById(job._id.toString());
  assert.equal(stored?.status, "failed");
  assert.equal(stored?.nextRetryAt, null);
});

test("processClaimedJob: an ffmpeg timeout (operational, retryable) remains failed_retryable, not terminal", async () => {
  const job = await claimFreshJob("retryable-timeout");
  const { storageService } = createFakeStorage({ sourceKey: job.sourceStorageKey });

  const deps: VideoProcessorDependencies = {
    repository,
    storageService,
    runFfmpeg: async (): Promise<FfmpegRunOutcome> => ({ ok: false, reason: "timeout" }),
    probeVideoFile: async () => validProbeOutcome(),
    checkDiskCapacity: okDiskCapacity,
  };

  const result = await processClaimedJob(job, job.leaseToken!, deps);

  assert.equal(result.outcome, "failed");
  const stored = await repository.findById(job._id.toString());
  assert.equal(stored?.status, "failed_retryable");
  assert.ok(stored?.nextRetryAt);
});

test("processClaimedJob: an upload failure (operational, retryable) remains failed_retryable, not terminal", async () => {
  const job = await claimFreshJob("retryable-upload");
  const { storageService } = createFakeStorage({ sourceKey: job.sourceStorageKey });
  storageService.uploadObject = async () => {
    throw new Error("simulated S3 upload failure");
  };

  const deps: VideoProcessorDependencies = {
    repository,
    storageService,
    runFfmpeg: successfulFfmpegRunner,
    probeVideoFile: makeValidProbeFn(),
    checkDiskCapacity: okDiskCapacity,
  };

  const result = await processClaimedJob(job, job.leaseToken!, deps);

  assert.equal(result.outcome, "failed");
  const stored = await repository.findById(job._id.toString());
  assert.equal(stored?.status, "failed_retryable");
  assert.ok(stored?.nextRetryAt);
  assert.ok(stored!.nextRetryAt!.getTime() > Date.now());

  // Make the scheduled retry immediately due (mirroring the pattern used in
  // test/transcoding-job-repository.test.ts) to prove it is genuinely
  // reclaimable once due, not merely left in a retryable-looking status.
  await TranscodingJobModel.updateOne({ _id: stored!._id }, { $set: { nextRetryAt: new Date(Date.now() - 1000) } });
  const reclaimAttempt = await repository.claimNext();
  assert.equal(reclaimAttempt?._id.toString(), job._id.toString());
  await repository.cancel(reclaimAttempt!._id.toString());
});

// ---------------------------------------------------------------------------
// Streaming upload
// ---------------------------------------------------------------------------

test("processClaimedJob: the optimized video is uploaded as a stream (not a Buffer), with a known content length; the thumbnail stays a buffer", async () => {
  const job = await claimFreshJob("streaming-upload");
  const { storageService, uploadCalls } = createFakeStorage({ sourceKey: job.sourceStorageKey });

  const deps: VideoProcessorDependencies = {
    repository,
    storageService,
    runFfmpeg: successfulFfmpegRunner,
    probeVideoFile: makeValidProbeFn(),
    checkDiskCapacity: okDiskCapacity,
  };

  const result = await processClaimedJob(job, job.leaseToken!, deps);
  assert.equal(result.outcome, "completed");

  const optimizedUploadCall = uploadCalls.find((call) => call.contentType === "video/mp4");
  const thumbnailUploadCall = uploadCalls.find((call) => call.contentType === "image/jpeg");

  assert.ok(optimizedUploadCall, "expected an optimized video upload call");
  assert.equal(optimizedUploadCall?.bodyKind, "stream");
  assert.equal(optimizedUploadCall?.contentLength, Buffer.from("fake-encoded-output").length);

  assert.ok(thumbnailUploadCall, "expected a thumbnail upload call");
  assert.equal(thumbnailUploadCall?.bodyKind, "buffer");
});

test("processClaimedJob: an upload failure on the optimized stream never reaches the thumbnail upload step", async () => {
  const job = await claimFreshJob("streaming-upload-failure-cleanup");
  const { storageService, uploadCalls } = createFakeStorage({ sourceKey: job.sourceStorageKey });
  storageService.uploadObject = async () => {
    throw new Error("simulated stream upload failure");
  };

  const deps: VideoProcessorDependencies = {
    repository,
    storageService,
    runFfmpeg: successfulFfmpegRunner,
    probeVideoFile: makeValidProbeFn(),
    checkDiskCapacity: okDiskCapacity,
  };

  const result = await processClaimedJob(job, job.leaseToken!, deps);

  assert.equal(result.outcome, "failed");
  assert.equal((result as { errorCode: string }).errorCode, "upload_failed");
  // The optimized upload attempt happened (and failed) before the thumbnail step was ever reached.
  assert.equal(uploadCalls.length, 0);
});

test("processClaimedJob: a thumbnail upload failure after a successful optimized upload cleans up the already-uploaded optimized object", async () => {
  const job = await claimFreshJob("thumbnail-upload-failure-cleanup");
  const { storageService, objects } = createFakeStorage({ sourceKey: job.sourceStorageKey });
  const realUpload = storageService.uploadObject.bind(storageService);
  storageService.uploadObject = async (payload) => {
    if (payload.contentType === "image/jpeg") {
      throw new Error("simulated thumbnail upload failure");
    }
    return realUpload(payload);
  };

  const deps: VideoProcessorDependencies = {
    repository,
    storageService,
    runFfmpeg: successfulFfmpegRunner,
    probeVideoFile: makeValidProbeFn(),
    checkDiskCapacity: okDiskCapacity,
  };

  const result = await processClaimedJob(job, job.leaseToken!, deps);

  assert.equal(result.outcome, "failed");
  assert.equal((result as { errorCode: string }).errorCode, "upload_failed");

  // The optimized object that was uploaded before the thumbnail failed must have been best-effort cleaned up.
  const remainingKeys = [...objects.keys()].filter((key) => key !== job.sourceStorageKey);
  assert.deepEqual(remainingKeys, []);
});

// ---------------------------------------------------------------------------
// Local optimized-output validation (before any upload)
// ---------------------------------------------------------------------------

test("processClaimedJob: wrong output video codec fails local validation before any upload", async () => {
  const job = await claimFreshJob("local-verify-wrong-codec");
  const { storageService, uploadCalls } = createFakeStorage({ sourceKey: job.sourceStorageKey });

  const deps: VideoProcessorDependencies = {
    repository,
    storageService,
    runFfmpeg: successfulFfmpegRunner,
    probeVideoFile: makeBrokenOutputProbeFn(validProbeOutcome({ video: { width: 1280, height: 720, codecName: "hevc" } })),
    checkDiskCapacity: okDiskCapacity,
  };

  const result = await processClaimedJob(job, job.leaseToken!, deps);

  assert.equal(result.outcome, "failed");
  assert.equal((result as { errorCode: string }).errorCode, "verification_failed");
  assert.equal(uploadCalls.length, 0);

  const stored = await repository.findById(job._id.toString());
  assert.equal(stored?.status, "failed_retryable");
});

test("processClaimedJob: output dimensions that don't match the plan fail local validation before any upload", async () => {
  const job = await claimFreshJob("local-verify-wrong-dimensions");
  const { storageService, uploadCalls } = createFakeStorage({ sourceKey: job.sourceStorageKey });

  const deps: VideoProcessorDependencies = {
    repository,
    storageService,
    runFfmpeg: successfulFfmpegRunner,
    probeVideoFile: makeBrokenOutputProbeFn(validProbeOutcome({ video: { width: 640, height: 360 } })),
    checkDiskCapacity: okDiskCapacity,
  };

  const result = await processClaimedJob(job, job.leaseToken!, deps);

  assert.equal(result.outcome, "failed");
  assert.equal((result as { errorCode: string }).errorCode, "verification_failed");
  assert.equal(uploadCalls.length, 0);
});

test("processClaimedJob: missing AAC audio in the output when the source had audio fails local validation", async () => {
  const job = await claimFreshJob("local-verify-missing-audio");
  const { storageService, uploadCalls } = createFakeStorage({ sourceKey: job.sourceStorageKey });

  const deps: VideoProcessorDependencies = {
    repository,
    storageService,
    runFfmpeg: successfulFfmpegRunner,
    probeVideoFile: makeBrokenOutputProbeFn(
      validProbeOutcome({ video: { width: 1280, height: 720 }, hasAudioStream: false }),
    ),
    checkDiskCapacity: okDiskCapacity,
  };

  const result = await processClaimedJob(job, job.leaseToken!, deps);

  assert.equal(result.outcome, "failed");
  assert.equal((result as { errorCode: string }).errorCode, "verification_failed");
  assert.equal(uploadCalls.length, 0);
});

test("processClaimedJob: unexpected audio in the output when the source had none fails local validation", async () => {
  const job = await claimFreshJob("local-verify-unexpected-audio");
  const { storageService, uploadCalls } = createFakeStorage({ sourceKey: job.sourceStorageKey });

  // The source genuinely has no audio while the produced output unexpectedly does.
  const probeFn = async (filePath: string): Promise<VideoProbeOutcome> => (
    filePath.endsWith("source")
      ? validProbeOutcome({ hasAudioStream: false })
      : validProbeOutcome({ video: { width: 1280, height: 720 }, hasAudioStream: true })
  );

  const deps: VideoProcessorDependencies = {
    repository,
    storageService,
    runFfmpeg: successfulFfmpegRunner,
    probeVideoFile: probeFn,
    checkDiskCapacity: okDiskCapacity,
  };

  const result = await processClaimedJob(job, job.leaseToken!, deps);

  assert.equal(result.outcome, "failed");
  assert.equal((result as { errorCode: string }).errorCode, "verification_failed");
  assert.equal(uploadCalls.length, 0);
});

test("processClaimedJob: a correct audio-less output is accepted when the source genuinely had no audio", async () => {
  const job = await claimFreshJob("local-verify-audioless-ok");
  const { storageService } = createFakeStorage({ sourceKey: job.sourceStorageKey });

  const deps: VideoProcessorDependencies = {
    repository,
    storageService,
    runFfmpeg: successfulFfmpegRunner,
    probeVideoFile: makeValidProbeFn({ hasAudioStream: false }),
    checkDiskCapacity: okDiskCapacity,
  };

  const result = await processClaimedJob(job, job.leaseToken!, deps);

  assert.equal(result.outcome, "completed");
});

test("processClaimedJob: a zero-byte optimized output fails local validation before any upload", async () => {
  const job = await claimFreshJob("local-verify-zero-byte");
  const { storageService, uploadCalls } = createFakeStorage({ sourceKey: job.sourceStorageKey });

  const zeroByteFfmpegRunner = async (_executablePath: string, args: string[]): Promise<FfmpegRunOutcome> => {
    const outputPath = args[args.length - 1];
    const bytes = outputPath.endsWith(".jpg") ? VALID_JPEG_BYTES : Buffer.alloc(0);
    await writeFile(outputPath, bytes);
    return { ok: true };
  };

  const deps: VideoProcessorDependencies = {
    repository,
    storageService,
    runFfmpeg: zeroByteFfmpegRunner,
    probeVideoFile: makeValidProbeFn(),
    checkDiskCapacity: okDiskCapacity,
  };

  const result = await processClaimedJob(job, job.leaseToken!, deps);

  assert.equal(result.outcome, "failed");
  assert.equal((result as { errorCode: string }).errorCode, "verification_failed");
  assert.equal(uploadCalls.length, 0);
});

test("processClaimedJob: a corrupt (non-JPEG) thumbnail fails local validation before any upload", async () => {
  const job = await claimFreshJob("local-verify-corrupt-thumbnail");
  const { storageService, uploadCalls } = createFakeStorage({ sourceKey: job.sourceStorageKey });

  const corruptThumbnailFfmpegRunner = async (_executablePath: string, args: string[]): Promise<FfmpegRunOutcome> => {
    const outputPath = args[args.length - 1];
    const bytes = outputPath.endsWith(".jpg") ? Buffer.from("not actually a jpeg") : Buffer.from("fake-encoded-output");
    await writeFile(outputPath, bytes);
    return { ok: true };
  };

  const deps: VideoProcessorDependencies = {
    repository,
    storageService,
    runFfmpeg: corruptThumbnailFfmpegRunner,
    probeVideoFile: makeValidProbeFn(),
    checkDiskCapacity: okDiskCapacity,
  };

  const result = await processClaimedJob(job, job.leaseToken!, deps);

  assert.equal(result.outcome, "failed");
  assert.equal((result as { errorCode: string }).errorCode, "verification_failed");
  assert.equal(uploadCalls.length, 0);
});

test("processClaimedJob: a correct H.264/AAC output at the planned resolution passes local validation and completes", async () => {
  const job = await claimFreshJob("local-verify-correct-ok");
  const { storageService } = createFakeStorage({ sourceKey: job.sourceStorageKey });

  const deps: VideoProcessorDependencies = {
    repository,
    storageService,
    runFfmpeg: successfulFfmpegRunner,
    probeVideoFile: makeValidProbeFn(),
    checkDiskCapacity: okDiskCapacity,
  };

  const result = await processClaimedJob(job, job.leaseToken!, deps);

  assert.equal(result.outcome, "completed");
});

// ---------------------------------------------------------------------------
// S3 content-length / content-type verification
// ---------------------------------------------------------------------------

test("processClaimedJob: a wrong Content-Type reported back by S3 HEAD for the optimized video is caught as verification_failed", async () => {
  const job = await claimFreshJob("s3-verify-wrong-content-type");
  const { storageService } = createFakeStorage({ sourceKey: job.sourceStorageKey });
  const realGetMetadata = storageService.getObjectMetadata.bind(storageService);
  storageService.getObjectMetadata = async (key: string) => {
    const metadata = await realGetMetadata(key);
    if (key !== job.sourceStorageKey && metadata.contentType === "video/mp4") {
      return { ...metadata, contentType: "application/octet-stream" };
    }
    return metadata;
  };

  const deps: VideoProcessorDependencies = {
    repository,
    storageService,
    runFfmpeg: successfulFfmpegRunner,
    probeVideoFile: makeValidProbeFn(),
    checkDiskCapacity: okDiskCapacity,
  };

  const result = await processClaimedJob(job, job.leaseToken!, deps);

  assert.equal(result.outcome, "failed");
  assert.equal((result as { errorCode: string }).errorCode, "verification_failed");
});

test("processClaimedJob: a Content-Length mismatch on the uploaded thumbnail is caught as verification_failed", async () => {
  const job = await claimFreshJob("s3-verify-wrong-length");
  const { storageService } = createFakeStorage({ sourceKey: job.sourceStorageKey });
  const realGetMetadata = storageService.getObjectMetadata.bind(storageService);
  storageService.getObjectMetadata = async (key: string) => {
    const metadata = await realGetMetadata(key);
    if (key !== job.sourceStorageKey && metadata.contentType === "image/jpeg") {
      return { ...metadata, contentLength: (metadata.contentLength ?? 0) + 5 };
    }
    return metadata;
  };

  const deps: VideoProcessorDependencies = {
    repository,
    storageService,
    runFfmpeg: successfulFfmpegRunner,
    probeVideoFile: makeValidProbeFn(),
    checkDiskCapacity: okDiskCapacity,
  };

  const result = await processClaimedJob(job, job.leaseToken!, deps);

  assert.equal(result.outcome, "failed");
  assert.equal((result as { errorCode: string }).errorCode, "verification_failed");
});

test("processClaimedJob: correct S3 HEAD content-length and content-type for both objects allows completion", async () => {
  const job = await claimFreshJob("s3-verify-correct");
  const { storageService, objects } = createFakeStorage({ sourceKey: job.sourceStorageKey });

  const deps: VideoProcessorDependencies = {
    repository,
    storageService,
    runFfmpeg: successfulFfmpegRunner,
    probeVideoFile: makeValidProbeFn(),
    checkDiskCapacity: okDiskCapacity,
  };

  const result = await processClaimedJob(job, job.leaseToken!, deps);
  assert.equal(result.outcome, "completed");

  const stored = await repository.findById(job._id.toString());
  const optimized = objects.get(stored!.optimizedStorageKey!);
  const thumbnail = objects.get(stored!.thumbnailStorageKey!);

  assert.equal(optimized?.contentType, "video/mp4");
  assert.ok((optimized?.body.length ?? 0) > 0);
  assert.equal(thumbnail?.contentType, "image/jpeg");
  assert.ok((thumbnail?.body.length ?? 0) > 0);
});
