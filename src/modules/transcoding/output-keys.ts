const OPTIMIZED_VIDEO_PREFIX = "videos/optimized";
const THUMBNAIL_PREFIX = "videos/thumbnails";

const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

const assertSafeId = (label: string, value: string): void => {
  if (!SAFE_ID_PATTERN.test(value)) {
    throw new Error(`${label} must be a safe identifier (got an unsafe value)`);
  }
};

/**
 * Deterministic S3 key for a job's optimized output video. Deliberately
 * derived only from internal identity (owning user id + job id) — never the
 * user's original filename, never the source storage key. The same job
 * retried multiple times resolves to the exact same key every time, so a
 * retry overwrites the previous (incomplete/failed) attempt's object rather
 * than accumulating orphaned objects, while two different jobs can never
 * collide because job ids are unique.
 */
export const buildOptimizedVideoKey = (userId: string, jobId: string): string => {
  assertSafeId("userId", userId);
  assertSafeId("jobId", jobId);

  return `${OPTIMIZED_VIDEO_PREFIX}/${userId}/${jobId}.mp4`;
};

/** Same determinism/collision guarantees as buildOptimizedVideoKey, for the thumbnail. */
export const buildThumbnailKey = (userId: string, jobId: string): string => {
  assertSafeId("userId", userId);
  assertSafeId("jobId", jobId);

  return `${THUMBNAIL_PREFIX}/${userId}/${jobId}.jpg`;
};
