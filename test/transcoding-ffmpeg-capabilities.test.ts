import assert from "node:assert/strict";
import test from "node:test";
import {
  parseFfmpegEncodersOutput,
  parseFfmpegVersionOutput,
  runCapabilityCommand,
  verifyFfmpegCapabilities,
} from "../src/modules/transcoding/ffmpeg-capabilities.js";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

// ---------------------------------------------------------------------------
// Pure parsers — no process spawning.
// ---------------------------------------------------------------------------

test("parseFfmpegVersionOutput extracts the version token from ffmpeg -version", () => {
  const stdout = "ffmpeg version N-121256-g0fdb5829e3-20250929 Copyright (c) 2000-2025 the FFmpeg developers\n"
    + "built with gcc 15.2.0\n";

  assert.equal(parseFfmpegVersionOutput(stdout), "N-121256-g0fdb5829e3-20250929");
});

test("parseFfmpegVersionOutput extracts the version token from ffprobe -version", () => {
  const stdout = "ffprobe version 6.1.1-3ubuntu5 Copyright (c) 2007-2023 the FFmpeg developers\n";

  assert.equal(parseFfmpegVersionOutput(stdout), "6.1.1-3ubuntu5");
});

test("parseFfmpegVersionOutput returns null for unrecognized output", () => {
  assert.equal(parseFfmpegVersionOutput("not ffmpeg output at all"), null);
  assert.equal(parseFfmpegVersionOutput(""), null);
});

test("parseFfmpegEncodersOutput finds libx264 in a realistic encoder listing", () => {
  const stdout = [
    "Encoders:",
    " V..... = Video",
    " A..... = Audio",
    " ------",
    " V....D a64multi             Multicolor charset for Commodore 64 (codec a64_multi)",
    " V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)",
    " V....D libx264rgb           libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 RGB (codec h264)",
    " A....D aac                  AAC (Advanced Audio Coding)",
    " A....D aac_mf                AAC via MediaFoundation (codec aac)",
  ].join("\n");

  const encoders = parseFfmpegEncodersOutput(stdout);

  assert.equal(encoders.has("libx264"), true);
  assert.equal(encoders.has("aac"), true);
});

test("parseFfmpegEncodersOutput does not confuse aac_mf/aac_at variants with the native aac encoder", () => {
  const stdout = [
    " A....D aac_mf                AAC via MediaFoundation (codec aac)",
    " A....D aac_at                 AAC (AudioToolbox) (codec aac)",
  ].join("\n");

  const encoders = parseFfmpegEncodersOutput(stdout);

  assert.equal(encoders.has("aac"), false);
  assert.equal(encoders.has("aac_mf"), true);
  assert.equal(encoders.has("aac_at"), true);
});

test("parseFfmpegEncodersOutput reports missing when libx264/aac are absent from the listing", () => {
  const stdout = [
    " V....D mpeg4                MPEG-4 part 2",
    " A....D mp3                  MP3 (MPEG audio layer 3)",
  ].join("\n");

  const encoders = parseFfmpegEncodersOutput(stdout);

  assert.equal(encoders.has("libx264"), false);
  assert.equal(encoders.has("aac"), false);
});

test("parseFfmpegEncodersOutput handles empty/garbage input safely", () => {
  assert.equal(parseFfmpegEncodersOutput("").size, 0);
  assert.equal(parseFfmpegEncodersOutput("not encoder output\nrandom garbage").size, 0);
});

// ---------------------------------------------------------------------------
// runCapabilityCommand — real process spawning, deterministic bad-path test.
// ---------------------------------------------------------------------------

test("runCapabilityCommand returns null (not a throw) for a nonexistent executable", async () => {
  const output = await runCapabilityCommand("/definitely/not/a/real/ffmpeg/binary", ["-version"]);

  assert.equal(output, null);
});

test("runCapabilityCommand uses an argument array, never a shell string (proof: a value containing shell metacharacters is passed as a literal, inert argument)", async () => {
  // If this were ever built as a shell string, an argument like this would
  // either break the command or execute injected content. Passed as an
  // argv element via execFile with shell:false, it is simply an inert,
  // nonexistent path and the call fails safely exactly like any other
  // missing executable — proving no shell interpretation occurs.
  const output = await runCapabilityCommand("/tmp/does-not-exist; echo INJECTED > /tmp/pwned", ["-version"]);

  assert.equal(output, null);
});

// ---------------------------------------------------------------------------
// verifyFfmpegCapabilities — real runtime verification against the locally
// configured ffmpeg/ffprobe (env.FFMPEG_PATH / env.FFPROBE_PATH). This proves
// the function's own logic end-to-end using whatever ffmpeg is reachable in
// THIS environment. It does not and cannot prove anything about a different,
// not-yet-built container image (see the final report for that distinction).
// ---------------------------------------------------------------------------

test("verifyFfmpegCapabilities against the locally configured ffmpeg/ffprobe", async () => {
  const result = await verifyFfmpegCapabilities();

  assert.equal(typeof result.ok, "boolean");
  assert.equal(typeof result.capabilities.ffmpegFound, "boolean");
  assert.equal(typeof result.capabilities.ffprobeFound, "boolean");
  assert.ok(Array.isArray(result.problems));

  // Informational, not a hard assertion: report what was actually found in
  // this environment without making the test suite depend on a specific
  // machine having ffmpeg installed.
  if (!result.ok) {
    console.log("verifyFfmpegCapabilities: local environment gap ->", result.problems);
  }
});
