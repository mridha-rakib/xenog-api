import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { StorageService } from "../storage/storage.service.js";

// Small, generic AWS-SDK-error-shape classifiers mirroring the convention
// already established in moment-video.service.ts. Duplicated locally (a few
// lines) rather than exporting from that module, to avoid touching Phase 1's
// upload-validation file for this Phase 2 addition — these operate on the
// generic AWS SDK error shape, not any Moment-specific logic.
type StorageFailureCode = string | undefined;

const getStorageErrorCode = (error: unknown): StorageFailureCode => {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const candidate = error as { Code?: string; code?: string; name?: string };
  return candidate.Code ?? candidate.code ?? candidate.name;
};

const getStorageErrorStatus = (error: unknown): number | undefined => {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return typeof status === "number" ? status : undefined;
};

export const isMissingObjectError = (error: unknown): boolean => {
  const status = getStorageErrorStatus(error);
  const code = getStorageErrorCode(error);
  return status === 404 || code === "NoSuchKey" || code === "NotFound" || code === "NotFoundException";
};

export const isRetryableStorageError = (error: unknown): boolean => {
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

/** Same redaction convention as moment-video.service.ts's redactStorageKey — SHA-256, 12 hex chars. */
export const redactStorageKey = (key: string): string => createHash("sha256").update(key).digest("hex").slice(0, 12);

export type SourceHeadOutcome =
  | { ok: true; contentLength: number; contentType: string | null }
  | { ok: false; reason: "missing" | "storage_unavailable" | "too_large" | "content_length_unavailable" };

/**
 * S3 HEAD pre-check: confirms the object exists and its Content-Length is
 * present and within the configured maximum, before ever starting a
 * download. Never trusts the client-declared content type alone (nothing
 * here rejects on content type — the actual video-stream validity is
 * confirmed later by ffprobe on the downloaded bytes).
 */
export const checkSourceHead = async (
  storageService: StorageService,
  key: string,
  maxBytes: number,
): Promise<SourceHeadOutcome> => {
  try {
    const metadata = await storageService.getObjectMetadata(key);

    if (metadata.contentLength === undefined || metadata.contentLength <= 0) {
      return { ok: false, reason: "content_length_unavailable" };
    }

    if (metadata.contentLength > maxBytes) {
      return { ok: false, reason: "too_large" };
    }

    return { ok: true, contentLength: metadata.contentLength, contentType: metadata.contentType ?? null };
  } catch (error) {
    if (isMissingObjectError(error)) {
      return { ok: false, reason: "missing" };
    }

    return { ok: false, reason: "storage_unavailable" };
  }
};

export type DownloadOutcome =
  | { ok: true; downloadedBytes: number }
  | { ok: false; reason: "missing" | "storage_unavailable" | "too_large" | "download_failed"; downloadedBytes: number };

/**
 * Streams an S3 object to a local file with a hard byte-count ceiling —
 * never buffers the whole video in memory. Uses Node's stream `pipeline`
 * (the same idiom already used both by the public storage.controller.ts GET
 * route and by moment-video.service.ts's probe download) with a counting
 * Transform that aborts the underlying S3 read the instant the configured
 * maximum is exceeded, even if the HEAD check's Content-Length was somehow
 * wrong or absent. Always removes any partial file on failure.
 */
export const downloadSourceToFile = async (params: {
  storageService: StorageService;
  key: string;
  destinationPath: string;
  maxBytes: number;
}): Promise<DownloadOutcome> => {
  const abortController = new AbortController();
  let downloadedBytes = 0;
  let exceededLimit = false;

  const byteLimiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      downloadedBytes += chunk.length;

      if (downloadedBytes > params.maxBytes) {
        exceededLimit = true;
        abortController.abort();
        callback(new Error("source stream exceeded the maximum allowed size"));
        return;
      }

      callback(null, chunk);
    },
  });

  try {
    const object = await params.storageService.getObject(params.key, undefined, abortController.signal);
    await pipeline(object.body, byteLimiter, createWriteStream(params.destinationPath));

    return { ok: true, downloadedBytes };
  } catch (error) {
    await rm(params.destinationPath, { force: true }).catch(() => undefined);

    if (exceededLimit) {
      return { ok: false, reason: "too_large", downloadedBytes };
    }

    if (isMissingObjectError(error)) {
      return { ok: false, reason: "missing", downloadedBytes };
    }

    if (isRetryableStorageError(error)) {
      return { ok: false, reason: "storage_unavailable", downloadedBytes };
    }

    return { ok: false, reason: "download_failed", downloadedBytes };
  }
};
