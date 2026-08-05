import type { ResolutionPlan } from "./resolution-plan.js";

// Pure argument-array builders. Every value returned here is a plain string
// array meant for `spawn`/`execFile` — never concatenated into a shell
// string, and never containing anything derived from a user-supplied
// filename (callers pass only worker-generated local paths).

export interface TranscodeArgsOptions {
  inputPath: string;
  outputPath: string;
  resolution: ResolutionPlan;
  hasAudio: boolean;
  crf: number;
  preset: string;
}

/**
 * Builds the ffmpeg argument array for the main video transcode.
 *
 * Fixed, non-configurable safety choices baked directly into this function
 * (never taken from env, never overridable): H.264 via libx264, a single
 * encoding thread, yuv420p pixel format, one video + at most one audio
 * stream, MP4 fast-start, and no upscaling (the scale filter is only added
 * when the resolution plan says a transform is actually needed).
 */
export const buildTranscodeArgs = (options: TranscodeArgsOptions): string[] => {
  const args: string[] = ["-y", "-i", options.inputPath, "-map", "0:v:0"];

  if (options.hasAudio) {
    args.push("-map", "0:a:0");
  }

  args.push(
    "-c:v",
    "libx264",
    "-preset",
    options.preset,
    "-crf",
    String(options.crf),
    "-threads",
    "1",
    "-pix_fmt",
    "yuv420p",
  );

  if (options.resolution.scaled) {
    args.push("-vf", `scale=${options.resolution.width}:${options.resolution.height}`);
  }

  if (options.hasAudio) {
    // Native AAC, conservative mobile-friendly stereo bitrate. Never invoked
    // when the source has no audio stream — see the -an branch below.
    args.push("-c:a", "aac", "-b:a", "128k", "-ac", "2");
  } else {
    // No audio stream in the source: produce an audio-less MP4. Do not pass
    // any audio codec/mapping arguments — passing -c:a with nothing mapped
    // to it is exactly the "invalid mapping" failure mode this must avoid.
    args.push("-an");
  }

  args.push(
    "-movflags",
    "+faststart",
    "-max_muxing_queue_size",
    "1024",
    options.outputPath,
  );

  return args;
};

export interface ThumbnailArgsOptions {
  inputPath: string;
  outputPath: string;
  timestampSeconds: number;
  resolution: ResolutionPlan;
}

/**
 * Builds the ffmpeg argument array for a single-frame JPEG thumbnail. `-ss`
 * is placed before `-i` for fast input seeking. Always scales to the same
 * planned (never-upscaled, even) dimensions as the video output, so the
 * thumbnail's aspect ratio and orientation always match the video.
 */
export const buildThumbnailArgs = (options: ThumbnailArgsOptions): string[] => [
  "-y",
  "-ss",
  options.timestampSeconds.toFixed(3),
  "-i",
  options.inputPath,
  "-frames:v",
  "1",
  "-vf",
  `scale=${options.resolution.width}:${options.resolution.height}`,
  "-q:v",
  "4",
  options.outputPath,
];

/**
 * Chooses a safe representative timestamp (in seconds) for the thumbnail
 * frame, given the source duration. Avoids frame 0 (often black/a transition
 * frame) for anything long enough to have a meaningful "a bit into the clip"
 * moment, but never seeks at or beyond the end, and never goes negative.
 */
export const planThumbnailTimestampSeconds = (durationSeconds: number): number => {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return 0;
  }

  if (durationSeconds < 1) {
    return 0;
  }

  const candidate = Math.min(1, durationSeconds * 0.1);
  const maxSafeTimestamp = Math.max(0, durationSeconds - 0.05);

  return Math.min(candidate, maxSafeTimestamp);
};
