import type { Types } from "mongoose";

// Internal worker/job lifecycle. Distinct from, and never exposed alongside,
// MomentMediaItem.processingStatus (the small user-facing status in
// moments/moment.interface.ts). This set mirrors the shape already proven by
// RefundReceiptStatus ("pending" | "sending" | "sent" | "failed_retryable" |
// "failed_terminal") in src/modules/payments/refund-receipt.interface.ts, with
// domain-appropriate names plus "cancelled", which that model does not need but
// this one does (a Moment/media can be deleted while a job is in flight).
export const transcodingJobStatuses = [
  "queued",
  "processing",
  "failed_retryable",
  "completed",
  "failed",
  "cancelled",
] as const;
export type TranscodingJobStatus = (typeof transcodingJobStatuses)[number];

// Independent from the main status above: a completed transcode's original-file
// cleanup can fail without the transcode itself ever being considered failed.
export const transcodingJobCleanupStatuses = ["pending", "completed", "failed"] as const;
export type TranscodingJobCleanupStatus = (typeof transcodingJobCleanupStatuses)[number];

// Phase 3A addition: independent from `status` and `cleanupStatus`, tracks
// whether a completed job's verified output has been repointed onto its
// Moment media item yet. Existing only so a worker crash between markSuccess()
// (job completed) and the Moment repoint write cannot silently strand a
// finished transcode forever — on restart, the worker can find every
// `status:"completed"` job still at "pending"/unset here and finish the
// repoint without ever re-running FFmpeg. "stale" means the repoint was
// attempted but the Moment/media no longer matched (deleted/replaced) — a
// terminal outcome for this job's sync, never retried automatically, and left
// for a later phase's orphan-output cleanup rather than looped on forever.
export const transcodingJobMomentSyncStatuses = ["pending", "synced", "stale"] as const;
export type TranscodingJobMomentSyncStatus = (typeof transcodingJobMomentSyncStatuses)[number];

// Phase 3B3: independent of `cleanupStatus` (Phase 3B1's original-source
// cleanup) — tracks deletion of the *optimized video and thumbnail* produced
// for a job whose Moment repoint went permanently stale (deleted/replaced
// feed video post), so those objects don't linger forever unreferenced.
// "processing" is an explicit claimed-but-not-yet-resolved state (unlike
// cleanupStatus, which stays "pending" throughout a claim and relies solely
// on lease fields to signal "in progress" — this phase's spec calls for a
// real status value instead). "blocked" is a distinct terminal outcome from
// "failed": "failed" means a retryable S3 error (retried up to the attempt
// ceiling); "blocked" means the pre-delete reference check proved deleting
// would be unsafe (still referenced) — a structural fact retrying cannot
// change, so it is never automatically retried once reached.
export const transcodingJobOrphanCleanupStatuses = ["pending", "processing", "failed", "completed", "blocked"] as const;
export type TranscodingJobOrphanCleanupStatus = (typeof transcodingJobOrphanCleanupStatuses)[number];

// Internal, stable, bounded error classification. Never a raw FFmpeg/S3 message,
// stack trace, or command line — see sanitizeErrorSummary for the free-text
// companion field, which is itself bounded and redacted before being stored.
export const transcodingJobErrorCodes = [
  "source_invalid",
  "source_too_large",
  "probe_failed",
  // Phase 2 addition: no existing code distinguished "the source download
  // from S3 failed" (a retryable operational failure, distinct from
  // "source_invalid"/"source_too_large", which describe the file itself)
  // from every other failure mode, so "unknown" was the only fit — this adds
  // the one missing, conservative, narrowly-scoped code rather than reusing
  // an unrelated one.
  "download_failed",
  "encode_failed",
  "thumbnail_failed",
  "upload_failed",
  "verification_failed",
  "timeout",
  "worker_crashed",
  // Phase 3B1 addition: original-source cleanup deletion is a new operation
  // this enum never covered — distinct from "upload_failed" (an output
  // upload) and too specific to collapse into "unknown".
  "delete_failed",
  "unknown",
] as const;
export type TranscodingJobErrorCode = (typeof transcodingJobErrorCodes)[number];

// Initial attempt + exactly two automatic retries.
export const TRANSCODING_JOB_MAX_ATTEMPTS = 3;

// Provisional; Phase 2 will tune this against real ffmpeg timing on the
// confirmed t3.small worker. Must exceed the worst-case per-job processing time
// with margin, since an expired lease is what makes a job eligible for
// stale-job reclaim (see TranscodingJobRepository.claimNext).
export const TRANSCODING_JOB_DEFAULT_LEASE_MS = 5 * 60 * 1000;

// Provisional deterministic bounded backoff. No new dependency: a small pure
// function, independently unit-tested, mirroring the deterministic-delay intent
// of nextRetryAt on RefundReceipt/EventCancellationRefund/TicketCancellation
// without copying their exact (longer, indefinite-retry) backoff curve, since
// this job caps at 3 total attempts, not an open-ended retry schedule.
export const TRANSCODING_JOB_RETRY_BASE_DELAY_MS = 30 * 1000;
const TRANSCODING_JOB_RETRY_MAX_DELAY_MS = TRANSCODING_JOB_RETRY_BASE_DELAY_MS * 8;

/**
 * Delay before the next automatic retry, given the attempt number that just
 * failed (1-based, i.e. the value TranscodingJob.attempts held at the moment
 * of failure). Deterministic and pure so it can be tested without a clock or a
 * database. Doubles per attempt and is capped, never negative, never zero.
 */
export const computeTranscodingJobRetryDelayMs = (failedAttempt: number): number => {
  const safeAttempt = Number.isFinite(failedAttempt) && failedAttempt > 0 ? Math.floor(failedAttempt) : 1;
  const exponent = Math.max(0, safeAttempt - 1);
  const delay = TRANSCODING_JOB_RETRY_BASE_DELAY_MS * 2 ** exponent;

  return Math.min(delay, TRANSCODING_JOB_RETRY_MAX_DELAY_MS);
};

// Phase 3B1: original-source cleanup deletion. Independent of the
// TRANSCODING_JOB_MAX_ATTEMPTS/lease constants above — cleanup only ever runs
// after a job is already `status:"completed"`, so it has its own attempt
// budget and its own (much shorter, since an S3 delete is fast — nothing like
// an FFmpeg encode) lease duration. Reuses computeTranscodingJobRetryDelayMs
// for backoff — the same deterministic doubling curve, just keyed off
// cleanupAttempts instead of attempts.
export const TRANSCODING_CLEANUP_MAX_ATTEMPTS = 5;
export const TRANSCODING_CLEANUP_DEFAULT_LEASE_MS = 2 * 60 * 1000;

// Phase 3B3: orphan optimized-output/thumbnail cleanup. A wholly separate
// attempt budget and lease from both video-processing attempts and
// Phase 3B1's original-source cleanup attempts — this only ever runs after a
// job has already gone `momentSyncStatus:"stale"`, and involves up to two S3
// deletes (optimized + thumbnail) instead of one.
export const TRANSCODING_ORPHAN_CLEANUP_MAX_ATTEMPTS = 5;
export const TRANSCODING_ORPHAN_CLEANUP_DEFAULT_LEASE_MS = 2 * 60 * 1000;

export interface ITranscodingJob {
  _id: Types.ObjectId;

  // Identity: stable per unique upload. sourceStorageKey is already
  // globally-unique (random-UUID-based, see moment-video.service.ts's
  // createMomentVideoStorageKey), so the compound (momentId, sourceStorageKey)
  // pair is both a safe idempotency key and a natural scope for
  // Moment-triggered cancellation lookups.
  momentId: Types.ObjectId;
  userId: Types.ObjectId;
  sourceStorageKey: string;
  sourceContentType?: string | null;

  // Lifecycle.
  status: TranscodingJobStatus;
  attempts: number;
  maxAttempts: number;
  nextRetryAt?: Date | null;
  lastErrorCode?: TranscodingJobErrorCode | null;
  lastErrorSummary?: string | null;

  // Lease / crash recovery. leaseToken is the safety mechanism a stale or
  // replaced worker cannot forge: every write that would mutate a claimed job
  // (renew, success, failure) is filtered by both status and this exact token.
  leaseToken?: string | null;
  leaseExpiresAt?: Date | null;
  claimedAt?: Date | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  failedAt?: Date | null;
  cancelledAt?: Date | null;
  cancelReason?: string | null;

  // Output references, populated only on success. Never surfaced to any public
  // API in this phase; a later phase repoints the Moment media item's own
  // storageKey once these are independently verified.
  optimizedStorageKey?: string | null;
  thumbnailStorageKey?: string | null;
  outputWidth?: number | null;
  outputHeight?: number | null;
  outputFileSize?: number | null;
  outputDurationSeconds?: number | null;

  // Cleanup (original-file deletion) lifecycle. Deliberately independent of
  // `status` above: a cleanup failure after a successful transcode must never
  // flip `status` back to "failed" or "failed_retryable".
  cleanupStatus?: TranscodingJobCleanupStatus | null;
  originalDeletedAt?: Date | null;
  cleanupErrorCode?: TranscodingJobErrorCode | null;
  cleanupErrorSummary?: string | null;
  cleanupAttempts: number;
  cleanupNextRetryAt?: Date | null;
  // Phase 3B1: cleanup's own lease, mirroring leaseToken/leaseExpiresAt/
  // claimedAt above but entirely independent of them — a cleanup task is only
  // ever claimed after the main processing lease has already been released
  // (job status:"completed"), so reusing the main lease would conflate two
  // unrelated claims. A non-null, unexpired cleanupLeaseToken means some
  // worker currently owns this job's cleanup attempt.
  cleanupLeaseToken?: string | null;
  cleanupLeaseExpiresAt?: Date | null;
  cleanupClaimedAt?: Date | null;

  // Phase 3A: Moment-repoint sync lifecycle, independent of `status` and
  // `cleanupStatus` — see transcodingJobMomentSyncStatuses above.
  momentSyncStatus?: TranscodingJobMomentSyncStatus | null;

  // Phase 3B3: orphan optimized-video/thumbnail cleanup lifecycle —
  // independent of `status`, `cleanupStatus`, and `momentSyncStatus`. Only
  // ever relevant once `momentSyncStatus` is "stale". See
  // transcodingJobOrphanCleanupStatuses above.
  orphanCleanupStatus?: TranscodingJobOrphanCleanupStatus | null;
  orphanCleanupAttempts: number;
  orphanCleanupNextRetryAt?: Date | null;
  orphanCleanupLeaseToken?: string | null;
  orphanCleanupLeaseExpiresAt?: Date | null;
  orphanCleanupClaimedAt?: Date | null;
  orphanCleanupCompletedAt?: Date | null;
  orphanCleanupErrorCode?: TranscodingJobErrorCode | null;
  orphanCleanupErrorSummary?: string | null;

  createdAt: Date;
  updatedAt: Date;
}
