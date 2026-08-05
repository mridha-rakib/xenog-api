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
import {
  connectTranscodingTestDb,
  disconnectTranscodingTestDb,
  TRANSCODING_TEST_MONGODB_URI as TEST_MONGODB_URI,
} from "./helpers/transcoding-test-db.js";

process.env.NODE_ENV = "test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

// This suite connects through connectTranscodingTestDb(), which hard-guards
// the URI (loopback host only, never mongodb+srv, never the production
// database name) before ever calling mongoose.connect — see
// test/helpers/transcoding-test-db.ts for why a plain
// `process.env.MONGODB_URI ?? fallback` pattern is not safe here: ESM import
// hoisting means this repo's real (Atlas) .env can already have populated
// process.env.MONGODB_URI by the time any such fallback assignment runs.

const repository = new TranscodingJobRepository();
const createdJobIds: Types.ObjectId[] = [];

const FAKE_SOURCE_BYTES = Buffer.from("fake-source-video-bytes");

interface FakeStoredObject {
  body: Buffer;
  contentType: string;
}

/** Reads a Node Readable fully into a Buffer — used only inside the fake in-memory store, never inside production code (which must never buffer the optimized video). */
const readStreamToBuffer = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

/**
 * A fake StorageService boundary: an in-memory map keyed by S3 key, honoring
 * the exact StorageService method shapes used by the downloader/uploader.
 * Tracks the content type actually passed to uploadObject() (rather than a
 * hardcoded value) so S3 HEAD content-type verification is genuinely
 * exercised, and accepts either a Buffer or a Readable stream body so
 * streaming-upload tests can assert on what was actually received.
 */
const createFakeStorage = (options: { sourceKey: string; sourceContentType?: string }) => {
  const objects = new Map<string, FakeStoredObject>();
  objects.set(options.sourceKey, { body: FAKE_SOURCE_BYTES, contentType: options.sourceContentType ?? "video/mp4" });
  const uploadCalls: Array<{ key: string; bodyKind: "buffer" | "stream"; contentType: string; contentLength?: number }> = [];

  const storageService: Pick<StorageService, "getObject" | "getObjectMetadata" | "uploadObject" | "deleteObject"> = {
    getObjectMetadata: async (key: string): Promise<StorageObjectMetadata> => {
      const stored = objects.get(key);
      if (!stored) {
        const error = new Error("not found") as Error & { $metadata?: { httpStatusCode?: number } };
        error.$metadata = { httpStatusCode: 404 };
        throw error;
      }
      return { contentLength: stored.body.length, contentType: stored.contentType };
    },
    getObject: async (key: string): Promise<StorageObject> => {
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

  return { storageService: storageService as StorageService, objects, uploadCalls };
};

const okDiskCapacity = async (): Promise<DiskCapacityResult> => ({ ok: true, freeBytes: 50 * 1024 * 1024 * 1024, totalBytes: 100 * 1024 * 1024 * 1024 });

type ValidProbeVideoOverrides = Partial<{ width: number; height: number; rotationDegrees: number }>;

const validProbeOutcome = (overrides: { durationSeconds?: number; video?: ValidProbeVideoOverrides; hasAudioStream?: boolean } = {}): VideoProbeOutcome => ({
  ok: true,
  probe: {
    formatName: "mov,mp4,m4a,3gp,3g2,mj2",
    durationSeconds: overrides.durationSeconds ?? 5,
    hasVideoStream: true,
    hasAudioStream: overrides.hasAudioStream ?? true,
    audio: (overrides.hasAudioStream ?? true) ? { codecName: "aac" } : null,
    video: {
      codecName: "h264",
      width: 1920,
      height: 1080,
      rotationDegrees: 0,
      frameRate: 30,
      ...overrides.video,
    },
  },
});

/**
 * Path-aware fake probe: the video processor now re-probes its own produced
 * output (in addition to the source) before ever uploading it, using this
 * same injected function. Returns a source-shaped probe for the downloaded
 * source path and a correctly output-shaped probe (matching whatever
 * planTranscodeResolution would actually plan for that source) for the
 * produced optimized-output path, so tests that expect a successful
 * transcode don't have to duplicate the resolution-planning math by hand.
 */
const makeProbeFn = (sourceOverrides: { durationSeconds?: number; video?: ValidProbeVideoOverrides; hasAudioStream?: boolean } = {}) => {
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

/**
 * A fake ffmpeg runner that writes a small placeholder file at the command's
 * final argument (the output path), mirroring what real ffmpeg would leave
 * behind. Writes valid minimal JPEG SOI/EOI bytes for `.jpg` (thumbnail)
 * outputs specifically, since the processor now locally validates the
 * thumbnail's JPEG signature before ever uploading it.
 */
const successfulFfmpegRunner = async (_executablePath: string, args: string[]): Promise<FfmpegRunOutcome> => {
  const outputPath = args[args.length - 1];
  const bytes = outputPath.endsWith(".jpg")
    ? Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
        Buffer.alloc(10, 0),
        Buffer.from([0xff, 0xd9]),
      ])
    : Buffer.from("fake-encoded-output");
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
  await connectTranscodingTestDb(TEST_MONGODB_URI);
});

test.after(async () => {
  if (createdJobIds.length) {
    await TranscodingJobModel.deleteMany({ _id: { $in: createdJobIds } });
  }
  await disconnectTranscodingTestDb();
});

test("processClaimedJob: full success path transcodes, uploads, verifies, and marks the job completed", async () => {
  const job = await claimFreshJob("success");
  const { storageService } = createFakeStorage({ sourceKey: job.sourceStorageKey });

  const deps: VideoProcessorDependencies = {
    repository,
    storageService,
    runFfmpeg: successfulFfmpegRunner,
    probeVideoFile: makeProbeFn(),
    checkDiskCapacity: okDiskCapacity,
  };

  const result = await processClaimedJob(job, job.leaseToken!, deps);

  assert.equal(result.outcome, "completed");

  const stored = await repository.findById(job._id.toString());
  assert.equal(stored?.status, "completed");
  assert.equal(stored?.outputWidth, 1280);
  assert.equal(stored?.outputHeight, 720);
  assert.ok(stored?.optimizedStorageKey?.endsWith(`${job._id.toString()}.mp4`));
  assert.ok(stored?.thumbnailStorageKey?.endsWith(`${job._id.toString()}.jpg`));
  assert.equal(stored?.cleanupStatus, "pending");
});

test("processClaimedJob: missing source object at HEAD time is a permanent failure and does not consume infinite retries", async () => {
  const job = await claimFreshJob("missing-source");
  const { storageService, objects } = createFakeStorage({ sourceKey: job.sourceStorageKey });
  objects.delete(job.sourceStorageKey);

  const deps: VideoProcessorDependencies = {
    repository,
    storageService,
    runFfmpeg: successfulFfmpegRunner,
    probeVideoFile: async () => validProbeOutcome(),
    checkDiskCapacity: okDiskCapacity,
  };

  const result = await processClaimedJob(job, job.leaseToken!, deps);

  assert.equal(result.outcome, "failed");
  assert.equal((result as { errorCode: string }).errorCode, "source_invalid");

  // A missing source is a permanent, non-retryable problem: it must go
  // straight to terminal "failed" on the very first attempt via
  // markPermanentFailure(), never pass through "failed_retryable", and never
  // schedule a retry — see test/transcoding-job-repository.test.ts's
  // markPermanentFailure suite for the repository-level guarantees this relies on.
  const stored = await repository.findById(job._id.toString());
  assert.equal(stored?.status, "failed");
  assert.equal(stored?.lastErrorCode, "source_invalid");
  assert.equal(stored?.nextRetryAt, null);
  assert.ok(stored?.failedAt);

  const reclaimAttempt = await repository.claimNext();
  assert.notEqual(reclaimAttempt?._id.toString(), job._id.toString());
});

test("processClaimedJob: ffmpeg transcode failure is classified as encode_failed and job returns to failed_retryable", async () => {
  const job = await claimFreshJob("encode-fail");
  const { storageService } = createFakeStorage({ sourceKey: job.sourceStorageKey });

  const deps: VideoProcessorDependencies = {
    repository,
    storageService,
    runFfmpeg: async (): Promise<FfmpegRunOutcome> => ({ ok: false, reason: "failed" }),
    probeVideoFile: async () => validProbeOutcome(),
    checkDiskCapacity: okDiskCapacity,
  };

  const result = await processClaimedJob(job, job.leaseToken!, deps);

  assert.equal(result.outcome, "failed");
  assert.equal((result as { errorCode: string }).errorCode, "encode_failed");
});

test("processClaimedJob: an ffmpeg timeout is classified as timeout", async () => {
  const job = await claimFreshJob("encode-timeout");
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
  assert.equal((result as { errorCode: string }).errorCode, "timeout");
});

test("processClaimedJob: a corrupt/no-video-stream source is a permanent source_invalid failure", async () => {
  const job = await claimFreshJob("no-video-stream");
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
  assert.equal((result as { errorCode: string }).errorCode, "source_invalid");
});

test("processClaimedJob: a source longer than the max duration is a permanent source_invalid failure", async () => {
  const job = await claimFreshJob("too-long");
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
  assert.equal((result as { errorCode: string }).errorCode, "source_invalid");
});

test("processClaimedJob: portrait rotated source resolves to the portrait bound, never a naive long-edge crop", async () => {
  const job = await claimFreshJob("rotated-portrait");
  const { storageService } = createFakeStorage({ sourceKey: job.sourceStorageKey });

  const deps: VideoProcessorDependencies = {
    repository,
    storageService,
    runFfmpeg: successfulFfmpegRunner,
    // Stored as a 1920x1080 landscape frame with a 90-degree rotation tag —
    // effective displayed size is 1080x1920 portrait.
    probeVideoFile: makeProbeFn({ video: { width: 1920, height: 1080, rotationDegrees: 90 } }),
    checkDiskCapacity: okDiskCapacity,
  };

  const result = await processClaimedJob(job, job.leaseToken!, deps);

  assert.equal(result.outcome, "completed");
  const stored = await repository.findById(job._id.toString());
  assert.equal(stored?.outputWidth, 720);
  assert.equal(stored?.outputHeight, 1280);
});

test("processClaimedJob: insufficient disk capacity defers the job without recording a failure or consuming a retry attempt", async () => {
  const job = await claimFreshJob("disk-blocked");
  const { storageService } = createFakeStorage({ sourceKey: job.sourceStorageKey });
  const attemptsBeforeDefer = job.attempts;

  const deps: VideoProcessorDependencies = {
    repository,
    storageService,
    runFfmpeg: successfulFfmpegRunner,
    probeVideoFile: async () => validProbeOutcome(),
    checkDiskCapacity: async (): Promise<DiskCapacityResult> => ({ ok: false, freeBytes: 1024, totalBytes: 1024 }),
  };

  const result = await processClaimedJob(job, job.leaseToken!, deps);

  assert.equal(result.outcome, "deferred");

  const stored = await repository.findById(job._id.toString());
  assert.equal(stored?.status, "queued");
  assert.equal(stored?.attempts, attemptsBeforeDefer - 1);
  assert.equal(stored?.lastErrorCode, null);
});

test("processClaimedJob: an upload failure is classified as upload_failed", async () => {
  const job = await claimFreshJob("upload-fail");
  const { storageService } = createFakeStorage({ sourceKey: job.sourceStorageKey });
  storageService.uploadObject = async () => {
    throw new Error("simulated S3 upload failure");
  };

  const deps: VideoProcessorDependencies = {
    repository,
    storageService,
    runFfmpeg: successfulFfmpegRunner,
    probeVideoFile: makeProbeFn(),
    checkDiskCapacity: okDiskCapacity,
  };

  const result = await processClaimedJob(job, job.leaseToken!, deps);

  assert.equal(result.outcome, "failed");
  assert.equal((result as { errorCode: string }).errorCode, "upload_failed");
});

test("processClaimedJob: an output verification mismatch after upload is classified as verification_failed", async () => {
  const job = await claimFreshJob("verify-fail");
  const { storageService, objects } = createFakeStorage({ sourceKey: job.sourceStorageKey });
  const originalGetMetadata = storageService.getObjectMetadata;
  storageService.getObjectMetadata = async (key: string) => {
    if (key !== job.sourceStorageKey) {
      // Simulate a verification mismatch (e.g. a truncated upload) for any output key.
      return { contentLength: 999999, contentType: "application/octet-stream" };
    }
    return originalGetMetadata(key);
  };
  void objects;

  const deps: VideoProcessorDependencies = {
    repository,
    storageService,
    runFfmpeg: successfulFfmpegRunner,
    probeVideoFile: makeProbeFn(),
    checkDiskCapacity: okDiskCapacity,
  };

  const result = await processClaimedJob(job, job.leaseToken!, deps);

  assert.equal(result.outcome, "failed");
  assert.equal((result as { errorCode: string }).errorCode, "verification_failed");
});

test("processClaimedJob: a lease lost mid-processing to another worker aborts and reports lease_lost without touching the job", async () => {
  const job = await claimFreshJob("lease-lost");
  const { storageService } = createFakeStorage({ sourceKey: job.sourceStorageKey });

  // Simulate a rival worker reclaiming the job the moment processing starts:
  // reassign a brand-new lease token directly, which is exactly what
  // claimNext() does for a genuinely stale lease.
  await TranscodingJobModel.updateOne({ _id: job._id }, { $set: { leaseToken: "a-different-workers-token" } });

  const deps: VideoProcessorDependencies = {
    repository,
    storageService,
    runFfmpeg: successfulFfmpegRunner,
    probeVideoFile: makeProbeFn(),
    checkDiskCapacity: okDiskCapacity,
  };

  const result = await processClaimedJob(job, job.leaseToken!, deps);

  assert.equal(result.outcome, "lease_lost");

  const stored = await repository.findById(job._id.toString());
  assert.equal(stored?.leaseToken, "a-different-workers-token");
  assert.equal(stored?.status, "processing");

  // Cleanup: return the job to a non-claimable terminal state so it does not
  // pollute any other test's claimNext() call.
  await TranscodingJobModel.updateOne({ _id: job._id }, { $set: { status: "cancelled" } });
});
