import type { VideoProbeResult } from "./video-probe.js";

// Pure, no I/O — these only classify already-obtained probe results/bytes so
// they can be exhaustively unit tested without a real ffmpeg/ffprobe run.
// Never trusts FFmpeg's own exit code alone: the worker must independently
// re-probe and inspect whatever FFmpeg actually produced before it is ever
// uploaded or the job is marked complete.

/** How far the encoded output's duration may drift from the source's before it is treated as a real problem rather than probe/encoder rounding. */
export const OUTPUT_DURATION_TOLERANCE_SECONDS = 2;

export type OptimizedOutputInvalidReason =
  | "unreadable"
  | "not_mp4_compatible"
  | "wrong_video_codec"
  | "missing_dimensions"
  | "wrong_dimensions"
  | "odd_dimensions"
  | "missing_duration"
  | "duration_drift"
  | "zero_byte_output"
  | "missing_expected_audio"
  | "unexpected_audio"
  | "wrong_audio_codec";

export type OptimizedOutputValidationResult =
  | { ok: true }
  | { ok: false; reason: OptimizedOutputInvalidReason };

export interface ValidateOptimizedOutputParams {
  /** null when ffprobe could not read the produced file at all. */
  probe: VideoProbeResult | null;
  expectedWidth: number;
  expectedHeight: number;
  sourceHasAudio: boolean;
  sourceDurationSeconds: number | null;
  outputFileSizeBytes: number;
}

/**
 * Validates a produced optimized-output file against the plan that was used
 * to encode it, independent of ffmpeg's own reported exit status. Every
 * check here is deliberately narrow and structural — codec/dimension/
 * duration/audio-presence — never a byte-for-byte content comparison.
 */
export const validateOptimizedOutput = (params: ValidateOptimizedOutputParams): OptimizedOutputValidationResult => {
  if (params.outputFileSizeBytes <= 0) {
    return { ok: false, reason: "zero_byte_output" };
  }

  if (!params.probe) {
    return { ok: false, reason: "unreadable" };
  }

  if (!params.probe.formatName || !params.probe.formatName.includes("mp4")) {
    return { ok: false, reason: "not_mp4_compatible" };
  }

  if (!params.probe.hasVideoStream || !params.probe.video) {
    return { ok: false, reason: "unreadable" };
  }

  if (params.probe.video.codecName !== "h264") {
    return { ok: false, reason: "wrong_video_codec" };
  }

  const { width, height } = params.probe.video;

  if (width === null || height === null || width <= 0 || height <= 0) {
    return { ok: false, reason: "missing_dimensions" };
  }

  if (width % 2 !== 0 || height % 2 !== 0) {
    return { ok: false, reason: "odd_dimensions" };
  }

  if (width !== params.expectedWidth || height !== params.expectedHeight) {
    return { ok: false, reason: "wrong_dimensions" };
  }

  if (params.probe.durationSeconds === null || params.probe.durationSeconds <= 0) {
    return { ok: false, reason: "missing_duration" };
  }

  if (params.sourceDurationSeconds !== null) {
    const drift = Math.abs(params.probe.durationSeconds - params.sourceDurationSeconds);

    if (drift > OUTPUT_DURATION_TOLERANCE_SECONDS) {
      return { ok: false, reason: "duration_drift" };
    }
  }

  if (params.sourceHasAudio) {
    if (!params.probe.hasAudioStream || !params.probe.audio) {
      return { ok: false, reason: "missing_expected_audio" };
    }

    if (params.probe.audio.codecName !== "aac") {
      return { ok: false, reason: "wrong_audio_codec" };
    }
  } else if (params.probe.hasAudioStream) {
    return { ok: false, reason: "unexpected_audio" };
  }

  return { ok: true };
};

const JPEG_SOI = [0xff, 0xd8, 0xff];
const JPEG_EOI = [0xff, 0xd9];

/**
 * Smallest safe local thumbnail check: confirms the file starts with a JPEG
 * SOI marker, ends with a JPEG EOI marker, and is non-trivially sized. Not a
 * full JPEG parse — just enough to reject a truncated/corrupt/non-image
 * output without spawning another ffprobe process for a single small file.
 */
export const isValidJpegThumbnail = (buffer: Buffer): boolean => {
  if (buffer.length < 16) {
    return false;
  }

  const hasSoi = JPEG_SOI.every((byte, index) => buffer[index] === byte);
  const hasEoi = JPEG_EOI.every((byte, index) => buffer[buffer.length - JPEG_EOI.length + index] === byte);

  return hasSoi && hasEoi;
};
