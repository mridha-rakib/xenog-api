// Dedicated video-transcoding worker entrypoint. Deliberately separate from
// src/server.ts — never imported by it, never started by the normal API
// `dev`/`start` scripts — so the API process is completely unaffected by this
// file's existence. This worker claims and processes TranscodingJob
// documents, synchronizes the exact matching Moment media item's processing
// lifecycle off that job's state (Phase 3A), and — only once a feed video
// post has been verifiably repointed to its optimized output — deletes the
// now-unused original source object (Phase 3B1). When a job's repoint went
// permanently stale (its feed video post or media item no longer exists), it
// also deletes that job's now-orphaned optimized video and thumbnail, but
// only after a fresh, system-wide check proves neither object is still
// referenced by any existing feed video post (Phase 3B3). It never creates
// jobs itself, and never repoints a feed video post to output that has not
// passed Phase 2's local + S3 verification.

import { access, mkdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { env } from "./config/env.js";
import { Database } from "./config/database.js";
import { logger } from "./core/logger/logger.js";
import { checkDiskCapacity, estimateJobDiskBudgetBytes } from "./modules/transcoding/disk-guard.js";
import { verifyFfmpegCapabilities } from "./modules/transcoding/ffmpeg-capabilities.js";
import { sweepStaleWorkspaces } from "./modules/transcoding/temp-workspace.js";
import { ensureTranscodingJobIndexes } from "./modules/transcoding/transcoding-job.model.js";
import { TranscodingCleanupService } from "./modules/transcoding/transcoding-cleanup.service.js";
import { TranscodingJobRepository } from "./modules/transcoding/transcoding-job.repository.js";
import { TranscodingMomentSyncService } from "./modules/transcoding/transcoding-moment-sync.service.js";
import { TranscodingOrphanCleanupService } from "./modules/transcoding/transcoding-orphan-cleanup.service.js";
import { processClaimedJob } from "./modules/transcoding/video-processor.js";
import { StorageService } from "./modules/storage/storage.service.js";

// A claimed job's lease is at most a few minutes (see
// TRANSCODING_JOB_DEFAULT_LEASE_MS); any workspace directory older than this
// is unambiguously orphaned (crashed worker, killed process), never one an
// active claim in this or any other worker still owns.
const STALE_WORKSPACE_MAX_AGE_MS = 60 * 60 * 1000;

let shuttingDown = false;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const ensureTempRootReady = async (): Promise<void> => {
  await mkdir(env.TRANSCODING_TMP_ROOT, { recursive: true, mode: 0o700 });
  await access(env.TRANSCODING_TMP_ROOT, fsConstants.W_OK);
};

const requestShutdown = (signal: NodeJS.Signals): void => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info({ signal }, "Video worker: shutdown requested — will stop claiming new jobs after the current one finishes");
};

/**
 * Sequential loop, worker concurrency exactly 1: per iteration, (1) finalize
 * any completed-but-unsynced job (Phase 3A crash recovery), (2) claim and
 * process at most one due original-source cleanup task (Phase 3B1), (3)
 * claim and process at most one due orphan optimized-output/thumbnail
 * cleanup task (Phase 3B3), then (4) claim and process at most one normal
 * transcoding job. Only sleeps (no busy loop) when (2), (3), and (4) all
 * found nothing to do — neither cleanup step waits on transcoding's disk
 * check, since deleting an S3 object needs no local temp disk at all.
 * `shuttingDown` is checked only between iterations — work already claimed
 * within an iteration always runs to completion (including its own cleanup/
 * workspace/Moment-media sync) rather than being abandoned mid-flight.
 */
const runWorkerLoop = async (
  repository: TranscodingJobRepository,
  storageService: StorageService,
  momentSyncService: TranscodingMomentSyncService,
  cleanupService: TranscodingCleanupService,
  orphanCleanupService: TranscodingOrphanCleanupService,
): Promise<void> => {
  while (!shuttingDown) {
    const finalizedCount = await momentSyncService.finalizePendingCompletedJobs();

    if (finalizedCount > 0) {
      logger.info({ finalizedCount }, "Video worker: finalized completed jobs left unsynchronized by a previous run");
    }

    const cleanupOutcome = await cleanupService.processNextCleanup();
    const orphanCleanupOutcome = await orphanCleanupService.processNextOrphanCleanup();
    const noCleanupWorkThisIteration = cleanupOutcome.outcome === "no_job" && orphanCleanupOutcome.outcome === "no_job";

    const requiredFreeBytes = env.TRANSCODING_MIN_FREE_DISK_BYTES + estimateJobDiskBudgetBytes(env.TRANSCODING_MAX_SOURCE_BYTES);
    const diskCheck = await checkDiskCapacity(env.TRANSCODING_TMP_ROOT, requiredFreeBytes);

    if (!diskCheck.ok) {
      logger.warn({ freeBytes: diskCheck.freeBytes, requiredFreeBytes }, "Video worker: insufficient disk capacity, backing off");

      if (noCleanupWorkThisIteration) {
        await sleep(env.TRANSCODING_DISK_BLOCKED_BACKOFF_MS);
      }
      continue;
    }

    const claimed = await repository.claimNext();

    if (!claimed) {
      if (noCleanupWorkThisIteration) {
        await sleep(env.TRANSCODING_POLL_INTERVAL_MS);
      }
      continue;
    }

    await momentSyncService.syncAfterClaim(claimed);

    const outcome = await processClaimedJob(claimed, claimed.leaseToken!, { repository, storageService });

    // A lease_lost outcome means another worker already reclaimed this job —
    // that worker owns the next Moment sync, not this one. Every other
    // outcome re-reads the job's own stored state (authoritative over the
    // in-memory outcome) to decide the matching Moment media transition.
    if (outcome.outcome !== "lease_lost") {
      await momentSyncService.syncAfterJobAttempt(claimed._id.toString());
    }
  }
};

const startWorker = async (): Promise<void> => {
  const capabilities = await verifyFfmpegCapabilities();

  if (!capabilities.ok) {
    logger.fatal(
      { problems: capabilities.problems },
      "Video worker: required FFmpeg/FFprobe capabilities are missing — refusing to start and claim jobs",
    );
    process.exit(1);
  }

  await ensureTempRootReady();
  await Database.connect();
  await ensureTranscodingJobIndexes();
  await sweepStaleWorkspaces(env.TRANSCODING_TMP_ROOT, STALE_WORKSPACE_MAX_AGE_MS);

  process.on("SIGTERM", () => requestShutdown("SIGTERM"));
  process.on("SIGINT", () => requestShutdown("SIGINT"));

  const repository = new TranscodingJobRepository();
  const storageService = new StorageService();
  const momentSyncService = new TranscodingMomentSyncService();
  const cleanupService = new TranscodingCleanupService();
  const orphanCleanupService = new TranscodingOrphanCleanupService();

  logger.info({ ffmpegVersion: capabilities.capabilities.ffmpegVersion }, "Video worker started");

  // Crash recovery (Phase 3A: finalize completed-but-unsynced jobs),
  // original-source cleanup (Phase 3B1), and orphan optimized-output/
  // thumbnail cleanup (Phase 3B3) all run at the top of every loop
  // iteration, not just at startup — see runWorkerLoop's doc comment.
  await runWorkerLoop(repository, storageService, momentSyncService, cleanupService, orphanCleanupService);

  await Database.disconnect();
  logger.info("Video worker stopped");
};

void startWorker().catch((error) => {
  logger.fatal({ error }, "Video worker crashed");
  process.exit(1);
});
