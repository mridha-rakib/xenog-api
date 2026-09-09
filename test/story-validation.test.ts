import assert from "node:assert/strict";
import test from "node:test";

import { storyValidation } from "../src/modules/stories/story.validation.js";

const baseImageBody = {
  mediaType: "image" as const,
  mediaSource: "gallery" as const,
  storageKey: "stories/1.jpg",
  contentType: "image/jpeg",
  durationSeconds: 5,
};

test("createStory accepts a legacy payload with no transform/overlay fields", () => {
  const result = storyValidation.createStory.safeParse({ body: baseImageBody });

  assert.equal(result.success, true);
});

test("createStory accepts an imageTransform within the documented bounds", () => {
  const result = storyValidation.createStory.safeParse({
    body: {
      ...baseImageBody,
      imageTransform: { x: 0.2, y: 1.4, scale: 2.5, rotation: 90 },
    },
  });

  assert.equal(result.success, true);
});

test("createStory rejects an imageTransform scale outside MIN/MAX_IMAGE_SCALE", () => {
  const result = storyValidation.createStory.safeParse({
    body: {
      ...baseImageBody,
      imageTransform: { x: 0.5, y: 0.5, scale: 10, rotation: 0 },
    },
  });

  assert.equal(result.success, false);
});

test("createStory rejects an imageTransform position past the off-canvas allowance", () => {
  const result = storyValidation.createStory.safeParse({
    body: {
      ...baseImageBody,
      imageTransform: { x: 5, y: 0.5, scale: 1, rotation: 0 },
    },
  });

  assert.equal(result.success, false);
});

test("createStory accepts textOverlay.rotation and keeps it optional", () => {
  const withRotation = storyValidation.createStory.safeParse({
    body: {
      ...baseImageBody,
      textOverlay: { text: "hi", x: 0.5, y: 0.5, scale: 1, color: "#FFFFFF", rotation: -45 },
    },
  });
  const withoutRotation = storyValidation.createStory.safeParse({
    body: {
      ...baseImageBody,
      textOverlay: { text: "hi", x: 0.5, y: 0.5, scale: 1, color: "#FFFFFF" },
    },
  });

  assert.equal(withRotation.success, true);
  assert.equal(withoutRotation.success, true);
});

test("createStory rejects an unknown top-level field (schema is .strict())", () => {
  const result = storyValidation.createStory.safeParse({
    body: { ...baseImageBody, someUnrelatedField: true },
  });

  assert.equal(result.success, false);
});

// --- text style controls: image-overlay textOverlay ---------------------------

const baseOverlay = { text: "hi", x: 0.5, y: 0.5, scale: 1, color: "#FFFFFF" };

test("textOverlay.fontWeight accepts the new '800' (Heavy) value", () => {
  const result = storyValidation.createStory.safeParse({
    body: { ...baseImageBody, textOverlay: { ...baseOverlay, fontWeight: "800" } },
  });
  assert.equal(result.success, true);
});

test("textOverlay.fontWeight still accepts legacy 'bold'", () => {
  const result = storyValidation.createStory.safeParse({
    body: { ...baseImageBody, textOverlay: { ...baseOverlay, fontWeight: "bold" } },
  });
  assert.equal(result.success, true);
});

test("textOverlay.fontWeight rejects an unsupported weight", () => {
  const result = storyValidation.createStory.safeParse({
    body: { ...baseImageBody, textOverlay: { ...baseOverlay, fontWeight: "900" } },
  });
  assert.equal(result.success, false);
});

test("textOverlay.shadow accepts true and false, and defaults to true when omitted", () => {
  const on = storyValidation.createStory.safeParse({
    body: { ...baseImageBody, textOverlay: { ...baseOverlay, shadow: true } },
  });
  const off = storyValidation.createStory.safeParse({
    body: { ...baseImageBody, textOverlay: { ...baseOverlay, shadow: false } },
  });
  const missing = storyValidation.createStory.safeParse({
    body: { ...baseImageBody, textOverlay: { ...baseOverlay } },
  });

  assert.equal(on.success, true);
  assert.equal(off.success, true);
  assert.equal(missing.success, true);
  assert.equal(off.success && off.data.body.textOverlay?.shadow, false);
  assert.equal(missing.success && missing.data.body.textOverlay?.shadow, true);
});

// --- text style controls: text-only Story textStyle --------------------------

const baseTextBody = {
  mediaType: "text" as const,
  mediaSource: "upload" as const,
  durationSeconds: 5,
  textContent: "hello",
};

test("createStory accepts a text Story with no textStyle (legacy shape)", () => {
  const result = storyValidation.createStory.safeParse({ body: baseTextBody });
  assert.equal(result.success, true);
});

test("textStyle accepts every supported fontWeight", () => {
  for (const fontWeight of ["normal", "600", "700", "800"]) {
    const result = storyValidation.createStory.safeParse({
      body: { ...baseTextBody, textStyle: { fontWeight } },
    });
    assert.equal(result.success, true, `expected ${fontWeight} to be accepted`);
  }
});

test("textStyle rejects an unsupported fontWeight (e.g. legacy 'bold')", () => {
  const result = storyValidation.createStory.safeParse({
    body: { ...baseTextBody, textStyle: { fontWeight: "bold" } },
  });
  assert.equal(result.success, false);
});

test("textStyle accepts a valid hex color and rejects a non-hex color", () => {
  const ok = storyValidation.createStory.safeParse({
    body: { ...baseTextBody, textStyle: { color: "#A855F7" } },
  });
  const bad = storyValidation.createStory.safeParse({
    body: { ...baseTextBody, textStyle: { color: "rebeccapurple" } },
  });
  assert.equal(ok.success, true);
  assert.equal(bad.success, false);
});

test("textStyle accepts left/center/right and rejects any other alignment", () => {
  for (const textAlign of ["left", "center", "right"]) {
    const result = storyValidation.createStory.safeParse({
      body: { ...baseTextBody, textStyle: { textAlign } },
    });
    assert.equal(result.success, true, `expected ${textAlign} to be accepted`);
  }
  const bad = storyValidation.createStory.safeParse({
    body: { ...baseTextBody, textStyle: { textAlign: "justify" } },
  });
  assert.equal(bad.success, false);
});

test("textStyle accepts shadow true/false and applies the documented defaults when omitted", () => {
  const off = storyValidation.createStory.safeParse({
    body: { ...baseTextBody, textStyle: { shadow: false } },
  });
  const empty = storyValidation.createStory.safeParse({
    body: { ...baseTextBody, textStyle: {} },
  });

  assert.equal(off.success, true);
  assert.equal(empty.success, true);
  assert.equal(off.success && off.data.body.textStyle?.shadow, false);
  if (empty.success) {
    assert.deepEqual(empty.data.body.textStyle, {
      fontWeight: "800",
      color: "#FFFFFF",
      textAlign: "center",
      shadow: true,
    });
  }
});

test("textStyle is optional at the outer level — it never auto-attaches to image Stories", () => {
  const result = storyValidation.createStory.safeParse({ body: baseImageBody });
  assert.equal(result.success, true);
  assert.equal(result.success && result.data.body.textStyle, undefined);
});
