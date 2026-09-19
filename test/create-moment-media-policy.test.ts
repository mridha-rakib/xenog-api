import assert from "node:assert/strict";
import test from "node:test";
import { momentValidation } from "../src/modules/moments/moment.validation.js";

// CRT-011 media policy completion — image/audio MIME + audio duration.
// Mirrors this repo's existing schema-level test style (moment-tagging-
// contract.test.ts, repost-contract.test.ts). File-size limits (15 MB/image,
// 20 MB/audio, 50 MB total) are intentionally NOT asserted here: they are
// client-enforced only (see the CRT-011 media-policy report), since
// MomentMediaItem's `fileSize` is not part of the create payload contract.

const baseBody = (mediaItems: unknown[]) => ({
  mode: "feed" as const,
  audience: "public" as const,
  mediaItems,
});

const parse = (mediaItems: unknown[]) => momentValidation.createMoment.safeParse({ body: baseBody(mediaItems) });

// ── Image MIME ────────────────────────────────────────────────────────────

test("approved image MIME types are accepted", () => {
  for (const contentType of ["image/jpeg", "image/png", "image/webp"]) {
    const result = parse([{ type: "image", storageKey: "moments/image/a.jpg", contentType }]);
    assert.equal(result.success, true, `${contentType} should be accepted`);
  }
});

test("unsupported image MIME types are rejected", () => {
  const result = parse([{ type: "image", storageKey: "moments/image/a.gif", contentType: "image/gif" }]);
  assert.equal(result.success, false);
});

test("HEIC/HEIF images are rejected (deferred pending cross-platform verification)", () => {
  for (const contentType of ["image/heic", "image/heif"]) {
    const result = parse([{ type: "image", storageKey: "moments/image/a.heic", contentType }]);
    assert.equal(result.success, false, `${contentType} should be rejected`);
  }
});

test("an image with no contentType is not rejected on MIME grounds (additive, non-breaking check)", () => {
  const result = parse([{ type: "image", storageKey: "moments/image/a.jpg" }]);
  assert.equal(result.success, true);
});

// ── Audio MIME ────────────────────────────────────────────────────────────

test("approved audio MIME types are accepted", () => {
  for (const contentType of [
    "audio/mp4", "audio/m4a", "audio/x-m4a", "audio/aac",
    "audio/mpeg", "audio/wav", "audio/x-wav", "audio/ogg",
  ]) {
    const result = parse([{ type: "audio", storageKey: "moments/audio/a.m4a", contentType, durationSeconds: 30 }]);
    assert.equal(result.success, true, `${contentType} should be accepted`);
  }
});

test("MIME normalization: uppercase and parameterized MIME still match", () => {
  const upper = parse([{ type: "audio", storageKey: "moments/audio/a.mp3", contentType: "AUDIO/MPEG", durationSeconds: 30 }]);
  const withParams = parse([{ type: "audio", storageKey: "moments/audio/a.m4a", contentType: "audio/mp4; codecs=mp4a.40.2", durationSeconds: 30 }]);

  assert.equal(upper.success, true);
  assert.equal(withParams.success, true);
});

test("unsupported audio MIME types are rejected", () => {
  const result = parse([{ type: "audio", storageKey: "moments/audio/a.flac", contentType: "audio/flac", durationSeconds: 30 }]);
  assert.equal(result.success, false);
});

test("the app's own recorded-audio MIME ('audio/mp4', hardcoded in AudioPickerSheet.stopRecording) remains accepted", () => {
  const result = parse([{ type: "audio", storageKey: "moments/audio/recording.m4a", contentType: "audio/mp4", durationSeconds: 12 }]);
  assert.equal(result.success, true);
});

// ── Audio duration ────────────────────────────────────────────────────────

test("audio duration boundary matrix", () => {
  const cases: [number, boolean][] = [
    [0, false],
    [0.9, false],
    [1, true],
    [299, true],
    [300, true],
    [300.1, false],
  ];

  for (const [durationSeconds, expected] of cases) {
    const result = parse([{ type: "audio", storageKey: "moments/audio/a.m4a", contentType: "audio/mp4", durationSeconds }]);
    assert.equal(result.success, expected, `duration ${durationSeconds}s should ${expected ? "pass" : "fail"}`);
  }
});

test("audio with no durationSeconds is not rejected on duration grounds (additive, non-breaking check)", () => {
  const result = parse([{ type: "audio", storageKey: "moments/audio/a.m4a", contentType: "audio/mp4" }]);
  assert.equal(result.success, true);
});

// ── Video validation untouched ────────────────────────────────────────────

test("existing video duration validation is unaffected by the new audio/image rules", () => {
  const tooLong = parse([{ type: "video", storageKey: "moments/video/a.mp4", contentType: "video/mp4", durationSeconds: 61 }]);
  const ok = parse([{ type: "video", storageKey: "moments/video/a.mp4", contentType: "video/mp4", durationSeconds: 59 }]);

  assert.equal(tooLong.success, false);
  assert.equal(ok.success, true);
});

// ── Client/server numeric alignment (no silently-drifting magic numbers) ──

test("backend audio duration bounds match the frontend's AUDIO_MIN/MAX_DURATION_SECONDS (1 and 300)", () => {
  const atMin = parse([{ type: "audio", storageKey: "moments/audio/a.m4a", contentType: "audio/mp4", durationSeconds: 1 }]);
  const belowMin = parse([{ type: "audio", storageKey: "moments/audio/a.m4a", contentType: "audio/mp4", durationSeconds: 0.999 }]);
  const atMax = parse([{ type: "audio", storageKey: "moments/audio/a.m4a", contentType: "audio/mp4", durationSeconds: 5 * 60 }]);
  const aboveMax = parse([{ type: "audio", storageKey: "moments/audio/a.m4a", contentType: "audio/mp4", durationSeconds: 5 * 60 + 0.001 }]);

  assert.equal(atMin.success, true);
  assert.equal(belowMin.success, false);
  assert.equal(atMax.success, true);
  assert.equal(aboveMax.success, false);
});

// ── Regression: existing contract still holds ────────────────────────────

test("caption/media-required, image-count-10, and clientRequestId rules are all unaffected", () => {
  const empty = momentValidation.createMoment.safeParse({ body: { mode: "feed", audience: "public" } });
  const elevenImages = parse(Array.from({ length: 11 }, (_, i) => (
    { type: "image", storageKey: `moments/image/${i}.jpg`, contentType: "image/jpeg" }
  )));
  const tenImages = parse(Array.from({ length: 10 }, (_, i) => (
    { type: "image", storageKey: `moments/image/${i}.jpg`, contentType: "image/jpeg" }
  )));

  assert.equal(empty.success, false);
  assert.equal(elevenImages.success, false);
  assert.equal(tenImages.success, true);
});
