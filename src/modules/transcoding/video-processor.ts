import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { env } from "../../config/env.js";
import { logger } from "../../core/logger/logger.js";
import type { StorageService } from "../storage/storage.service.js";
import { checkDiskCapacity, estimateJobDiskBudgetBytes } from "./disk-guard.js";
import type { ProcessingFailureReason } from "./failure-classification.js";
import { classifyProcessingFailure } from "./failure-classification.js";
import { runFfmpegProcess } from "./ffmpeg-runner.js";
import { buildThumbnailArgs, buildTranscodeArgs, planThumbnailTimestampSeconds } from "./ffmpeg-args.js";
import { runWithPeriodicLeaseRenewal } from "./lease-renewal.js";
import { isValidJpegThumbnail, validateOptimizedOutput } from "./output-validation.js";
import { buildOptimizedVideoKey, buildThumbnailKey } from "./output-keys.js";
import { resolveEffectiveDimensions, planTranscodeResolution } from "./resolution-plan.js";
import { checkSourceHead, downloadSourceToFile, redactStorageKey } from "./source-downloader.js";
import type { TranscodingJobRepository } from "./transcoding-job.repository.js";
import { cleanupWorkspace, createJobWorkspace } from "./temp-workspace.js";
import { classifySourceProbe, probeVideoFile } from "./video-probe.js";
import type { ITranscodingJob } from "./transcoding-job.interface.js";

export interface VideoProcessorDependencies {
  repository: TranscodingJobRepository;
  storageService: StorageService;
  /** Injectable so integration tests can fake the child-process boundary without a real ffmpeg binary. */
  runFfmpeg?: typeof runFfmpegProcess;
  /** Injectable so integration tests can fake the child-process boundary without a real ffprobe binary. Used both to probe the downloaded source and, separately, to re-probe the produced local output before upload. */
  probeVideoFile?: typeof probeVideoFile;
  /** Injectable so integration tests can deterministically exercise the disk-guard deferral path without touching real disk state. */
  checkDiskCapacity?: typeof checkDiskCapacity;
  /** Injectable so the configured maximum source size can be exercised deterministically in tests without mutating parsed process.env after module import. Defaults to env.TRANSCODING_MAX_SOURCE_BYTES. */
  maxSourceBytes?: number;
}

export type ProcessJobOutcome =
  | { outcome: "completed"; jobId: string; optimizedKey: string; thumbnailKey: string }
  | { outcome: "failed"; jobId: string; errorCode: ReturnType<typeof classifyProcessingFailure>["errorCode"] }
  | { outcome: "deferred"; jobId: string; reason: "disk_capacity" }
  | { outcome: "lease_lost"; jobId: string };

type StepFailure =
  | { step: "encode"; reason: Extract<ProcessingFailureReason, "encode_failed" | "encode_timeout"> }
  | { step: "thumbnail"; reason: "thumbnail_failed" }
  | { step: "local_verify_optimized" | "local_verify_thumbnail"; reason: "output_verification_failed" }
  | { step: "upload_optimized" | "upload_thumbnail"; reason: "upload_failed" }
  | { step: "verify_optimized" | "verify_thumbnail"; reason: "output_verification_failed" };

type ProcessingStepsResult =
  | {
      ok: true;
      optimizedKey: string;
      thumbnailKey: string;
      outputWidth: number;
      outputHeight: number;
      outputFileSize: number;
      outputDurationSeconds: number | null;
    }
  | { ok: false; failure: StepFailure };

const SUPPORTED_CONTENT_TYPE_PREFIX = "video/";
const OPTIMIZED_VIDEO_CONTENT_TYPE = "video/mp4";
const THUMBNAIL_CONTENT_TYPE = "image/jpeg";

/**
 * Streams the local optimized MP4 straight to S3 via `createReadStream` +
 * `stat` for the known content length — never reads the whole file into a
 * Buffer first, so a large optimized output never sits fully in Node memory
 * during upload. On any failure the stream is explicitly destroyed rather
 * than left to the caller/GC.
 */
const uploadOptimizedVideoStream = async (
  storageService: StorageService,
  key: string,
  filePath: string,
): Promise<{ ok: true; size: number } | { ok: false; reason: "upload_failed" }> => {
  let fileStat: Awaited<ReturnType<typeof stat>>;

  try {
    fileStat = await stat(filePath);
  } catch {
    return { ok: false, reason: "upload_failed" };
  }

  const stream = createReadStream(filePath);

  try {
    await storageService.uploadObject({
      body: stream,
      contentType: OPTIMIZED_VIDEO_CONTENT_TYPE,
      key,
      contentLength: fileStat.size,
    });
  } catch {
    if (!stream.destroyed) {
      stream.destroy();
    }
    return { ok: false, reason: "upload_failed" };
  }

  return { ok: true, size: fileStat.size };
};

/** Thumbnails are small (a single JPEG frame) — buffering is simplest and safe at this size. */
const uploadThumbnailBuffer = async (
  storageService: StorageService,
  key: string,
  buffer: Buffer,
): Promise<{ ok: true; size: number } | { ok: false; reason: "upload_failed" }> => {
  try {
    await storageService.uploadObject({ body: buffer, contentType: THUMBNAIL_CONTENT_TYPE, key });
  } catch {
    return { ok: false, reason: "upload_failed" };
  }

  return { ok: true, size: buffer.length };
};

/**
 * Post-upload S3 HEAD verification: the object must exist, its
 * Content-Length must exactly match the local file that was uploaded (never
 * merely non-zero), and its Content-Type must be exactly what was intended —
 * catches a truncated upload or a storage-layer content-type mismatch that a
 * bare "did uploadObject throw" check would miss entirely.
 */
const verifyUploadedObject = async (
  storageService: StorageService,
  key: string,
  expectedSize: number,
  expectedContentType: string,
): Promise<{ ok: true } | { ok: false; reason: "verification_failed" }> => {
  try {
    const metadata = await storageService.getObjectMetadata(key);

    if (metadata.contentLength === undefined || metadata.contentLength <= 0) {
      return { ok: false, reason: "verification_failed" };
    }

    if (metadata.contentLength !== expectedSize) {
      return { ok: false, reason: "verification_failed" };
    }

    if (metadata.contentType !== expectedContentType) {
      return { ok: false, reason: "verification_failed" };
    }
  } catch {
    return { ok: false, reason: "verification_failed" };
  }

  return { ok: true };
};

const stepFailureToReason = (failure: StepFailure): ProcessingFailureReason => {
  switch (failure.step) {
    case "encode":
      return failure.reason;
    case "thumbnail":
      return "thumbnail_failed";
    case "upload_optimized":
    case "upload_thumbnail":
      return "upload_failed";
    case "local_verify_optimized":
    case "local_verify_thumbnail":
    case "verify_optimized":
    case "verify_thumbnail":
      return "output_verification_failed";
  }
};

/**
 * Processes exactly one already-claimed job end to end: disk guard, source
 * download+validation, transcode, thumbnail, upload+verify, and the final
 * markSuccess/recordFailure write. The caller (the worker loop) owns
 * claimNext() and any cross-job state (e.g. disk-guard log rate-limiting);
 * this function only ever touches the one job it was handed, using its exact
 * leaseToken for every repository write, exactly like every other
 * lease-guarded mutation in this module.
 */
export const processClaimedJob = async (
  job: ITranscodingJob,
  leaseToken: string,
  deps: VideoProcessorDependencies,
): Promise<ProcessJobOutcome> => {
  const jobId = job._id.toString();
  const userId = job.userId.toString();
  const runFfmpeg = deps.runFfmpeg ?? runFfmpegProcess;
  const probe = deps.probeVideoFile ?? probeVideoFile;
  const diskCapacityCheck = deps.checkDiskCapacity ?? checkDiskCapacity;
  const maxSourceBytes = deps.maxSourceBytes ?? env.TRANSCODING_MAX_SOURCE_BYTES;
  const redactedKey = redactStorageKey(job.sourceStorageKey);

  // Permanent source problems (retryable:false — corrupt/oversized/missing/
  // undecodable/wrong-shape source, or an over-duration clip) go straight to
  // markPermanentFailure(): one atomic terminal write, no further retries.
  // Every other classified failure (download/upload/encode/probe/timeout/
  // verification hiccups — all operational, retryable:true) keeps using the
  // ordinary recordFailure(), which schedules up to two automatic retries
  // before becoming terminal on its own. Insufficient disk never reaches this
  // function at all — it is handled entirely by deferClaim() below.
  const recordFailure = async (reason: ProcessingFailureReason, detail?: unknown) => {
    const classification = classifyProcessingFailure(reason);
    const payload = { errorCode: classification.errorCode, errorSummary: detail ?? reason };

    if (classification.retryable) {
      await deps.repository.recordFailure(jobId, leaseToken, payload);
    } else {
      await deps.repository.markPermanentFailure(jobId, leaseToken, payload);
    }

    logger.warn(
      { jobId, sourceKeyHash: redactedKey, reason, errorCode: classification.errorCode, retryable: classification.retryable },
      "Transcoding job failed",
    );
    return classification.errorCode;
  };

  // Guard against starting a job this worker cannot safely complete: the
  // required threshold is the fixed operational floor plus this job's own
  // conservative worst-case disk budget, so a job is only ever started when
  // completing it cannot drive free space below that floor.
  const requiredFreeBytes = env.TRANSCODING_MIN_FREE_DISK_BYTES + estimateJobDiskBudgetBytes(maxSourceBytes);
  const diskCheck = await diskCapacityCheck(env.TRANSCODING_TMP_ROOT, requiredFreeBytes);

  if (!diskCheck.ok) {
    await deps.repository.deferClaim(jobId, leaseToken, { retryDelayMs: env.TRANSCODING_DISK_BLOCKED_BACKOFF_MS });
    logger.warn({ jobId, freeBytes: diskCheck.freeBytes, requiredFreeBytes }, "Transcoding job deferred: insufficient disk capacity");
    return { outcome: "deferred", jobId, reason: "disk_capacity" };
  }

  let workspaceDir: string | null = null;

  try {
    const workspace = await createJobWorkspace(env.TRANSCODING_TMP_ROOT, jobId);
    workspaceDir = workspace.dir;

    const head = await checkSourceHead(deps.storageService, job.sourceStorageKey, maxSourceBytes);

    if (!head.ok) {
      const reason: ProcessingFailureReason = head.reason === "missing"
        ? "source_missing"
        : head.reason === "too_large"
          ? "source_too_large"
          : "download_failed";
      const errorCode = await recordFailure(reason);
      return { outcome: "failed", jobId, errorCode };
    }

    if (head.contentType && !head.contentType.startsWith(SUPPORTED_CONTENT_TYPE_PREFIX)) {
      const errorCode = await recordFailure("source_unreadable", `unsupported content type: ${head.contentType}`);
      return { outcome: "failed", jobId, errorCode };
    }

    const download = await downloadSourceToFile({
      storageService: deps.storageService,
      key: job.sourceStorageKey,
      destinationPath: workspace.sourcePath,
      maxBytes: maxSourceBytes,
    });

    if (!download.ok) {
      const reason: ProcessingFailureReason = download.reason === "missing"
        ? "source_missing"
        : download.reason === "too_large"
          ? "source_too_large"
          : "download_failed";
      const errorCode = await recordFailure(reason);
      return { outcome: "failed", jobId, errorCode };
    }

    const probeOutcome = await probe(workspace.sourcePath, env.MEDIA_PROBE_TIMEOUT_MS);

    if (!probeOutcome.ok) {
      const reason: ProcessingFailureReason = probeOutcome.reason === "unavailable"
        ? "source_probe_unavailable"
        : probeOutcome.reason === "timeout"
          ? "source_probe_timeout"
          : "source_unreadable";
      const errorCode = await recordFailure(reason);
      return { outcome: "failed", jobId, errorCode };
    }

    const classification = classifySourceProbe(probeOutcome.probe, env.MOMENT_VIDEO_MAX_DURATION_SECONDS);

    if (classification !== "valid") {
      const reason: ProcessingFailureReason = classification === "no_video_stream"
        ? "source_no_video_stream"
        : classification === "invalid_dimensions"
          ? "source_invalid_dimensions"
          : classification === "duration_too_long"
            ? "source_duration_too_long"
            : "source_unreadable";
      const errorCode = await recordFailure(reason);
      return { outcome: "failed", jobId, errorCode };
    }

    const sourceVideo = probeOutcome.probe.video;

    if (!sourceVideo || sourceVideo.width === null || sourceVideo.height === null) {
      const errorCode = await recordFailure("source_invalid_dimensions");
      return { outcome: "failed", jobId, errorCode };
    }

    const effective = resolveEffectiveDimensions(sourceVideo.width, sourceVideo.height, sourceVideo.rotationDegrees);
    const resolution = planTranscodeResolution(effective.width, effective.height);
    const hasAudio = probeOutcome.probe.hasAudioStream;
    const durationSeconds = probeOutcome.probe.durationSeconds;

    let leaseLost = false;
    const abortController = new AbortController();

    const doProcessingSteps = async (): Promise<ProcessingStepsResult> => {
      const transcodeArgs = buildTranscodeArgs({
        inputPath: workspace.sourcePath,
        outputPath: workspace.optimizedPath,
        resolution,
        hasAudio,
        crf: env.TRANSCODING_CRF,
        preset: env.TRANSCODING_PRESET,
      });

      const transcodeRun = await runFfmpeg(env.FFMPEG_PATH, transcodeArgs, {
        timeoutMs: env.TRANSCODING_FFMPEG_TIMEOUT_MS,
        signal: abortController.signal,
      });

      if (!transcodeRun.ok) {
        return {
          ok: false,
          failure: { step: "encode", reason: transcodeRun.reason === "timeout" ? "encode_timeout" : "encode_failed" },
        };
      }

      const thumbnailArgs = buildThumbnailArgs({
        inputPath: workspace.sourcePath,
        outputPath: workspace.thumbnailPath,
        timestampSeconds: planThumbnailTimestampSeconds(durationSeconds ?? 0),
        resolution,
      });

      const thumbnailRun = await runFfmpeg(env.FFMPEG_PATH, thumbnailArgs, {
        timeoutMs: env.TRANSCODING_FFMPEG_TIMEOUT_MS,
        signal: abortController.signal,
      });

      if (!thumbnailRun.ok) {
        return { ok: false, failure: { step: "thumbnail", reason: "thumbnail_failed" } };
      }

      // Local validation happens before anything is uploaded: never trust
      // FFmpeg's own exit code alone. Both the optimized video and the
      // thumbnail must independently pass before either is uploaded.
      let optimizedFileSize: number;

      try {
        optimizedFileSize = (await stat(workspace.optimizedPath)).size;
      } catch {
        return { ok: false, failure: { step: "local_verify_optimized", reason: "output_verification_failed" } };
      }

      const optimizedProbe = await probe(workspace.optimizedPath, env.MEDIA_PROBE_TIMEOUT_MS);
      const optimizedValidation = validateOptimizedOutput({
        probe: optimizedProbe.ok ? optimizedProbe.probe : null,
        expectedWidth: resolution.width,
        expectedHeight: resolution.height,
        sourceHasAudio: hasAudio,
        sourceDurationSeconds: durationSeconds,
        outputFileSizeBytes: optimizedFileSize,
      });

      if (!optimizedValidation.ok) {
        return { ok: false, failure: { step: "local_verify_optimized", reason: "output_verification_failed" } };
      }

      let thumbnailBuffer: Buffer;

      try {
        thumbnailBuffer = await readFile(workspace.thumbnailPath);
      } catch {
        return { ok: false, failure: { step: "local_verify_thumbnail", reason: "output_verification_failed" } };
      }

      if (!isValidJpegThumbnail(thumbnailBuffer)) {
        return { ok: false, failure: { step: "local_verify_thumbnail", reason: "output_verification_failed" } };
      }

      const optimizedKey = buildOptimizedVideoKey(userId, jobId);
      const thumbnailKey = buildThumbnailKey(userId, jobId);

      // Best-effort cleanup of whatever this attempt already uploaded, if a
      // later step in this same attempt fails. Deterministic keys mean the
      // next attempt (or another worker) simply overwrites the same objects,
      // so this is a courtesy against orphaned partial output, never a
      // correctness requirement — failures here are swallowed on purpose.
      const cleanupUploaded = async (keys: string[]): Promise<void> => {
        await Promise.all(
          keys.map((key) => deps.storageService.deleteObject(key).catch(() => undefined)),
        );
      };

      const optimizedUpload = await uploadOptimizedVideoStream(deps.storageService, optimizedKey, workspace.optimizedPath);

      if (!optimizedUpload.ok) {
        return { ok: false, failure: { step: "upload_optimized", reason: "upload_failed" } };
      }

      const thumbnailUpload = await uploadThumbnailBuffer(deps.storageService, thumbnailKey, thumbnailBuffer);

      if (!thumbnailUpload.ok) {
        await cleanupUploaded([optimizedKey]);
        return { ok: false, failure: { step: "upload_thumbnail", reason: "upload_failed" } };
      }

      const optimizedVerify = await verifyUploadedObject(
        deps.storageService,
        optimizedKey,
        optimizedUpload.size,
        OPTIMIZED_VIDEO_CONTENT_TYPE,
      );

      if (!optimizedVerify.ok) {
        await cleanupUploaded([optimizedKey, thumbnailKey]);
        return { ok: false, failure: { step: "verify_optimized", reason: "output_verification_failed" } };
      }

      const thumbnailVerify = await verifyUploadedObject(
        deps.storageService,
        thumbnailKey,
        thumbnailUpload.size,
        THUMBNAIL_CONTENT_TYPE,
      );

      if (!thumbnailVerify.ok) {
        await cleanupUploaded([optimizedKey, thumbnailKey]);
        return { ok: false, failure: { step: "verify_thumbnail", reason: "output_verification_failed" } };
      }

      return {
        ok: true,
        optimizedKey,
        thumbnailKey,
        outputWidth: resolution.width,
        outputHeight: resolution.height,
        outputFileSize: optimizedUpload.size,
        outputDurationSeconds: durationSeconds,
      };
    };

    const processingResult = await runWithPeriodicLeaseRenewal({
      intervalMs: env.TRANSCODING_LEASE_RENEWAL_INTERVAL_MS,
      renew: async () => {
        const renewed = await deps.repository.renewLease(jobId, leaseToken);
        return renewed !== null;
      },
      onLeaseLost: () => {
        leaseLost = true;
        abortController.abort();
      },
      work: doProcessingSteps,
    });

    if (leaseLost) {
      logger.warn({ jobId }, "Transcoding job lease lost mid-processing; another worker has reclaimed it");
      return { outcome: "lease_lost", jobId };
    }

    if (!processingResult.ok) {
      const errorCode = await recordFailure(stepFailureToReason(processingResult.failure));
      return { outcome: "failed", jobId, errorCode };
    }

    const success = await deps.repository.markSuccess(jobId, leaseToken, {
      optimizedStorageKey: processingResult.optimizedKey,
      thumbnailStorageKey: processingResult.thumbnailKey,
      outputWidth: processingResult.outputWidth,
      outputHeight: processingResult.outputHeight,
      outputFileSize: processingResult.outputFileSize,
      outputDurationSeconds: processingResult.outputDurationSeconds,
    });

    if (!success) {
      // Lease was lost in the narrow window between the last renewal and this
      // final write — the encode/upload work already happened, but this
      // worker no longer owns the job record, so it must not claim credit or
      // retry. The deterministic output keys mean the worker that now owns
      // the job (or a future retry) will simply overwrite the same objects.
      logger.warn({ jobId }, "Transcoding job lease lost immediately before markSuccess");
      return { outcome: "lease_lost", jobId };
    }

    logger.info(
      { jobId, optimizedKey: processingResult.optimizedKey, thumbnailKey: processingResult.thumbnailKey },
      "Transcoding job completed",
    );

    return { outcome: "completed", jobId, optimizedKey: processingResult.optimizedKey, thumbnailKey: processingResult.thumbnailKey };
  } catch (error) {
    const errorCode = await recordFailure("unknown", error instanceof Error ? error.message : String(error));
    return { outcome: "failed", jobId, errorCode };
  } finally {
    if (workspaceDir) {
      await cleanupWorkspace(workspaceDir);
    }
  }
};
