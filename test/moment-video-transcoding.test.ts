import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { Types } from "mongoose";
import { MomentModel } from "../src/modules/moments/moment.model.js";
import { MomentShareModel } from "../src/modules/moments/moment-share.model.js";
import { MomentRepository } from "../src/modules/moments/moment.repository.js";
import { MomentShareRepository } from "../src/modules/moments/moment-share.repository.js";
import { MomentService } from "../src/modules/moments/moment.service.js";
import { createMomentVideoStorageKey, MomentVideoService } from "../src/modules/moments/moment-video.service.js";
import { MomentMediaLifecycleService } from "../src/modules/moments/moment-media-lifecycle.service.js";
import { TranscodingJobModel } from "../src/modules/transcoding/transcoding-job.model.js";
import { TranscodingJobRepository } from "../src/modules/transcoding/transcoding-job.repository.js";
import { TranscodingMomentSyncService } from "../src/modules/transcoding/transcoding-moment-sync.service.js";
import {
  connectTranscodingTestDb,
  disconnectTranscodingTestDb,
  TRANSCODING_TEST_MONGODB_URI,
} from "./helpers/transcoding-test-db.js";

process.env.NODE_ENV = "test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const now = new Date("2026-08-06T00:00:00.000Z");
const jobRepository = new TranscodingJobRepository();
const syncService = new TranscodingMomentSyncService();
const lifecycleService = new MomentMediaLifecycleService();

const createdMomentIds: Types.ObjectId[] = [];
const createdJobIds: Types.ObjectId[] = [];
const createdShareMomentIds: string[] = [];

const makeUser = (id: string) => ({
  id,
  name: "Tester",
  username: "tester",
  email: "tester@example.com",
  accountType: "personal",
  currentLocationSharingEnabled: false,
  notificationsEnabled: true,
  role: "user",
  isActive: true,
  emailVerified: true,
  createdAt: now,
  updatedAt: now,
});

const fakeStorageService = {
  createDownloadUrl: async (key: string) => ({ key, expiresIn: 600, url: `https://storage.example/${key}` }),
  getObjectMetadata: async () => ({ contentLength: 1000, contentType: "video/mp4" }),
  getObject: async () => ({ body: Readable.from([Buffer.from("video")]), contentLength: 1000, contentType: "video/mp4" }),
  deleteObject: async () => undefined,
};

/** A near-real MomentService: real MomentRepository + real TranscodingMomentSyncService (both hitting the local test Mongo), stubbed only where ffprobe/S3 would otherwise be required. */
const createIntegrationMomentService = (momentVideoService: MomentVideoService, momentShareRepository: MomentShareRepository = new MomentShareRepository()) => new MomentService(
  new MomentRepository(),
  fakeStorageService as never,
  { findByIds: async () => [], findById: async () => null } as never,
  momentShareRepository as never,
  { findMutualFriendIds: async () => [], findFollowingIds: async () => [] } as never,
  { findBlockedIds: async () => [] } as never,
  {
    countByMomentId: async () => 0,
    countByMomentIds: async () => new Map<string, number>(),
    findLikedMomentIds: async () => new Set<string>(),
  } as never,
  { countByMomentId: async () => 0, countByMomentIds: async () => new Map<string, number>() } as never,
  {} as never,
  { findSavedMomentIds: async () => new Set<string>() } as never,
  { findById: async () => null } as never,
  {} as never,
  {} as never,
  momentVideoService,
);

const createMomentPayload = (userId: string, videoKey?: string) => ({
  mode: "feed" as const,
  caption: "test",
  audience: "public" as const,
  taggedPeople: [],
  taggedFriendIds: [],
  mediaItems: videoKey
    ? [{ type: "video" as const, source: "upload" as const, storageKey: videoKey, contentType: "video/mp4", durationSeconds: 5 }]
    : [],
});

const trackMoment = (moment: { _id: Types.ObjectId }): typeof moment => {
  createdMomentIds.push(moment._id);
  return moment;
};

const trackJob = (job: { _id: Types.ObjectId } | null): typeof job => {
  if (job) {
    createdJobIds.push(job._id);
  }
  return job;
};

test.before(async () => {
  await connectTranscodingTestDb(TRANSCODING_TEST_MONGODB_URI);
});

test.after(async () => {
  if (createdMomentIds.length) {
    await MomentModel.deleteMany({ _id: { $in: createdMomentIds } });
  }
  if (createdJobIds.length) {
    await TranscodingJobModel.deleteMany({ _id: { $in: createdJobIds } });
  }
  if (createdShareMomentIds.length) {
    await MomentShareModel.deleteMany({ momentId: { $in: createdShareMomentIds } });
  }
  await disconnectTranscodingTestDb();
});

// ---------------------------------------------------------------------------
// New Moment job creation / eligibility
// ---------------------------------------------------------------------------

test("a new eligible video creates exactly one TranscodingJob and the media is queued", async () => {
  const userId = new Types.ObjectId().toString();
  const key = createMomentVideoStorageKey(userId, "video/mp4");
  const service = createIntegrationMomentService(new MomentVideoService(fakeStorageService as never));

  const response = await service.createMoment(createMomentPayload(userId, key), makeUser(userId) as never);
  trackMoment({ _id: new Types.ObjectId(response.id) });

  const job = trackJob(await jobRepository.findByIdentity(response.id, key));
  assert.ok(job);
  assert.equal(job?.sourceStorageKey, key);
  assert.equal(job?.status, "queued");

  const count = await TranscodingJobModel.countDocuments({ momentId: response.id, sourceStorageKey: key });
  assert.equal(count, 1);

  assert.equal(response.mediaItems[0]?.processingStatus, "queued");
  assert.equal(response.mediaItems[0]?.storageKey, key);

  // Left "queued" and immediately due, this job would otherwise be picked up
  // by the next claimNext() call in an unrelated later test — cancel it now
  // that this test's own assertions are done, mirroring the same cleanup
  // convention already established in test/transcoding-job-repository.test.ts.
  await jobRepository.cancel(job!._id.toString());
});

test("an image media item creates no TranscodingJob", async () => {
  const userId = new Types.ObjectId().toString();
  const service = createIntegrationMomentService(new MomentVideoService(fakeStorageService as never));

  const response = await service.createMoment({
    mode: "feed",
    caption: "image only",
    audience: "public",
    taggedPeople: [],
    taggedFriendIds: [],
    mediaItems: [{ type: "image", source: "gallery", url: "https://cdn.example.com/a.jpg" }],
  }, makeUser(userId) as never);
  trackMoment({ _id: new Types.ObjectId(response.id) });

  const count = await TranscodingJobModel.countDocuments({ momentId: response.id });
  assert.equal(count, 0);
  assert.equal(response.mediaItems[0]?.processingStatus, undefined);
});

test("duplicate service execution for the same Moment/source key returns the same job (idempotent)", async () => {
  const userId = new Types.ObjectId().toString();
  const momentId = new Types.ObjectId().toString();
  const key = createMomentVideoStorageKey(userId, "video/mp4");

  await syncService.queueNewVideoJob({ momentId, userId, sourceStorageKey: key });
  const firstJob = await jobRepository.findByIdentity(momentId, key);
  trackJob(firstJob);

  await syncService.queueNewVideoJob({ momentId, userId, sourceStorageKey: key });
  const secondJob = await jobRepository.findByIdentity(momentId, key);

  assert.ok(firstJob);
  assert.ok(secondJob);
  assert.equal(firstJob?._id.toString(), secondJob?._id.toString());

  const count = await TranscodingJobModel.countDocuments({ momentId, sourceStorageKey: key });
  assert.equal(count, 1);

  await jobRepository.cancel(firstJob!._id.toString());
});

test("a repost of a video Moment does not create a duplicate TranscodingJob", async () => {
  const authorId = new Types.ObjectId().toString();
  const reposterId = new Types.ObjectId().toString();
  const key = createMomentVideoStorageKey(authorId, "video/mp4");
  const service = createIntegrationMomentService(new MomentVideoService(fakeStorageService as never));

  const response = await service.createMoment(createMomentPayload(authorId, key), makeUser(authorId) as never);
  trackMoment({ _id: new Types.ObjectId(response.id) });
  const job = trackJob(await jobRepository.findByIdentity(response.id, key));

  await service.shareMoment(response.id, makeUser(reposterId) as never, {});
  createdShareMomentIds.push(response.id);

  const count = await TranscodingJobModel.countDocuments({ momentId: response.id, sourceStorageKey: key });
  assert.equal(count, 1);

  await jobRepository.cancel(job!._id.toString());
});

test("client-submitted server-managed processing fields are rejected by the existing strict media schema", async () => {
  // Full end-to-end confirmation of the existing Phase 1 Zod `.strict()` guard
  // (see test/moment-media-processing-fields.test.ts for the focused unit
  // test) — a request smuggling processingStatus never reaches MomentService.
  const { momentValidation } = await import("../src/modules/moments/moment.validation.js");
  const result = momentValidation.createMoment.safeParse({
    body: {
      mode: "feed",
      caption: "smuggle",
      audience: "public",
      mediaItems: [{
        type: "video",
        source: "upload",
        storageKey: "moments/x/video/y.mp4",
        contentType: "video/mp4",
        durationSeconds: 5,
        processingStatus: "ready",
        thumbnailStorageKey: "videos/thumbnails/y.jpg",
      }],
    },
  });

  assert.equal(result.success, false);
});

// ---------------------------------------------------------------------------
// Job creation failure safety
// ---------------------------------------------------------------------------

test("a job-creation failure leaves the original storage key intact and marks the media safely failed, not stuck processing", async () => {
  const userId = new Types.ObjectId().toString();
  const momentId = new Types.ObjectId().toString();
  const key = createMomentVideoStorageKey(userId, "video/mp4");
  await MomentModel.create({
    _id: momentId,
    userId,
    mode: "feed",
    audience: "public",
    mediaItems: [{ type: "video", source: "upload", storageKey: key, contentType: "video/mp4" }],
  });
  trackMoment({ _id: new Types.ObjectId(momentId) });

  const failingJobRepository = {
    createOrGet: async () => {
      throw new Error("simulated DB failure");
    },
  };
  const failingSyncService = new TranscodingMomentSyncService(failingJobRepository as never, lifecycleService);

  const updated = await failingSyncService.queueNewVideoJob({ momentId, userId, sourceStorageKey: key });

  assert.equal(updated?.mediaItems[0]?.processingStatus, "failed");
  assert.equal(updated?.mediaItems[0]?.processingErrorCode, "unknown");
  assert.equal(updated?.mediaItems[0]?.storageKey, key);

  const stillReadable = await MomentModel.findById(momentId);
  assert.ok(stillReadable);
  assert.equal(stillReadable?.mediaItems[0]?.storageKey, key);
});

// ---------------------------------------------------------------------------
// Lifecycle synchronization
// ---------------------------------------------------------------------------

const seedMomentWithJob = async (label: string, overrides: Record<string, unknown> = {}) => {
  const userId = new Types.ObjectId().toString();
  const momentId = new Types.ObjectId();
  const key = `moments/${userId}/video/${label}-${new Types.ObjectId().toString()}.mp4`;

  await MomentModel.create({
    _id: momentId,
    userId,
    mode: "feed",
    audience: "public",
    mediaItems: [{ type: "video", source: "upload", storageKey: key, contentType: "video/mp4", processingStatus: "queued" }],
  });
  createdMomentIds.push(momentId);

  const job = await jobRepository.createOrGet({ momentId: momentId.toString(), userId, sourceStorageKey: key });
  createdJobIds.push(job._id);

  if (Object.keys(overrides).length > 0) {
    await TranscodingJobModel.updateOne({ _id: job._id }, { $set: overrides });
  }

  return { userId, momentId: momentId.toString(), key, jobId: job._id.toString() };
};

/**
 * claimNext() has no way to scope itself to one caller's job — it always
 * claims whichever due job is oldest across the whole collection. Combining
 * seed+claim with a hard guard (mirroring the identical pattern already
 * established in test/transcoding-video-processor.test.ts's claimFreshJob)
 * makes any cross-test leftover-due-job contamination fail immediately and
 * legibly here, instead of silently claiming the wrong job and producing a
 * confusing lease-mismatch failure several lines later.
 */
const seedAndClaimMomentJob = async (label: string, overrides: Record<string, unknown> = {}) => {
  const seeded = await seedMomentWithJob(label, overrides);
  const claimed = await jobRepository.claimNext();

  if (!claimed || claimed._id.toString() !== seeded.jobId) {
    throw new Error(`test setup failed: claimNext() did not claim the job just seeded for "${label}"`);
  }

  return { ...seeded, claimed };
};

test("queued -> processing when the worker claims the job", async () => {
  const { momentId, key, claimed } = await seedAndClaimMomentJob("processing");

  await syncService.syncAfterClaim(claimed);

  const moment = await MomentModel.findById(momentId);
  assert.equal(moment?.mediaItems[0]?.storageKey, key);
  assert.equal(moment?.mediaItems[0]?.processingStatus, "processing");
});

test("processing -> queued on a retryable failure", async () => {
  const { momentId, jobId, claimed } = await seedAndClaimMomentJob("retry-queued");
  await syncService.syncAfterClaim(claimed!);

  await jobRepository.recordFailure(jobId, claimed!.leaseToken!, { errorCode: "encode_failed", errorSummary: "transient" });
  await syncService.syncAfterJobAttempt(jobId);

  const moment = await MomentModel.findById(momentId);
  assert.equal(moment?.mediaItems[0]?.processingStatus, "queued");
  assert.equal(moment?.mediaItems[0]?.processingErrorCode, undefined);
});

test("disk defer -> queued without a final failure state", async () => {
  const { momentId, jobId, claimed } = await seedAndClaimMomentJob("disk-defer");
  await syncService.syncAfterClaim(claimed!);

  // A long retry delay (well beyond this whole suite's runtime) keeps this
  // deferred-but-still-queued job from ever becoming due again and being
  // accidentally picked up by a later test's own claimNext() call.
  await jobRepository.deferClaim(jobId, claimed!.leaseToken!, { retryDelayMs: 10 * 60 * 1000 });
  await syncService.syncAfterJobAttempt(jobId);

  const moment = await MomentModel.findById(momentId);
  assert.equal(moment?.mediaItems[0]?.processingStatus, "queued");
  assert.equal(moment?.mediaItems[0]?.processingErrorCode, undefined);
});

test("processing -> failed on a permanent source failure, with only a safe error code", async () => {
  const { momentId, jobId, claimed } = await seedAndClaimMomentJob("permanent-fail");
  await syncService.syncAfterClaim(claimed!);

  await jobRepository.markPermanentFailure(jobId, claimed!.leaseToken!, {
    errorCode: "source_invalid",
    errorSummary: "no valid video stream at /tmp/internal/path",
  });
  await syncService.syncAfterJobAttempt(jobId);

  const moment = await MomentModel.findById(momentId);
  assert.equal(moment?.mediaItems[0]?.processingStatus, "failed");
  assert.equal(moment?.mediaItems[0]?.processingErrorCode, "source_invalid");
});

test("failed after attempt exhaustion also reaches the safe failed state", async () => {
  const { momentId, jobId, claimed } = await seedAndClaimMomentJob("exhausted", { maxAttempts: 1 });
  await syncService.syncAfterClaim(claimed!);

  await jobRepository.recordFailure(jobId, claimed!.leaseToken!, { errorCode: "timeout" });
  await syncService.syncAfterJobAttempt(jobId);

  const moment = await MomentModel.findById(momentId);
  assert.equal(moment?.mediaItems[0]?.processingStatus, "failed");
  assert.equal(moment?.mediaItems[0]?.processingErrorCode, "timeout");
});

test("job internals (job id, lease, attempts, raw error summary) never appear on the Moment media item", async () => {
  const { momentId, jobId, claimed } = await seedAndClaimMomentJob("no-internals");
  await syncService.syncAfterClaim(claimed!);
  await jobRepository.markPermanentFailure(jobId, claimed!.leaseToken!, {
    errorCode: "source_invalid",
    errorSummary: "internal detail that must never leak",
  });
  await syncService.syncAfterJobAttempt(jobId);

  const moment = await MomentModel.findById(momentId);
  const json = JSON.stringify(moment?.toObject().mediaItems[0]);
  assert.doesNotMatch(json, /leaseToken/);
  assert.doesNotMatch(json, /attempts/);
  assert.doesNotMatch(json, new RegExp(jobId));
  assert.doesNotMatch(json, /internal detail/);
});

// ---------------------------------------------------------------------------
// Ready repoint
// ---------------------------------------------------------------------------

test("ready: exact original key changes to the verified optimized key, with thumbnail and metadata, and error code cleared", async () => {
  const { momentId, jobId, key, claimed } = await seedAndClaimMomentJob("ready-basic");
  await syncService.syncAfterClaim(claimed!);
  const optimizedKey = `videos/optimized/x/${jobId}.mp4`;
  const thumbnailKey = `videos/thumbnails/x/${jobId}.jpg`;

  await jobRepository.markSuccess(jobId, claimed!.leaseToken!, {
    optimizedStorageKey: optimizedKey,
    thumbnailStorageKey: thumbnailKey,
    outputWidth: 1280,
    outputHeight: 720,
    outputFileSize: 12345,
  });
  await syncService.syncAfterJobAttempt(jobId);

  const moment = await MomentModel.findById(momentId);
  const media = moment?.mediaItems[0];
  assert.equal(media?.storageKey, optimizedKey);
  assert.notEqual(media?.storageKey, key);
  assert.equal(media?.thumbnailStorageKey, thumbnailKey);
  assert.equal(media?.width, 1280);
  assert.equal(media?.height, 720);
  assert.equal(media?.fileSize, 12345);
  assert.equal(media?.processingStatus, "ready");
  assert.equal(media?.processingErrorCode ?? null, null);
  assert.ok(media?.processedAt);

  const job = await jobRepository.findById(jobId);
  assert.equal(job?.momentSyncStatus, "synced");
});

test("ready: repeating finalization is an idempotent success, not a double-apply or error", async () => {
  const { momentId, jobId, claimed } = await seedAndClaimMomentJob("ready-idempotent");
  await syncService.syncAfterClaim(claimed!);
  const optimizedKey = `videos/optimized/x/${jobId}.mp4`;
  const thumbnailKey = `videos/thumbnails/x/${jobId}.jpg`;

  await jobRepository.markSuccess(jobId, claimed!.leaseToken!, {
    optimizedStorageKey: optimizedKey,
    thumbnailStorageKey: thumbnailKey,
    outputWidth: 1280,
    outputHeight: 720,
    outputFileSize: 100,
  });

  const job = (await jobRepository.findById(jobId))!;
  await syncService.finalizeCompletedJob(job);
  await syncService.finalizeCompletedJob(job);
  await syncService.finalizeCompletedJob(job);

  const moment = await MomentModel.findById(momentId);
  assert.equal(moment?.mediaItems[0]?.storageKey, optimizedKey);
  assert.equal(moment?.mediaItems[0]?.processingStatus, "ready");

  const finalJob = await jobRepository.findById(jobId);
  assert.equal(finalJob?.momentSyncStatus, "synced");
});

test("ready: the derived-URL response serialization resolves a fresh URL from the repointed optimized key", async () => {
  const { momentId, jobId, claimed } = await seedAndClaimMomentJob("ready-derived-url");
  await syncService.syncAfterClaim(claimed!);
  const optimizedKey = `videos/optimized/x/${jobId}.mp4`;

  await jobRepository.markSuccess(jobId, claimed!.leaseToken!, {
    optimizedStorageKey: optimizedKey,
    thumbnailStorageKey: `videos/thumbnails/x/${jobId}.jpg`,
  });
  await syncService.syncAfterJobAttempt(jobId);

  const service = createIntegrationMomentService(new MomentVideoService(fakeStorageService as never));
  const userId = (await MomentModel.findById(momentId))!.userId.toString();
  const response = await service.getMoment(momentId, makeUser(userId) as never);

  assert.equal(response.mediaItems[0]?.storageKey, optimizedKey);
  assert.equal(response.mediaItems[0]?.url, `https://storage.example/${optimizedKey}`);
});

test("ready: another video media item on a different Moment is never changed", async () => {
  const seeded1 = await seedMomentWithJob("isolation-a");
  const claimed1 = await jobRepository.claimNext();
  if (!claimed1 || claimed1._id.toString() !== seeded1.jobId) {
    throw new Error("test setup failed: claimNext() did not claim seeded1's job");
  }
  const seeded2 = await seedMomentWithJob("isolation-b");
  await syncService.syncAfterClaim(claimed1);

  const optimizedKey = `videos/optimized/x/${seeded1.jobId}.mp4`;
  await jobRepository.markSuccess(seeded1.jobId, claimed1!.leaseToken!, {
    optimizedStorageKey: optimizedKey,
    thumbnailStorageKey: `videos/thumbnails/x/${seeded1.jobId}.jpg`,
  });
  await syncService.syncAfterJobAttempt(seeded1.jobId);

  const untouchedMoment = await MomentModel.findById(seeded2.momentId);
  assert.equal(untouchedMoment?.mediaItems[0]?.storageKey, seeded2.key);
  assert.equal(untouchedMoment?.mediaItems[0]?.processingStatus, "queued");

  // seeded2's job was deliberately never claimed (that's the point of this
  // test) — cancel it so it cannot be picked up by a later test's claimNext().
  await jobRepository.cancel(seeded2.jobId);
});

test("ready: a media item that no longer points at the expected original key is not overwritten, and sync is marked stale", async () => {
  const { momentId, jobId, claimed } = await seedAndClaimMomentJob("replaced-media");
  await syncService.syncAfterClaim(claimed!);

  // Simulate the media item having been replaced by something else entirely
  // (e.g. a hypothetical future edit flow) before this job's output was ready.
  await MomentModel.updateOne(
    { _id: momentId },
    { $set: { "mediaItems.0.storageKey": "moments/other/video/replaced.mp4", "mediaItems.0.processingStatus": "queued" } },
  );

  await jobRepository.markSuccess(jobId, claimed!.leaseToken!, {
    optimizedStorageKey: `videos/optimized/x/${jobId}.mp4`,
    thumbnailStorageKey: `videos/thumbnails/x/${jobId}.jpg`,
  });
  await syncService.syncAfterJobAttempt(jobId);

  const moment = await MomentModel.findById(momentId);
  assert.equal(moment?.mediaItems[0]?.storageKey, "moments/other/video/replaced.mp4");
  assert.equal(moment?.mediaItems[0]?.processingStatus, "queued");

  const job = await jobRepository.findById(jobId);
  assert.equal(job?.momentSyncStatus, "stale");
});

test("ready: a deleted Moment is handled safely — no crash, no recreation, job marked stale", async () => {
  const { momentId, jobId, claimed } = await seedAndClaimMomentJob("deleted-moment");
  await syncService.syncAfterClaim(claimed!);

  await MomentModel.deleteOne({ _id: momentId });
  createdMomentIds.splice(createdMomentIds.findIndex((id) => id.toString() === momentId), 1);

  await jobRepository.markSuccess(jobId, claimed!.leaseToken!, {
    optimizedStorageKey: `videos/optimized/x/${jobId}.mp4`,
    thumbnailStorageKey: `videos/thumbnails/x/${jobId}.jpg`,
  });
  await syncService.syncAfterJobAttempt(jobId);

  const stillDeleted = await MomentModel.findById(momentId);
  assert.equal(stillDeleted, null);

  const job = await jobRepository.findById(jobId);
  assert.equal(job?.momentSyncStatus, "stale");
});

test("ready: the original source object is never deleted by any lifecycle transition", async () => {
  const { jobId, claimed } = await seedAndClaimMomentJob("no-original-deletion");
  await syncService.syncAfterClaim(claimed!);
  await jobRepository.markSuccess(jobId, claimed!.leaseToken!, {
    optimizedStorageKey: `videos/optimized/x/${jobId}.mp4`,
    thumbnailStorageKey: `videos/thumbnails/x/${jobId}.jpg`,
  });
  await syncService.syncAfterJobAttempt(jobId);

  // Structural guarantee: MomentMediaLifecycleService never imports or calls
  // any storage-deletion primitive at all.
  const { readFileSync } = await import("node:fs");
  const contents = readFileSync(
    new URL("../src/modules/moments/moment-media-lifecycle.service.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(contents, /deleteObject|StorageService/);
});

// ---------------------------------------------------------------------------
// Crash/restart recovery
// ---------------------------------------------------------------------------

test("crash recovery: a completed job with verified output but an unsynchronized Moment is finalized by the sweep without retranscoding", async () => {
  const { momentId, jobId, claimed } = await seedAndClaimMomentJob("crash-recovery");
  await syncService.syncAfterClaim(claimed);
  // Deliberately skip syncAfterJobAttempt here, simulating a worker that
  // completed the job (markSuccess already ran) and then crashed before ever
  // running its own post-completion Moment-sync step.
  const optimizedKey = `videos/optimized/x/${jobId}.mp4`;
  await jobRepository.markSuccess(jobId, claimed!.leaseToken!, {
    optimizedStorageKey: optimizedKey,
    thumbnailStorageKey: `videos/thumbnails/x/${jobId}.jpg`,
    outputWidth: 640,
    outputHeight: 360,
  });

  const beforeSweep = await MomentModel.findById(momentId);
  assert.equal(beforeSweep?.mediaItems[0]?.processingStatus, "processing");

  const swept = await syncService.finalizePendingCompletedJobs();
  assert.ok(swept >= 1);

  const moment = await MomentModel.findById(momentId);
  assert.equal(moment?.mediaItems[0]?.storageKey, optimizedKey);
  assert.equal(moment?.mediaItems[0]?.processingStatus, "ready");

  const job = await jobRepository.findById(jobId);
  assert.equal(job?.momentSyncStatus, "synced");
});

test("crash recovery: re-running the finalizer sweep again is safe and does not re-process already-synced jobs", async () => {
  const { jobId, claimed } = await seedAndClaimMomentJob("crash-recovery-rerun");
  await jobRepository.markSuccess(jobId, claimed!.leaseToken!, {
    optimizedStorageKey: `videos/optimized/x/${jobId}.mp4`,
    thumbnailStorageKey: `videos/thumbnails/x/${jobId}.jpg`,
  });

  const firstSweepCount = await syncService.finalizePendingCompletedJobs();
  assert.ok(firstSweepCount >= 1);

  const pendingAfterFirstSweep = await jobRepository.findCompletedPendingMomentSync(50);
  assert.equal(pendingAfterFirstSweep.some((job) => job._id.toString() === jobId), false);
});

test("crash recovery: the finalizer never points a Moment at a job with missing/unverified output keys", async () => {
  const { momentId, jobId } = await seedMomentWithJob("crash-recovery-unverified");
  const job = await jobRepository.findById(jobId);
  assert.ok(job);

  // A job that is not actually "completed" (still "processing", the seeded
  // default) has no verified output — finalizeCompletedJob must refuse to
  // touch the Moment even if called directly.
  await syncService.finalizeCompletedJob(job!);

  const moment = await MomentModel.findById(momentId);
  assert.notEqual(moment?.mediaItems[0]?.processingStatus, "ready");
});
