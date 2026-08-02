import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import httpStatus from "http-status";
import { AppError } from "../../core/errors/app-error.js";
import { env } from "../../config/env.js";
import { logger } from "../../core/logger/logger.js";
import { StorageService } from "../storage/storage.service.js";
import type { AuthUser } from "../auth/auth.interface.js";
import type { MomentMediaItem } from "./moment.interface.js";

const execFileAsync = promisify(execFile);

export const MOMENT_VIDEO_STORAGE_PREFIX = "moments";
const MOMENT_VIDEO_SEGMENT = "video";
const VIDEO_UPLOAD_URL_TTL_SECONDS = 60 * 30;
const MAX_PROBE_OUTPUT_BYTES = 1024 * 1024;
const SAFE_VIDEO_EXTENSIONS_BY_CONTENT_TYPE = new Map<string, string>([
  ["video/mp4", "mp4"],
  ["video/quicktime", "mov"],
  ["video/mov", "mov"],
  ["video/x-m4v", "m4v"],
  ["video/webm", "webm"],
  ["video/3gpp", "3gp"],
  ["video/3gpp2", "3g2"],
]);

type StorageFailureCode = string | undefined;

export type MomentVideoProbeClassification =
  | "valid"
  | "missing"
  | "too_large"
  | "not_video"
  | "duration_unavailable"
  | "duration_too_long"
  | "probe_unavailable"
  | "probe_timeout"
  | "probe_failed"
  | "storage_unavailable";

export interface MomentVideoProbeResult {
  classification: MomentVideoProbeClassification;
  durationSeconds?: number;
  width?: number | null;
  height?: number | null;
  formatName?: string | null;
  videoCodec?: string | null;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: {
    duration?: string;
    format_name?: string;
  };
}

class AsyncGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  public constructor(private readonly limit: number) {}

  public async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();

    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }

    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiting.shift();
    next?.();
  }
}

const probeGate = new AsyncGate(env.MEDIA_PROBE_MAX_CONCURRENCY);

const getStorageErrorCode = (error: unknown): StorageFailureCode => {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const candidate = error as {
    Code?: string;
    code?: string;
    name?: string;
  };

  return candidate.Code ?? candidate.code ?? candidate.name;
};

const getStorageErrorStatus = (error: unknown): number | undefined => {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return typeof status === "number" ? status : undefined;
};

const isMissingObjectError = (error: unknown): boolean => {
  const status = getStorageErrorStatus(error);
  const code = getStorageErrorCode(error);
  return status === 404 || code === "NoSuchKey" || code === "NotFound" || code === "NotFoundException";
};

const isRetryableStorageError = (error: unknown): boolean => {
  const status = getStorageErrorStatus(error);
  const code = getStorageErrorCode(error);
  return status === 500
    || status === 502
    || status === 503
    || status === 504
    || code === "RequestTimeout"
    || code === "ServiceUnavailable"
    || code === "SlowDown"
    || code === "Throttling"
    || code === "ThrottlingException"
    || code === "TimeoutError";
};

const parseDuration = (value: string | undefined): number | null => {
  if (!value) {
    return null;
  }

  const duration = Number(value);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
};

const toSafeExtension = (contentType: string): string => {
  const normalized = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  return SAFE_VIDEO_EXTENSIONS_BY_CONTENT_TYPE.get(normalized) ?? "mp4";
};

const normalizeContentType = (contentType: string): string => contentType.toLowerCase().split(";")[0]?.trim() ?? "";

const redactStorageKey = (key: string): string => createHash("sha256").update(key).digest("hex").slice(0, 12);

const nowMs = (): number => Number(process.hrtime.bigint() / 1000000n);

const createByteCounter = (onCount: (bytes: number) => void) => {
  let bytes = 0;

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      onCount(bytes);
      callback(null, chunk);
    },
  });
};

const assertVideoContentType = (contentType: string): string => {
  const normalized = normalizeContentType(contentType);

  if (!normalized.startsWith("video/")) {
    throw new AppError("Moment videos must be video files.", httpStatus.BAD_REQUEST);
  }

  return normalized;
};

export const createMomentVideoStorageKey = (userId: string, contentType: string): string => {
  const extension = toSafeExtension(contentType);
  return `${MOMENT_VIDEO_STORAGE_PREFIX}/${userId}/${MOMENT_VIDEO_SEGMENT}/${randomUUID()}.${extension}`;
};

export const getMomentVideoStoragePrefixForUser = (userId: string): string =>
  `${MOMENT_VIDEO_STORAGE_PREFIX}/${userId}/${MOMENT_VIDEO_SEGMENT}/`;

export const isOwnedMomentVideoStorageKey = (key: string, userId: string): boolean => {
  if (!key || key.includes("..") || key.startsWith("/") || key.includes("\\")) {
    return false;
  }

  return key.startsWith(getMomentVideoStoragePrefixForUser(userId))
    && key.split("/").length === 4
    && /^[a-f\d-]{36}\.[a-z0-9]+$/i.test(key.split("/").at(-1) ?? "");
};

const toMomentVideoError = (classification: MomentVideoProbeClassification): AppError => {
  switch (classification) {
    case "missing":
      return new AppError("The uploaded video could not be found. Please upload it again.", httpStatus.BAD_REQUEST);
    case "too_large":
      return new AppError("Create Post videos are too large. Please choose a shorter video.", httpStatus.BAD_REQUEST);
    case "not_video":
      return new AppError("Create Post videos must be valid video files.", httpStatus.BAD_REQUEST);
    case "duration_unavailable":
      return new AppError("We could not verify this video duration. Please choose another video.", httpStatus.BAD_REQUEST);
    case "duration_too_long":
      return new AppError("Create Post videos can be up to 1 minute. Please record a shorter video.", httpStatus.BAD_REQUEST);
    case "probe_unavailable":
    case "probe_timeout":
      return new AppError("We could not verify this video right now. Please try again.", httpStatus.SERVICE_UNAVAILABLE);
    case "probe_failed":
      return new AppError("We could not read this video. Please record or choose another video.", httpStatus.BAD_REQUEST);
    case "storage_unavailable":
      return new AppError("We could not verify this video right now. Please try again.", httpStatus.SERVICE_UNAVAILABLE);
    case "valid":
      return new AppError("Video verification failed.", httpStatus.BAD_REQUEST);
  }
};

export class MomentVideoService {
  public constructor(private readonly storageService = new StorageService()) {}

  public async createUpload(user: AuthUser, contentType: string): Promise<Record<string, unknown>> {
    const normalizedContentType = assertVideoContentType(contentType);
    const key = createMomentVideoStorageKey(user.id, normalizedContentType);

    return this.storageService.createUploadUrl({
      key,
      contentType: normalizedContentType,
      expiresIn: VIDEO_UPLOAD_URL_TTL_SECONDS,
    });
  }

  public assertOwnedKey(key: string, user: AuthUser): void {
    if (!isOwnedMomentVideoStorageKey(key, user.id)) {
      throw new AppError("This uploaded video is not available for your account.", httpStatus.BAD_REQUEST);
    }
  }

  public async uploadObject(payload: {
    user: AuthUser;
    key: string;
    contentType: string;
    body: Buffer;
  }): Promise<{ key: string }> {
    this.assertOwnedKey(payload.key, payload.user);
    const normalizedContentType = assertVideoContentType(payload.contentType);

    return this.storageService.uploadObject({
      key: payload.key,
      contentType: normalizedContentType,
      body: payload.body,
    });
  }

  public async validateCreateMomentVideo(mediaItem: MomentMediaItem, user: AuthUser): Promise<MomentMediaItem> {
    if (mediaItem.url) {
      throw new AppError("Create Post videos must use an uploaded video file.", httpStatus.BAD_REQUEST);
    }

    const storageKey = mediaItem.storageKey?.trim();

    if (!storageKey) {
      throw new AppError("Create Post video upload is required.", httpStatus.BAD_REQUEST);
    }

    this.assertOwnedKey(storageKey, user);

    const contentType = assertVideoContentType(mediaItem.contentType ?? "");
    const probe = await this.probeStorageVideo(storageKey, contentType);

    if (probe.classification !== "valid") {
      if (probe.classification !== "missing" && probe.classification !== "storage_unavailable") {
        await this.safeDeleteOwnedUpload(storageKey, user);
      }

      throw toMomentVideoError(probe.classification);
    }

    return {
      ...mediaItem,
      type: "video",
      source: mediaItem.source,
      url: null,
      storageKey,
      contentType,
      durationSeconds: probe.durationSeconds ?? null,
    };
  }

  public async probeStorageVideo(key: string, contentType: string): Promise<MomentVideoProbeResult> {
    const keyHash = redactStorageKey(key);
    const startedAt = nowMs();
    const phaseTimings: Record<string, number> = {};

    if (!normalizeContentType(contentType).startsWith("video/")) {
      return { classification: "not_video" };
    }

    let metadata: Awaited<ReturnType<StorageService["getObjectMetadata"]>>;

    try {
      const phaseStartedAt = nowMs();
      metadata = await this.storageService.getObjectMetadata(key);
      phaseTimings.headObjectMs = nowMs() - phaseStartedAt;
    } catch (error) {
      if (isMissingObjectError(error)) {
        logger.info({ keyHash, classification: "missing" }, "Moment video storage object is missing");
        return { classification: "missing" };
      }

      const classification = isRetryableStorageError(error) ? "storage_unavailable" : "probe_failed";
      logger.warn({ keyHash, classification }, "Moment video metadata check failed");
      return { classification };
    }

    if (metadata.contentLength === undefined || metadata.contentLength <= 0) {
      logger.info({ keyHash, contentLength: metadata.contentLength ?? null, classification: "probe_failed" }, "Moment video upload is empty");
      return { classification: "probe_failed" };
    }

    if (metadata.contentLength > env.MEDIA_PROBE_MAX_BYTES) {
      logger.info({ keyHash, contentLength: metadata.contentLength, classification: "too_large" }, "Moment video exceeds probe byte limit");
      return { classification: "too_large" };
    }

    return probeGate.run(async () => {
      const tempDir = path.resolve(env.MEDIA_PROBE_TMP_DIR, "xenog-moment-video-probes");
      const tempFile = path.join(tempDir, `${randomUUID()}.media`);
      let downloadedBytes = 0;

      try {
        await mkdir(tempDir, { recursive: true });
        const downloadStartedAt = nowMs();
        const object = await this.storageService.getObject(key);
        await pipeline(
          object.body,
          createByteCounter((bytes) => {
            downloadedBytes = bytes;
          }),
          createWriteStream(tempFile),
        );
        phaseTimings.downloadMs = nowMs() - downloadStartedAt;

        const probeStartedAt = nowMs();
        const result = await this.probeFile(tempFile);
        phaseTimings.ffprobeMs = nowMs() - probeStartedAt;
        logger.info(
          {
            keyHash,
            classification: result.classification,
            contentLength: metadata.contentLength,
            downloadedBytes,
            metadataContentType: metadata.contentType ?? null,
            requestContentType: contentType,
            durationSeconds: result.durationSeconds ?? null,
            totalMs: nowMs() - startedAt,
            ...phaseTimings,
          },
          "Moment video probe completed",
        );
        return result;
      } catch (error) {
        if (isMissingObjectError(error)) {
          return { classification: "missing" };
        }

        if (isRetryableStorageError(error)) {
          return { classification: "storage_unavailable" };
        }

        logger.warn(
          {
            keyHash,
            downloadedBytes,
            totalMs: nowMs() - startedAt,
            ...phaseTimings,
          },
          "Moment video probe failed before ffprobe completed",
        );
        return { classification: "probe_failed" };
      } finally {
        await rm(tempFile, { force: true }).catch(() => undefined);
      }
    });
  }

  public async safeDeleteOwnedUpload(key: string, user: AuthUser): Promise<void> {
    this.assertOwnedKey(key, user);
    await this.storageService.deleteObject(key).catch(() => undefined);
  }

  protected async probeFile(filePath: string): Promise<MomentVideoProbeResult> {
    let stdout: string;

    try {
      const result = await execFileAsync(
        env.FFPROBE_PATH,
        [
          "-v",
          "error",
          "-print_format",
          "json",
          "-show_format",
          "-show_streams",
          filePath,
        ],
        {
          encoding: "utf8",
          maxBuffer: MAX_PROBE_OUTPUT_BYTES,
          shell: false,
          timeout: env.MEDIA_PROBE_TIMEOUT_MS,
          windowsHide: true,
        },
      );
      stdout = result.stdout;
    } catch (error) {
      const code = getStorageErrorCode(error);
      const killed = Boolean(error && typeof error === "object" && (error as { killed?: boolean }).killed);
      const signal = error && typeof error === "object" ? (error as { signal?: string }).signal : undefined;

      if (code === "ENOENT" || code === "EACCES") {
        logger.error({ code, ffprobePath: env.FFPROBE_PATH }, "Moment video ffprobe executable unavailable");
        return { classification: "probe_unavailable" };
      }

      if (code === "ETIMEDOUT" || killed || signal === "SIGTERM") {
        logger.warn({ code, signal, timeoutMs: env.MEDIA_PROBE_TIMEOUT_MS }, "Moment video ffprobe timed out");
        return { classification: "probe_timeout" };
      }

      return { classification: "probe_failed" };
    }

    let parsed: FfprobeOutput;

    try {
      parsed = JSON.parse(stdout) as FfprobeOutput;
    } catch {
      return { classification: "probe_failed" };
    }

    const videoStream = parsed.streams?.find((stream) => stream.codec_type === "video");

    if (!videoStream) {
      return { classification: "not_video" };
    }

    const durationSeconds = parseDuration(videoStream.duration) ?? parseDuration(parsed.format?.duration);

    if (durationSeconds === null) {
      return { classification: "duration_unavailable" };
    }

    if (durationSeconds > env.MOMENT_VIDEO_MAX_DURATION_SECONDS) {
      return {
        classification: "duration_too_long",
        durationSeconds,
        width: videoStream.width ?? null,
        height: videoStream.height ?? null,
        formatName: parsed.format?.format_name ?? null,
        videoCodec: videoStream.codec_name ?? null,
      };
    }

    return {
      classification: "valid",
      durationSeconds,
      width: videoStream.width ?? null,
      height: videoStream.height ?? null,
      formatName: parsed.format?.format_name ?? null,
      videoCodec: videoStream.codec_name ?? null,
    };
  }
}
