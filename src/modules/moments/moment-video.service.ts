import { createHash, randomUUID } from "node:crypto";
import httpStatus from "http-status";
import { AppError } from "../../core/errors/app-error.js";
import { env } from "../../config/env.js";
import { logger } from "../../core/logger/logger.js";
import { StorageService } from "../storage/storage.service.js";
import type { AuthUser } from "../auth/auth.interface.js";
import type { MomentMediaItem } from "./moment.interface.js";

export const MOMENT_VIDEO_STORAGE_PREFIX = "moments";
const MOMENT_VIDEO_SEGMENT = "video";
const VIDEO_UPLOAD_URL_TTL_SECONDS = 60 * 30;
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

// Lightweight, HEAD-only availability check run synchronously inside
// POST /moments. Deliberately narrower than the full ffprobe-based
// validation the transcoding worker performs on its own downloaded copy
// (see modules/transcoding/video-probe.ts's classifySourceProbe): this only
// ever inspects S3 object metadata, never downloads or decodes bytes, so it
// cannot detect a corrupt/non-video/over-duration file — those are permanent
// failures the worker classifies authoritatively after its own download,
// and which the Moment media item surfaces as "failed" once it does.
export type MomentVideoAvailabilityClassification =
  | "valid"
  | "missing"
  | "too_large"
  | "not_video"
  | "unreadable"
  | "storage_unavailable";

export interface MomentVideoAvailabilityResult {
  classification: MomentVideoAvailabilityClassification;
  contentLength?: number;
}

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

const toSafeExtension = (contentType: string): string => {
  const normalized = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  return SAFE_VIDEO_EXTENSIONS_BY_CONTENT_TYPE.get(normalized) ?? "mp4";
};

const normalizeContentType = (contentType: string): string => contentType.toLowerCase().split(";")[0]?.trim() ?? "";

const redactStorageKey = (key: string): string => createHash("sha256").update(key).digest("hex").slice(0, 12);

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

const toMomentVideoError = (classification: MomentVideoAvailabilityClassification): AppError => {
  switch (classification) {
    case "missing":
      return new AppError("The uploaded video could not be found. Please upload it again.", httpStatus.BAD_REQUEST);
    case "too_large":
      return new AppError("Create Post videos are too large. Please choose a shorter video.", httpStatus.BAD_REQUEST);
    case "not_video":
      return new AppError("Create Post videos must be valid video files.", httpStatus.BAD_REQUEST);
    case "unreadable":
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
    const availability = await this.checkStorageVideoAvailability(storageKey, contentType);

    if (availability.classification !== "valid") {
      if (availability.classification !== "missing" && availability.classification !== "storage_unavailable") {
        await this.safeDeleteOwnedUpload(storageKey, user);
      }

      throw toMomentVideoError(availability.classification);
    }

    return {
      ...mediaItem,
      type: "video",
      source: mediaItem.source,
      url: null,
      storageKey,
      contentType,
      // Not yet known: no bytes have been downloaded or decoded at this
      // point (that is deliberately deferred to the transcoding worker — see
      // checkStorageVideoAvailability's doc comment). Never trust the
      // client-supplied durationSeconds as authoritative — moment.validation.ts
      // only uses it for a fast, non-authoritative pre-check, never persists
      // it. The worker's authoritative ffprobe result repoints this field
      // once the media reaches "ready" (see
      // MomentMediaLifecycleService.markReady).
      durationSeconds: null,
    };
  }

  /**
   * Confirms the uploaded object exists, belongs to this Moment-video
   * namespace's expected shape, and is within the allowed upload size —
   * entirely from S3 HEAD metadata, never downloading or decoding the
   * object. This intentionally cannot detect a corrupt file, a non-video
   * container, or an over-duration clip: those require ffprobe to actually
   * decode the bytes, which is exactly the authoritative check the
   * transcoding worker already performs on its own downloaded copy before
   * transcoding (see modules/transcoding/video-probe.ts's classifySourceProbe
   * and video-processor.ts's processClaimedJob) — running that same
   * decode-requiring check again here, synchronously inside POST /moments,
   * would mean downloading the entire source video twice for every upload
   * for no additional safety. A file that slips past this check but fails
   * the worker's later validation transitions the Moment media item to
   * "failed" (see TranscodingMomentSyncService.syncAfterJobAttempt) — it
   * never reaches "ready".
   */
  public async checkStorageVideoAvailability(key: string, contentType: string): Promise<MomentVideoAvailabilityResult> {
    const keyHash = redactStorageKey(key);

    if (!normalizeContentType(contentType).startsWith("video/")) {
      return { classification: "not_video" };
    }

    let metadata: Awaited<ReturnType<StorageService["getObjectMetadata"]>>;

    try {
      metadata = await this.storageService.getObjectMetadata(key);
    } catch (error) {
      if (isMissingObjectError(error)) {
        logger.info({ keyHash, classification: "missing" }, "Moment video storage object is missing");
        return { classification: "missing" };
      }

      const classification = isRetryableStorageError(error) ? "storage_unavailable" : "unreadable";
      logger.warn({ keyHash, classification }, "Moment video metadata check failed");
      return { classification };
    }

    if (metadata.contentLength === undefined || metadata.contentLength <= 0) {
      logger.info({ keyHash, contentLength: metadata.contentLength ?? null, classification: "unreadable" }, "Moment video upload is empty");
      return { classification: "unreadable" };
    }

    if (metadata.contentLength > env.MEDIA_PROBE_MAX_BYTES) {
      logger.info({ keyHash, contentLength: metadata.contentLength, classification: "too_large" }, "Moment video exceeds allowed upload size");
      return { classification: "too_large" };
    }

    logger.info(
      {
        keyHash,
        classification: "valid",
        contentLength: metadata.contentLength,
        metadataContentType: metadata.contentType ?? null,
        requestContentType: contentType,
      },
      "Moment video storage availability check completed",
    );

    return { classification: "valid", contentLength: metadata.contentLength };
  }

  public async safeDeleteOwnedUpload(key: string, user: AuthUser): Promise<void> {
    this.assertOwnedKey(key, user);
    await this.storageService.deleteObject(key).catch(() => undefined);
  }
}
