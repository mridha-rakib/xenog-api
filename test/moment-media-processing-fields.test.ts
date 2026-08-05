import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { MomentModel } from "../src/modules/moments/moment.model.js";
import { momentValidation } from "../src/modules/moments/moment.validation.js";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const baseMoment = (mediaItems: Record<string, unknown>[]) => ({
  userId: new Types.ObjectId(),
  mode: "feed",
  caption: "Existing-shape moment",
  audience: "public",
  mediaItems,
});

test("existing image media item (no processing fields at all) remains valid and gains no new keys", async () => {
  const doc = new MomentModel(baseMoment([
    { type: "image", source: "gallery", url: "https://cdn.example.com/a.jpg" },
  ]));

  await doc.validate();

  const mediaItem = doc.toObject().mediaItems[0];
  assert.equal(mediaItem.type, "image");
  assert.equal("processingStatus" in mediaItem, false);
  assert.equal("thumbnailStorageKey" in mediaItem, false);
  assert.equal("width" in mediaItem, false);
  assert.equal("height" in mediaItem, false);
  assert.equal("fileSize" in mediaItem, false);
  assert.equal("processedAt" in mediaItem, false);
  assert.equal("processingErrorCode" in mediaItem, false);
});

test("existing old-style video media item (no processing fields) remains valid and gains no new keys", async () => {
  const doc = new MomentModel(baseMoment([
    {
      type: "video",
      source: "upload",
      storageKey: "moments/507f1f77bcf86cd799439011/video/00000000-0000-4000-8000-000000000000.mp4",
      contentType: "video/mp4",
      durationSeconds: 12.5,
    },
  ]));

  await doc.validate();

  const mediaItem = doc.toObject().mediaItems[0];
  assert.equal(mediaItem.type, "video");
  assert.equal(mediaItem.durationSeconds, 12.5);
  assert.equal("processingStatus" in mediaItem, false);
  assert.equal("processingErrorCode" in mediaItem, false);
  assert.equal(mediaItem.processingStatus, undefined);
});

test("a moment with no video media at all is unaffected by the new fields", async () => {
  const doc = new MomentModel(baseMoment([
    { type: "image", source: "gallery", url: "https://cdn.example.com/a.jpg" },
    { type: "image", source: "gallery", url: "https://cdn.example.com/b.jpg" },
  ]));

  await doc.validate();

  const json = JSON.parse(JSON.stringify(doc.toObject()));
  assert.equal(JSON.stringify(json).includes("processingStatus"), false);
});

test("no default processing status is applied to any current media record", async () => {
  const doc = new MomentModel(baseMoment([
    { type: "video", source: "upload", storageKey: "moments/x/video/y.mp4", contentType: "video/mp4" },
  ]));

  await doc.validate();

  assert.equal(doc.mediaItems[0]?.processingStatus, undefined);
  assert.equal(doc.mediaItems[0]?.get?.("processingStatus"), undefined);
});

test("optional processing fields validate correctly when explicitly present", async () => {
  const processedAt = new Date("2026-08-01T00:00:00.000Z");
  const doc = new MomentModel(baseMoment([
    {
      type: "video",
      source: "upload",
      storageKey: "moments/x/video/y.mp4",
      contentType: "video/mp4",
      durationSeconds: 30,
      processingStatus: "ready",
      thumbnailStorageKey: "videos/thumbnails/y.jpg",
      width: 1280,
      height: 720,
      fileSize: 4_500_000,
      processedAt,
      processingErrorCode: null,
    },
  ]));

  await doc.validate();

  const mediaItem = doc.toObject().mediaItems[0];
  assert.equal(mediaItem.processingStatus, "ready");
  assert.equal(mediaItem.thumbnailStorageKey, "videos/thumbnails/y.jpg");
  assert.equal(mediaItem.width, 1280);
  assert.equal(mediaItem.height, 720);
  assert.equal(mediaItem.fileSize, 4_500_000);
  assert.equal(mediaItem.processedAt?.toISOString(), processedAt.toISOString());
});

test("all four required processing statuses (queued, processing, ready, failed) validate", async () => {
  for (const status of ["queued", "processing", "ready", "failed"]) {
    const doc = new MomentModel(baseMoment([
      { type: "video", source: "upload", storageKey: `moments/x/video/${status}.mp4`, processingStatus: status },
    ]));

    await doc.validate();
    assert.equal(doc.toObject().mediaItems[0].processingStatus, status);
  }
});

test("an invalid processingStatus value is rejected", async () => {
  const doc = new MomentModel(baseMoment([
    { type: "video", source: "upload", storageKey: "moments/x/video/y.mp4", processingStatus: "done" },
  ]));

  await assert.rejects(() => doc.validate());
});

test("an invalid processingErrorCode value is rejected", async () => {
  const doc = new MomentModel(baseMoment([
    {
      type: "video",
      source: "upload",
      storageKey: "moments/x/video/y.mp4",
      processingStatus: "failed",
      processingErrorCode: "ffmpeg_exit_code_1_stack_trace_leak",
    },
  ]));

  await assert.rejects(() => doc.validate());
});

test("existing create-Moment request shape (no processing fields) still validates", () => {
  const result = momentValidation.createMoment.safeParse({
    body: {
      mode: "feed",
      caption: "Still works exactly as before",
      audience: "public",
      mediaItems: [
        { type: "video", source: "upload", storageKey: "moments/x/video/y.mp4", contentType: "video/mp4", durationSeconds: 10 },
      ],
    },
  });

  assert.equal(result.success, true);
});

test("a client cannot set processing fields through the existing create-Moment request", () => {
  const result = momentValidation.createMoment.safeParse({
    body: {
      mode: "feed",
      caption: "Attempting to smuggle a processing field",
      audience: "public",
      mediaItems: [
        {
          type: "video",
          source: "upload",
          storageKey: "moments/x/video/y.mp4",
          contentType: "video/mp4",
          durationSeconds: 10,
          processingStatus: "ready",
        },
      ],
    },
  });

  // The mediaItem schema is `.strict()`, so an unrecognized key is a hard
  // validation failure, not a silently-ignored extra field — clients cannot
  // set the processing lifecycle through the ordinary create-Moment request.
  assert.equal(result.success, false);
});
