import assert from "node:assert/strict";
import test from "node:test";
import { isValidJpegThumbnail, validateOptimizedOutput } from "../src/modules/transcoding/output-validation.js";
import type { VideoProbeResult } from "../src/modules/transcoding/video-probe.js";

const validProbe = (overrides: Partial<VideoProbeResult> = {}): VideoProbeResult => ({
  formatName: "mov,mp4,m4a,3gp,3g2,mj2",
  durationSeconds: 10,
  hasVideoStream: true,
  hasAudioStream: true,
  video: { codecName: "h264", width: 1280, height: 720, rotationDegrees: 0, frameRate: 30 },
  audio: { codecName: "aac" },
  ...overrides,
});

const baseParams = {
  expectedWidth: 1280,
  expectedHeight: 720,
  sourceHasAudio: true,
  sourceDurationSeconds: 10,
  outputFileSizeBytes: 1024,
};

test("validateOptimizedOutput: a correct H.264/AAC output at the planned resolution is valid", () => {
  const result = validateOptimizedOutput({ ...baseParams, probe: validProbe() });
  assert.deepEqual(result, { ok: true });
});

test("validateOptimizedOutput: a correct audio-less output when the source had no audio is valid", () => {
  const result = validateOptimizedOutput({
    ...baseParams,
    sourceHasAudio: false,
    probe: validProbe({ hasAudioStream: false, audio: null }),
  });
  assert.deepEqual(result, { ok: true });
});

test("validateOptimizedOutput: zero-byte output is rejected before even looking at the probe", () => {
  const result = validateOptimizedOutput({ ...baseParams, outputFileSizeBytes: 0, probe: null });
  assert.deepEqual(result, { ok: false, reason: "zero_byte_output" });
});

test("validateOptimizedOutput: an unreadable/unprobeable output is rejected", () => {
  const result = validateOptimizedOutput({ ...baseParams, probe: null });
  assert.deepEqual(result, { ok: false, reason: "unreadable" });
});

test("validateOptimizedOutput: a non-MP4-compatible container is rejected", () => {
  const result = validateOptimizedOutput({ ...baseParams, probe: validProbe({ formatName: "matroska,webm" }) });
  assert.deepEqual(result, { ok: false, reason: "not_mp4_compatible" });
});

test("validateOptimizedOutput: the wrong video codec is rejected", () => {
  const result = validateOptimizedOutput({
    ...baseParams,
    probe: validProbe({ video: { codecName: "hevc", width: 1280, height: 720, rotationDegrees: 0, frameRate: 30 } }),
  });
  assert.deepEqual(result, { ok: false, reason: "wrong_video_codec" });
});

test("validateOptimizedOutput: dimensions that don't match the plan are rejected", () => {
  const result = validateOptimizedOutput({
    ...baseParams,
    probe: validProbe({ video: { codecName: "h264", width: 640, height: 360, rotationDegrees: 0, frameRate: 30 } }),
  });
  assert.deepEqual(result, { ok: false, reason: "wrong_dimensions" });
});

test("validateOptimizedOutput: odd-numbered dimensions are rejected even if otherwise close", () => {
  const result = validateOptimizedOutput({
    ...baseParams,
    expectedWidth: 1281,
    probe: validProbe({ video: { codecName: "h264", width: 1281, height: 720, rotationDegrees: 0, frameRate: 30 } }),
  });
  assert.deepEqual(result, { ok: false, reason: "odd_dimensions" });
});

test("validateOptimizedOutput: missing AAC audio when the source had audio is rejected", () => {
  const result = validateOptimizedOutput({
    ...baseParams,
    probe: validProbe({ hasAudioStream: false, audio: null }),
  });
  assert.deepEqual(result, { ok: false, reason: "missing_expected_audio" });
});

test("validateOptimizedOutput: the wrong audio codec is rejected even though audio is present", () => {
  const result = validateOptimizedOutput({
    ...baseParams,
    probe: validProbe({ audio: { codecName: "mp3" } }),
  });
  assert.deepEqual(result, { ok: false, reason: "wrong_audio_codec" });
});

test("validateOptimizedOutput: unexpected audio when the source had none is rejected", () => {
  const result = validateOptimizedOutput({
    ...baseParams,
    sourceHasAudio: false,
    probe: validProbe(), // still reports audio
  });
  assert.deepEqual(result, { ok: false, reason: "unexpected_audio" });
});

test("validateOptimizedOutput: duration far outside tolerance is rejected", () => {
  const result = validateOptimizedOutput({
    ...baseParams,
    sourceDurationSeconds: 10,
    probe: validProbe({ durationSeconds: 25 }),
  });
  assert.deepEqual(result, { ok: false, reason: "duration_drift" });
});

test("validateOptimizedOutput: duration within tolerance is accepted", () => {
  const result = validateOptimizedOutput({
    ...baseParams,
    sourceDurationSeconds: 10,
    probe: validProbe({ durationSeconds: 11.5 }),
  });
  assert.deepEqual(result, { ok: true });
});

test("validateOptimizedOutput: a missing/zero duration is rejected", () => {
  const result = validateOptimizedOutput({ ...baseParams, probe: validProbe({ durationSeconds: null }) });
  assert.deepEqual(result, { ok: false, reason: "missing_duration" });
});

// ---------------------------------------------------------------------------
// isValidJpegThumbnail
// ---------------------------------------------------------------------------

test("isValidJpegThumbnail: accepts bytes with a valid JPEG SOI/EOI envelope", () => {
  const bytes = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(20, 0),
    Buffer.from([0xff, 0xd9]),
  ]);
  assert.equal(isValidJpegThumbnail(bytes), true);
});

test("isValidJpegThumbnail: rejects a zero-byte buffer", () => {
  assert.equal(isValidJpegThumbnail(Buffer.alloc(0)), false);
});

test("isValidJpegThumbnail: rejects arbitrary non-JPEG bytes", () => {
  assert.equal(isValidJpegThumbnail(Buffer.from("this is not a jpeg at all, just text")), false);
});

test("isValidJpegThumbnail: rejects a truncated file missing the EOI marker", () => {
  const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20, 0)]);
  assert.equal(isValidJpegThumbnail(bytes), false);
});

test("isValidJpegThumbnail: rejects a PNG signature masquerading with a jpg extension", () => {
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const bytes = Buffer.concat([pngSignature, Buffer.alloc(20, 0)]);
  assert.equal(isValidJpegThumbnail(bytes), false);
});
