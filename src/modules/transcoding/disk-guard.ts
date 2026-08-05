import { statfs } from "node:fs/promises";

export interface DiskCapacityResult {
  ok: boolean;
  freeBytes: number | null;
  totalBytes: number | null;
  error?: string;
}

/**
 * Checks free disk space on the filesystem containing `rootPath` using
 * Node's built-in `fs.promises.statfs()` — no new dependency. `bavail` (not
 * `bfree`) is used for free bytes: it is space available to an unprivileged
 * process, which is the number that actually matters for "can this worker,
 * running as a non-root user, write this many more bytes."
 */
export const checkDiskCapacity = async (rootPath: string, minFreeBytes: number): Promise<DiskCapacityResult> => {
  try {
    const stats = await statfs(rootPath);
    const freeBytes = stats.bavail * stats.bsize;
    const totalBytes = stats.blocks * stats.bsize;

    return { ok: freeBytes >= minFreeBytes, freeBytes, totalBytes };
  } catch (error) {
    return {
      ok: false,
      freeBytes: null,
      totalBytes: null,
      error: error instanceof Error ? error.message : "unknown statfs error",
    };
  }
};

/**
 * Conservative worst-case local temp-disk budget for one job: the downloaded
 * source (bounded by env.TRANSCODING_MAX_SOURCE_BYTES), the optimized output
 * (assumed up to the same order of magnitude as the source, since a
 * pathological input could compress poorly), one extra full copy of the
 * optimized output as fast-start rewrite headroom, and a small thumbnail —
 * see the Phase 0 audit's disk-budget analysis for the reasoning.
 */
export const estimateJobDiskBudgetBytes = (maxSourceBytes: number): number => (
  maxSourceBytes // downloaded source
  + maxSourceBytes // optimized output, conservatively
  + maxSourceBytes // fast-start rewrite headroom
  + 2 * 1024 * 1024 // thumbnail + logs/metadata, generous flat allowance
);

/**
 * Tracks disk-guard state across repeated polls so the worker logs only on a
 * state transition (blocked <-> recovered) or at a bounded rate while still
 * blocked — never once per poll, which would spam logs during an extended
 * capacity shortage. `nowMs` is an explicit parameter (not read internally)
 * so this is deterministically testable with a fake clock.
 */
export class DiskGuardLogGate {
  private lastKnownBlocked: boolean | null = null;
  private lastLoggedAtMs: number | null = null;

  public constructor(private readonly rateLimitMs: number) {}

  public shouldLog(isBlockedNow: boolean, nowMs: number): boolean {
    const transitioned = this.lastKnownBlocked !== null && this.lastKnownBlocked !== isBlockedNow;
    const firstBlockedObservation = this.lastKnownBlocked === null && isBlockedNow;
    const rateLimitElapsed = this.lastLoggedAtMs === null || (nowMs - this.lastLoggedAtMs) >= this.rateLimitMs;
    const shouldLog = transitioned || firstBlockedObservation || (isBlockedNow && rateLimitElapsed);

    this.lastKnownBlocked = isBlockedNow;

    if (shouldLog) {
      this.lastLoggedAtMs = nowMs;
    }

    return shouldLog;
  }

  public get isCurrentlyBlocked(): boolean {
    return this.lastKnownBlocked === true;
  }
}
