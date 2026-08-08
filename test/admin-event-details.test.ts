import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { EventService } from "../src/modules/events/event.service.js";
import { eventRoutes } from "../src/modules/events/event.route.js";
import { authorizeRoles } from "../src/core/middlewares/auth.middleware.js";
import type { EventMediaItem, EventStatus, IEvent } from "../src/modules/events/event.interface.js";

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

const now = new Date("2026-08-08T10:00:00.000Z");
const eventId = new Types.ObjectId();
const hostId = new Types.ObjectId();
const mediaUploaderId = new Types.ObjectId();

const host = {
  _id: hostId,
  name: "Admin Visible Host",
  username: "visible-host",
  email: "host@example.com",
  avatarKey: "avatars/host.jpg",
  bio: "Host bio",
  accountType: "business",
  role: "user",
  isActive: true,
  emailVerified: true,
  createdAt: now,
  updatedAt: now,
};

const mediaItem: EventMediaItem = {
  id: "gallery-image",
  storageKey: `events/gallery/${eventId}/${hostId}/image.jpg`,
  type: "image",
  contentType: "image/jpeg",
  fileSize: 2048,
  width: 640,
  height: 480,
  durationSeconds: null,
  uploaderId: mediaUploaderId,
  displayOrder: 1,
  createdAt: now,
};

const createEvent = (status: EventStatus = "published", overrides: Partial<IEvent> = {}): IEvent => ({
  _id: eventId,
  userId: hostId,
  status,
  name: "Admin Detail Event",
  description: "Readable admin detail copy",
  bannerImageKey: "events/banner.jpg",
  bannerOriginalImageKey: null,
  bannerImageDisplay: null,
  ageRestriction: "all_ages",
  category: "Live Music & Concerts",
  categories: ["Live Music & Concerts", "Community & Movements"],
  hashtags: ["admin", "readonly"],
  scheduledAt: now,
  endAt: new Date("2026-08-08T12:00:00.000Z"),
  location: {
    latitude: 23.7808,
    longitude: 90.4192,
    venue: "Dhaka Hall",
    address: "Gulshan, Dhaka",
    searchLabel: "Dhaka Hall",
    additionalInfo: "Use the north gate.",
  },
  tickets: [{
    id: "ticket-1",
    name: "General",
    description: "General admission",
    type: "pay",
    price: 25,
    capacity: 100,
    availableCount: 80,
    salesEndAt: null,
  }],
  rewards: [],
  eventMedia: [mediaItem],
  privacy: "private",
  memberUserIds: [],
  joinRequests: [],
  publishedAt: now,
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
} as IEvent);

const createService = (event: IEvent | null, calls: { findById?: number; summaries?: number; crowd?: number } = {}) => {
  const eventRepository = {
    findById: async (requestedId: string) => {
      calls.findById = (calls.findById ?? 0) + 1;
      assert.equal(requestedId, eventId.toString());
      return event;
    },
  };
  const userRepository = {
    findById: async (requestedId: string) => {
      assert.equal(requestedId, hostId.toString());
      return host;
    },
  };
  const storageService = {
    createDownloadUrl: async (key: string) => {
      assert.equal(key, "avatars/host.jpg");
      return { url: "https://cdn.example.test/avatars/host.jpg" };
    },
  };
  const checkoutPaymentService = {
    getPublicEventGoingSummaries: async (events: Array<{ id: string; status: string }>) => {
      calls.summaries = (calls.summaries ?? 0) + 1;
      assert.deepEqual(events, [{ id: eventId.toString(), status: event?.status }]);
      return new Map([[eventId.toString(), { going: 3, avatars: ["one", "two"] }]]);
    },
  };
  const crowdStatusService = {
    getCrowdStatusByEventId: async (events: IEvent[]) => {
      calls.crowd = (calls.crowd ?? 0) + 1;
      assert.equal(events[0]?._id.toString(), eventId.toString());
      return new Map([[eventId.toString(), "busy"]]);
    },
  };
  const mustNotCall = {
    ensureEventAnnouncement: async () => {
      throw new Error("admin detail must not create interaction moments");
    },
    ensureById: async () => {
      throw new Error("admin detail must not create chat rooms");
    },
  };

  return new EventService(
    eventRepository as never,
    userRepository as never,
    {} as never,
    storageService as never,
    {} as never,
    {} as never,
    {} as never,
    checkoutPaymentService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    mustNotCall as never,
    mustNotCall as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    crowdStatusService as never,
  );
};

test("admin event detail returns private published event data with host and media", async () => {
  const calls: { findById?: number; summaries?: number; crowd?: number } = {};
  const service = createService(createEvent("published"), calls);

  const response = await service.getEventForAdmin(eventId.toString());

  assert.equal(response.id, eventId.toString());
  assert.equal(response.status, "published");
  assert.equal(response.privacy, "private");
  assert.equal(response.host?.id, hostId.toString());
  assert.equal(response.host?.avatarUrl, "https://cdn.example.test/avatars/host.jpg");
  assert.deepEqual(response.categories, ["Live Music & Concerts", "Community & Movements"]);
  assert.equal(response.eventMedia?.length, 1);
  assert.equal(response.eventMedia?.[0]?.url, `/events/${eventId.toString()}/media/gallery-image`);
  assert.deepEqual(response.publicGoingSummary, { going: 3, avatars: ["one", "two"] });
  assert.equal(response.crowdStatus, "busy");
  assert.deepEqual(calls, { findById: 1, summaries: 1, crowd: 1 });
});

test("admin event detail rejects draft events", async () => {
  const calls: { findById?: number; summaries?: number; crowd?: number } = {};
  const service = createService(createEvent("draft"), calls);

  await assert.rejects(
    () => service.getEventForAdmin(eventId.toString()),
    { statusCode: 404 },
  );
  assert.deepEqual(calls, { findById: 1 });
});

test("admin event detail route is registered before generic event details and admin guard rejects users", () => {
  const stack = (eventRoutes as unknown as {
    stack: Array<{
      route?: {
        path: string;
        methods: Record<string, boolean>;
        stack: Array<{ name: string }>;
      };
    }>;
  }).stack;
  const getRoutes = stack
    .map((layer) => layer.route)
    .filter((route): route is NonNullable<typeof route> => Boolean(route?.methods.get));
  const adminIndex = getRoutes.findIndex((route) => route.path === "/admin/:id");
  const genericIndex = getRoutes.findIndex((route) => route.path === "/:id");
  const adminRoute = getRoutes[adminIndex];

  assert.ok(adminIndex >= 0);
  assert.ok(genericIndex >= 0);
  assert.ok(adminIndex < genericIndex);
  assert.ok((adminRoute?.stack.length ?? 0) >= 3);

  const middleware = authorizeRoles("admin");
  let receivedError: { statusCode?: number } | undefined;
  middleware({ authUser: { role: "user" } } as never, {} as never, ((error?: unknown) => {
    receivedError = error as { statusCode?: number };
  }) as never);
  assert.equal(receivedError?.statusCode, 403);
});
