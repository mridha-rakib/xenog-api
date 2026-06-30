import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const eventId = new Types.ObjectId();
const windowId = new Types.ObjectId();
const hostId = new Types.ObjectId();
const attendeeId = new Types.ObjectId();
const otherAttendeeId = new Types.ObjectId();
const usageId = new Types.ObjectId();
const now = new Date();

const host = {
  id: hostId.toString(),
  name: "Host",
  username: "host",
  email: "host@example.com",
  accountType: "business",
  currentLocationSharingEnabled: false,
  notificationsEnabled: true,
  role: "user",
  isActive: true,
  emailVerified: true,
  createdAt: now,
  updatedAt: now,
};

const attendee = {
  ...host,
  id: attendeeId.toString(),
  name: "Attendee",
  username: "attendee",
  email: "attendee@example.com",
  accountType: "personal",
};

const otherAttendee = {
  ...attendee,
  id: otherAttendeeId.toString(),
  username: "other",
  email: "other@example.com",
};

const admin = {
  ...host,
  id: new Types.ObjectId().toString(),
  username: "admin",
  email: "admin@example.com",
  role: "admin",
};

const event = {
  _id: eventId,
  userId: hostId,
  status: "live",
  name: "Window Event",
  description: "Event description",
  bannerImageKey: null,
  bannerOriginalImageKey: null,
  bannerImageDisplay: null,
  ageRestriction: "all_ages",
  category: "Music",
  categories: ["Music"],
  scheduledAt: new Date(Date.now() - 60 * 60 * 1000),
  endAt: new Date(Date.now() + 60 * 60 * 1000),
  location: null,
  tickets: [],
  rewards: [],
  privacy: "public",
  memberUserIds: [],
  joinRequests: [],
  publishedAt: now,
  startedAt: now,
  completedAt: null,
  cancelledAt: null,
  createdAt: now,
  updatedAt: now,
};

const createWindowDoc = (overrides = {}) => ({
  _id: windowId,
  eventId,
  hostUserId: hostId,
  title: "Photo Drop",
  startsAt: new Date(Date.now() - 5 * 60 * 1000),
  endsAt: new Date(Date.now() + 5 * 60 * 1000),
  allowedContentTypes: ["text", "image"],
  maxPosts: 2,
  acceptedPostCount: 0,
  status: "scheduled",
  cancelledAt: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const createPostDoc = (overrides = {}) => ({
  _id: new Types.ObjectId(),
  eventId,
  windowId,
  userId: attendeeId,
  ticketUsageId: usageId,
  contentType: "text",
  text: "Checked in",
  mediaItems: [],
  status: "accepted",
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const validImageMedia = (overrides = {}) => ([{
  type: "image",
  source: "gallery",
  storageKey: `event-windows/${eventId.toString()}/${windowId.toString()}/${attendeeId.toString()}/photo.jpg`,
  contentType: "image/jpeg",
  ...overrides,
}]);

const createService = async (overrides: {
  event?: unknown;
  window?: unknown;
  existingPost?: unknown;
  attendance?: unknown;
  createPostResult?: unknown;
  acceptedPosts?: unknown[];
  countAcceptedPosts?: number;
  updateResult?: unknown;
  mediaPost?: unknown;
  storageMetadata?: unknown;
  storageError?: unknown;
} = {}) => {
  const { EventWindowService } = await import("../src/modules/event-windows/event-window.service.js");
  const window = overrides.window ?? createWindowDoc();
  const hasOverride = (key: keyof typeof overrides) => Object.prototype.hasOwnProperty.call(overrides, key);
  const eventWindowRepository = {
    create: async (payload: Record<string, unknown>) => createWindowDoc({
      title: payload.title,
      startsAt: payload.startsAt,
      endsAt: payload.endsAt,
      allowedContentTypes: payload.allowedContentTypes,
      maxPosts: payload.maxPosts,
    }),
    findByEventId: async () => [window],
    findByIdForEvent: async () => window,
    updateByIdForEvent: async (_eventId: string, _windowId: string, payload: Record<string, unknown>) => (
      hasOverride("updateResult")
        ? overrides.updateResult
        : {
            ...(window as object),
            ...payload,
          }
    ),
    cancelByIdForEvent: async () => ({ ...(window as object), status: "cancelled", cancelledAt: now }),
    countAcceptedPosts: async () => overrides.countAcceptedPosts ?? 0,
    findAcceptedPostByUser: async () => hasOverride("existingPost") ? overrides.existingPost : null,
    findAcceptedPostByIdForWindow: async () => overrides.mediaPost ?? createPostDoc({
      mediaItems: [{
        type: "image",
        source: "gallery",
        storageKey: `event-windows/${eventId.toString()}/${windowId.toString()}/${attendeeId.toString()}/photo.jpg`,
        contentType: "image/jpeg",
      }],
    }),
    listAcceptedPosts: async (_windowId: string, options: { limit: number; cursor?: string }) => {
      const posts = overrides.acceptedPosts ?? [createPostDoc()];
      const startIndex = options.cursor
        ? posts.findIndex((post) => (post as { _id: Types.ObjectId })._id.toString() === options.cursor) + 1
        : 0;
      return posts.slice(Math.max(0, startIndex), Math.max(0, startIndex) + options.limit + 1);
    },
    createPostWithCapacity: async () => (
      hasOverride("createPostResult")
        ? overrides.createPostResult
        : {
            status: "created",
            window: createWindowDoc({ acceptedPostCount: 1 }),
            post: createPostDoc(),
          }
    ),
  };
  const eventRepository = {
    findById: async () => overrides.event ?? event,
  };
  const ticketUsageRepository = {
    findByEventIdAndHolderUserId: async () => (
      hasOverride("attendance")
        ? overrides.attendance
        : {
            _id: usageId,
            eventId: eventId.toString(),
            holderUserId: attendeeId,
            usedAt: now,
          }
    ),
  };
  const storageService = {
    getObjectMetadata: async () => {
      if (hasOverride("storageError")) {
        throw overrides.storageError;
      }

      return overrides.storageMetadata ?? { contentLength: 1024, contentType: "image/jpeg" };
    },
  };

  return new EventWindowService(
    eventWindowRepository,
    eventRepository,
    ticketUsageRepository,
    storageService,
  );
};

test("host can create a valid event window", async () => {
  const service = await createService();
  const window = await service.createWindow(host, eventId.toString(), {
    title: "Photo Drop",
    startsAt: new Date(Date.now() - 10 * 60 * 1000),
    endsAt: new Date(Date.now() + 10 * 60 * 1000),
    allowedContentTypes: ["text", "image"],
    maxPosts: 25,
  });

  assert.equal(window.eventId, eventId.toString());
  assert.equal(window.hostUserId, hostId.toString());
  assert.deepEqual(window.allowedContentTypes, ["text", "image"]);
  assert.equal(window.maxPosts, 25);
});

test("non-host cannot create, edit, or cancel event windows", async () => {
  const service = await createService();
  const payload = {
    startsAt: new Date(Date.now() - 10 * 60 * 1000),
    endsAt: new Date(Date.now() + 10 * 60 * 1000),
    allowedContentTypes: ["text"],
    maxPosts: 1,
  };

  await assert.rejects(() => service.createWindow(attendee, eventId.toString(), payload), { statusCode: 403 });
  await assert.rejects(() => service.updateWindow(attendee, eventId.toString(), windowId.toString(), { maxPosts: 3 }), { statusCode: 403 });
  await assert.rejects(() => service.cancelWindow(attendee, eventId.toString(), windowId.toString()), { statusCode: 403 });
});

test("window outside event time is rejected", async () => {
  const service = await createService();

  await assert.rejects(
    () => service.createWindow(host, eventId.toString(), {
      startsAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      endsAt: new Date(Date.now() + 10 * 60 * 1000),
      allowedContentTypes: ["text"],
      maxPosts: 1,
    }),
    { statusCode: 400 },
  );
});

test("posting before scan attendance is rejected", async () => {
  const service = await createService({ attendance: null });

  await assert.rejects(
    () => service.createPost(attendee, eventId.toString(), windowId.toString(), {
      contentType: "text",
      text: "I am here",
      mediaItems: [],
    }),
    { statusCode: 403 },
  );
});

test("window listing reports scanned attendance and posting eligibility", async () => {
  const service = await createService({ attendance: { _id: usageId, usedAt: now } });
  const [window] = await service.listWindows(attendee, eventId.toString());

  assert.equal(window.hasAttended, true);
  assert.equal(window.hasPosted, false);
  assert.equal(window.canPost, true);
  assert.equal(window.canViewPosts, false);
});

test("window listing does not unlock posting before ticket scan", async () => {
  const service = await createService({ attendance: null });
  const [window] = await service.listWindows(attendee, eventId.toString());

  assert.equal(window.hasAttended, false);
  assert.equal(window.canPost, false);
  assert.equal(window.canViewPosts, false);
});

test("posting after successful ticket scan is accepted", async () => {
  const service = await createService();
  const post = await service.createPost(attendee, eventId.toString(), windowId.toString(), {
    contentType: "text",
    text: "I am here",
    mediaItems: [],
  });

  assert.equal(post.windowId, windowId.toString());
  assert.equal(post.userId, attendeeId.toString());
  assert.equal(post.text, "Checked in");
});

test("user cannot post twice in the same window", async () => {
  const service = await createService({ existingPost: createPostDoc() });

  await assert.rejects(
    () => service.createPost(attendee, eventId.toString(), windowId.toString(), {
      contentType: "text",
      text: "Again",
      mediaItems: [],
    }),
    { statusCode: 409 },
  );
});

test("window capacity limit is enforced", async () => {
  const service = await createService({ createPostResult: { status: "unavailable" } });

  await assert.rejects(
    () => service.createPost(attendee, eventId.toString(), windowId.toString(), {
      contentType: "text",
      text: "Too late",
      mediaItems: [],
    }),
    { statusCode: 409 },
  );
});

test("user who did not post cannot view window posts", async () => {
  const service = await createService({ existingPost: null });

  await assert.rejects(
    () => service.listPosts(otherAttendee, eventId.toString(), windowId.toString(), { limit: 20 }),
    { statusCode: 403 },
  );
});

test("user who posted can view posts from the same window", async () => {
  const service = await createService({
    existingPost: createPostDoc(),
    acceptedPosts: [
      createPostDoc({ text: "First" }),
      createPostDoc({ userId: otherAttendeeId, text: "Second" }),
    ],
  });
  const result = await service.listPosts(attendee, eventId.toString(), windowId.toString(), { limit: 20 });
  const { posts } = result;

  assert.equal(posts.length, 2);
  assert.deepEqual(posts.map((post) => post.text), ["First", "Second"]);
});

test("host and admin can view window posts for moderation", async () => {
  const service = await createService({ existingPost: null });

  assert.equal((await service.listPosts(host, eventId.toString(), windowId.toString(), { limit: 20 })).posts.length, 1);
  assert.equal((await service.listPosts(admin, eventId.toString(), windowId.toString(), { limit: 20 })).posts.length, 1);
});

test("event window routes require authentication before media access", async () => {
  const { eventWindowRoutes } = await import("../src/modules/event-windows/event-window.route.js");
  const stack = (eventWindowRoutes as unknown as { stack: { name: string }[] }).stack;

  assert.equal(stack[0]?.name, "authenticate");
});

test("user who did not post cannot access same-window media", async () => {
  const service = await createService({ existingPost: null });

  await assert.rejects(
    () => service.getAuthorizedMedia(otherAttendee, eventId.toString(), windowId.toString(), new Types.ObjectId().toString(), 0),
    { statusCode: 403 },
  );
});

test("posted user can access same-window media", async () => {
  const postId = new Types.ObjectId();
  const service = await createService({
    existingPost: createPostDoc(),
    mediaPost: createPostDoc({
      _id: postId,
      mediaItems: validImageMedia(),
    }),
  });

  const media = await service.getAuthorizedMedia(attendee, eventId.toString(), windowId.toString(), postId.toString(), 0);

  assert.equal(media.key, `event-windows/${eventId.toString()}/${windowId.toString()}/${attendeeId.toString()}/photo.jpg`);
  assert.equal(media.contentType, "image/jpeg");
});

test("host and admin can access event window media for moderation", async () => {
  const postId = new Types.ObjectId();
  const service = await createService({
    existingPost: null,
    mediaPost: createPostDoc({
      _id: postId,
      mediaItems: validImageMedia(),
    }),
  });

  assert.equal((await service.getAuthorizedMedia(host, eventId.toString(), windowId.toString(), postId.toString(), 0)).contentType, "image/jpeg");
  assert.equal((await service.getAuthorizedMedia(admin, eventId.toString(), windowId.toString(), postId.toString(), 0)).contentType, "image/jpeg");
});

test("event window post response uses authorized media paths instead of storage keys", async () => {
  const service = await createService({
    existingPost: createPostDoc(),
    acceptedPosts: [
      createPostDoc({
        mediaItems: validImageMedia(),
      }),
    ],
  });
  const result = await service.listPosts(attendee, eventId.toString(), windowId.toString(), { limit: 20 });
  const mediaUrl = result.posts[0]?.mediaItems[0]?.url;

  assert.ok(mediaUrl?.startsWith(`/events/${eventId.toString()}/windows/${windowId.toString()}/posts/`));
  assert.equal(mediaUrl?.includes("event-windows/"), false);
});

test("invalid storageKey prefix is rejected", async () => {
  const service = await createService();

  await assert.rejects(
    () => service.createPost(attendee, eventId.toString(), windowId.toString(), {
      contentType: "image",
      text: null,
      mediaItems: validImageMedia({ storageKey: `event-windows/${eventId.toString()}/${windowId.toString()}/${otherAttendeeId.toString()}/photo.jpg` }),
    }),
    { statusCode: 400 },
  );
});

test("missing media object is rejected", async () => {
  const service = await createService({ storageError: new Error("missing") });

  await assert.rejects(
    () => service.createPost(attendee, eventId.toString(), windowId.toString(), {
      contentType: "image",
      text: null,
      mediaItems: validImageMedia(),
    }),
    { statusCode: 400 },
  );
});

test("empty media object is rejected", async () => {
  const service = await createService({ storageMetadata: { contentLength: 0, contentType: "image/jpeg" } });

  await assert.rejects(
    () => service.createPost(attendee, eventId.toString(), windowId.toString(), {
      contentType: "image",
      text: null,
      mediaItems: validImageMedia(),
    }),
    { statusCode: 400 },
  );
});

test("wrong MIME content type is rejected", async () => {
  const service = await createService({ storageMetadata: { contentLength: 1024, contentType: "video/mp4" } });

  await assert.rejects(
    () => service.createPost(attendee, eventId.toString(), windowId.toString(), {
      contentType: "image",
      text: null,
      mediaItems: validImageMedia(),
    }),
    { statusCode: 400 },
  );
});

test("oversized media object is rejected", async () => {
  const service = await createService({ storageMetadata: { contentLength: 16 * 1024 * 1024, contentType: "image/jpeg" } });

  await assert.rejects(
    () => service.createPost(attendee, eventId.toString(), windowId.toString(), {
      contentType: "image",
      text: null,
      mediaItems: validImageMedia(),
    }),
    { statusCode: 400 },
  );
});

test("host and admin cannot post when attendee-only policy is enforced", async () => {
  const service = await createService();

  await assert.rejects(
    () => service.createPost(host, eventId.toString(), windowId.toString(), {
      contentType: "text",
      text: "Host post",
      mediaItems: [],
    }),
    { statusCode: 403 },
  );
  await assert.rejects(
    () => service.createPost(admin, eventId.toString(), windowId.toString(), {
      contentType: "text",
      text: "Admin post",
      mediaItems: [],
    }),
    { statusCode: 403 },
  );
});

test("duplicate submit returns 409 instead of 500", async () => {
  const service = await createService({ createPostResult: { status: "duplicate" } });

  await assert.rejects(
    () => service.createPost(attendee, eventId.toString(), windowId.toString(), {
      contentType: "text",
      text: "Retry",
      mediaItems: [],
    }),
    { statusCode: 409 },
  );
});

test("concurrent maxPosts edit cannot make acceptedPostCount exceed maxPosts", async () => {
  const service = await createService({
    window: createWindowDoc({ acceptedPostCount: 1 }),
    updateResult: null,
  });

  await assert.rejects(
    () => service.updateWindow(host, eventId.toString(), windowId.toString(), { maxPosts: 1 }),
    { statusCode: 409 },
  );
});

test("gallery pagination returns limited results", async () => {
  const firstPostId = new Types.ObjectId();
  const secondPostId = new Types.ObjectId();
  const service = await createService({
    existingPost: createPostDoc(),
    acceptedPosts: [
      createPostDoc({ _id: firstPostId, text: "First" }),
      createPostDoc({ _id: secondPostId, text: "Second" }),
    ],
  });
  const result = await service.listPosts(attendee, eventId.toString(), windowId.toString(), { limit: 1 });

  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0]?.text, "First");
  assert.equal(result.nextCursor, secondPostId.toString());
});

test("concurrent posts cannot exceed maxPosts", async () => {
  const [{ EventWindowRepository }, { EventWindowModel, EventWindowPostModel }, mongooseModule] = await Promise.all([
    import("../src/modules/event-windows/event-window.repository.js"),
    import("../src/modules/event-windows/event-window.model.js"),
    import("mongoose"),
  ]);
  const mongoose = mongooseModule.default;
  const originalStartSession = mongoose.startSession.bind(mongoose);
  const originalFindOne = EventWindowPostModel.findOne.bind(EventWindowPostModel);
  const originalFindOneAndUpdate = EventWindowModel.findOneAndUpdate.bind(EventWindowModel);
  const originalCreate = EventWindowPostModel.create.bind(EventWindowPostModel);
  const maxPosts = 2;
  let acceptedPostCount = 0;
  const postedUsers = new Set<string>();

  mongoose.startSession = (async () => ({
    withTransaction: async (callback: () => Promise<void>) => callback(),
    endSession: async () => undefined,
  })) as typeof mongoose.startSession;
  EventWindowPostModel.findOne = ((filter: { userId: string }) => ({
    session: async () => postedUsers.has(filter.userId) ? createPostDoc({ userId: new Types.ObjectId(filter.userId) }) : null,
  })) as typeof EventWindowPostModel.findOne;
  EventWindowModel.findOneAndUpdate = ((filter: Record<string, unknown>) => {
    assert.equal(filter.allowedContentTypes, "text");
    assert.deepEqual(filter.$expr, { $lt: ["$acceptedPostCount", "$maxPosts"] });

    if (acceptedPostCount >= maxPosts) {
      return null;
    }

    acceptedPostCount += 1;
    return createWindowDoc({ acceptedPostCount, maxPosts });
  }) as typeof EventWindowModel.findOneAndUpdate;
  EventWindowPostModel.create = ((docs: { userId: string }[]) => {
    const userId = docs[0]!.userId;
    postedUsers.add(userId);
    return [createPostDoc({ _id: new Types.ObjectId(), userId: new Types.ObjectId(userId) })];
  }) as typeof EventWindowPostModel.create;

  try {
    const repository = new EventWindowRepository();
    const results = await Promise.all(Array.from({ length: 10 }, (_, index) => repository.createPostWithCapacity({
      eventId: eventId.toString(),
      windowId: windowId.toString(),
      userId: new Types.ObjectId().toString(),
      ticketUsageId: usageId.toString(),
      contentType: "text",
      text: `Post ${index}`,
      mediaItems: [],
    })));

    assert.equal(results.filter((result) => result.status === "created").length, maxPosts);
    assert.equal(results.filter((result) => result.status === "unavailable").length, 8);
    assert.equal(acceptedPostCount, maxPosts);
  } finally {
    mongoose.startSession = originalStartSession;
    EventWindowPostModel.findOne = originalFindOne as typeof EventWindowPostModel.findOne;
    EventWindowModel.findOneAndUpdate = originalFindOneAndUpdate as typeof EventWindowModel.findOneAndUpdate;
    EventWindowPostModel.create = originalCreate as typeof EventWindowPostModel.create;
  }
});

test("existing event moments and event interaction stats remain unaffected", async () => {
  const [{ EventService }, { MomentRepository }, { MomentModel }] = await Promise.all([
    import("../src/modules/events/event.service.js"),
    import("../src/modules/moments/moment.repository.js"),
    import("../src/modules/moments/moment.model.js"),
  ]);
  const interactionMomentId = new Types.ObjectId();
  const originalFind = MomentModel.find.bind(MomentModel);
  let capturedMomentFilter: Record<string, unknown> | null = null;

  MomentModel.find = ((filter: Record<string, unknown>) => {
    capturedMomentFilter = filter;
    return {
      sort() {
        return this;
      },
      limit() {
        return [];
      },
    };
  }) as typeof MomentModel.find;

  try {
    await new MomentRepository().findByEventId(eventId.toString());
    assert.deepEqual(capturedMomentFilter, {
      audience: "public",
      eventId: eventId.toString(),
      isEventAnnouncement: { $ne: true },
    });
  } finally {
    MomentModel.find = originalFind as typeof MomentModel.find;
  }

  const eventService = new EventService(
    {
      findById: async () => event,
      countByUserId: async () => 1,
    },
    { findById: async () => ({ _id: hostId, name: "Host", username: "host", avatarKey: null }) },
    {
      countFollowers: async () => 0,
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
      ensureEventAnnouncement: async () => ({
        _id: interactionMomentId,
        userId: hostId,
        mode: "event",
        caption: event.description,
        hashtags: [],
        audience: "public",
        taggedPeople: [],
        eventTitle: event.name,
        eventId,
        isEventAnnouncement: true,
        eventCode: null,
        mediaItems: [],
        createdAt: now,
        updatedAt: now,
      }),
    },
    {
      countByMomentIds: async () => new Map([[interactionMomentId.toString(), 4]]),
      findLikedMomentIds: async () => new Set([interactionMomentId.toString()]),
    },
    { countByMomentIds: async () => new Map([[interactionMomentId.toString(), 5]]) },
    {},
    { countByMomentIds: async () => new Map([[interactionMomentId.toString(), 6]]) },
    {},
  );
  const eventResponse = await eventService.getEventById(attendee, eventId.toString());

  assert.equal(eventResponse.interactionMomentId, interactionMomentId.toString());
  assert.equal(eventResponse.likesCount, 4);
  assert.equal(eventResponse.commentsCount, 5);
  assert.equal(eventResponse.sharesCount, 6);
  assert.equal(eventResponse.isLiked, true);
});
