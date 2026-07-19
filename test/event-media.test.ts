import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import httpStatus from "http-status";
import { AppError } from "../src/core/errors/app-error.js";
import { EventService } from "../src/modules/events/event.service.js";
import {
  EVENT_MEDIA_LIMITS_BYTES,
  MAX_EVENT_MEDIA_ITEMS,
  type EventMediaItem,
  type IEvent,
} from "../src/modules/events/event.interface.js";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

test.afterEach(async () => {
  const { RedisClient } = await import("../src/config/redis.js");
  await RedisClient.disconnect().catch(() => undefined);
});

const now = new Date("2026-07-15T10:00:00.000Z");
const eventId = new Types.ObjectId();
const ownerId = new Types.ObjectId();
const viewerId = new Types.ObjectId();
const outsiderId = new Types.ObjectId();

const owner = {
  id: ownerId.toString(),
  name: "Owner",
  username: "owner",
  email: "owner@example.com",
  accountType: "business",
  currentLocationSharingEnabled: false,
  notificationsEnabled: true,
  role: "user",
  isActive: true,
  emailVerified: true,
  createdAt: now,
  updatedAt: now,
};

const viewer = {
  ...owner,
  id: viewerId.toString(),
  name: "Viewer",
  username: "viewer",
  email: "viewer@example.com",
};

const outsider = {
  ...owner,
  id: outsiderId.toString(),
  name: "Outsider",
  username: "outsider",
  email: "outsider@example.com",
};

const host = {
  _id: ownerId,
  name: "Owner",
  username: "owner",
  email: "owner@example.com",
  accountType: "business",
  avatarKey: null,
  role: "user",
  isActive: true,
  emailVerified: true,
  createdAt: now,
  updatedAt: now,
};

const createEventMediaItem = (overrides: Partial<EventMediaItem> = {}): EventMediaItem => ({
  id: "existing-media",
  storageKey: `events/gallery/${eventId}/${ownerId}/existing.jpg`,
  type: "image",
  contentType: "image/jpeg",
  fileSize: 1024,
  width: 100,
  height: 100,
  durationSeconds: null,
  uploaderId: ownerId,
  displayOrder: 1,
  createdAt: now,
  ...overrides,
});

const createEvent = (overrides: Partial<IEvent> = {}): IEvent => ({
  _id: eventId,
  userId: ownerId,
  status: "draft",
  name: "Gallery Event",
  description: "Gallery copy",
  bannerImageKey: null,
  bannerOriginalImageKey: null,
  bannerImageDisplay: null,
  ageRestriction: "all_ages",
  category: "Music",
  categories: ["Music"],
  hashtags: [],
  scheduledAt: now,
  endAt: new Date("2026-07-15T12:00:00.000Z"),
  location: null,
  tickets: [],
  rewards: [],
  eventMedia: [],
  privacy: "public",
  memberUserIds: [],
  joinRequests: [],
  publishedAt: null,
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
} as IEvent);

const createEventService = (options: {
  event?: IEvent;
  storageMetadata?: Record<string, { contentLength?: number; contentType?: string }>;
  appendEventMediaItem?: (id: string, userId: string, mediaItem: EventMediaItem) => Promise<IEvent | null>;
  removeEventMediaItem?: (id: string, userId: string, mediaId: string) => Promise<IEvent | null>;
  findByIdForUser?: (id: string, userId: string) => Promise<IEvent | null>;
  findByIdWithEventMedia?: (id: string) => Promise<IEvent | null>;
} = {}) => {
  let currentEvent = options.event ?? createEvent();

  const eventRepository = {
    findByIdForUser: options.findByIdForUser ?? (async (_id: string, userId: string) => (
      currentEvent.userId.toString() === userId ? currentEvent : null
    )),
    appendEventMediaItem: options.appendEventMediaItem ?? (async (_id: string, userId: string, mediaItem: EventMediaItem) => {
      const isDuplicateStorageKey = currentEvent.eventMedia.some((item) => item.storageKey === mediaItem.storageKey);

      if (
        currentEvent.userId.toString() !== userId ||
        currentEvent.eventMedia.length >= MAX_EVENT_MEDIA_ITEMS ||
        isDuplicateStorageKey
      ) {
        return null;
      }

      currentEvent = {
        ...currentEvent,
        eventMedia: [...currentEvent.eventMedia, mediaItem],
      } as IEvent;

      return currentEvent;
    }),
    removeEventMediaItem: options.removeEventMediaItem ?? (async (_id: string, userId: string, mediaId: string) => {
      if (
        currentEvent.userId.toString() !== userId ||
        currentEvent.status === "cancelled" ||
        !currentEvent.eventMedia.some((item) => item.id === mediaId)
      ) {
        return null;
      }

      currentEvent = {
        ...currentEvent,
        eventMedia: currentEvent.eventMedia.filter((item) => item.id !== mediaId),
      } as IEvent;

      return currentEvent;
    }),
    findByIdWithEventMedia: options.findByIdWithEventMedia ?? (async () => currentEvent),
  };

  const storageService = {
    getObjectMetadata: async (key: string) => {
      const metadata = options.storageMetadata?.[key];

      if (!metadata) {
        throw new Error("missing object");
      }

      return metadata;
    },
  };

  return new EventService(
    eventRepository as never,
    { findById: async () => host } as never,
    {} as never,
    storageService as never,
  );
};

const getImageInput = (storageKey = `events/gallery/${eventId}/${ownerId}/image.jpg`) => ({
  type: "image" as const,
  storageKey,
  contentType: "image/jpeg",
  fileSize: 1024,
  width: 100,
  height: 100,
});

const getVideoInput = (storageKey = `events/gallery/${eventId}/${ownerId}/video.mp4`) => ({
  type: "video" as const,
  storageKey,
  contentType: "video/mp4",
  fileSize: 2048,
  width: 640,
  height: 480,
  durationSeconds: 45,
});

test("creator can append event media in draft, published, live, and completed states without lifecycle mutations", async () => {
  for (const status of ["draft", "published", "live", "completed"] as const) {
    const imageKey = `events/gallery/${eventId}/${ownerId}/${status}.jpg`;
    const event = createEvent({ status });
    const service = createEventService({
      event,
      storageMetadata: {
        [imageKey]: { contentLength: 1024, contentType: "image/jpeg" },
      },
    });

    const result = await service.addEventMedia(owner, eventId.toString(), {
      mediaItems: [getImageInput(imageKey)],
    });

    assert.equal(result.failures.length, 0);
    assert.equal(result.mediaItems.length, 1);
    assert.equal(result.event.status, status);
    assert.equal(result.event.scheduledAt, event.scheduledAt);
    assert.equal(result.event.endAt, event.endAt);
    assert.equal(result.event.privacy, event.privacy);
    assert.equal(result.event.eventMedia?.length, 1);
    assert.match(result.event.eventMedia?.[0]?.url ?? "", /^\/events\/.+\/media\//);
  }
});

test("cancelled events reject creator gallery uploads", async () => {
  const imageKey = `events/gallery/${eventId}/${ownerId}/cancelled.jpg`;
  const service = createEventService({
    event: createEvent({ status: "cancelled" }),
    storageMetadata: {
      [imageKey]: { contentLength: 1024, contentType: "image/jpeg" },
    },
  });

  await assert.rejects(
    () => service.addEventMedia(owner, eventId.toString(), { mediaItems: [getImageInput(imageKey)] }),
    (error) => error instanceof AppError && error.statusCode === httpStatus.UNPROCESSABLE_ENTITY,
  );
});

test("non-owner cannot upload gallery media", async () => {
  const service = createEventService({
    event: createEvent({ status: "published" }),
  });

  await assert.rejects(
    () => service.addEventMedia(outsider, eventId.toString(), { mediaItems: [getImageInput()] }),
    (error) => error instanceof AppError && error.statusCode === httpStatus.NOT_FOUND,
  );
});

test("partial batch persists valid media and rejects invalid items independently", async () => {
  const imageKey = `events/gallery/${eventId}/${ownerId}/valid.jpg`;
  const videoKey = `events/gallery/${eventId}/${ownerId}/valid.mp4`;
  const service = createEventService({
    event: createEvent({ status: "published" }),
    storageMetadata: {
      [imageKey]: { contentLength: 1024, contentType: "image/jpeg" },
      [videoKey]: { contentLength: 2048, contentType: "video/mp4" },
    },
  });

  const result = await service.addEventMedia(owner, eventId.toString(), {
    mediaItems: [
      getImageInput(imageKey),
      getImageInput(`events/gallery/${eventId}/${outsiderId}/wrong-owner.jpg`),
      getVideoInput(videoKey),
    ],
  });

  assert.equal(result.mediaItems.length, 2);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.index, 1);
  assert.equal(result.event.eventMedia?.length, 2);
  assert.deepEqual(result.mediaItems.map((item) => item.type), ["image", "video"]);
});

test("backend enforces event gallery size, MIME, prefix, and duration validation", async () => {
  const largeImageKey = `events/gallery/${eventId}/${ownerId}/large.jpg`;
  const mimeMismatchKey = `events/gallery/${eventId}/${ownerId}/mismatch.jpg`;
  const videoKey = `events/gallery/${eventId}/${ownerId}/long.mp4`;
  const service = createEventService({
    event: createEvent({ status: "published" }),
    storageMetadata: {
      [largeImageKey]: { contentLength: EVENT_MEDIA_LIMITS_BYTES.image + 1, contentType: "image/jpeg" },
      [mimeMismatchKey]: { contentLength: 1024, contentType: "image/png" },
      [videoKey]: { contentLength: 2048, contentType: "video/mp4" },
    },
  });

  const result = await service.addEventMedia(owner, eventId.toString(), {
    mediaItems: [
      getImageInput(`events/gallery/${eventId}/${outsiderId}/wrong-owner.jpg`),
      getImageInput(largeImageKey),
      getImageInput(mimeMismatchKey),
      { ...getVideoInput(videoKey), durationSeconds: 601 },
    ],
  });

  assert.equal(result.mediaItems.length, 0);
  assert.equal(result.failures.length, 4);
  assert.equal(result.event.eventMedia?.length, 0);
});

test("repository append result is authoritative for the total 30-item limit", async () => {
  const existingMedia = Array.from({ length: MAX_EVENT_MEDIA_ITEMS }, (_, index) =>
    createEventMediaItem({
      id: `existing-${index}`,
      storageKey: `events/gallery/${eventId}/${ownerId}/existing-${index}.jpg`,
      displayOrder: index,
    }));
  const imageKey = `events/gallery/${eventId}/${ownerId}/overflow.jpg`;
  const service = createEventService({
    event: createEvent({ status: "published", eventMedia: existingMedia }),
    storageMetadata: {
      [imageKey]: { contentLength: 1024, contentType: "image/jpeg" },
    },
  });

  const result = await service.addEventMedia(owner, eventId.toString(), {
    mediaItems: [getImageInput(imageKey)],
  });

  assert.equal(result.mediaItems.length, 0);
  assert.equal(result.failures.length, 1);
  assert.equal(result.event.eventMedia?.length, MAX_EVENT_MEDIA_ITEMS);
});

test("duplicate storage keys are not persisted twice for the same event", async () => {
  const duplicateKey = `events/gallery/${eventId}/${ownerId}/duplicate.jpg`;
  const service = createEventService({
    event: createEvent({
      status: "published",
      eventMedia: [createEventMediaItem({ id: "already-saved", storageKey: duplicateKey })],
    }),
    storageMetadata: {
      [duplicateKey]: { contentLength: 1024, contentType: "image/jpeg" },
    },
  });

  const result = await service.addEventMedia(owner, eventId.toString(), {
    mediaItems: [getImageInput(duplicateKey)],
  });

  assert.equal(result.mediaItems.length, 0);
  assert.equal(result.failures.length, 1);
  assert.equal(result.event.eventMedia?.length, 1);
  assert.equal(result.event.eventMedia?.[0]?.id, "already-saved");
});

test("event media file reads follow event detail visibility rules", async () => {
  const mediaItem = createEventMediaItem();
  const service = createEventService({
    event: createEvent({
      status: "published",
      privacy: "private",
      memberUserIds: [viewerId],
      eventMedia: [mediaItem],
    }),
  });

  const media = await service.getAuthorizedEventMedia(viewer, eventId.toString(), mediaItem.id);
  assert.equal(media.key, mediaItem.storageKey);
  assert.equal(media.contentType, mediaItem.contentType);

  await assert.rejects(
    () => service.getAuthorizedEventMedia(outsider, eventId.toString(), mediaItem.id),
    (error) => error instanceof AppError && error.statusCode === httpStatus.NOT_FOUND,
  );
});

test("draft event media file reads are hidden from non-owners", async () => {
  const mediaItem = createEventMediaItem();
  const service = createEventService({
    event: createEvent({ status: "draft", eventMedia: [mediaItem] }),
  });

  const ownerMedia = await service.getAuthorizedEventMedia(owner, eventId.toString(), mediaItem.id);
  assert.equal(ownerMedia.key, mediaItem.storageKey);

  await assert.rejects(
    () => service.getAuthorizedEventMedia(viewer, eventId.toString(), mediaItem.id),
    (error) => error instanceof AppError && error.statusCode === httpStatus.NOT_FOUND,
  );
});

test("creator can delete event media in draft, published, live, and completed states without changing unrelated fields", async () => {
  for (const status of ["draft", "published", "live", "completed"] as const) {
    const deletedMedia = createEventMediaItem({ id: `delete-${status}` });
    const remainingMedia = createEventMediaItem({
      id: `keep-${status}`,
      storageKey: `events/gallery/${eventId}/${ownerId}/keep-${status}.jpg`,
      displayOrder: 2,
    });
    const event = createEvent({
      status,
      name: `Delete ${status}`,
      privacy: "locked",
      eventMedia: [deletedMedia, remainingMedia],
    });
    const service = createEventService({ event });

    const result = await service.deleteEventMedia(owner, eventId.toString(), deletedMedia.id);

    assert.equal(result.mediaItem.id, deletedMedia.id);
    assert.equal(result.event.eventMedia?.length, 1);
    assert.equal(result.event.eventMedia?.[0]?.id, remainingMedia.id);
    assert.equal(result.event.status, status);
    assert.equal(result.event.name, event.name);
    assert.equal(result.event.privacy, event.privacy);
    assert.equal(result.event.scheduledAt, event.scheduledAt);
    assert.equal(result.event.endAt, event.endAt);
  }
});

test("cancelled event media deletion is rejected", async () => {
  const mediaItem = createEventMediaItem();
  const service = createEventService({
    event: createEvent({ status: "cancelled", eventMedia: [mediaItem] }),
  });

  await assert.rejects(
    () => service.deleteEventMedia(owner, eventId.toString(), mediaItem.id),
    (error) => error instanceof AppError && error.statusCode === httpStatus.UNPROCESSABLE_ENTITY,
  );
});

test("normal users cannot delete event media", async () => {
  const mediaItem = createEventMediaItem();
  const service = createEventService({
    event: createEvent({ status: "published", eventMedia: [mediaItem] }),
  });

  await assert.rejects(
    () => service.deleteEventMedia(viewer, eventId.toString(), mediaItem.id),
    (error) => error instanceof AppError && error.statusCode === httpStatus.NOT_FOUND,
  );
});

test("unknown or already deleted media returns not found without removing another item", async () => {
  const remainingMedia = createEventMediaItem({ id: "remaining" });
  const service = createEventService({
    event: createEvent({ status: "published", eventMedia: [remainingMedia] }),
  });

  await assert.rejects(
    () => service.deleteEventMedia(owner, eventId.toString(), "missing-media"),
    (error) => error instanceof AppError && error.statusCode === httpStatus.NOT_FOUND,
  );

  const media = await service.getAuthorizedEventMedia(owner, eventId.toString(), remainingMedia.id);
  assert.equal(media.key, remainingMedia.storageKey);
});
