import { logger } from "../../core/logger/logger.js";
import { StorageService } from "../storage/storage.service.js";
import { MomentMediaLifecycleService } from "../moments/moment-media-lifecycle.service.js";
import { isMissingObjectError } from "./source-downloader.js";
import type { ITranscodingJob } from "./transcoding-job.interface.js";
import { TranscodingJobRepository } from "./transcoding-job.repository.js";

export type OrphanCleanupOutcome =
  | { outcome: "no_job" }
  | { outcome: "completed"; jobId: string }
  | { outcome: "retrying"; jobId: string }
  | { outcome: "blocked"; jobId: string };

/**
 * Phase 3B3: deletes the optimized video and thumbnail produced for a
 * transcoding job whose Moment repoint went permanently stale (its feed
 * video post — or the exact media item — no longer exists), once a fresh,
 * system-wide check proves neither object is still the current reference on
 * any existing feed video post. Never deletes `sourceStorageKey` — original
 * deletion is Phase 3B1's separate, unrelated concern and is not touched
 * here. Every eligibility condition from claimNextOrphanCleanup()'s atomic
 * claim query is re-proven here, immediately before the destructive S3
 * calls, against fresh reads — never trusting `momentSyncStatus`, an
 * in-memory job/Moment object, or a previous worker's result.
 */
export class TranscodingOrphanCleanupService {
  public constructor(
    private readonly transcodingJobRepository = new TranscodingJobRepository(),
    private readonly momentMediaLifecycleService = new MomentMediaLifecycleService(),
    private readonly storageService: Pick<StorageService, "deleteObject"> = new StorageService(),
  ) {}

  /** Claims and processes at most one due orphan-cleanup task. Returns `{outcome:"no_job"}` when nothing is due — the caller decides whether to sleep. */
  public async processNextOrphanCleanup(): Promise<OrphanCleanupOutcome> {
    const job = await this.transcodingJobRepository.claimNextOrphanCleanup();

    if (!job || !job.orphanCleanupLeaseToken) {
      return { outcome: "no_job" };
    }

    return this.processClaimedOrphanCleanup(job);
  }

  /** Exposed separately so tests can drive a specific already-claimed job deterministically. */
  public async processClaimedOrphanCleanup(job: ITranscodingJob): Promise<OrphanCleanupOutcome> {
    const jobId = job._id.toString();
    const leaseToken = job.orphanCleanupLeaseToken;

    if (!leaseToken) {
      return { outcome: "no_job" };
    }

    // Structural safety invariants, never trusted blindly before a
    // destructive call — see claimNextOrphanCleanup()'s doc comment for why
    // these are expected to be unreachable in normal operation.
    if (!job.optimizedStorageKey || !job.thumbnailStorageKey) {
      await this.transcodingJobRepository.markOrphanCleanupBlocked(jobId, leaseToken, {
        errorCode: "verification_failed",
        errorSummary: "orphan cleanup claimed without verified output keys",
      });
      logger.error({ jobId }, "Orphan cleanup claimed a job with missing verified output keys; refusing to delete");
      return { outcome: "blocked", jobId };
    }

    if (job.optimizedStorageKey === job.sourceStorageKey) {
      await this.transcodingJobRepository.markOrphanCleanupBlocked(jobId, leaseToken, {
        errorCode: "verification_failed",
        errorSummary: "optimized and source storage keys were unexpectedly equal",
      });
      logger.error({ jobId }, "Orphan cleanup found optimized and source storage keys unexpectedly equal; refusing to delete");
      return { outcome: "blocked", jobId };
    }

    // Fresh, system-wide reference check — never restricted to job.momentId,
    // and never based on momentSyncStatus/any cached state. Both keys are
    // checked independently so either one alone is enough to block deletion
    // of *both* objects (a job's optimized video and thumbnail are always
    // deleted or preserved together).
    const [optimizedReferenced, thumbnailReferenced] = await Promise.all([
      this.momentMediaLifecycleService.isStorageKeyReferencedByAnyMoment(job.optimizedStorageKey),
      this.momentMediaLifecycleService.isThumbnailStorageKeyReferencedByAnyMoment(job.thumbnailStorageKey),
    ]);

    if (optimizedReferenced || thumbnailReferenced) {
      await this.transcodingJobRepository.markOrphanCleanupBlocked(jobId, leaseToken, {
        errorCode: "verification_failed",
        errorSummary: "optimized output or thumbnail is still referenced by an existing feed video post",
      });
      logger.warn({ jobId }, "Orphan cleanup pre-delete reference check found an active reference; outputs left untouched");
      return { outcome: "blocked", jobId };
    }

    const deleteIfPresent = async (key: string): Promise<{ ok: true } | { ok: false; error: unknown }> => {
      try {
        await this.storageService.deleteObject(key);
        return { ok: true };
      } catch (error) {
        if (isMissingObjectError(error)) {
          // Already gone — a previous partial delete before a crash, or an
          // external/manual removal. Idempotent success either way.
          return { ok: true };
        }
        return { ok: false, error };
      }
    };

    const [optimizedResult, thumbnailResult] = await Promise.all([
      deleteIfPresent(job.optimizedStorageKey),
      deleteIfPresent(job.thumbnailStorageKey),
    ]);

    if (!optimizedResult.ok || !thumbnailResult.ok) {
      const failure = !optimizedResult.ok ? optimizedResult : thumbnailResult;
      await this.transcodingJobRepository.markOrphanCleanupFailed(jobId, leaseToken, {
        errorCode: "delete_failed",
        errorSummary: failure.ok === false && failure.error instanceof Error ? failure.error.message : "unknown orphan cleanup delete error",
      });
      logger.warn({ jobId }, "Orphan cleanup delete failed; retry scheduled");
      return { outcome: "retrying", jobId };
    }

    await this.transcodingJobRepository.markOrphanCleanupCompleted(jobId, leaseToken);
    return { outcome: "completed", jobId };
  }
}
