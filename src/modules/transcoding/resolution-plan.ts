// Pure resolution-planning functions for the Phase 2 video worker. No I/O, no
// ffmpeg/ffprobe invocation — these only compute numbers so they can be
// exhaustively unit tested without a real video file or child process.

export type VideoOrientation = "landscape" | "portrait" | "square";

export interface EffectiveDimensions {
  width: number;
  height: number;
}

export interface ResolutionPlan {
  /** Target width/height to pass to ffmpeg's scale filter, already even. */
  width: number;
  height: number;
  orientation: VideoOrientation;
  /** False when the source already fit inside the bound and was left untouched. */
  scaled: boolean;
}

const LANDSCAPE_BOUND = { width: 1280, height: 720 } as const;
const PORTRAIT_BOUND = { width: 720, height: 1280 } as const;
const SQUARE_BOUND = { width: 720, height: 720 } as const;

/**
 * Resolves the *displayed* width/height of a video from its stored (coded)
 * stream dimensions plus an optional rotation tag. FFprobe reports `width`/
 * `height` for the stored frame, not the displayed one — a phone-recorded
 * portrait clip is frequently stored as a landscape frame with a 90/270
 * degree rotation tag. This must run before planTranscodeResolution, whose
 * orientation/bounding logic operates on the effective, as-displayed size.
 */
export const resolveEffectiveDimensions = (
  width: number,
  height: number,
  rotationDegrees?: number | null,
): EffectiveDimensions => {
  const normalizedRotation = ((rotationDegrees ?? 0) % 360 + 360) % 360;
  const isSwapped = normalizedRotation === 90 || normalizedRotation === 270;

  return isSwapped ? { width: height, height: width } : { width, height };
};

const floorToEven = (value: number): number => Math.max(2, Math.floor(value / 2) * 2);

const resolveOrientation = (width: number, height: number): VideoOrientation => {
  if (width > height) {
    return "landscape";
  }

  if (height > width) {
    return "portrait";
  }

  return "square";
};

const boundFor = (orientation: VideoOrientation): { width: number; height: number } => {
  switch (orientation) {
    case "landscape":
      return LANDSCAPE_BOUND;
    case "portrait":
      return PORTRAIT_BOUND;
    case "square":
      return SQUARE_BOUND;
  }
};

/**
 * Plans the maximum-720p, never-upscale output size for one video, given its
 * *effective* (already rotation-corrected) width/height.
 *
 * This intentionally does NOT use a "long edge = 720" rule: that would scale
 * an already-720p 1280x720 landscape source down to ~720x404, which is wrong
 * — 1280x720 must remain 1280x720. Instead this fits the source inside an
 * orientation-specific bounding box (1280x720 landscape / 720x1280 portrait /
 * 720x720 square) by the single scale factor that makes it fit both
 * dimensions, and never lets that factor exceed 1 (no upscaling). The result
 * is floored to the nearest even integer in each dimension, since H.264
 * requires even width/height, using floor (never round-up) so the output can
 * never exceed either the source size or the bounding box due to rounding.
 */
export const planTranscodeResolution = (sourceWidth: number, sourceHeight: number): ResolutionPlan => {
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) {
    throw new RangeError(`planTranscodeResolution requires positive finite dimensions, got ${sourceWidth}x${sourceHeight}`);
  }

  const orientation = resolveOrientation(sourceWidth, sourceHeight);
  const bound = boundFor(orientation);

  const scaleFactor = Math.min(1, bound.width / sourceWidth, bound.height / sourceHeight);

  const rawWidth = sourceWidth * scaleFactor;
  const rawHeight = sourceHeight * scaleFactor;

  const width = floorToEven(rawWidth);
  const height = floorToEven(rawHeight);

  return {
    width,
    height,
    orientation,
    scaled: width !== floorToEven(sourceWidth) || height !== floorToEven(sourceHeight),
  };
};
