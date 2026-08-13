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
