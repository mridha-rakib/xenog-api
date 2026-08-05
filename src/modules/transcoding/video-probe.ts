import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { env } from "../../config/env.js";

const execFileAsync = promisify(execFile);

const MAX_PROBE_OUTPUT_BYTES = 1024 * 1024;

export interface VideoStreamProbe {
  codecName: string | null;
  width: number | null;
  height: number | null;
  /** Normalized to one of 0/90/180/270, derived from side_data or the legacy rotate tag. */
  rotationDegrees: number;
  frameRate: number | null;
}

export interface AudioStreamProbe {
  codecName: string | null;
}

export interface VideoProbeResult {
  formatName: string | null;
  durationSeconds: number | null;
  hasVideoStream: boolean;
  hasAudioStream: boolean;
  video: VideoStreamProbe | null;
  /** Populated whenever an audio stream is present — used by output validation to confirm the encoded audio codec (e.g. AAC), not just its presence. */
  audio: AudioStreamProbe | null;
}

interface FfprobeSideDataEntry {
  side_data_type?: string;
  rotation?: number;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  tags?: Record<string, string>;
  side_data_list?: FfprobeSideDataEntry[];
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: {
    duration?: string;
    format_name?: string;
  };
}

const parseDuration = (value: string | undefined): number | null => {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const parseFrameRate = (value: string | undefined): number | null => {
  if (!value) {
    return null;
  }

  const [numerator, denominator] = value.split("/");
  const num = Number(numerator);
  const den = denominator === undefined ? 1 : Number(denominator);

  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) {
    return null;
  }

  const frameRate = num / den;
  return Number.isFinite(frameRate) && frameRate >= 0 ? frameRate : null;
};

const normalizeRotation = (degrees: number): number => {
  const normalized = ((Math.round(degrees) % 360) + 360) % 360;

  // Snap to the nearest cardinal rotation; side_data rotation values are
  // occasionally reported as e.g. -90.0000001 due to matrix math.
  if (normalized > 45 && normalized <= 135) return 90;
  if (normalized > 135 && normalized <= 225) return 180;
  if (normalized > 225 && normalized <= 315) return 270;
  return 0;
};

const extractRotationDegrees = (stream: FfprobeStream): number => {
  const sideDataRotation = stream.side_data_list?.find((entry) => typeof entry.rotation === "number")?.rotation;

  if (typeof sideDataRotation === "number") {
    return normalizeRotation(sideDataRotation);
  }

  const tagRotate = stream.tags?.rotate;

  if (tagRotate !== undefined) {
    const parsed = Number(tagRotate);

    if (Number.isFinite(parsed)) {
      return normalizeRotation(parsed);
    }
  }

  return 0;
};

/**
 * Parses raw `ffprobe -print_format json -show_format -show_streams` stdout
 * into a structured result. Pure — no I/O — so malformed/hostile JSON can be
 * exercised directly in tests without spawning a process.
 */
export const parseVideoProbeJson = (raw: string): VideoProbeResult | null => {
  let parsed: FfprobeOutput;

  try {
    parsed = JSON.parse(raw) as FfprobeOutput;
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const videoStream = streams.find((stream) => stream.codec_type === "video");
  const audioStream = streams.find((stream) => stream.codec_type === "audio");

  const durationSeconds = parseDuration(videoStream?.duration) ?? parseDuration(parsed.format?.duration);

  return {
    formatName: parsed.format?.format_name ?? null,
    durationSeconds,
    hasVideoStream: Boolean(videoStream),
    hasAudioStream: Boolean(audioStream),
    audio: audioStream ? { codecName: audioStream.codec_name ?? null } : null,
    video: videoStream
      ? {
          codecName: videoStream.codec_name ?? null,
          width: typeof videoStream.width === "number" && videoStream.width > 0 ? videoStream.width : null,
          height: typeof videoStream.height === "number" && videoStream.height > 0 ? videoStream.height : null,
          rotationDegrees: extractRotationDegrees(videoStream),
          frameRate: parseFrameRate(videoStream.r_frame_rate) ?? parseFrameRate(videoStream.avg_frame_rate),
        }
      : null,
  };
};

export type SourceValidationClassification =
  | "valid"
  | "no_video_stream"
  | "invalid_dimensions"
  | "duration_unavailable"
  | "duration_too_long";

/**
 * Classifies a parsed probe against the worker's hard limits. Pure — used by
 * both the source-validation path (permanent vs retryable failure) and unit
 * tests, independent of ffprobe actually running.
 */
export const classifySourceProbe = (
  probe: VideoProbeResult | null,
  maxDurationSeconds: number,
): SourceValidationClassification => {
  if (!probe || !probe.hasVideoStream || !probe.video) {
    return "no_video_stream";
  }

  if (!probe.video.width || !probe.video.height || probe.video.width <= 0 || probe.video.height <= 0) {
    return "invalid_dimensions";
  }

  if (probe.durationSeconds === null) {
    return "duration_unavailable";
  }

  if (probe.durationSeconds > maxDurationSeconds) {
    return "duration_too_long";
  }

  return "valid";
};

export type VideoProbeOutcome =
  | { ok: true; probe: VideoProbeResult }
  | { ok: false; reason: "unavailable" | "timeout" | "unreadable" };

/**
 * Runs ffprobe against a local file and returns a structured, parsed result.
 * Uses the same safe execFile/argument-array/bounded-buffer/timeout pattern
 * already proven in moment-video.service.ts's probeFile — never a shell
 * string, never a user-influenced executable path (env.FFPROBE_PATH only).
 */
export const probeVideoFile = async (filePath: string, timeoutMs: number = env.MEDIA_PROBE_TIMEOUT_MS): Promise<VideoProbeOutcome> => {
  let stdout: string;

  try {
    const result = await execFileAsync(
      env.FFPROBE_PATH,
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath],
      {
        encoding: "utf8",
        maxBuffer: MAX_PROBE_OUTPUT_BYTES,
        shell: false,
        timeout: timeoutMs,
        windowsHide: true,
      },
    );
    stdout = result.stdout;
  } catch (error) {
    const code = error && typeof error === "object" ? (error as { code?: string }).code : undefined;
    const killed = Boolean(error && typeof error === "object" && (error as { killed?: boolean }).killed);
    const signal = error && typeof error === "object" ? (error as { signal?: string }).signal : undefined;

    if (code === "ENOENT" || code === "EACCES") {
      return { ok: false, reason: "unavailable" };
    }

    if (code === "ETIMEDOUT" || killed || signal === "SIGTERM") {
      return { ok: false, reason: "timeout" };
    }

    return { ok: false, reason: "unreadable" };
  }

  const probe = parseVideoProbeJson(stdout);

  if (!probe) {
    return { ok: false, reason: "unreadable" };
  }

  return { ok: true, probe };
};
