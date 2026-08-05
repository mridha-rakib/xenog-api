import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { env } from "../src/config/env.js";
import {
  classifySourceProbe,
  parseVideoProbeJson,
  probeVideoFile,
} from "../src/modules/transcoding/video-probe.js";

const ffprobeJson = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  streams: [
    {
      codec_type: "video",
      codec_name: "h264",
      width: 1920,
      height: 1080,
      duration: "12.500000",
      r_frame_rate: "30000/1001",
      ...((overrides.videoStream as Record<string, unknown>) ?? {}),
    },
    ...(overrides.includeAudio === false ? [] : [
      {
        codec_type: "audio",
        codec_name: "aac",
        duration: "12.500000",
      },
    ]),
  ],
  format: {
    duration: "12.500000",
    format_name: "mov,mp4,m4a,3gp,3g2,mj2",
  },
});

test("parseVideoProbeJson parses a normal H.264+AAC source correctly", () => {
  const probe = parseVideoProbeJson(ffprobeJson());

  assert.ok(probe);
  assert.equal(probe?.hasVideoStream, true);
  assert.equal(probe?.hasAudioStream, true);
  assert.equal(probe?.durationSeconds, 12.5);
  assert.equal(probe?.video?.codecName, "h264");
  assert.equal(probe?.video?.width, 1920);
  assert.equal(probe?.video?.height, 1080);
  assert.equal(probe?.video?.rotationDegrees, 0);
  assert.ok(probe?.video?.frameRate && Math.abs(probe.video.frameRate - 29.97) < 0.01);
});

test("parseVideoProbeJson detects the absence of an audio stream", () => {
  const probe = parseVideoProbeJson(ffprobeJson({ includeAudio: false }));

  assert.equal(probe?.hasAudioStream, false);
});

test("parseVideoProbeJson reads rotation from side_data_list (modern ffprobe)", () => {
  const raw = JSON.stringify({
    streams: [
      {
        codec_type: "video",
        codec_name: "h264",
        width: 1920,
        height: 1080,
        duration: "10",
        side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }],
      },
    ],
    format: { duration: "10" },
  });

  const probe = parseVideoProbeJson(raw);

  assert.equal(probe?.video?.rotationDegrees, 270);
});

test("parseVideoProbeJson reads rotation from the legacy tags.rotate field", () => {
  const raw = JSON.stringify({
    streams: [
      {
        codec_type: "video",
        codec_name: "h264",
        width: 1080,
        height: 1920,
        duration: "10",
        tags: { rotate: "90" },
      },
    ],
    format: { duration: "10" },
  });

  const probe = parseVideoProbeJson(raw);

  assert.equal(probe?.video?.rotationDegrees, 90);
});

test("parseVideoProbeJson normalizes near-cardinal rotation values from matrix math", () => {
  const raw = JSON.stringify({
    streams: [
      {
        codec_type: "video",
        width: 100,
        height: 100,
        duration: "1",
        side_data_list: [{ side_data_type: "Display Matrix", rotation: -89.999998 }],
      },
    ],
    format: { duration: "1" },
  });

  const probe = parseVideoProbeJson(raw);

  assert.equal(probe?.video?.rotationDegrees, 270);
});

test("parseVideoProbeJson returns hasVideoStream:false when there is no video stream", () => {
  const raw = JSON.stringify({
    streams: [{ codec_type: "audio", codec_name: "aac", duration: "5" }],
    format: { duration: "5" },
  });

  const probe = parseVideoProbeJson(raw);

  assert.equal(probe?.hasVideoStream, false);
  assert.equal(probe?.video, null);
});

test("parseVideoProbeJson returns null for malformed JSON rather than throwing", () => {
  assert.equal(parseVideoProbeJson("not json at all { { {"), null);
  assert.equal(parseVideoProbeJson(""), null);
});

test("parseVideoProbeJson handles a frame rate of 0/0 or garbage safely", () => {
  const raw = JSON.stringify({
    streams: [{ codec_type: "video", width: 100, height: 100, duration: "1", r_frame_rate: "0/0" }],
    format: { duration: "1" },
  });

  const probe = parseVideoProbeJson(raw);

  assert.equal(probe?.video?.frameRate, null);
});

test("parseVideoProbeJson treats zero/negative width or height as invalid (null)", () => {
  const raw = JSON.stringify({
    streams: [{ codec_type: "video", width: 0, height: -10, duration: "1" }],
    format: { duration: "1" },
  });

  const probe = parseVideoProbeJson(raw);

  assert.equal(probe?.video?.width, null);
  assert.equal(probe?.video?.height, null);
});

// ---------------------------------------------------------------------------
// classifySourceProbe
// ---------------------------------------------------------------------------

test("classifySourceProbe: a normal valid source classifies as valid", () => {
  const probe = parseVideoProbeJson(ffprobeJson({ videoStream: { duration: "45" } }));

  assert.equal(classifySourceProbe(probe, 60), "valid");
});

test("classifySourceProbe: no video stream is a permanent failure", () => {
  assert.equal(classifySourceProbe(null, 60), "no_video_stream");

  const audioOnly = parseVideoProbeJson(JSON.stringify({
    streams: [{ codec_type: "audio", duration: "5" }],
    format: { duration: "5" },
  }));
  assert.equal(classifySourceProbe(audioOnly, 60), "no_video_stream");
});

test("classifySourceProbe: invalid (zero/negative) dimensions is a permanent failure", () => {
  const probe = parseVideoProbeJson(JSON.stringify({
    streams: [{ codec_type: "video", width: 0, height: 0, duration: "5" }],
    format: { duration: "5" },
  }));

  assert.equal(classifySourceProbe(probe, 60), "invalid_dimensions");
});

test("classifySourceProbe: unavailable duration is a permanent failure", () => {
  const probe = parseVideoProbeJson(JSON.stringify({
    streams: [{ codec_type: "video", width: 100, height: 100 }],
    format: {},
  }));

  assert.equal(classifySourceProbe(probe, 60), "duration_unavailable");
});

test("classifySourceProbe: duration over the 60-second limit is a permanent failure", () => {
  const probe = parseVideoProbeJson(ffprobeJson({ videoStream: { duration: "61" } }));

  assert.equal(classifySourceProbe(probe, 60), "duration_too_long");
});

test("classifySourceProbe: duration exactly at the limit is valid", () => {
  const probe = parseVideoProbeJson(ffprobeJson({ videoStream: { duration: "60" } }));

  assert.equal(classifySourceProbe(probe, 60), "valid");
});

// ---------------------------------------------------------------------------
// probeVideoFile — the real execFile-spawning path (not the injected
// probeVideoFile used throughout transcoding-video-processor*.test.ts). This
// is the sole authoritative ffprobe validation for source videos: the API's
// POST /moments no longer downloads or decodes the source at all (see
// moment-video.service.ts's checkStorageVideoAvailability), so this exact
// safe execFile/argument-array/bounded-buffer/timeout/ENOENT-handling
// behavior is what every video upload's real validation now rests on.
// ---------------------------------------------------------------------------

test("probeVideoFile: a missing/unavailable ffprobe executable is classified as 'unavailable', not thrown", async () => {
  const tempFile = `./tmp-probe-${Date.now()}.bin`;
  const previousPath = env.FFPROBE_PATH;
  await fs.writeFile(tempFile, Buffer.from("not a real video"));
  env.FFPROBE_PATH = "/definitely/missing/ffprobe";

  try {
    const outcome = await probeVideoFile(tempFile);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false ? outcome.reason : null, "unavailable");
  } finally {
    env.FFPROBE_PATH = previousPath;
    await fs.rm(tempFile, { force: true });
  }
});

test("probeVideoFile: a real ffprobe run against a non-video file is classified as unreadable via parseVideoProbeJson", async () => {
  const tempFile = `./tmp-probe-${Date.now()}.bin`;
  await fs.writeFile(tempFile, Buffer.from("this is definitely not a video container"));

  try {
    const outcome = await probeVideoFile(tempFile);
    // The real ffprobe binary exits non-zero (or emits no streams) for
    // arbitrary bytes — either way this must never report ok:true.
    assert.equal(outcome.ok, false);
  } finally {
    await fs.rm(tempFile, { force: true });
  }
});
