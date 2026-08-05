import { logger } from "../../core/logger/logger.js";
import { StorageService } from "../storage/storage.service.js";
import { MomentMediaLifecycleService } from "../moments/moment-media-lifecycle.service.js";
import { isMissingObjectError } from "./source-downloader.js";
import type { ITranscodingJob } from "./transcoding-job.interface.js";
import { TranscodingJobRepository } from "./transcoding-job.repository.js";

export type CleanupOutcome =
  | { outcome: "no_job" }
  | { outcome: "completed"; jobId: string }
  | { outcome: "retrying"; jobId: string }
  | { outcome: "permanent_failure"; jobId: string };

/**
 * Phase 3B1: deletes exactly one original-source S3 object per call, only
 * once Phase 3A has verifiably repointed the owning Moment onto the
 * optimized output. Every eligibility condition from claimNextCleanup()'s
 * atomic claim query is re-proven here, immediately before the destructive
 * S3 call, against a fresh read — never trusting `momentSyncStatus`, an
 * in-memory job/Moment object, or a previous worker's result.
 */
export class TranscodingCleanupService {
  public constructor(
    private readonly transcodingJobRepository = new TranscodingJobRepository(),
    private readonly momentMediaLifecycleService = new MomentMediaLifecycleService(),
    private readonly storageService: Pick<StorageService, "deleteObject"> = new StorageService(),
  ) {}

  /** Claims and processes at most one due cleanup task. Returns `{outcome:"no_job"}` when nothing is due — the caller decides whether to sleep. */
  public async processNextCleanup(): Promise<CleanupOutcome> {
    const job = await this.transcodingJobRepository.claimNextCleanup();

    if (!job || !job.cleanupLeaseToken) {
      return { outcome: "no_job" };
    }

    return this.processClaimedCleanup(job);
  }

  /** Exposed separately so tests can drive a specific already-claimed job deterministically. */
  public async processClaimedCleanup(job: ITranscodingJob): Promise<CleanupOutcome> {
    const jobId = job._id.toString();
    const leaseToken = job.cleanupLeaseToken;

    if (!leaseToken) {
      return { outcome: "no_job" };
    }

    // Structural safety invariants — see claimNextCleanup()'s doc comment.
    // Unreachable in normal operation (markSuccess() always sets both output
    // keys before momentSyncStatus can ever become "synced", and the two key
    // namespaces can never collide), but never trusted blindly before a
    // destructive call.
    if (!job.optimizedStorageKey || !job.thumbnailStorageKey) {
      await this.transcodingJobRepository.markCleanupFailed(jobId, leaseToken, {
        errorCode: "verification_failed",
        errorSummary: "cleanup claimed without verified output keys",
        forceTerminal: true,
      });
      logger.error({ jobId }, "Cleanup claimed a job with missing verified output keys; refusing to delete original");
      return { outcome: "permanent_failure", jobId };
    }

    if (job.sourceStorageKey === job.optimizedStorageKey) {
      await this.transcodingJobRepository.markCleanupFailed(jobId, leaseToken, {
        errorCode: "verification_failed",
        errorSummary: "source and optimized storage keys were unexpectedly equal",
        forceTerminal: true,
      });
      logger.error({ jobId }, "Cleanup found source and optimized storage keys unexpectedly equal; refusing to delete");
      return { outcome: "permanent_failure", jobId };
    }

    const revalidated = await this.momentMediaLifecycleService.isMediaReadyAtOptimizedKey(
      job.momentId.toString(),
      job.optimizedStorageKey,
    );

    if (!revalidated) {
      await this.transcodingJobRepository.markCleanupFailed(jobId, leaseToken, {
        errorCode: "verification_failed",
        errorSummary: "Moment media no longer verifiably points at this job's optimized output",
        forceTerminal: true,
      });
      logger.warn({ jobId }, "Cleanup pre-delete revalidation failed; original left untouched, cleanup marked terminal");
      return { outcome: "permanent_failure", jobId };
    }

    try {
      await this.storageService.deleteObject(job.sourceStorageKey);
    } catch (error) {
      if (isMissingObjectError(error)) {
        // Already gone — a previous delete that crashed before the DB write,
        // or an external/manual removal. Idempotent success either way.
        await this.transcodingJobRepository.markCleanupCompleted(jobId, leaseToken);
        return { outcome: "completed", jobId };
      }

      await this.transcodingJobRepository.markCleanupFailed(jobId, leaseToken, {
        errorCode: "delete_failed",
        errorSummary: error instanceof Error ? error.message : "unknown cleanup delete error",
      });
      logger.warn({ jobId }, "Cleanup delete failed; retry scheduled");
      return { outcome: "retrying", jobId };
    }

    await this.transcodingJobRepository.markCleanupCompleted(jobId, leaseToken);
    return { outcome: "completed", jobId };
  }
}
