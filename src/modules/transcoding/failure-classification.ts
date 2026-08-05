import type { TranscodingJobErrorCode } from "./transcoding-job.interface.js";

export type ProcessingFailureReason =
  | "source_missing"
  | "source_too_large"
  | "source_duration_too_long"
  | "source_invalid_dimensions"
  | "source_no_video_stream"
  | "source_unreadable"
  | "source_probe_unavailable"
  | "source_probe_timeout"
  | "download_failed"
  | "encode_failed"
  | "encode_timeout"
  | "thumbnail_failed"
  | "output_verification_failed"
  | "upload_failed"
  | "unknown";

export interface FailureClassification {
  errorCode: TranscodingJobErrorCode;
  /** False = a permanent source problem (recordFailure will still schedule up to 2 retries per the fixed policy — this reflects whether retrying could plausibly help, for logging/analysis). */
  retryable: boolean;
}

/**
 * Maps every failure the video processor can encounter to one of the
 * existing (Phase 1) TranscodingJobErrorCode values plus a retryable
 * classification. Reuses the existing closed enum wherever a code already
 * fits; only "download_failed" was added (see transcoding-job.interface.ts)
 * because no existing code distinguished a source-download operational
 * failure from every other case.
 *
 * `retryable` here is informational/for logging and future tuning — every
 * classified failure still goes through the same fixed recordFailure()
 * retry policy (attempt + 2 automatic retries, then permanent) regardless of
 * this flag. What actually matters operationally is that source-content
 * problems (corrupt file, too long, too large, no video stream) are
 * extremely unlikely to succeed on retry, while infrastructure hiccups
 * (download/upload/verification/timeout) plausibly will.
 */
export const classifyProcessingFailure = (reason: ProcessingFailureReason): FailureClassification => {
  switch (reason) {
    case "source_missing":
    case "source_duration_too_long":
    case "source_invalid_dimensions":
    case "source_no_video_stream":
    case "source_unreadable":
      return { errorCode: "source_invalid", retryable: false };
    case "source_too_large":
      return { errorCode: "source_too_large", retryable: false };
    case "source_probe_unavailable":
    case "source_probe_timeout":
      return { errorCode: "probe_failed", retryable: true };
    case "download_failed":
      return { errorCode: "download_failed", retryable: true };
    case "encode_failed":
      return { errorCode: "encode_failed", retryable: true };
    case "encode_timeout":
      return { errorCode: "timeout", retryable: true };
    case "thumbnail_failed":
      return { errorCode: "thumbnail_failed", retryable: true };
    case "output_verification_failed":
      return { errorCode: "verification_failed", retryable: true };
    case "upload_failed":
      return { errorCode: "upload_failed", retryable: true };
    case "unknown":
    default:
      return { errorCode: "unknown", retryable: true };
  }
};
