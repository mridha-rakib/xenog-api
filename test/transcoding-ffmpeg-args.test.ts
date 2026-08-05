import assert from "node:assert/strict";
import test from "node:test";
import {
  buildThumbnailArgs,
  buildTranscodeArgs,
  planThumbnailTimestampSeconds,
} from "../src/modules/transcoding/ffmpeg-args.js";
import { planTranscodeResolution } from "../src/modules/transcoding/resolution-plan.js";

const scaledResolution = planTranscodeResolution(1920, 1080); // scaled: true, 1280x720
const unscaledResolution = planTranscodeResolution(640, 360); // scaled: false

test("buildTranscodeArgs is a plain string array, never a shell string", () => {
  const args = buildTranscodeArgs({
    inputPath: "/tmp/job/source",
    outputPath: "/tmp/job/optimized.mp4",
    resolution: scaledResolution,
    hasAudio: true,
    crf: 23,
    preset: "veryfast",
  });

  assert.ok(Array.isArray(args));
  assert.ok(args.every((arg) => typeof arg === "string"));
});

test("buildTranscodeArgs always uses libx264, veryfast preset, threads 1, and yuv420p", () => {
  const args = buildTranscodeArgs({
    inputPath: "/tmp/job/source",
    outputPath: "/tmp/job/optimized.mp4",
    resolution: unscaledResolution,
    hasAudio: true,
    crf: 23,
    preset: "veryfast",
  });

  assert.ok(args.includes("-c:v"));
  assert.equal(args[args.indexOf("-c:v") + 1], "libx264");
  assert.equal(args[args.indexOf("-preset") + 1], "veryfast");
  assert.equal(args[args.indexOf("-threads") + 1], "1");
  assert.equal(args[args.indexOf("-pix_fmt") + 1], "yuv420p");
});

test("buildTranscodeArgs uses the provided CRF value", () => {
  const args = buildTranscodeArgs({
    inputPath: "in",
    outputPath: "out.mp4",
    resolution: unscaledResolution,
    hasAudio: true,
    crf: 28,
    preset: "veryfast",
  });

  assert.equal(args[args.indexOf("-crf") + 1], "28");
});

test("buildTranscodeArgs enables MP4 fast-start", () => {
  const args = buildTranscodeArgs({
    inputPath: "in",
    outputPath: "out.mp4",
    resolution: unscaledResolution,
    hasAudio: true,
    crf: 23,
    preset: "veryfast",
  });

  assert.ok(args.includes("-movflags"));
  assert.equal(args[args.indexOf("-movflags") + 1], "+faststart");
});

test("buildTranscodeArgs only adds a scale filter when the resolution plan actually scales", () => {
  const scaledArgs = buildTranscodeArgs({
    inputPath: "in",
    outputPath: "out.mp4",
    resolution: scaledResolution,
    hasAudio: true,
    crf: 23,
    preset: "veryfast",
  });
  const unscaledArgs = buildTranscodeArgs({
    inputPath: "in",
    outputPath: "out.mp4",
    resolution: unscaledResolution,
    hasAudio: true,
    crf: 23,
    preset: "veryfast",
  });

  assert.ok(scaledArgs.includes("-vf"));
  assert.equal(scaledArgs[scaledArgs.indexOf("-vf") + 1], `scale=${scaledResolution.width}:${scaledResolution.height}`);
  assert.equal(unscaledArgs.includes("-vf"), false);
});

test("buildTranscodeArgs maps and encodes audio when the source has audio", () => {
  const args = buildTranscodeArgs({
    inputPath: "in",
    outputPath: "out.mp4",
    resolution: unscaledResolution,
    hasAudio: true,
    crf: 23,
    preset: "veryfast",
  });

  assert.ok(args.includes("0:a:0"));
  assert.equal(args[args.indexOf("-c:a") + 1], "aac");
  assert.equal(args.includes("-an"), false);
});

test("buildTranscodeArgs produces an audio-less MP4 (no audio mapping/codec args) when the source has no audio", () => {
  const args = buildTranscodeArgs({
    inputPath: "in",
    outputPath: "out.mp4",
    resolution: unscaledResolution,
    hasAudio: false,
    crf: 23,
    preset: "veryfast",
  });

  assert.equal(args.includes("0:a:0"), false);
  assert.equal(args.includes("-c:a"), false);
  assert.ok(args.includes("-an"));
});

test("buildTranscodeArgs never references a user-provided filename (only the given local paths)", () => {
  const args = buildTranscodeArgs({
    inputPath: "/app/tmp/transcoding/507f1f77bcf86cd799439011-a1b2c3/source",
    outputPath: "/app/tmp/transcoding/507f1f77bcf86cd799439011-a1b2c3/optimized.mp4",
    resolution: unscaledResolution,
    hasAudio: true,
    crf: 23,
    preset: "veryfast",
  });

  assert.ok(args.includes("/app/tmp/transcoding/507f1f77bcf86cd799439011-a1b2c3/source"));
  assert.ok(args.includes("/app/tmp/transcoding/507f1f77bcf86cd799439011-a1b2c3/optimized.mp4"));
});

test("buildThumbnailArgs produces a single-frame JPEG extraction with matching scale", () => {
  const args = buildThumbnailArgs({
    inputPath: "/tmp/job/optimized.mp4",
    outputPath: "/tmp/job/thumbnail.jpg",
    timestampSeconds: 1,
    resolution: scaledResolution,
  });

  assert.ok(Array.isArray(args));
  assert.ok(args.every((arg) => typeof arg === "string"));
  assert.equal(args[args.indexOf("-frames:v") + 1], "1");
  assert.equal(args[args.indexOf("-vf") + 1], `scale=${scaledResolution.width}:${scaledResolution.height}`);
  assert.equal(args[args.indexOf("-ss") + 1], "1.000");
});

// ---------------------------------------------------------------------------
// planThumbnailTimestampSeconds
// ---------------------------------------------------------------------------

test("planThumbnailTimestampSeconds returns 0 for a video shorter than one second", () => {
  assert.equal(planThumbnailTimestampSeconds(0.5), 0);
  assert.equal(planThumbnailTimestampSeconds(0.01), 0);
});

test("planThumbnailTimestampSeconds returns 0 for zero/negative/non-finite duration", () => {
  assert.equal(planThumbnailTimestampSeconds(0), 0);
  assert.equal(planThumbnailTimestampSeconds(-5), 0);
  assert.equal(planThumbnailTimestampSeconds(Number.NaN), 0);
});

test("planThumbnailTimestampSeconds picks an early representative frame for a normal-length video", () => {
  const timestamp = planThumbnailTimestampSeconds(27);

  assert.equal(timestamp, 1);
});

test("planThumbnailTimestampSeconds never seeks at or beyond the video's end", () => {
  for (const duration of [0.5, 1, 1.5, 2, 27, 60]) {
    const timestamp = planThumbnailTimestampSeconds(duration);

    assert.ok(timestamp < duration || duration < 1, `timestamp ${timestamp} must be before duration ${duration}`);
  }
});

test("planThumbnailTimestampSeconds stays safely inside a video just over one second", () => {
  const timestamp = planThumbnailTimestampSeconds(1.2);

  assert.ok(timestamp >= 0);
  assert.ok(timestamp < 1.2);
});
