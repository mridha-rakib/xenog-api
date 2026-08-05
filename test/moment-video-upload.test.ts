import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import crypto from "node:crypto";
import { once } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";
import express from "express";
import { Types } from "mongoose";
import { AppError } from "../src/core/errors/app-error.js";
import { MomentService } from "../src/modules/moments/moment.service.js";
import {
  MomentVideoService,
  createMomentVideoStorageKey,
  isOwnedMomentVideoStorageKey,
} from "../src/modules/moments/moment-video.service.js";
import { momentRoutes } from "../src/modules/moments/moment.route.js";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const userId = new Types.ObjectId().toString();
const otherUserId = new Types.ObjectId().toString();
const now = new Date("2026-08-02T12:00:00.000Z");
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
};

class FakeStorageService {
  public readonly deletedKeys: string[] = [];
  public readonly metadataCalls: string[] = [];
  // Deliberately still tracked: every test below that reaches a "valid"
  // classification must assert this stays empty — POST /moments now proves
  // its HEAD-only availability check (see MomentVideoService's
  // checkStorageVideoAvailability) never calls getObject() to download the
  // source, unlike the removed synchronous full-file ffprobe path.
  public readonly objectCalls: string[] = [];
  public readonly uploads: Array<{ key: string; contentType: string; bytes: number }> = [];
  public metadata = new Map<string, { contentLength?: number; contentType?: string }>();

  public async createUploadUrl(payload: { key: string; contentType: string; expiresIn?: number }) {
    return { ...payload, url: `https://storage.example/${payload.key}` };
  }

  public async uploadObject(payload: { key: string; contentType: string; body: Buffer }) {
    this.uploads.push({ key: payload.key, contentType: payload.contentType, bytes: payload.body.length });
    return { key: payload.key };
  }

  public async getObjectMetadata(key: string) {
    this.metadataCalls.push(key);
    const metadata = this.metadata.get(key);

    if (!metadata) {
      const error = new Error("missing") as Error & { $metadata?: { httpStatusCode?: number }; Code?: string };
      error.$metadata = { httpStatusCode: 404 };
      error.Code = "NoSuchKey";
      throw error;
    }

    return metadata;
  }

  public async getObject(key: string) {
    this.objectCalls.push(key);
    return {
      body: Readable.from([Buffer.from("video")]),
      contentLength: this.metadata.get(key)?.contentLength,
      contentType: this.metadata.get(key)?.contentType,
    };
  }

  public async deleteObject(key: string) {
    this.deletedKeys.push(key);
  }
}

const createMomentService = (momentVideoService: MomentVideoService, repositoryOverrides: Record<string, unknown> = {}) => {
  const momentRepository = {
    create: async (payload: Record<string, unknown>) => ({
      _id: new Types.ObjectId(),
      userId: new Types.ObjectId(userId),
      mode: payload.mode,
      caption: payload.caption,
      hashtags: [],
      audience: payload.audience,
      taggedPeople: payload.taggedPeople,
      taggedFriendIds: payload.taggedFriendIds,
      eventTitle: payload.eventTitle,
      eventId: payload.eventId,
      eventCode: payload.eventCode,
      mediaItems: payload.mediaItems,
      createdAt: now,
      updatedAt: now,
    }),
    ...repositoryOverrides,
  };

  return new MomentService(
    momentRepository as never,
    { createDownloadUrl: async () => ({ url: "" }) } as never,
    {
      findByIds: async () => [],
      findById: async () => null,
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {
      countByMomentId: async () => 0,
      findLikedMomentIds: async () => new Set<string>(),
    } as never,
    {
      countByMomentId: async () => 0,
    } as never,
    {} as never,
    { findSavedMomentIds: async () => new Set<string>() } as never,
    { findById: async () => null } as never,
    {} as never,
    {} as never,
    momentVideoService,
    // Fake TranscodingMomentSyncService: none of these tests exercise
    // Phase 3A job creation (see test/moment-video-transcoding.test.ts for
    // that), so this stays offline and simply reports "no job created" —
    // createMoment() must fall back to the moment as originally persisted.
    { queueNewVideoJob: async () => null } as never,
  );
};

const createPayload = (key: string, overrides: Record<string, unknown> = {}) => ({
  mode: "feed" as const,
  caption: "video",
  audience: "public" as const,
  taggedPeople: [],
  taggedFriendIds: [],
  mediaItems: [{
    type: "video" as const,
    source: "upload" as const,
    storageKey: key,
    contentType: "video/mp4",
    durationSeconds: 1,
    ...overrides,
  }],
});

test("unauthenticated Moment video upload request is rejected", async () => {
  const app = express();
  app.use(express.json());
  app.use("/moments", momentRoutes);
  app.use((error: unknown, _req: unknown, res: { status: (status: number) => { json: (body: unknown) => void } }, _next: unknown) => {
    const appError = error as AppError;
    res.status(appError.statusCode ?? 500).json({ message: appError.message });
  });
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.notEqual(address, null);

  try {
    const port = typeof address === "object" && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/moments/video-upload-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentType: "video/mp4" }),
    });
    assert.equal(response.status, 401);
  } finally {
    server.close();
  }
});

test("backend generates user-scoped Moment video keys and ignores client user IDs", async () => {
  const key = createMomentVideoStorageKey(userId, "video/mp4");
  assert.match(key, new RegExp(`^moments/${userId}/video/[a-f\\d-]{36}\\.mp4$`, "i"));
  assert.equal(isOwnedMomentVideoStorageKey(key, userId), true);
  assert.equal(isOwnedMomentVideoStorageKey(key, otherUserId), false);
});

test("Moment video upload object requires an owned Moment-video key", async () => {
  const storage = new FakeStorageService();
  const service = new MomentVideoService(storage as never);

  await assert.rejects(
    service.uploadObject({
      user: user as never,
      key: `moments/${otherUserId}/video/${crypto.randomUUID()}.mp4`,
      contentType: "video/mp4",
      body: Buffer.from("video"),
    }),
    /not available/,
  );
  assert.equal(storage.uploads.length, 0);
});

test("User A cannot create a Moment with User B or non-Moment video keys", async () => {
  const storage = new FakeStorageService();
  const service = createMomentService(new MomentVideoService(storage as never));

  await assert.rejects(
    service.createMoment(createPayload(createMomentVideoStorageKey(otherUserId, "video/mp4")), user as never),
    /not available/,
  );
  await assert.rejects(
    service.createMoment(createPayload("moments/image/not-video.mp4"), user as never),
    /not available/,
  );
  assert.deepEqual(storage.deletedKeys, []);
  assert.deepEqual(storage.metadataCalls, []);
});

test("arbitrary URLs are rejected and not probed", async () => {
  const storage = new FakeStorageService();
  const service = createMomentService(new MomentVideoService(storage as never));

  await assert.rejects(
    service.createMoment(createPayload("", { storageKey: null, url: "https://example.com/video.mp4" }), user as never),
    /uploaded video file/,
  );
  assert.deepEqual(storage.metadataCalls, []);
});

test("valid owned Moment video is created from S3 HEAD metadata alone — no full source download, and client-declared duration is never trusted", async () => {
  const key = createMomentVideoStorageKey(userId, "video/mp4");
  const storage = new FakeStorageService();
  storage.metadata.set(key, { contentLength: 1000, contentType: "video/mp4" });
  let persisted: Record<string, unknown> | null = null;
  const service = createMomentService(new MomentVideoService(storage as never), {
    create: async (payload: Record<string, unknown>) => {
      persisted = payload;
      return {
        _id: new Types.ObjectId(),
        userId: new Types.ObjectId(userId),
        mode: "feed",
        caption: "video",
        hashtags: [],
        audience: "public",
        taggedPeople: [],
        taggedFriendIds: [],
        eventTitle: null,
        eventId: null,
        eventCode: null,
        mediaItems: payload.mediaItems,
        createdAt: now,
        updatedAt: now,
      };
    },
  });

  await service.createMoment(createPayload(key, { durationSeconds: 999 }), user as never);
  assert.deepEqual(storage.metadataCalls, [key]);
  // The core latency fix: POST /moments must never call getObject() (a full
  // source download) merely to validate a video upload — the transcoding
  // worker performs the authoritative ffprobe validation on its own
  // downloaded copy instead.
  assert.deepEqual(storage.objectCalls, []);
  assert.deepEqual(storage.deletedKeys, []);
  const mediaItems = persisted?.mediaItems as Array<{ durationSeconds?: number | null }> | undefined;
  // Never the client-supplied 999 — no bytes were decoded here to verify it,
  // so it stays unset until the worker's authoritative probe repoints it at
  // "ready" (see MomentMediaLifecycleService.markReady).
  assert.equal(mediaItems?.[0]?.durationSeconds, null);
});

test("generic camera upload MIME metadata is accepted based on the client-declared content type, without downloading the object", async () => {
  const key = createMomentVideoStorageKey(userId, "video/mp4");
  const storage = new FakeStorageService();
  storage.metadata.set(key, { contentLength: 1000, contentType: "application/octet-stream" });
  const service = createMomentService(new MomentVideoService(storage as never));

  await service.createMoment(createPayload(key), user as never);
  assert.deepEqual(storage.metadataCalls, [key]);
  assert.deepEqual(storage.objectCalls, []);
  assert.deepEqual(storage.deletedKeys, []);
});

test("zero-byte object is rejected as unreadable and cleaned up after ownership is proven", async () => {
  const key = createMomentVideoStorageKey(userId, "video/mp4");
  const storage = new FakeStorageService();
  storage.metadata.set(key, { contentLength: 0, contentType: "video/mp4" });
  const service = createMomentService(new MomentVideoService(storage as never));

  await assert.rejects(service.createMoment(createPayload(key), user as never), /could not read/);
  assert.deepEqual(storage.objectCalls, []);
  assert.deepEqual(storage.deletedKeys, [key]);
});

test("an unexpected (non-AWS-shaped) metadata error is treated as unreadable, not silently allowed through", async () => {
  const key = createMomentVideoStorageKey(userId, "video/mp4");
  const storage = new FakeStorageService();
  storage.getObjectMetadata = async () => {
    throw new Error("totally unexpected failure shape");
  };
  let createCalled = false;
  const service = createMomentService(new MomentVideoService(storage as never), {
    create: async () => {
      createCalled = true;
      throw new Error("should not persist");
    },
  });

  await assert.rejects(service.createMoment(createPayload(key), user as never), /could not read/);
  assert.deepEqual(storage.deletedKeys, [key]);
  assert.equal(createCalled, false);
});

test("retryable AWS metadata failure does not masquerade as unreadable video", async () => {
  const key = createMomentVideoStorageKey(userId, "video/mp4");
  const storage = new FakeStorageService();
  storage.getObjectMetadata = async () => {
    const error = new Error("slow down") as Error & { $metadata?: { httpStatusCode?: number }; Code?: string };
    error.$metadata = { httpStatusCode: 503 };
    error.Code = "SlowDown";
    throw error;
  };
  const service = createMomentService(new MomentVideoService(storage as never));

  await assert.rejects(
    service.createMoment(createPayload(key), user as never),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 503);
      assert.match(error.message, /verify this video right now/);
      assert.doesNotMatch(error.message, /could not read/);
      return true;
    },
  );
  assert.deepEqual(storage.deletedKeys, []);
});

test("missing S3 object rejects without deleting", async () => {
  const key = createMomentVideoStorageKey(userId, "video/mp4");
  const storage = new FakeStorageService();
  const service = createMomentService(new MomentVideoService(storage as never));

  await assert.rejects(service.createMoment(createPayload(key), user as never), /could not be found/);
  assert.deepEqual(storage.deletedKeys, []);
});

test("oversized upload is rejected and deleted, while a normally-sized upload is not deleted", async () => {
  const oversizedKey = createMomentVideoStorageKey(userId, "video/mp4");
  const normalKey = createMomentVideoStorageKey(userId, "video/mp4");
  const { env } = await import("../src/config/env.js");

  const oversizedStorage = new FakeStorageService();
  oversizedStorage.metadata.set(oversizedKey, { contentLength: env.MEDIA_PROBE_MAX_BYTES + 1, contentType: "video/mp4" });
  const oversizedService = createMomentService(new MomentVideoService(oversizedStorage as never));

  await assert.rejects(oversizedService.createMoment(createPayload(oversizedKey), user as never), /too large/);
  assert.deepEqual(oversizedStorage.deletedKeys, [oversizedKey]);
  assert.deepEqual(oversizedStorage.objectCalls, []);

  const normalStorage = new FakeStorageService();
  normalStorage.metadata.set(normalKey, { contentLength: 1000, contentType: "video/mp4" });
  const normalService = createMomentService(new MomentVideoService(normalStorage as never));
  await normalService.createMoment(createPayload(normalKey), user as never);
  assert.deepEqual(normalStorage.deletedKeys, []);
});

test("unowned object is never deleted", async () => {
  const storage = new FakeStorageService();
  const service = createMomentService(new MomentVideoService(storage as never));

  await assert.rejects(
    service.createMoment(createPayload(createMomentVideoStorageKey(otherUserId, "video/mp4")), user as never),
    /not available/,
  );
  assert.deepEqual(storage.deletedKeys, []);
  assert.deepEqual(storage.metadataCalls, []);
});

test("Moment-video namespace cannot be submitted as image media", async () => {
  const key = createMomentVideoStorageKey(userId, "video/mp4");
  const storage = new FakeStorageService();
  const service = createMomentService(new MomentVideoService(storage as never));

  await assert.rejects(
    service.createMoment({
      mode: "feed",
      caption: "wrong type",
      audience: "public",
      taggedPeople: [],
      taggedFriendIds: [],
      mediaItems: [{ type: "image", source: "upload", storageKey: key, contentType: "image/jpeg" }],
    }, user as never),
    /submitted as video/,
  );
  assert.deepEqual(storage.metadataCalls, []);
  assert.deepEqual(storage.deletedKeys, []);
});

test("Moment image, audio, and text creation remain unchanged", async () => {
  let validateCalls = 0;
  const service = createMomentService({
    createUpload: async () => ({}),
    uploadObject: async () => ({ key: "" }),
    validateCreateMomentVideo: async () => {
      validateCalls += 1;
      throw new Error("should not validate non-video media");
    },
  } as never);

  await service.createMoment({
    mode: "feed",
    caption: "image",
    audience: "public",
    taggedPeople: [],
    taggedFriendIds: [],
    mediaItems: [{ type: "image", source: "upload", storageKey: "moments/image/test.jpg", contentType: "image/jpeg" }],
  }, user as never);
  await service.createMoment({
    mode: "feed",
    caption: "audio",
    audience: "public",
    taggedPeople: [],
    taggedFriendIds: [],
    mediaItems: [{ type: "audio", source: "upload", storageKey: "moments/audio/test.m4a", contentType: "audio/mp4", durationSeconds: 120 }],
  }, user as never);
  await service.createMoment({
    mode: "feed",
    caption: "text",
    audience: "public",
    taggedPeople: [],
    taggedFriendIds: [],
    mediaItems: [],
  }, user as never);
  assert.equal(validateCalls, 0);
});

test("mobile Create Post uses authenticated Moment video contract and keeps Story/Event limits unchanged", async () => {
  const createPost = await fs.readFile("../app/app/post-screen/create-post.tsx", "utf8");
  const pendingUploads = await fs.readFile("../app/lib/pendingMomentUploads.ts", "utf8");
  const storage = await fs.readFile("../app/lib/storage.ts", "utf8");
  const story = await fs.readFile("../app/app/post-screen/add-story.tsx", "utf8");
  const eventAboutTab = await fs.readFile("../app/components/eventTabs/AboutTab.tsx", "utf8");
  const eventsLib = await fs.readFile("../app/lib/events.ts", "utf8");

  assert.match(storage, /\/moments\/video-upload-url/);
  assert.match(storage, /\/moments\/video-upload\?/);
  assert.match(createPost, /MAX_VIDEO_RECORDING_DURATION_SECONDS = 60/);
  assert.match(createPost, /videoMaxDuration: MAX_VIDEO_RECORDING_DURATION_SECONDS/);
  assert.match(createPost, /uploadMomentVideoFile/);
  assert.match(pendingUploads, /startMomentVideoFileUpload/);
  assert.doesNotMatch(pendingUploads, /moments\/video\/\$\{id\}/);
  assert.match(story, /MAX_STORY_SECONDS = 15/);
  assert.match(eventAboutTab, /MAX_EVENT_MEDIA_VIDEO_DURATION_SECONDS/);
  assert.match(eventsLib, /MAX_EVENT_MEDIA_VIDEO_DURATION_SECONDS = 10 \* 60/);
});
