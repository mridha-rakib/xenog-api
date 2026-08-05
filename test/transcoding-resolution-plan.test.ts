import assert from "node:assert/strict";
import test from "node:test";
import {
  planTranscodeResolution,
  resolveEffectiveDimensions,
} from "../src/modules/transcoding/resolution-plan.js";

const cases: Array<[number, number, number, number, string]> = [
  [640, 360, 640, 360, "small landscape 16:9 stays unchanged"],
  [640, 480, 640, 480, "small landscape 4:3 stays unchanged"],
  [1280, 720, 1280, 720, "exact 720p landscape stays unchanged (not the naive long-edge=720 bug)"],
  [1920, 1080, 1280, 720, "1080p landscape downscales to 1280x720"],
  [3840, 2160, 1280, 720, "4K landscape downscales to 1280x720"],
  [360, 640, 360, 640, "small portrait 9:16 stays unchanged"],
  [480, 640, 480, 640, "small portrait 3:4 stays unchanged"],
  [720, 1280, 720, 1280, "exact 720p portrait stays unchanged"],
  [1080, 1920, 720, 1280, "1080p portrait downscales to 720x1280"],
  [2160, 3840, 720, 1280, "4K portrait downscales to 720x1280"],
  [720, 720, 720, 720, "square 720 stays unchanged"],
  [1080, 1080, 720, 720, "square 1080 downscales to 720x720"],
];

for (const [sourceWidth, sourceHeight, expectedWidth, expectedHeight, label] of cases) {
  test(`planTranscodeResolution: ${sourceWidth}x${sourceHeight} -> ${expectedWidth}x${expectedHeight} (${label})`, () => {
    const plan = planTranscodeResolution(sourceWidth, sourceHeight);

    assert.equal(plan.width, expectedWidth);
    assert.equal(plan.height, expectedHeight);
  });
}

test("orientation is classified correctly for landscape, portrait, and square", () => {
  assert.equal(planTranscodeResolution(1920, 1080).orientation, "landscape");
  assert.equal(planTranscodeResolution(1080, 1920).orientation, "portrait");
  assert.equal(planTranscodeResolution(1080, 1080).orientation, "square");
});

test("never upscales a source smaller than the bounding box in either dimension", () => {
  const plan = planTranscodeResolution(320, 180);

  assert.equal(plan.width, 320);
  assert.equal(plan.height, 180);
  assert.equal(plan.scaled, false);
});

test("width and height are always even", () => {
  for (const [width, height] of [[1921, 1081], [641, 361], [3841, 2161], [101, 57], [1279, 719]]) {
    const plan = planTranscodeResolution(width!, height!);

    assert.equal(plan.width % 2, 0, `width ${plan.width} for ${width}x${height} must be even`);
    assert.equal(plan.height % 2, 0, `height ${plan.height} for ${width}x${height} must be even`);
  }
});

test("odd source dimensions resolve to the nearest safe even size without meaningful distortion", () => {
  // 641x361 is landscape, close to 640x360 (16:9). Floor-to-even should land
  // on 640x360, not drift the aspect ratio noticeably.
  const plan = planTranscodeResolution(641, 361);

  assert.equal(plan.width, 640);
  assert.equal(plan.height, 360);

  const sourceRatio = 641 / 361;
  const outputRatio = plan.width / plan.height;
  assert.ok(Math.abs(sourceRatio - outputRatio) < 0.02, `aspect ratio drifted too far: ${sourceRatio} vs ${outputRatio}`);
});

test("a large odd 4K-ish source downscales to the 720p bound with even dimensions", () => {
  const plan = planTranscodeResolution(3839, 2159);

  assert.equal(plan.width % 2, 0);
  assert.equal(plan.height % 2, 0);
  assert.ok(plan.width <= 1280);
  assert.ok(plan.height <= 720);
});

test("output dimensions never exceed the source (guards against rounding introducing upscale)", () => {
  for (const [width, height] of [[1281, 719], [641, 360], [1279, 721]]) {
    const plan = planTranscodeResolution(width!, height!);

    assert.ok(plan.width <= width!, `planned width ${plan.width} exceeded source ${width}`);
    assert.ok(plan.height <= height!, `planned height ${plan.height} exceeded source ${height}`);
  }
});

test("throws on non-positive or non-finite input rather than silently producing invalid output", () => {
  assert.throws(() => planTranscodeResolution(0, 100));
  assert.throws(() => planTranscodeResolution(100, 0));
  assert.throws(() => planTranscodeResolution(-100, 100));
  assert.throws(() => planTranscodeResolution(Number.NaN, 100));
  assert.throws(() => planTranscodeResolution(100, Number.POSITIVE_INFINITY));
});

// ---------------------------------------------------------------------------
// resolveEffectiveDimensions (rotation handling)
// ---------------------------------------------------------------------------

test("resolveEffectiveDimensions leaves dimensions unchanged with no rotation", () => {
  assert.deepEqual(resolveEffectiveDimensions(1920, 1080, 0), { width: 1920, height: 1080 });
  assert.deepEqual(resolveEffectiveDimensions(1920, 1080, null), { width: 1920, height: 1080 });
  assert.deepEqual(resolveEffectiveDimensions(1920, 1080, undefined), { width: 1920, height: 1080 });
});

test("resolveEffectiveDimensions swaps dimensions for a 90-degree rotation", () => {
  // A phone recorded in portrait but stored as a rotated 1920x1080 stream.
  assert.deepEqual(resolveEffectiveDimensions(1920, 1080, 90), { width: 1080, height: 1920 });
});

test("resolveEffectiveDimensions swaps dimensions for a 270-degree (or -90) rotation", () => {
  assert.deepEqual(resolveEffectiveDimensions(1920, 1080, 270), { width: 1080, height: 1920 });
  assert.deepEqual(resolveEffectiveDimensions(1920, 1080, -90), { width: 1080, height: 1920 });
});

test("resolveEffectiveDimensions does not swap for a 180-degree rotation (upside down, same orientation)", () => {
  assert.deepEqual(resolveEffectiveDimensions(1920, 1080, 180), { width: 1920, height: 1080 });
});

test("resolution planning composes correctly with rotation: a rotated 4K stream plans as portrait", () => {
  const effective = resolveEffectiveDimensions(3840, 2160, 90);
  const plan = planTranscodeResolution(effective.width, effective.height);

  assert.equal(plan.orientation, "portrait");
  assert.equal(plan.width, 720);
  assert.equal(plan.height, 1280);
});
