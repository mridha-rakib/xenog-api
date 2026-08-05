import { Schema, model } from "mongoose";
import type { ITranscodingJob } from "./transcoding-job.interface.js";
import {
  TRANSCODING_JOB_MAX_ATTEMPTS,
  transcodingJobCleanupStatuses,
  transcodingJobErrorCodes,
  transcodingJobMomentSyncStatuses,
  transcodingJobOrphanCleanupStatuses,
  transcodingJobStatuses,
} from "./transcoding-job.interface.js";

const transcodingJobSchema = new Schema<ITranscodingJob>(
  {
    momentId: {
      type: Schema.Types.ObjectId,
      ref: "Moment",
      required: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    sourceStorageKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 300,
    },
    sourceContentType: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null,
    },

    status: {
      type: String,
      enum: transcodingJobStatuses,
      required: true,
      default: "queued",
      index: true,
    },
    attempts: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    maxAttempts: {
      type: Number,
      required: true,
      min: 1,
      default: TRANSCODING_JOB_MAX_ATTEMPTS,
    },
    nextRetryAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    lastErrorCode: {
      type: String,
      enum: transcodingJobErrorCodes,
      default: null,
    },
    lastErrorSummary: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },

    leaseToken: {
      type: String,
      default: null,
    },
    leaseExpiresAt: {
      type: Date,
      default: null,
      index: true,
    },
    claimedAt: {
      type: Date,
      default: null,
    },
    startedAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    failedAt: {
      type: Date,
      default: null,
    },
    cancelledAt: {
      type: Date,
      default: null,
    },
    cancelReason: {
      type: String,
      trim: true,
      maxlength: 300,
      default: null,
    },

    optimizedStorageKey: {
      type: String,
      trim: true,
      maxlength: 300,
      default: null,
    },
    thumbnailStorageKey: {
      type: String,
      trim: true,
      maxlength: 300,
      default: null,
    },
    outputWidth: {
      type: Number,
      min: 0,
      default: null,
    },
    outputHeight: {
      type: Number,
      min: 0,
      default: null,
    },
    outputFileSize: {
      type: Number,
      min: 0,
      default: null,
    },
    outputDurationSeconds: {
      type: Number,
      min: 0,
      default: null,
    },

    cleanupStatus: {
      type: String,
      enum: transcodingJobCleanupStatuses,
      default: null,
    },
    originalDeletedAt: {
      type: Date,
      default: null,
    },
    cleanupErrorCode: {
      type: String,
      enum: transcodingJobErrorCodes,
      default: null,
    },
    cleanupErrorSummary: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },
    cleanupAttempts: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    cleanupNextRetryAt: {
      type: Date,
      default: null,
    },
    // Phase 3B1: cleanup's own lease — see ITranscodingJob's comment. Given
    // defaults (unlike momentSyncStatus below), matching the convention
    // already used for cleanupAttempts/cleanupNextRetryAt above, since these
    // are genuinely analogous lease fields to leaseToken/leaseExpiresAt/
    // claimedAt (which are also defaulted), not a new phase-boundary marker.
    cleanupLeaseToken: {
      type: String,
      default: null,
    },
    cleanupLeaseExpiresAt: {
      type: Date,
      default: null,
    },
    cleanupClaimedAt: {
      type: Date,
      default: null,
    },

    // Phase 3A. No `default`, matching the convention already used above for
    // Phase-1/2 additive fields: a document from before this field existed
    // simply omits the key rather than gaining an implicit value.
    momentSyncStatus: {
      type: String,
      enum: transcodingJobMomentSyncStatuses,
    },

    // Phase 3B3: orphan optimized-video/thumbnail cleanup. Given defaults —
    // matching the convention already used for cleanupAttempts/
    // cleanupLeaseToken/etc. above (genuine counters/lease fields, not a new
    // phase-boundary marker like momentSyncStatus just above).
    orphanCleanupStatus: {
      type: String,
      enum: transcodingJobOrphanCleanupStatuses,
      default: null,
    },
    orphanCleanupAttempts: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    orphanCleanupNextRetryAt: {
      type: Date,
      default: null,
    },
    orphanCleanupLeaseToken: {
      type: String,
      default: null,
    },
    orphanCleanupLeaseExpiresAt: {
      type: Date,
      default: null,
    },
    orphanCleanupClaimedAt: {
      type: Date,
      default: null,
    },
    orphanCleanupCompletedAt: {
      type: Date,
      default: null,
    },
    orphanCleanupErrorCode: {
      type: String,
      enum: transcodingJobErrorCodes,
      default: null,
    },
    orphanCleanupErrorSummary: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// Claim query: due queued/retryable jobs, or processing jobs whose lease has
// expired (stale-job recovery). Mirrors the proven shape of
// refundReceiptSchema.index({ status: 1, nextRetryAt: 1, lockedAt: 1 }) and
// eventCancellationRefundSchema.index({ status: 1, nextRetryAt: 1, lockExpiresAt: 1 })
// in src/modules/payments, adapted to this model's lease field name.
transcodingJobSchema.index({ status: 1, nextRetryAt: 1, leaseExpiresAt: 1 });

// Idempotency + Moment-scoped lookups. sourceStorageKey is already
// globally-unique per upload, so at most one job should ever exist per
// (momentId, sourceStorageKey) for that upload's entire lifecycle — a manual
// retry (future phase) resets this same document rather than inserting a new
// one, so a full (non-partial) unique index is correct here, unlike indexes
// that must tolerate multiple historical rows for the same logical entity.
// This compound index's momentId-prefix also serves plain momentId lookups
// (e.g. future cancel-jobs-for-a-deleted-moment sweeps) without a separate index.
transcodingJobSchema.index({ momentId: 1, sourceStorageKey: 1 }, { unique: true });

// Crash-recovery finalization sweep: find completed jobs whose verified
// output has not yet been repointed onto their Moment media item.
transcodingJobSchema.index({ status: 1, momentSyncStatus: 1 });

// Cleanup claim query: completed + synced jobs whose cleanup is pending or
// retry-due. Mirrors the same {status, dueTime, leaseExpiry}-shaped index
// pattern used above for the main claim query.
transcodingJobSchema.index({ status: 1, momentSyncStatus: 1, cleanupStatus: 1, cleanupNextRetryAt: 1, cleanupLeaseExpiresAt: 1 });

// Orphan-cleanup claim query: completed + stale jobs whose orphan-output
// cleanup is pending/processing (stale-lease reclaim) or retry-due.
transcodingJobSchema.index({ status: 1, momentSyncStatus: 1, orphanCleanupStatus: 1, orphanCleanupNextRetryAt: 1, orphanCleanupLeaseExpiresAt: 1 });

export const TranscodingJobModel = model<ITranscodingJob>("TranscodingJob", transcodingJobSchema);

// Exported for parity with ensureRefundReceiptIndexes (src/modules/payments/refund-receipt.model.ts),
// but deliberately NOT called from src/server.ts in this phase — Phase 1 must not
// change main API startup. Tests and a future phase's worker bootstrap can call
// this directly.
export const ensureTranscodingJobIndexes = async (): Promise<void> => {
  await TranscodingJobModel.syncIndexes();
};
