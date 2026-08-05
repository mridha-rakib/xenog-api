import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { env } from "../../config/env.js";
import { logger } from "../../core/logger/logger.js";

const execFileAsync = promisify(execFile);

const MAX_CAPABILITY_OUTPUT_BYTES = 1024 * 1024;
const CAPABILITY_CHECK_TIMEOUT_MS = 10_000;

export interface FfmpegCapabilities {
  ffmpegFound: boolean;
  ffmpegVersion: string | null;
  ffprobeFound: boolean;
  ffprobeVersion: string | null;
  hasLibx264: boolean;
  hasAac: boolean;
}

export interface FfmpegCapabilityResult {
  ok: boolean;
  capabilities: FfmpegCapabilities;
  /** Short, safe (no paths/credentials) reasons the check failed, for logging. */
  problems: string[];
}

/**
 * Parses `ffmpeg -version`'s first line, e.g.
 * "ffmpeg version N-121256-g0fdb5829e3-20250929 Copyright (c) 2000-2025 ...".
 * Returns just the version token, or null if the format is unrecognized.
 */
export const parseFfmpegVersionOutput = (stdout: string): string | null => {
  const match = /^\s*ff(?:mpeg|probe)\s+version\s+(\S+)/m.exec(stdout);
  return match?.[1] ?? null;
};

/**
 * Parses `ffmpeg -encoders` output into the set of available encoder names.
 * Each row looks like ` V....D libx264              libx264 H.264 / AVC ...`
 * — flags, whitespace, the exact encoder name, whitespace, description. This
 * intentionally matches the encoder name as a whole token so "aac" does not
 * incorrectly match "aac_mf"/"aac_at"/etc. variants.
 */
export const parseFfmpegEncodersOutput = (stdout: string): Set<string> => {
  const encoders = new Set<string>();
  const lines = stdout.split("\n");

  for (const line of lines) {
    const match = /^\s*[VASDX.]{6}\s+(\S+)\s+\S/.exec(line);

    if (match?.[1]) {
      encoders.add(match[1]);
    }
  }

  return encoders;
};

/**
 * Runs one capability-check command (e.g. `-version`, `-encoders`) and
 * returns its stdout, or null if the executable could not be run at all
 * (missing, not executable, timed out). Exported separately from
 * verifyFfmpegCapabilities so tests can exercise "executable not found"
 * deterministically with an arbitrary path, without depending on the
 * once-parsed env.FFMPEG_PATH/env.FFPROBE_PATH singleton.
 */
export const runCapabilityCommand = async (executablePath: string, args: string[]): Promise<string | null> => {
  try {
    const result = await execFileAsync(executablePath, args, {
      encoding: "utf8",
      maxBuffer: MAX_CAPABILITY_OUTPUT_BYTES,
      shell: false,
      timeout: CAPABILITY_CHECK_TIMEOUT_MS,
      windowsHide: true,
    });

    return result.stdout;
  } catch {
    return null;
  }
};

/**
 * Verifies that the configured FFmpeg/FFprobe executables are reachable and
 * that the specific encoders this worker requires (libx264, native aac) are
 * built into this FFmpeg. Always uses argument arrays via execFile — never a
 * shell string — and never accepts a path from anything but validated
 * environment configuration (env.FFMPEG_PATH / env.FFPROBE_PATH).
 *
 * This only proves the *currently reachable* ffmpeg/ffprobe (wherever
 * env.FFMPEG_PATH/env.FFPROBE_PATH point on the machine this runs on) has
 * these capabilities — it says nothing about a different, not-yet-built
 * container image.
 */
export const verifyFfmpegCapabilities = async (): Promise<FfmpegCapabilityResult> => {
  const problems: string[] = [];

  const [versionOutput, probeVersionOutput, encodersOutput] = await Promise.all([
    runCapabilityCommand(env.FFMPEG_PATH, ["-version"]),
    runCapabilityCommand(env.FFPROBE_PATH, ["-version"]),
    runCapabilityCommand(env.FFMPEG_PATH, ["-hide_banner", "-encoders"]),
  ]);

  const ffmpegFound = versionOutput !== null;
  const ffprobeFound = probeVersionOutput !== null;
  const ffmpegVersion = versionOutput ? parseFfmpegVersionOutput(versionOutput) : null;
  const ffprobeVersion = probeVersionOutput ? parseFfmpegVersionOutput(probeVersionOutput) : null;
  const encoders = encodersOutput ? parseFfmpegEncodersOutput(encodersOutput) : new Set<string>();
  const hasLibx264 = encoders.has("libx264");
  const hasAac = encoders.has("aac");

  if (!ffmpegFound) {
    problems.push("ffmpeg executable is not reachable");
  }

  if (!ffprobeFound) {
    problems.push("ffprobe executable is not reachable");
  }

  if (ffmpegFound && !hasLibx264) {
    problems.push("libx264 encoder is not available in this ffmpeg build");
  }

  if (ffmpegFound && !hasAac) {
    problems.push("aac encoder is not available in this ffmpeg build");
  }

  const capabilities: FfmpegCapabilities = {
    ffmpegFound,
    ffmpegVersion,
    ffprobeFound,
    ffprobeVersion,
    hasLibx264,
    hasAac,
  };

  const ok = ffmpegFound && ffprobeFound && hasLibx264 && hasAac;

  if (!ok) {
    logger.error({ problems, capabilities }, "FFmpeg capability verification failed");
  } else {
    logger.info({ ffmpegVersion, ffprobeVersion }, "FFmpeg capability verification passed");
  }

  return { ok, capabilities, problems };
};
