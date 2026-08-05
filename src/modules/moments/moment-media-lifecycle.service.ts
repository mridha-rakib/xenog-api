import { MomentModel } from "./moment.model.js";
import type { IMoment, MomentMediaProcessingErrorCode } from "./moment.interface.js";

export interface ReadyMediaPayload {
  optimizedStorageKey: string;
  thumbnailStorageKey: string;
  width: number | null;
  height: number | null;
  fileSize: number | null;
  durationSeconds: number | null;
}

const LOGICAL_QUERY_OPERATORS = new Set(["$or", "$and", "$nor"]);

/**
 * Rewrites a plain-field media condition (e.g. `{ storageKey: x }`, or
 * `{ $or: [...] }` of such conditions) into its `elem.`-prefixed form for use
 * inside `arrayFilters`, recursing through logical operators so nested
 * conditions are prefixed too.
 */
const toArrayFilterCondition = (condition: Record<string, unknown>, prefix = "elem."): Record<string, unknown> => {
  const prefixed: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(condition)) {
    if (LOGICAL_QUERY_OPERATORS.has(key) && Array.isArray(value)) {
      prefixed[key] = value.map((sub) => toArrayFilterCondition(sub as Record<string, unknown>, prefix));
    } else {
      prefixed[`${prefix}${key}`] = value;
    }
  }

  return prefixed;
};

/**
 * The only backend service that writes to a Moment media item's video
 * processing lifecycle fields (processingStatus, thumbnailStorageKey, width,
 * height, fileSize, processedAt, processingErrorCode). Every method here
 * identifies the exact media item by (momentId, storageKey) via a Mongoose
 * `arrayFilters` update — never a positional-array scan the caller has to
 * get right itself — so a Moment with several media items (video and
 * otherwise) can never have the wrong one mutated.
 *
 * Deliberately knows nothing about TranscodingJob: callers (MomentService for
 * the initial queue, the transcoding-side sync orchestrator for every later
 * transition) pass in plain values. This keeps the dependency direction
 * one-way — moments/ never imports from transcoding/ — even though
 * transcoding/ imports this service.
 */
export class MomentMediaLifecycleService {
  /**
   * Queued: set once, right after an eligible video media item's
   * TranscodingJob has been created/retrieved. Guarded so it can never
   * clobber a media item already further along (processing/ready/failed) —
   * relevant if this were ever called twice for the same media item, even
   * though the create-Moment flow only calls it once per fresh item.
   */
  public async markQueued(momentId: string, sourceStorageKey: string): Promise<IMoment | null> {
    return this.updateMatchingMedia(
      momentId,
      { storageKey: sourceStorageKey, processingStatus: { $in: [null, "queued"] } },
      { processingStatus: "queued" },
    );
  }

  /**
   * Processing: set the instant a worker atomically claims the job. Only
   * matches while the media item still points at the original source key and
   * has not already reached "ready" — never overwrites a finished result.
   */
  public async markProcessing(momentId: string, sourceStorageKey: string): Promise<IMoment | null> {
    return this.updateMatchingMedia(
      momentId,
      { storageKey: sourceStorageKey, processingStatus: { $ne: "ready" } },
      { processingStatus: "processing" },
    );
  }

  /**
   * Retryable failure or an operational disk defer: the job is not done, but
   * it is not permanently failed either — return the media to "queued" so
   * the client sees the same state it would have seen before this attempt
   * started. Never touches a "ready" item.
   */
  public async markQueuedAgain(momentId: string, sourceStorageKey: string): Promise<IMoment | null> {
    return this.updateMatchingMedia(
      momentId,
      { storageKey: sourceStorageKey, processingStatus: { $ne: "ready" } },
      { processingStatus: "queued" },
    );
  }

  /**
   * Permanent source failure or attempts exhausted: terminal, user-facing
   * "failed" with only a safe coarse error code — never the internal
   * TranscodingJob error summary. The original storageKey is left completely
   * untouched, so existing clients can keep playing the original upload.
   */
  public async markFailed(
    momentId: string,
    sourceStorageKey: string,
    errorCode: MomentMediaProcessingErrorCode,
  ): Promise<IMoment | null> {
    return this.updateMatchingMedia(
      momentId,
      { storageKey: sourceStorageKey, processingStatus: { $ne: "ready" } },
      { processingStatus: "failed", processingErrorCode: errorCode },
    );
  }

  /**
   * Phase 3B2B manual retry: moves a terminally FAILED video media item back
   * to "queued" and clears its processingErrorCode. Guarded strictly on
   * `processingStatus:"failed"` — deliberately tighter than markQueuedAgain()
   * above (which permits any non-"ready" status, since that method only ever
   * runs during the automatic retry path, where the media is never "failed"
   * yet). That tighter guard is what makes this safe: it can never
   * accidentally reset an already-queued or already-processing item's error
   * code, and — like every method here — it can never touch a "ready" item.
   * The original storageKey is left completely untouched (not part of the
   * `$set`), and no optimized/thumbnail/processedAt field is written.
   */
  public async markQueuedForRetry(momentId: string, sourceStorageKey: string): Promise<IMoment | null> {
    return this.updateMatchingMedia(
      momentId,
      { storageKey: sourceStorageKey, processingStatus: "failed" },
      { processingStatus: "queued", processingErrorCode: null },
    );
  }

  /**
   * Ready: the atomic, idempotent optimized-output repoint. Matches either
   * (A) the media item still points at the original source key — the first,
   * real finalization — or (B) it already points at the optimized key and is
   * already "ready" — a repeated finalization call (crash-recovery retry,
   * or two workers racing on the same completed job), which must succeed as
   * a no-op rather than error or double-apply. Any other current state (a
   * different/replaced media item, or a deleted Moment) matches neither
   * branch, so the update matches nothing and this returns null — the caller
   * must treat that as "stale," never as "retry harder."
   */
  public async markReady(
    momentId: string,
    sourceStorageKey: string,
    payload: ReadyMediaPayload,
  ): Promise<IMoment | null> {
    return this.updateMatchingMedia(
      momentId,
      {
        $or: [
          { storageKey: sourceStorageKey },
          { storageKey: payload.optimizedStorageKey, processingStatus: "ready" },
        ],
      },
      {
        storageKey: payload.optimizedStorageKey,
        thumbnailStorageKey: payload.thumbnailStorageKey,
        processingStatus: "ready",
        width: payload.width,
        height: payload.height,
        fileSize: payload.fileSize,
        durationSeconds: payload.durationSeconds,
        processedAt: new Date(),
        processingErrorCode: null,
      },
    );
  }

  /**
   * Phase 3B1 pre-delete revalidation: a read-only, fresh-from-the-database
   * proof that the exact Moment media item currently points at
   * `optimizedStorageKey` and is `processingStatus:"ready"` — used
   * immediately before deleting an original source object, so that decision
   * never rests on `momentSyncStatus`, an in-memory Moment object, or any
   * other previously-cached state. Deliberately a plain existence check
   * (never a mutation) — the caller decides what to do with the answer.
   */
  public async isMediaReadyAtOptimizedKey(momentId: string, optimizedStorageKey: string): Promise<boolean> {
    const match = await MomentModel.exists({
      _id: momentId,
      mediaItems: { $elemMatch: { storageKey: optimizedStorageKey, processingStatus: "ready" } },
    });

    return match !== null;
  }

  /**
   * Phase 3B3 pre-delete reference safety: a read-only, fresh-from-the-
   * database, *system-wide* check — deliberately never scoped to a single
   * momentId — for whether `storageKey` is the current playable reference on
   * any existing feed video post at all. Used immediately before deleting an
   * optimized-output object left behind by a permanently stale transcoding
   * job, so an object that (however unexpectedly) is still serving some
   * other feed video post can never be deleted just because its own
   * originating Moment is gone or unrelated.
   */
  public async isStorageKeyReferencedByAnyMoment(storageKey: string): Promise<boolean> {
    const match = await MomentModel.exists({ "mediaItems.storageKey": storageKey });
    return match !== null;
  }

  /** Same system-wide safety guarantee as isStorageKeyReferencedByAnyMoment above, for the thumbnailStorageKey field specifically. */
  public async isThumbnailStorageKeyReferencedByAnyMoment(thumbnailStorageKey: string): Promise<boolean> {
    const match = await MomentModel.exists({ "mediaItems.thumbnailStorageKey": thumbnailStorageKey });
    return match !== null;
  }

  /**
   * `arrayFilters` alone only decides which array element a `$[elem]` update
   * path targets — it does NOT gate whether the operation matches at all: if
   * `_id` matches but no array element satisfies the filter, MongoDB still
   * reports the document as matched (just unmodified), so `findOneAndUpdate`
   * would return the unchanged document instead of null. To get a genuine
   * "stale/missing" `null` result when no media item qualifies, the identical
   * condition is also asserted at the top level via `mediaItems: $elemMatch`,
   * so the whole query — not just the update target — fails to match.
   */
  private async updateMatchingMedia(
    momentId: string,
    condition: Record<string, unknown>,
    setFields: Record<string, unknown>,
  ): Promise<IMoment | null> {
    const positionalSet = Object.fromEntries(
      Object.entries(setFields).map(([key, value]) => [`mediaItems.$[elem].${key}`, value]),
    );

    return MomentModel.findOneAndUpdate(
      { _id: momentId, mediaItems: { $elemMatch: condition } },
      { $set: positionalSet },
      { arrayFilters: [toArrayFilterCondition(condition)], new: true, runValidators: true },
    );
  }
}
