import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { Types } from "mongoose";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const now = new Date("2026-06-30T00:00:00.000Z");
const eventId = new Types.ObjectId();
const hostId = new Types.ObjectId();
const viewerId = new Types.ObjectId();

const viewer = {
  id: viewerId.toString(),
  name: "Viewer",
  username: "viewer",
  email: "viewer@example.com",
  accountType: "personal",
  currentLocationSharingEnabled: false,
  notificationsEnabled: true,
  role: "user",
  isActive: true,
  emailVerified: true,
  createdAt: now,
  updatedAt: now,
};

const host = {
  _id: hostId,
  name: "Host User",
  username: "host",
  email: "host@example.com",
  accountType: "business",
  avatarKey: null,
  role: "user",
  isActive: true,
  emailVerified: true,
  createdAt: now,
  updatedAt: now,
};

const event = {
  _id: eventId,
  userId: hostId,
  status: "published",
  name: "Launch Night",
  description: "Automatic announcement text",
  bannerImageKey: null,
  bannerOriginalImageKey: null,
  bannerImageDisplay: null,
  ageRestriction: "all_ages",
  category: "Music",
  categories: ["Music"],
  scheduledAt: now,
  endAt: new Date("2026-06-30T03:00:00.000Z"),
  location: null,
  tickets: [],
  rewards: [],
  privacy: "public",
  memberUserIds: [],
  joinRequests: [],
  publishedAt: now,
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
  createdAt: now,
  updatedAt: now,
};

const createMoment = (overrides: {
  id: Types.ObjectId;
  caption: string;
  isEventAnnouncement: boolean;
}) => ({
  _id: overrides.id,
  userId: hostId,
  mode: "event",
  caption: overrides.caption,
  hashtags: [],
  audience: "public",
  taggedPeople: [],
  eventTitle: "Launch Night",
  eventId,
  isEventAnnouncement: overrides.isEventAnnouncement,
  eventCode: null,
  mediaItems: [],
  createdAt: now,
  updatedAt: now,
});

test("GET /moments/event/:eventId excludes event announcement moments and returns user-created event moments", async () => {
  const [{ MomentController }, { MomentService }, { MomentRepository }, { MomentModel }] = await Promise.all([
    import("../src/modules/moments/moment.controller.js"),
    import("../src/modules/moments/moment.service.js"),
    import("../src/modules/moments/moment.repository.js"),
    import("../src/modules/moments/moment.model.js"),
  ]);

  const announcementMoment = createMoment({
    id: new Types.ObjectId(),
    caption: "Automatic announcement text",
    isEventAnnouncement: true,
  });
  const userMoment = createMoment({
    id: new Types.ObjectId(),
    caption: "A real attendee mooment",
    isEventAnnouncement: false,
  });
  const originalFind = MomentModel.find.bind(MomentModel);
  let capturedFilter: Record<string, unknown> | null = null;

  MomentModel.find = ((filter: Record<string, unknown>) => {
    capturedFilter = filter;
    const announcementFilter = filter.isEventAnnouncement as { $ne?: boolean } | undefined;
    const moments = announcementFilter?.$ne === true
      ? [userMoment]
      : [announcementMoment, userMoment];

    return {
      sort() {
        return this;
      },
      limit() {
        return moments;
      },
    };
  }) as typeof MomentModel.find;

  const momentService = new MomentService(
    new MomentRepository(),
    { createDownloadUrl: async () => ({ url: "" }) },
    {
      findByIds: async () => [host],
      findById: async () => host,
    },
    {
      countByMomentIds: async () => new Map<string, number>(),
      countByMomentId: async () => 0,
    },
    { findFollowingIds: async () => [] },
    { findBlockedIds: async () => [] },
    {
      countByMomentIds: async () => new Map<string, number>(),
      countByMomentId: async () => 0,
      findLikedMomentIds: async () => new Set<string>(),
    },
    {
      countByMomentIds: async () => new Map<string, number>(),
      countByMomentId: async () => 0,
    },
    {},
    { findSavedMomentIds: async () => new Set<string>() },
    { findById: async () => event },
    {},
    {},
  );
  const controller = new MomentController(momentService);
  const app = express();

  app.use((req, _res, next) => {
    req.authUser = viewer;
    next();
  });
  app.get("/moments/event/:eventId", (req, res, next) => {
    void controller.listEventMoments(req, res).catch(next);
  });

  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/moments/event/${eventId.toString()}`);
    const body = await response.json() as { data?: { moments?: Array<{ id: string; caption?: string | null }> } };
    const moments = body.data?.moments ?? [];

    assert.equal(response.status, 200);
    assert.deepEqual(capturedFilter, {
      audience: "public",
      eventId: eventId.toString(),
      isEventAnnouncement: { $ne: true },
    });
    assert.equal(moments.length, 1);
    assert.equal(moments[0]?.id, userMoment._id.toString());
    assert.equal(moments[0]?.caption, "A real attendee mooment");
  } finally {
    MomentModel.find = originalFind as typeof MomentModel.find;
    server.close();
    await once(server, "close");
  }
});

test("event detail keeps interactionMomentId and interaction stats on the announcement moment", async () => {
  const { EventService } = await import("../src/modules/events/event.service.js");
  const interactionMomentId = new Types.ObjectId();
  let ensuredAnnouncementPayload: {
    eventId: string;
    userId: string;
    eventTitle?: string | null;
    caption?: string | null;
  } | null = null;

  const eventService = new EventService(
    {
      findById: async () => event,
      countByUserId: async () => 1,
    },
    { findById: async () => host },
    {
      countFollowers: async () => 11,
      isFollowing: async () => false,
    },
    { createDownloadUrl: async () => ({ url: "" }) },
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    { ensureById: async () => undefined },
    {
      ensureEventAnnouncement: async (payload: {
        eventId: string;
        userId: string;
        eventTitle?: string | null;
        caption?: string | null;
      }) => {
        ensuredAnnouncementPayload = payload;
        return createMoment({
          id: interactionMomentId,
          caption: payload.caption ?? "",
          isEventAnnouncement: true,
        });
      },
    },
    {
      countByMomentIds: async () => new Map([[interactionMomentId.toString(), 7]]),
      findLikedMomentIds: async () => new Set([interactionMomentId.toString()]),
    },
    { countByMomentIds: async () => new Map([[interactionMomentId.toString(), 3]]) },
    {},
    { countByMomentIds: async () => new Map([[interactionMomentId.toString(), 2]]) },
    {},
  );

  const response = await eventService.getEventById(viewer, eventId.toString());

  assert.deepEqual(ensuredAnnouncementPayload, {
    eventId: eventId.toString(),
    userId: hostId.toString(),
    eventTitle: "Launch Night",
    caption: "Automatic announcement text",
  });
  assert.equal(response.interactionMomentId, interactionMomentId.toString());
  assert.equal(response.likesCount, 7);
  assert.equal(response.commentsCount, 3);
  assert.equal(response.sharesCount, 2);
  assert.equal(response.isLiked, true);
});
