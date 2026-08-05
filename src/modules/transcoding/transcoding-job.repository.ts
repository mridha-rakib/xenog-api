import { randomUUID } from "node:crypto";
import { sanitizeErrorSummary } from "../../core/utils/errorSanitizer.js";
import type { ITranscodingJob, TranscodingJobErrorCode } from "./transcoding-job.interface.js";
import {
  TRANSCODING_CLEANUP_DEFAULT_LEASE_MS,
  TRANSCODING_CLEANUP_MAX_ATTEMPTS,
  TRANSCODING_JOB_DEFAULT_LEASE_MS,
  TRANSCODING_JOB_MAX_ATTEMPTS,
  TRANSCODING_ORPHAN_CLEANUP_DEFAULT_LEASE_MS,
  TRANSCODING_ORPHAN_CLEANUP_MAX_ATTEMPTS,
  computeTranscodingJobRetryDelayMs,
} from "./transcoding-job.interface.js";
import { TranscodingJobModel } from "./transcoding-job.model.js";

export type CreateOrGetTranscodingJobPayload = {
  momentId: string;
  userId: string;
  sourceStorageKey: string;
  sourceContentType?: string | null;
  maxAttempts?: number;
};

export type TranscodingJobSuccessPayload = {
  optimizedStorageKey: string;
  thumbnailStorageKey: string;
  outputWidth?: number | null;
  outputHeight?: number | null;
  outputFileSize?: number | null;
  outputDurationSeconds?: number | null;
};

export type TranscodingJobFailurePayload = {
  errorCode: TranscodingJobErrorCode;
  errorSummary?: unknown;
  retryDelayMs?: number;
};

export type TranscodingCleanupFailurePayload = {
  errorCode: TranscodingJobErrorCode;
  errorSummary?: unknown;
  retryDelayMs?: number;
  /**
   * Bypasses the normal attempts-based retry schedule and makes this failure
   * immediately terminal (no further cleanup claims will ever match it) —
   * used only for structural/identity safety violations that retrying could
   * never fix: source/optimized keys unexpectedly equal, or the Moment media
   * no longer verifiably points at this job's optimized output.
   */
  forceTerminal?: boolean;
};

export type TranscodingOrphanCleanupFailurePayload = {
  errorCode: TranscodingJobErrorCode;
  errorSummary?: unknown;
  retryDelayMs?: number;
};

export type TranscodingOrphanCleanupBlockedPayload = {
  errorCode: TranscodingJobErrorCode;
  errorSummary?: unknown;
};

const ACTIVE_STATUSES = ["queued", "processing", "failed_retryable"] as const;

export class TranscodingJobRepository {
  /**
   * Idempotent create. Repeated calls for the same (momentId, sourceStorageKey)
   * identity return the same document rather than inserting a duplicate — a
   * future owner-authorized manual retry (Phase 3) should call this (or a
   * dedicated reset method built on top of it) instead of ever inserting a
   * second job for the same upload.
   */
  public async createOrGet(payload: CreateOrGetTranscodingJobPayload): Promise<ITranscodingJob> {
    return TranscodingJobModel.findOneAndUpdate(
      { momentId: payload.momentId, sourceStorageKey: payload.sourceStorageKey },
      {
        $setOnInsert: {
          momentId: payload.momentId,
          userId: payload.userId,
          sourceStorageKey: payload.sourceStorageKey,
          sourceContentType: payload.sourceContentType ?? null,
          status: "queued",
          attempts: 0,
          maxAttempts: payload.maxAttempts ?? TRANSCODING_JOB_MAX_ATTEMPTS,
          nextRetryAt: new Date(),
          cleanupAttempts: 0,
        },
      },
      { new: true, upsert: true, runValidators: true },
    );
  }

  public async findById(jobId: string): Promise<ITranscodingJob | null> {
    return TranscodingJobModel.findById(jobId);
  }

  public async findByIdentity(momentId: string, sourceStorageKey: string): Promise<ITranscodingJob | null> {
    return TranscodingJobModel.findOne({ momentId, sourceStorageKey });
  }

  /**
   * Atomically claims exactly one due job: a queued/failed_retryable job whose
   * nextRetryAt has passed, or a processing job whose lease has expired
   * (stale-job recovery after a worker crash). A job already at maxAttempts is
   * excluded by the $expr guard below, independent of its stored status, so a
   * bug that ever left a job in "failed_retryable" at the attempt ceiling still
   * cannot be claimed again. The single findOneAndUpdate is MongoDB's atomicity
   * guarantee that two concurrent callers can never both claim the same job.
   */
  public async claimNext(options: { leaseMs?: number } = {}): Promise<ITranscodingJob | null> {
    const now = new Date();
    const leaseMs = options.leaseMs ?? TRANSCODING_JOB_DEFAULT_LEASE_MS;
    const leaseToken = randomUUID();

    return TranscodingJobModel.findOneAndUpdate(
      {
        $expr: { $lt: ["$attempts", "$maxAttempts"] },
        $or: [
          {
            status: { $in: ["queued", "failed_retryable"] },
            $or: [{ nextRetryAt: null }, { nextRetryAt: { $lte: now } }],
          },
          { status: "processing", leaseExpiresAt: { $lte: now } },
        ],
      },
      {
        $set: {
          status: "processing",
          leaseToken,
          leaseExpiresAt: new Date(now.getTime() + leaseMs),
          claimedAt: now,
          startedAt: now,
        },
        $inc: { attempts: 1 },
      },
      { new: true, sort: { nextRetryAt: 1, createdAt: 1 }, runValidators: true },
    );
  }

  /**
   * Extends a currently-held lease. The filter requires both status:"processing"
   * and an exact leaseToken match — a stale or replaced token (e.g. from a
   * worker whose job was already reclaimed) matches nothing and this returns
   * null, which the caller must treat as "I no longer own this job."
   */
  public async renewLease(
    jobId: string,
    leaseToken: string,
    leaseMs: number = TRANSCODING_JOB_DEFAULT_LEASE_MS,
  ): Promise<ITranscodingJob | null> {
    const now = new Date();

    return TranscodingJobModel.findOneAndUpdate(
      { _id: jobId, status: "processing", leaseToken },
      { $set: { leaseExpiresAt: new Date(now.getTime() + leaseMs) } },
      { new: true, runValidators: true },
    );
  }

  /**
   * Records a successful transcode. Requires the current valid lease, exactly
   * like renewLease — an old/replaced worker's token cannot complete a job that
   * has since been reclaimed by another worker. Does NOT touch the Moment
   * document; repointing the Moment media item to the optimized output is a
   * later phase's responsibility, kept out of this repository entirely so this
   * phase cannot accidentally start mutating Moment data.
   */
  public async markSuccess(
    jobId: string,
    leaseToken: string,
    payload: TranscodingJobSuccessPayload,
  ): Promise<ITranscodingJob | null> {
    const now = new Date();

    return TranscodingJobModel.findOneAndUpdate(
      { _id: jobId, status: "processing", leaseToken },
      {
        $set: {
          status: "completed",
          completedAt: now,
          optimizedStorageKey: payload.optimizedStorageKey,
          thumbnailStorageKey: payload.thumbnailStorageKey,
          outputWidth: payload.outputWidth ?? null,
          outputHeight: payload.outputHeight ?? null,
          outputFileSize: payload.outputFileSize ?? null,
          outputDurationSeconds: payload.outputDurationSeconds ?? null,
          // A completed transcode always has an original left to clean up.
          cleanupStatus: "pending",
          // A freshly completed job always needs its Moment media item
          // repointed — see markMomentSynced/markMomentSyncStale below.
          momentSyncStatus: "pending",
          leaseToken: null,
          leaseExpiresAt: null,
          nextRetryAt: null,
        },
      },
      { new: true, runValidators: true },
    );
  }

  /**
   * Records a failed attempt. A single lease-guarded write performs the whole
   * state transition — error fields, retryable-vs-terminal status,
   * nextRetryAt/failedAt, and lease release are all set together by one
   * findOneAndUpdate filtered on `{_id, status:"processing", leaseToken}`. A
   * caller that no longer holds that exact token — wrong token, or the lease
   * was reclaimed by another worker after this token was issued (reclaim in
   * claimNext always mints a brand-new random token) — cannot match that
   * filter, so this returns null and writes nothing at all, including no
   * partial error information.
   *
   * A preliminary, non-mutating findOne reads `attempts`/`maxAttempts` (and
   * `failedAt`) to decide retryable-vs-exhausted and compute the backoff
   * delay before the write. That read is safe even if it goes stale before
   * the write runs: the write can only succeed while this exact leaseToken is
   * still current, and nothing can change a job's `attempts` while its
   * current token is still held by this caller — only claimNext changes
   * `attempts`, and it only ever does so by also replacing the token. So
   * either the read's values are still accurate when the write commits, or
   * the write does not commit at all; a stale read can never produce a
   * mismatched write.
   *
   * This intentionally does not also require an unexpired `leaseExpiresAt`,
   * to stay consistent with markSuccess(), which likewise accepts the exact
   * current token without an expiry check. The scenario this method must
   * prevent — another worker having already taken over — is what leaseToken
   * alone guarantees, since reclaiming always mints a new token; a lease that
   * is merely running late but has not yet been reclaimed by anyone still
   * belongs, by this repository's design, to the worker holding its current
   * token.
   */
  public async recordFailure(
    jobId: string,
    leaseToken: string,
    payload: TranscodingJobFailurePayload,
  ): Promise<ITranscodingJob | null> {
    const current = await TranscodingJobModel.findOne({ _id: jobId, status: "processing", leaseToken });

    if (!current) {
      return null;
    }

    const now = new Date();
    const sanitizedSummary = sanitizeErrorSummary(payload.errorSummary ?? payload.errorCode);
    const isExhausted = current.attempts >= current.maxAttempts;
    const retryDelayMs = payload.retryDelayMs ?? computeTranscodingJobRetryDelayMs(current.attempts);

    return TranscodingJobModel.findOneAndUpdate(
      { _id: jobId, status: "processing", leaseToken },
      {
        $set: {
          lastErrorCode: payload.errorCode,
          lastErrorSummary: sanitizedSummary,
          status: isExhausted ? "failed" : "failed_retryable",
          failedAt: isExhausted ? now : (current.failedAt ?? null),
          nextRetryAt: isExhausted ? null : new Date(now.getTime() + retryDelayMs),
          leaseToken: null,
          leaseExpiresAt: null,
        },
      },
      { new: true, runValidators: true },
    );
  }

  /**
   * Records an immediately terminal failure for a permanent, non-retryable
   * source problem (missing/oversized/corrupt/undecodable source, no video
   * stream, invalid dimensions, over-duration) — as opposed to recordFailure(),
   * which schedules up to two automatic retries for operational failures. A
   * single lease-guarded write moves the job straight to `status: "failed"`
   * with `nextRetryAt: null`, without incrementing `attempts` again (claimNext
   * already incremented it once when this job was claimed) and without ever
   * passing through `failed_retryable`. Guarded identically to every other
   * lease-guarded transition in this repository: `{_id, status:"processing",
   * leaseToken}`. A wrong or stale token matches nothing and this returns
   * null, writing nothing; a completed/cancelled/already-failed job is
   * likewise untouched, since none of those has `status: "processing"`.
   */
  public async markPermanentFailure(
    jobId: string,
    leaseToken: string,
    payload: TranscodingJobFailurePayload,
  ): Promise<ITranscodingJob | null> {
    const now = new Date();
    const sanitizedSummary = sanitizeErrorSummary(payload.errorSummary ?? payload.errorCode);

    return TranscodingJobModel.findOneAndUpdate(
      { _id: jobId, status: "processing", leaseToken },
      {
        $set: {
          status: "failed",
          lastErrorCode: payload.errorCode,
          lastErrorSummary: sanitizedSummary,
          failedAt: now,
          nextRetryAt: null,
          leaseToken: null,
          leaseExpiresAt: null,
        },
      },
      { new: true, runValidators: true },
    );
  }

  /**
   * Releases a claimed job back to "queued" for a purely operational reason
   * (e.g. the worker's local disk is below its configured minimum free
   * space) — never a media/source problem. This is deliberately NOT
   * recordFailure(): it does not touch `lastErrorCode`/`lastErrorSummary`,
   * does not transition through "failed_retryable", and explicitly
   * decrements `attempts` by one to undo the increment claimNext() already
   * applied when this job was claimed, so the job's attempt count ends up
   * exactly where it would have been had this operational defer never
   * happened. A subsequent real claim increments it again to the same value
   * it would have reached without this detour — the three-attempt media
   * budget is never charged for a condition that has nothing to do with the
   * media itself.
   *
   * Guarded identically to recordFailure/markSuccess: `{_id,
   * status:"processing", leaseToken}`. A stale or replaced token cannot
   * invoke this, exactly like every other lease-guarded transition.
   */
  public async deferClaim(
    jobId: string,
    leaseToken: string,
    options: { retryDelayMs: number },
  ): Promise<ITranscodingJob | null> {
    const now = new Date();

    return TranscodingJobModel.findOneAndUpdate(
      { _id: jobId, status: "processing", leaseToken },
      {
        $set: {
          status: "queued",
          leaseToken: null,
          leaseExpiresAt: null,
          nextRetryAt: new Date(now.getTime() + options.retryDelayMs),
        },
        $inc: { attempts: -1 },
      },
      { new: true, runValidators: true },
    );
  }

  /**
   * Records that a completed job's verified output has been successfully
   * repointed onto its Moment media item. Guarded by status:"completed" only
   * (no lease token — Moment-sync happens after the job is already finished
   * and lease-released, so there is nothing left to hold). Safe to call
   * repeatedly: setting the same value twice is a no-op.
   */
  public async markMomentSynced(jobId: string): Promise<ITranscodingJob | null> {
    return TranscodingJobModel.findOneAndUpdate(
      { _id: jobId, status: "completed" },
      { $set: { momentSyncStatus: "synced" } },
      { new: true, runValidators: true },
    );
  }

  /**
   * Records that a completed job's Moment/media could not be repointed
   * because it no longer matches (deleted Moment, replaced media item) —
   * a terminal outcome for this job's sync attempt. Never retried
   * automatically; left for a later phase's orphan-output cleanup.
   */
  public async markMomentSyncStale(jobId: string): Promise<ITranscodingJob | null> {
    return TranscodingJobModel.findOneAndUpdate(
      { _id: jobId, status: "completed" },
      { $set: { momentSyncStatus: "stale" } },
      { new: true, runValidators: true },
    );
  }

  /**
   * Finds completed jobs whose Moment repoint is still outstanding —
   * `momentSyncStatus` unset (pre-Phase-3A document, treated the same as
   * "pending") or explicitly "pending". Used only for the worker's
   * startup finalization sweep, so a crash between markSuccess() and the
   * Moment-repoint write can never strand a finished transcode: on restart,
   * this query finds it and the worker finishes the repoint without
   * re-running FFmpeg. Deliberately excludes "stale" — that is a terminal
   * outcome for this job's sync, not something to keep retrying forever.
   */
  public async findCompletedPendingMomentSync(limit = 50): Promise<ITranscodingJob[]> {
    return TranscodingJobModel.find({
      status: "completed",
      momentSyncStatus: { $in: [null, "pending"] },
    }).limit(limit);
  }

  /**
   * Idempotent cancellation for a job whose Moment/media is deleted or no
   * longer relevant. Only queued/processing/failed_retryable jobs are actually
   * transitioned; a completed job is never destructively reset (the filter
   * simply excludes it, so the update matches nothing and the job's current
   * state is returned unchanged). Calling cancel on an already-cancelled job is
   * likewise a safe no-op that returns the existing cancelled document.
   */
  public async cancel(jobId: string, reason?: string | null): Promise<ITranscodingJob | null> {
    const now = new Date();

    const cancelled = await TranscodingJobModel.findOneAndUpdate(
      { _id: jobId, status: { $in: ACTIVE_STATUSES } },
      {
        $set: {
          status: "cancelled",
          cancelledAt: now,
          cancelReason: reason ? sanitizeErrorSummary(reason, 300) : null,
          leaseToken: null,
          leaseExpiresAt: null,
          nextRetryAt: null,
        },
      },
      { new: true, runValidators: true },
    );

    if (cancelled) {
      return cancelled;
    }

    return TranscodingJobModel.findById(jobId);
  }

  /**
   * Phase 3B2B: owner-authorized manual retry — atomically resets a
   * terminally `failed` job back to a fresh `queued` state, granting exactly
   * one more full processing budget (initial attempt + two automatic
   * retries), without ever creating a second job. Guarded by the exact
   * trusted identity triple (`momentId`, `sourceStorageKey`, `userId` — never
   * a client-supplied job id) plus `status:"failed"` and `leaseToken: null`.
   * The last two conditions are what makes this safe: `status:"failed"` is a
   * terminal state no other write path can produce a lease for (every
   * failure-transition method already clears `leaseToken` in the same atomic
   * write that sets `status:"failed"`), so requiring both is defense in
   * depth, not two independent guarantees — either one alone already implies
   * "no worker can currently be holding this job." A completed, cancelled,
   * queued, processing, or failed_retryable job can never match this filter,
   * so none of those can ever be revived or have attempts reset by this
   * method. `(momentId, sourceStorageKey)` is already a unique compound
   * index, so at most one document can ever match regardless of the extra
   * conditions.
   */
  public async resetFailedForManualRetry(
    momentId: string,
    sourceStorageKey: string,
    userId: string,
  ): Promise<ITranscodingJob | null> {
    return TranscodingJobModel.findOneAndUpdate(
      {
        momentId,
        sourceStorageKey,
        userId,
        status: "failed",
        leaseToken: null,
      },
      {
        $set: {
          status: "queued",
          attempts: 0,
          maxAttempts: TRANSCODING_JOB_MAX_ATTEMPTS,
          nextRetryAt: new Date(),
          failedAt: null,
          lastErrorCode: null,
          lastErrorSummary: null,
          leaseToken: null,
          leaseExpiresAt: null,
          claimedAt: null,
          startedAt: null,
        },
      },
      { new: true, runValidators: true },
    );
  }

  /**
   * Phase 3B2B compensation: if a manual retry's job reset succeeded but the
   * matching Moment media could not be reset to "queued" (deleted Moment,
   * replaced/mismatched media), this undoes the just-created claimable job —
   * but only while it is still in the *exact* state resetFailedForManualRetry
   * just left it: `status:"queued"`, `attempts:0`, no lease. If a worker has
   * already claimed it in the narrow window between the two writes (status
   * now "processing", attempts now 1, a real leaseToken set), this filter
   * cannot match, so the claim is left completely alone — compensation can
   * never cancel or fail a job another worker has already legitimately
   * picked up.
   */
  public async cancelUnclaimedManualRetry(jobId: string): Promise<ITranscodingJob | null> {
    return TranscodingJobModel.findOneAndUpdate(
      { _id: jobId, status: "queued", attempts: 0, leaseToken: null },
      {
        $set: {
          status: "cancelled",
          cancelledAt: new Date(),
          cancelReason: "manual retry could not be applied to Moment media",
          nextRetryAt: null,
        },
      },
      { new: true, runValidators: true },
    );
  }

  /**
   * Phase 3B2A: Moment-wide cancellation for a deleted Moment. Atomically
   * cancels every job belonging to the exact `momentId` that is still
   * active/retryable (`queued`, `processing`, or `failed_retryable`) — the
   * exact same transition as the single-job `cancel()` above (same
   * ACTIVE_STATUSES filter, same field resets), just applied Moment-wide in
   * one `updateMany` instead of one `findOneAndUpdate` per job, so this never
   * issues one query per media item. A `processing` job caught mid-flight is
   * cancelled exactly like any other active state: its `leaseToken` is
   * cleared, so the worker currently holding the old token will find its
   * next `renewLease()`/`markSuccess()`/`recordFailure()` call rejected (none
   * of those match a non-"processing" status) — no in-memory signal needed.
   * Idempotent: re-running against a Moment with no remaining active jobs
   * simply matches and modifies zero documents. Never touches a `completed`,
   * already-`cancelled`, or permanently-`failed` job — completed jobs are
   * handled separately by markCompletedPendingSyncStaleByMomentId below, and
   * a permanently-failed job is left exactly as `cancel()` already leaves it
   * (untouched — `failed` is not in ACTIVE_STATUSES and is already terminal
   * and unclaimable, so there is nothing further to change).
   */
  public async cancelActiveByMomentId(
    momentId: string,
    reason?: string | null,
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    const now = new Date();

    const result = await TranscodingJobModel.updateMany(
      { momentId, status: { $in: ACTIVE_STATUSES } },
      {
        $set: {
          status: "cancelled",
          cancelledAt: now,
          cancelReason: reason ? sanitizeErrorSummary(reason, 300) : null,
          leaseToken: null,
          leaseExpiresAt: null,
          nextRetryAt: null,
        },
      },
      { runValidators: true },
    );

    return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
  }

  /**
   * Phase 3B2A: for a deleted Moment, marks every one of its jobs that is
   * `status:"completed"` but still Moment-sync `momentSyncStatus` "pending"
   * (or unset) as `"stale"` — the exact same terminal outcome
   * finalizeCompletedJob() already reaches on its own the first time it
   * tries to repoint a Moment that no longer exists, just applied
   * immediately and explicitly at deletion time instead of waiting for that
   * job to eventually be swept. This is what keeps
   * findCompletedPendingMomentSync() (the startup finalization sweep) from
   * ever considering it again — that query explicitly excludes "stale".
   * Deliberately never touches a job whose momentSyncStatus is already
   * "synced": the Moment was already correctly repointed to the optimized
   * output before deletion, and that job's history should stay "synced", not
   * be rewritten to "stale". Optimized/thumbnail keys are never read or
   * modified here — orphan-output cleanup for a "stale" job is a later
   * phase's responsibility.
   */
  public async markCompletedPendingSyncStaleByMomentId(
    momentId: string,
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    const result = await TranscodingJobModel.updateMany(
      { momentId, status: "completed", momentSyncStatus: { $in: [null, "pending"] } },
      { $set: { momentSyncStatus: "stale" } },
      { runValidators: true },
    );

    return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
  }

  /** Explicit reset-to-pending for a completed job's cleanup lifecycle. */
  public async markCleanupPending(jobId: string): Promise<ITranscodingJob | null> {
    return TranscodingJobModel.findOneAndUpdate(
      { _id: jobId, status: "completed" },
      { $set: { cleanupStatus: "pending" } },
      { new: true, runValidators: true },
    );
  }

  /**
   * Phase 3B1: atomically claims exactly one due original-source cleanup
   * task. Only ever matches a job that is already `status:"completed"` and
   * `momentSyncStatus:"synced"` — cleanup never starts before Phase 3A has
   * verifiably repointed the Moment onto the optimized output. Eligible
   * cleanup state is "pending" (fresh, right after markSuccess()) or "failed"
   * with a due retry; a cleanup already at TRANSCODING_CLEANUP_MAX_ATTEMPTS is
   * excluded unconditionally, mirroring claimNext()'s own attempts ceiling.
   * The lease is entirely separate from the main processing lease (which is
   * already released by the time a job reaches "completed") — an unexpired
   * `cleanupLeaseExpiresAt` is what makes a second concurrent claim
   * impossible; an expired one (crashed cleanup worker) makes the job
   * reclaimable, exactly like stale-job recovery on the main claim.
   */
  public async claimNextCleanup(options: { leaseMs?: number } = {}): Promise<ITranscodingJob | null> {
    const now = new Date();
    const leaseMs = options.leaseMs ?? TRANSCODING_CLEANUP_DEFAULT_LEASE_MS;
    const cleanupLeaseToken = randomUUID();

    return TranscodingJobModel.findOneAndUpdate(
      {
        status: "completed",
        momentSyncStatus: "synced",
        cleanupAttempts: { $lt: TRANSCODING_CLEANUP_MAX_ATTEMPTS },
        $and: [
          {
            $or: [
              { cleanupStatus: "pending" },
              { cleanupStatus: "failed", cleanupNextRetryAt: { $ne: null, $lte: now } },
            ],
          },
          {
            $or: [
              { cleanupLeaseToken: null },
              { cleanupLeaseExpiresAt: { $lte: now } },
            ],
          },
        ],
      },
      {
        $set: {
          cleanupLeaseToken,
          cleanupLeaseExpiresAt: new Date(now.getTime() + leaseMs),
          cleanupClaimedAt: now,
        },
        $inc: { cleanupAttempts: 1 },
      },
      { new: true, sort: { cleanupNextRetryAt: 1, createdAt: 1 }, runValidators: true },
    );
  }

  /**
   * Records successful original-file deletion. Guarded by `{_id,
   * status:"completed", cleanupLeaseToken}` — exactly the same lease-token
   * discipline as every main-lease transition (renewLease/markSuccess/
   * recordFailure): a wrong or superseded token matches nothing and this
   * returns null, writing nothing. Never touches the main `status` field, so
   * a cleanup failure can never flip a successful transcode back to failed.
   */
  public async markCleanupCompleted(
    jobId: string,
    cleanupLeaseToken: string,
    originalDeletedAt: Date = new Date(),
  ): Promise<ITranscodingJob | null> {
    return TranscodingJobModel.findOneAndUpdate(
      { _id: jobId, status: "completed", cleanupLeaseToken },
      {
        $set: {
          cleanupStatus: "completed",
          originalDeletedAt,
          cleanupErrorCode: null,
          cleanupErrorSummary: null,
          cleanupNextRetryAt: null,
          cleanupLeaseToken: null,
          cleanupLeaseExpiresAt: null,
        },
      },
      { new: true, runValidators: true },
    );
  }

  /**
   * Records a failed cleanup attempt and, unless exhausted or forced
   * terminal, schedules a cleanup retry. Never touches `status`; a job that
   * reaches this method is, and remains, status:"completed" — only
   * cleanupStatus reflects the failure. Guarded identically to
   * markCleanupCompleted: `{_id, status:"completed", cleanupLeaseToken}`.
   *
   * A preliminary, non-mutating findOne reads the current `cleanupAttempts`
   * to decide retryable-vs-exhausted and compute backoff before the write —
   * safe for the same reason the analogous read in recordFailure() is safe:
   * nothing can change `cleanupAttempts` while this exact token is still held
   * (only claimNextCleanup() changes it, and always mints a new token when it
   * does), so the write can only ever commit while the read is still accurate.
   */
  public async markCleanupFailed(
    jobId: string,
    cleanupLeaseToken: string,
    payload: TranscodingCleanupFailurePayload,
  ): Promise<ITranscodingJob | null> {
    const current = await TranscodingJobModel.findOne({ _id: jobId, status: "completed", cleanupLeaseToken });

    if (!current) {
      return null;
    }

    const now = new Date();
    const sanitizedSummary = sanitizeErrorSummary(payload.errorSummary ?? payload.errorCode);
    const isExhausted = payload.forceTerminal === true || current.cleanupAttempts >= TRANSCODING_CLEANUP_MAX_ATTEMPTS;
    const retryDelayMs = payload.retryDelayMs ?? computeTranscodingJobRetryDelayMs(current.cleanupAttempts);

    return TranscodingJobModel.findOneAndUpdate(
      { _id: jobId, status: "completed", cleanupLeaseToken },
      {
        $set: {
          cleanupStatus: "failed",
          cleanupErrorCode: payload.errorCode,
          cleanupErrorSummary: sanitizedSummary,
          cleanupNextRetryAt: isExhausted ? null : new Date(now.getTime() + retryDelayMs),
          cleanupLeaseToken: null,
          cleanupLeaseExpiresAt: null,
        },
      },
      { new: true, runValidators: true },
    );
  }

  /**
   * Phase 3B3: atomically claims exactly one due orphan optimized-output/
   * thumbnail cleanup task. Only ever matches a job that is already
   * `status:"completed"` and `momentSyncStatus:"stale"` (Phase 3A's repoint
   * permanently failed to find a matching Moment/media — see
   * markMomentSyncStale/markCompletedPendingSyncStaleByMomentId) with both
   * verified output keys present. Eligible orphan-cleanup state is
   * "pending"/unset (never yet attempted), "processing" (a prior claim whose
   * lease has since expired — stale-worker recovery, exactly like
   * claimNext()'s own processing+expired-lease branch), or "failed" with a
   * due retry; "completed" and "blocked" never match any branch, so neither
   * can ever be claimed again. A job already at
   * TRANSCODING_ORPHAN_CLEANUP_MAX_ATTEMPTS is excluded unconditionally. The
   * lease is entirely separate from both the main processing lease and
   * Phase 3B1's original-source cleanup lease.
   */
  public async claimNextOrphanCleanup(options: { leaseMs?: number } = {}): Promise<ITranscodingJob | null> {
    const now = new Date();
    const leaseMs = options.leaseMs ?? TRANSCODING_ORPHAN_CLEANUP_DEFAULT_LEASE_MS;
    const orphanCleanupLeaseToken = randomUUID();

    return TranscodingJobModel.findOneAndUpdate(
      {
        status: "completed",
        momentSyncStatus: "stale",
        optimizedStorageKey: { $ne: null },
        thumbnailStorageKey: { $ne: null },
        orphanCleanupAttempts: { $lt: TRANSCODING_ORPHAN_CLEANUP_MAX_ATTEMPTS },
        $and: [
          {
            $or: [
              { orphanCleanupStatus: { $in: [null, "pending"] } },
              { orphanCleanupStatus: "failed", orphanCleanupNextRetryAt: { $ne: null, $lte: now } },
              { orphanCleanupStatus: "processing" },
            ],
          },
          {
            $or: [
              { orphanCleanupLeaseToken: null },
              { orphanCleanupLeaseExpiresAt: { $lte: now } },
            ],
          },
        ],
      },
      {
        $set: {
          orphanCleanupStatus: "processing",
          orphanCleanupLeaseToken,
          orphanCleanupLeaseExpiresAt: new Date(now.getTime() + leaseMs),
          orphanCleanupClaimedAt: now,
        },
        $inc: { orphanCleanupAttempts: 1 },
      },
      { new: true, sort: { orphanCleanupNextRetryAt: 1, createdAt: 1 }, runValidators: true },
    );
  }

  /**
   * Records successful orphan-output deletion (both objects deleted or
   * already missing). Guarded by the full expected state per Phase 3B3's
   * spec: exact job id, `status:"completed"`, `momentSyncStatus:"stale"`,
   * `orphanCleanupStatus:"processing"`, and the exact current lease token —
   * a wrong/superseded token, or a job no longer in this exact expected
   * state, matches nothing and this returns null.
   */
  public async markOrphanCleanupCompleted(
    jobId: string,
    orphanCleanupLeaseToken: string,
  ): Promise<ITranscodingJob | null> {
    const now = new Date();

    return TranscodingJobModel.findOneAndUpdate(
      {
        _id: jobId,
        status: "completed",
        momentSyncStatus: "stale",
        orphanCleanupStatus: "processing",
        orphanCleanupLeaseToken,
      },
      {
        $set: {
          orphanCleanupStatus: "completed",
          orphanCleanupCompletedAt: now,
          orphanCleanupErrorCode: null,
          orphanCleanupErrorSummary: null,
          orphanCleanupNextRetryAt: null,
          orphanCleanupLeaseToken: null,
          orphanCleanupLeaseExpiresAt: null,
        },
      },
      { new: true, runValidators: true },
    );
  }

  /**
   * Records a retryable orphan-cleanup failure (a genuine S3 delete error,
   * not a reference-safety block — see markOrphanCleanupBlocked below for
   * that) and, unless attempts are now exhausted, schedules a retry. Guarded
   * identically to markOrphanCleanupCompleted. The preliminary non-mutating
   * findOne is safe for the same reason the analogous reads in
   * recordFailure()/markCleanupFailed() are safe: nothing can change
   * `orphanCleanupAttempts` while this exact token is held.
   */
  public async markOrphanCleanupFailed(
    jobId: string,
    orphanCleanupLeaseToken: string,
    payload: TranscodingOrphanCleanupFailurePayload,
  ): Promise<ITranscodingJob | null> {
    const current = await TranscodingJobModel.findOne({
      _id: jobId,
      status: "completed",
      momentSyncStatus: "stale",
      orphanCleanupStatus: "processing",
      orphanCleanupLeaseToken,
    });

    if (!current) {
      return null;
    }

    const now = new Date();
    const sanitizedSummary = sanitizeErrorSummary(payload.errorSummary ?? payload.errorCode);
    const isExhausted = current.orphanCleanupAttempts >= TRANSCODING_ORPHAN_CLEANUP_MAX_ATTEMPTS;
    const retryDelayMs = payload.retryDelayMs ?? computeTranscodingJobRetryDelayMs(current.orphanCleanupAttempts);

    return TranscodingJobModel.findOneAndUpdate(
      {
        _id: jobId,
        status: "completed",
        momentSyncStatus: "stale",
        orphanCleanupStatus: "processing",
        orphanCleanupLeaseToken,
      },
      {
        $set: {
          orphanCleanupStatus: "failed",
          orphanCleanupErrorCode: payload.errorCode,
          orphanCleanupErrorSummary: sanitizedSummary,
          orphanCleanupNextRetryAt: isExhausted ? null : new Date(now.getTime() + retryDelayMs),
          orphanCleanupLeaseToken: null,
          orphanCleanupLeaseExpiresAt: null,
        },
      },
      { new: true, runValidators: true },
    );
  }

  /**
   * Records a terminal, never-automatically-retried "blocked" outcome — the
   * pre-delete reference check (or a structural safety invariant) proved
   * deleting would be unsafe. Deliberately a distinct status from "failed":
   * retrying a genuine S3 error can plausibly succeed, but retrying a
   * reference-safety block cannot change whether the object is referenced.
   * Guarded identically to the other two final transitions above. Output key
   * history is preserved (never cleared) for later investigation.
   */
  public async markOrphanCleanupBlocked(
    jobId: string,
    orphanCleanupLeaseToken: string,
    payload: TranscodingOrphanCleanupBlockedPayload,
  ): Promise<ITranscodingJob | null> {
    return TranscodingJobModel.findOneAndUpdate(
      {
        _id: jobId,
        status: "completed",
        momentSyncStatus: "stale",
        orphanCleanupStatus: "processing",
        orphanCleanupLeaseToken,
      },
      {
        $set: {
          orphanCleanupStatus: "blocked",
          orphanCleanupErrorCode: payload.errorCode,
          orphanCleanupErrorSummary: sanitizeErrorSummary(payload.errorSummary ?? payload.errorCode),
          orphanCleanupNextRetryAt: null,
          orphanCleanupLeaseToken: null,
          orphanCleanupLeaseExpiresAt: null,
        },
      },
      { new: true, runValidators: true },
    );
  }
}
