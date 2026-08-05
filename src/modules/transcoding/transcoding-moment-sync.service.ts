import { logger } from "../../core/logger/logger.js";
import type { IMoment, MomentMediaProcessingErrorCode } from "../moments/moment.interface.js";
import { MomentMediaLifecycleService } from "../moments/moment-media-lifecycle.service.js";
import type { ITranscodingJob, TranscodingJobErrorCode } from "./transcoding-job.interface.js";
import { TranscodingJobRepository } from "./transcoding-job.repository.js";

const TRANSCODING_TO_MOMENT_ERROR_CODE: Record<TranscodingJobErrorCode, MomentMediaProcessingErrorCode> = {
  source_invalid: "source_invalid",
  source_too_large: "source_too_large",
  probe_failed: "unknown",
  download_failed: "storage_failed",
  encode_failed: "encode_failed",
  thumbnail_failed: "encode_failed",
  upload_failed: "storage_failed",
  verification_failed: "storage_failed",
  timeout: "timeout",
  worker_crashed: "unknown",
  // Cleanup (original-source deletion) failures never reach this mapping in
  // practice — cleanup never touches Moment media — but the map must stay
  // exhaustive over the shared TranscodingJobErrorCode enum regardless.
  delete_failed: "storage_failed",
  unknown: "unknown",
};

/** Maps the internal (closed) TranscodingJob error code to the safe, coarse, user-facing MomentMediaProcessingErrorCode. Never exposes the internal code or summary directly. */
export const mapTranscodingErrorCodeToMomentErrorCode = (code: TranscodingJobErrorCode): MomentMediaProcessingErrorCode =>
  TRANSCODING_TO_MOMENT_ERROR_CODE[code] ?? "unknown";

const DEFAULT_FINALIZATION_SWEEP_LIMIT = 50;

/**
 * The single orchestration point that knows about both TranscodingJob and
 * Moment: it drives every Moment media transition off TranscodingJob state,
 * using MomentMediaLifecycleService for the actual Moment writes. Used by
 * MomentService (to queue a new job at Moment-creation time) and by
 * src/video-worker.ts (to sync state around every claim/outcome, and to
 * finalize completed-but-unsynced jobs after a restart).
 */
export class TranscodingMomentSyncService {
  public constructor(
    private readonly transcodingJobRepository = new TranscodingJobRepository(),
    private readonly momentMediaLifecycleService = new MomentMediaLifecycleService(),
  ) {}

  /**
   * Creates (or idempotently retrieves) the TranscodingJob for one eligible
   * new video media item and marks it queued on the Moment. If job creation
   * itself fails (a genuine infrastructure error, not the ordinary path),
   * the media is instead marked failed/unknown rather than left silently
   * "processing" forever — the original upload and the Moment document are
   * never touched destructively either way.
   */
  public async queueNewVideoJob(params: {
    momentId: string;
    userId: string;
    sourceStorageKey: string;
    sourceContentType?: string | null;
  }): Promise<IMoment | null> {
    try {
      await this.transcodingJobRepository.createOrGet({
        momentId: params.momentId,
        userId: params.userId,
        sourceStorageKey: params.sourceStorageKey,
        sourceContentType: params.sourceContentType ?? null,
      });

      return await this.momentMediaLifecycleService.markQueued(params.momentId, params.sourceStorageKey);
    } catch (error) {
      logger.error(
        {
          momentId: params.momentId,
          error: error instanceof Error ? error.message : "unknown error",
        },
        "Failed to create transcoding job for a new Moment video — media left playable at its original upload",
      );

      return this.momentMediaLifecycleService.markFailed(params.momentId, params.sourceStorageKey, "unknown");
    }
  }

  /** Called immediately after a worker atomically claims a job — before Phase 2 processing starts. */
  public async syncAfterClaim(job: ITranscodingJob): Promise<void> {
    await this.momentMediaLifecycleService.markProcessing(job.momentId.toString(), job.sourceStorageKey);
  }

  /**
   * Called after `processClaimedJob()` returns, re-reading the job's stored
   * state (the database, not the in-memory outcome, is authoritative) and
   * applying the matching Moment media transition.
   */
  public async syncAfterJobAttempt(jobId: string): Promise<void> {
    const job = await this.transcodingJobRepository.findById(jobId);

    if (!job) {
      return;
    }

    switch (job.status) {
      case "completed":
        await this.finalizeCompletedJob(job);
        return;
      case "failed":
        await this.momentMediaLifecycleService.markFailed(
          job.momentId.toString(),
          job.sourceStorageKey,
          mapTranscodingErrorCodeToMomentErrorCode(job.lastErrorCode ?? "unknown"),
        );
        return;
      case "queued":
      case "failed_retryable":
        // Covers both a retryable failure (recordFailure) and an operational
        // disk-capacity defer (deferClaim) — both leave the job re-claimable
        // without having permanently failed.
        await this.momentMediaLifecycleService.markQueuedAgain(job.momentId.toString(), job.sourceStorageKey);
        return;
      case "processing":
        // Another worker already reclaimed this job (stale-lease race) — it
        // owns the next sync for this job, not this caller.
        return;
      case "cancelled":
        // Moment/media deletion flows own cancellation cleanup; no media
        // write belongs here.
        return;
    }
  }

  /**
   * The core idempotent repoint step for one completed job, shared by both
   * the main worker loop (right after a fresh success) and the startup
   * finalization sweep (crash recovery) — never re-runs FFmpeg, only writes
   * already-verified output metadata onto the Moment media item.
   */
  public async finalizeCompletedJob(job: ITranscodingJob): Promise<void> {
    const jobId = job._id.toString();

    if (!job.optimizedStorageKey || !job.thumbnailStorageKey) {
      // Should be unreachable: markSuccess() is only ever called after full
      // local + S3 output verification. Never repoint to an unverified or
      // missing output if this invariant were somehow violated.
      logger.error({ jobId }, "Completed transcoding job is missing verified output keys; refusing to repoint Moment media");
      return;
    }

    const updated = await this.momentMediaLifecycleService.markReady(job.momentId.toString(), job.sourceStorageKey, {
      optimizedStorageKey: job.optimizedStorageKey,
      thumbnailStorageKey: job.thumbnailStorageKey,
      width: job.outputWidth ?? null,
      height: job.outputHeight ?? null,
      fileSize: job.outputFileSize ?? null,
      durationSeconds: job.outputDurationSeconds ?? null,
    });

    if (!updated) {
      logger.warn({ jobId }, "Completed transcoding job's Moment/media no longer matches; marking Moment sync stale");
      await this.transcodingJobRepository.markMomentSyncStale(jobId);
      return;
    }

    await this.transcodingJobRepository.markMomentSynced(jobId);
  }

  /**
   * Startup crash-recovery sweep: finds every completed job whose verified
   * output has not yet been repointed onto its Moment (including one this
   * exact worker process completed but crashed before finalizing), and
   * finalizes each — without ever re-transcoding. Returns how many jobs were
   * swept, for logging.
   */
  public async finalizePendingCompletedJobs(limit: number = DEFAULT_FINALIZATION_SWEEP_LIMIT): Promise<number> {
    const pending = await this.transcodingJobRepository.findCompletedPendingMomentSync(limit);

    for (const job of pending) {
      await this.finalizeCompletedJob(job);
    }

    return pending.length;
  }

  /**
   * Phase 3B2A: called once a Moment has already been authorized and
   * successfully deleted (never before — see MomentService.deleteMoment()),
   * scoped strictly to that trusted server-side `momentId`, never a
   * client-supplied job id. Stops every active/retryable job dead (queued,
   * processing, failed_retryable → cancelled) and marks every completed
   * job still awaiting Moment-repoint as permanently stale, so the startup
   * finalization sweep can never later try to repoint a Moment that no
   * longer exists. Deliberately does nothing else: a completed+synced job's
   * verified output identities, and any already-completed cleanup, are left
   * exactly as they are — no S3 object is touched here, and none of the
   * existing Moment-deletion side effects (comments/reactions/shares/saves)
   * are duplicated or altered. Idempotent — safe to call again for the same
   * momentId (e.g. a defensive retry), and every write is scoped by
   * `momentId` alone, so it can never affect another Moment's jobs.
   */
  public async cancelForDeletedMoment(momentId: string): Promise<{ cancelledCount: number; staleCount: number }> {
    const [cancelResult, staleResult] = await Promise.all([
      this.transcodingJobRepository.cancelActiveByMomentId(momentId, "moment deleted"),
      this.transcodingJobRepository.markCompletedPendingSyncStaleByMomentId(momentId),
    ]);

    return { cancelledCount: cancelResult.modifiedCount, staleCount: staleResult.modifiedCount };
  }

  /**
   * Phase 3B2B: owner-authorized manual retry for one failed video media
   * item, identified by trusted server-side (momentId, sourceStorageKey,
   * userId) — never a client-supplied job id. Two separate MongoDB documents
   * must both end up consistent (job "queued", Moment media "queued");
   * without a shared transaction, this uses idempotent compensation instead:
   * if the job reset succeeds but the Moment write then fails to match
   * (deleted Moment, replaced/mismatched media — both effectively
   * unreachable in the current codebase, since no media-replacement flow
   * exists, but guarded regardless), the just-reset job is atomically
   * cancelled again — unless a worker has already claimed it in that narrow
   * window, in which case cancelUnclaimedManualRetry()'s own tighter guard
   * leaves it alone (see that method's doc comment).
   */
  public async retryFailedVideoProcessing(
    momentId: string,
    sourceStorageKey: string,
    userId: string,
  ): Promise<{ outcome: "retried"; moment: IMoment } | { outcome: "not_eligible" } | { outcome: "conflict" }> {
    const job = await this.transcodingJobRepository.resetFailedForManualRetry(momentId, sourceStorageKey, userId);

    if (!job) {
      return { outcome: "not_eligible" };
    }

    const moment = await this.momentMediaLifecycleService.markQueuedForRetry(momentId, sourceStorageKey);

    if (!moment) {
      await this.transcodingJobRepository.cancelUnclaimedManualRetry(job._id.toString());
      return { outcome: "conflict" };
    }

    return { outcome: "retried", moment };
  }
}
