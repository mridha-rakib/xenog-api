import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Types } from "mongoose";
import { AppError } from "../src/core/errors/app-error.js";
import { MomentVideoService } from "../src/modules/moments/moment-video.service.js";
import { StoryService } from "../src/modules/stories/story.service.js";
import { EventWindowService } from "../src/modules/event-windows/event-window.service.js";

// Video creation is temporarily disabled (ENABLE_VIDEO_UPLOADS defaults to
// disabled — see src/config/env.ts). These tests intentionally do NOT set
// process.env.ENABLE_VIDEO_UPLOADS, so every guard below is exercised in its
// real default state. Each "poison" fake dependency throws if any of its
// methods are called, proving the video guard short-circuits before any
// storage/DB access is attempted — not just that an error is eventually
// thrown somewhere downstream.

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const now = new Date("2026-08-12T12:00:00.000Z");
const userId = new Types.ObjectId().toString();
const user = {
  id: userId,
  name: "Tester",
  username: "tester",
  email: "tester@example.com",
  accountType: "personal",
  currentLocationSharingEnabled: false,
  notificationsEnabled: true,
  role: "user",
  isActive: true,
  emailVerified: true,
  createdAt: now,
  updatedAt: now,
} as const;

const poison = <T extends object>(label: string): T =>
  new Proxy({}, {
    get: (_target, prop) => {
      if (typeof prop !== "string") return undefined;
      return () => {
        throw new Error(`${label}.${prop} should not be called while video is disabled`);
      };
    },
  }) as T;

test("Moment video upload URL creation is rejected while video is disabled", async () => {
  const service = new MomentVideoService(poison("StorageService"));

  await assert.rejects(
    () => service.createUpload(user, "video/mp4"),
    (error: unknown) => error instanceof AppError && error.statusCode === 400,
  );
});

test("Moment video proxy upload is rejected while video is disabled", async () => {
  const service = new MomentVideoService(poison("StorageService"));

  await assert.rejects(
    () => service.uploadObject({
      user,
      key: `moments/${userId}/video/${randomUUID()}.mp4`,
      contentType: "video/mp4",
      body: Buffer.from("video"),
    }),
    (error: unknown) => error instanceof AppError && error.statusCode === 400,
  );
});

test("Moment video media item in POST /moments is rejected while video is disabled", async () => {
  const service = new MomentVideoService(poison("StorageService"));

  await assert.rejects(
    () => service.validateCreateMomentVideo(
      {
        type: "video",
        source: "upload",
        storageKey: `moments/${userId}/video/${randomUUID()}.mp4`,
        contentType: "video/mp4",
      },
      user,
    ),
    (error: unknown) => error instanceof AppError && error.statusCode === 400,
  );
});

test("Video Story creation is rejected while video is disabled; no repository call is made", async () => {
  const service = new StoryService(
    poison("StoryRepository"),
    poison("UserFollowRepository"),
    poison("StorageService"),
    poison("MomentRepository"),
  );

  await assert.rejects(
    () => service.createStory({
      mediaType: "video",
      mediaSource: "upload",
      storageKey: "stories/123.mp4",
      contentType: "video/mp4",
      durationSeconds: 10,
    }, user),
    (error: unknown) => error instanceof AppError && error.statusCode === 400,
  );
});

test("Event window creation rejects 'video' in allowedContentTypes while disabled; no repository call is made", async () => {
  const service = new EventWindowService(
    poison("EventWindowRepository"),
    poison("EventRepository"),
    poison("TicketUsageRepository"),
    poison("StorageService"),
  );

  await assert.rejects(
    () => service.createWindow(user, new Types.ObjectId().toString(), {
      startsAt: now,
      endsAt: new Date(now.getTime() + 60 * 60 * 1000),
      allowedContentTypes: ["image", "video"],
      maxPosts: 10,
    }),
    (error: unknown) => error instanceof AppError && error.statusCode === 400,
  );
});

test("Event window creation with only non-video content types is not blocked by the video guard", async () => {
  // Uses poison repositories too — this proves the video guard specifically
  // does not fire for an image-only window (it should fail later, on the
  // poisoned getEventForHost call, not on the video check).
  const service = new EventWindowService(
    poison("EventWindowRepository"),
    poison("EventRepository"),
    poison("TicketUsageRepository"),
    poison("StorageService"),
  );

  await assert.rejects(
    () => service.createWindow(user, new Types.ObjectId().toString(), {
      startsAt: now,
      endsAt: new Date(now.getTime() + 60 * 60 * 1000),
      allowedContentTypes: ["image", "text"],
      maxPosts: 10,
    }),
    /EventRepository\.findById should not be called/,
  );
});
