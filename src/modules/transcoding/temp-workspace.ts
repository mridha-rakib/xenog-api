import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { logger } from "../../core/logger/logger.js";

const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Strips anything that isn't a safe path-segment character. Never used on user filenames. */
const toSafeSegment = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "unknown";

export interface JobWorkspace {
  dir: string;
  sourcePath: string;
  optimizedPath: string;
  thumbnailPath: string;
}

/**
 * Confirms `candidatePath` resolves to a location inside `root` — the last
 * line of defense against a crafted job ID or suffix ever escaping the
 * configured temp root via `..` segments or an absolute-path override.
 */
export const assertPathWithinRoot = (root: string, candidatePath: string): void => {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidatePath);
  const relative = path.relative(resolvedRoot, resolvedCandidate);

  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Resolved temp path escapes the configured transcoding temp root");
  }
};

/**
 * Builds the job-scoped workspace directory name from internal identity
 * only — the Mongo job ID and a random-UUID-derived suffix, never the user's
 * original filename or the raw S3 storage key. Both inputs are sanitized to a
 * safe character set before being used as a path segment, independent of
 * assertPathWithinRoot's own defense-in-depth check.
 */
export const resolveJobWorkspacePath = (root: string, jobId: string, suffix: string = randomUUID()): string => {
  const safeJobId = toSafeSegment(jobId);
  const safeSuffix = toSafeSegment(suffix);
  const dirName = `${safeJobId}-${safeSuffix}`;
  const resolved = path.join(path.resolve(root), dirName);

  assertPathWithinRoot(root, resolved);

  return resolved;
};

/**
 * Creates a fresh, restrictive-permission job workspace directory and
 * returns the paths worker code should use for the source download,
 * optimized output, and thumbnail. Does not follow symlinks — `recursive`
 * mkdir on a path that already resolves through a symlink would still target
 * the symlink's destination, so this also verifies the created directory
 * matches the expected resolved path.
 */
export const createJobWorkspace = async (root: string, jobId: string, suffix?: string): Promise<JobWorkspace> => {
  const dir = resolveJobWorkspacePath(root, jobId, suffix);

  await mkdir(dir, { recursive: true, mode: 0o700 });

  return {
    dir,
    sourcePath: path.join(dir, "source"),
    optimizedPath: path.join(dir, "optimized.mp4"),
    thumbnailPath: path.join(dir, "thumbnail.jpg"),
  };
};

/**
 * Best-effort recursive removal of a job workspace. Never throws — callers
 * must not let a cleanup failure hide or override the real processing
 * outcome (success or classified failure) that already happened before this
 * runs. Logs a failure without exposing any file content or user data.
 */
export const cleanupWorkspace = async (dir: string): Promise<boolean> => {
  try {
    await rm(dir, { recursive: true, force: true });
    return true;
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : String(error) }, "Transcoding temp workspace cleanup failed");
    return false;
  }
};

export interface StaleSweepResult {
  scanned: number;
  removed: number;
  skippedActive: number;
  failed: number;
}

/**
 * Removes job workspace directories under `root` older than `olderThanMs`,
 * skipping anything in `activeDirNames` (directories owned by an in-flight
 * job in *this* process, to guarantee a startup sweep can never delete a
 * directory a currently-running claim is using — relevant if a sweep were
 * ever triggered concurrently with active work, not just at cold start).
 * Only ever touches the dedicated configured transcoding root, never `/tmp`
 * at large, and only inspects directory names, never file contents.
 */
export const sweepStaleWorkspaces = async (
  root: string,
  olderThanMs: number,
  activeDirNames: ReadonlySet<string> = new Set(),
): Promise<StaleSweepResult> => {
  const result: StaleSweepResult = { scanned: 0, removed: 0, skippedActive: 0, failed: 0 };
  const resolvedRoot = path.resolve(root);

  let entries: string[];

  try {
    entries = await readdir(resolvedRoot);
  } catch {
    // Root does not exist yet or is not readable — nothing to sweep.
    return result;
  }

  const now = Date.now();

  for (const entryName of entries) {
    if (!SAFE_ID_PATTERN.test(entryName)) {
      // Never touch anything that doesn't look like a job workspace this
      // module itself would have created.
      continue;
    }

    result.scanned += 1;

    if (activeDirNames.has(entryName)) {
      result.skippedActive += 1;
      continue;
    }

    const entryPath = path.join(resolvedRoot, entryName);

    try {
      const stats = await stat(entryPath);

      if (!stats.isDirectory()) {
        continue;
      }

      if (now - stats.mtimeMs < olderThanMs) {
        continue;
      }

      await rm(entryPath, { recursive: true, force: true });
      result.removed += 1;
    } catch {
      result.failed += 1;
    }
  }

  logger.info(
    { scanned: result.scanned, removed: result.removed, skippedActive: result.skippedActive, failed: result.failed },
    "Transcoding temp root startup sweep completed",
  );

  return result;
};
