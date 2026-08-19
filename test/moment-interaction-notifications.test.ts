import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { EventModel } from "../src/modules/events/event.model.js";
import { MomentModel } from "../src/modules/moments/moment.model.js";
import { MomentService } from "../src/modules/moments/moment.service.js";
import { NotificationModel } from "../src/modules/notifications/notification.model.js";
import {
  connectTranscodingTestDb,
  disconnectTranscodingTestDb,
  TRANSCODING_TEST_MONGODB_URI,
} from "./helpers/transcoding-test-db.js";

process.env.NODE_ENV = "test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const now = new Date("2026-08-19T00:00:00.000Z");
const service = new MomentService();

const createdMomentIds: Types.ObjectId[] = [];
const createdEventIds: Types.ObjectId[] = [];
const recipientIdsToClean: Types.ObjectId[] = [];

const makeUser = (id: string, name = "Actor") => ({
  id,
  name,
  username: name.toLowerCase(),
  email: `${name.toLowerCase()}@example.com`,
  accountType: "personal",
  currentLocationSharingEnabled: false,
  notificationsEnabled: true,
  role: "user",
  isActive: true,
  emailVerified: true,
  createdAt: now,
  updatedAt: now,
});

const seedPost = async (ownerId: string) => {
  const doc = await MomentModel.create({
    userId: ownerId,
    mode: "feed",
    caption: "Hello from a Post",
    hashtags: [],
    audience: "public",
    taggedPeople: [],
    taggedFriendIds: [],
    mediaItems: [],
  });
  createdMomentIds.push(doc._id);
  return doc._id.toString();
};

const seedEventWithInteractionMoment = async (hostId: string, eventName = "Rooftop Mixer") => {
  const event = await EventModel.create({
    userId: hostId,
    status: "published",
    privacy: "public",
    name: eventName,
    category: "Social Meetups",
    categories: ["Social Meetups"],
  });
  createdEventIds.push(event._id);

  const interactionMoment = await MomentModel.create({
    userId: hostId,
    mode: "event",
    audience: "public",
    hashtags: [],
    taggedPeople: [],
    taggedFriendIds: [],
    mediaItems: [],
    isEventAnnouncement: true,
    eventId: event._id,
    eventTitle: eventName,
  });
  createdMomentIds.push(interactionMoment._id);

  return { eventId: event._id.toString(), interactionMomentId: interactionMoment._id.toString() };
};

const newUserId = (): string => {
  const id = new Types.ObjectId();
  recipientIdsToClean.push(id);
  return id.toString();
};

test.before(async () => {
  await connectTranscodingTestDb(TRANSCODING_TEST_MONGODB_URI);
});

test.after(async () => {
  if (createdMomentIds.length) await MomentModel.deleteMany({ _id: { $in: createdMomentIds } });
  if (createdEventIds.length) await EventModel.deleteMany({ _id: { $in: createdEventIds } });
  if (recipientIdsToClean.length) {
    await NotificationModel.deleteMany({ recipientUserId: { $in: recipientIdsToClean } });
  }
  await disconnectTranscodingTestDb();
});

// ---------------------------------------------------------------------------
// Schema contract — no DB connection needed
// ---------------------------------------------------------------------------

test("Notification schema recognizes the new moment interaction types", () => {
  const typePath = NotificationModel.schema.path("type") as unknown as { enumValues: string[] };
  assert.ok(typePath.enumValues.includes("moment_reaction"));
  assert.ok(typePath.enumValues.includes("moment_comment"));
  assert.ok(typePath.enumValues.includes("moment_share"));
});

test("Notification recipient+sourceKey dedup index is intact", () => {
  const uniqueIndex = NotificationModel.schema.indexes().find(([fields, options]) => (
    fields.recipientUserId === 1 && fields.sourceKey === 1 && options.unique === true
  ));
  assert.ok(uniqueIndex);
});

// ---------------------------------------------------------------------------
// Post reaction
// ---------------------------------------------------------------------------

test("A liking B's Post notifies B exactly once, with correct actor/target/copy", async () => {
  const ownerId = newUserId();
  const actorId = newUserId();
  const momentId = await seedPost(ownerId);

  await service.toggleMomentReaction(momentId, makeUser(actorId, "Alex") as never);

  const notification = await NotificationModel.findOne({ recipientUserId: ownerId, type: "moment_reaction" });
  assert.ok(notification);
  assert.equal(notification!.actorName, "Alex");
  assert.equal(notification!.contentType, "post");
  assert.equal(notification!.momentId, momentId);
  assert.equal(notification!.eventId, null);
  assert.equal(notification!.message, "Alex liked your post.");
  assert.equal(notification!.sourceKey, `reaction:${momentId}:${actorId}`);
});

test("unliking creates no new notification, and re-liking does not duplicate the historical one", async () => {
  const ownerId = newUserId();
  const actorId = newUserId();
  const momentId = await seedPost(ownerId);
  const actor = makeUser(actorId, "Alex") as never;

  await service.toggleMomentReaction(momentId, actor); // like
  await service.toggleMomentReaction(momentId, actor); // unlike
  await service.toggleMomentReaction(momentId, actor); // re-like

  const count = await NotificationModel.countDocuments({ recipientUserId: ownerId, type: "moment_reaction" });
  assert.equal(count, 1);
});

// ---------------------------------------------------------------------------
// Post comment
// ---------------------------------------------------------------------------

test("A commenting on B's Post notifies B once per distinct comment", async () => {
  const ownerId = newUserId();
  const actorId = newUserId();
  const momentId = await seedPost(ownerId);
  const actor = makeUser(actorId, "Alex") as never;

  await service.createMomentComment(momentId, { text: "Nice!" }, actor);
  await service.createMomentComment(momentId, { text: "Love this" }, actor);

  const notifications = await NotificationModel.find({ recipientUserId: ownerId, type: "moment_comment" });
  assert.equal(notifications.length, 2);
  assert.equal(notifications[0]?.message, "Alex commented on your post.");
  assert.equal(notifications[0]?.contentType, "post");
  assert.equal(notifications[0]?.momentId, momentId);
});

// ---------------------------------------------------------------------------
// Post share
// ---------------------------------------------------------------------------

test("A sharing B's Post notifies B once; repeating the share does not duplicate it", async () => {
  const ownerId = newUserId();
  const actorId = newUserId();
  const momentId = await seedPost(ownerId);
  const actor = makeUser(actorId, "Alex") as never;

  await service.shareMoment(momentId, actor);
  await service.shareMoment(momentId, actor); // idempotent upsert — must not re-notify

  const notifications = await NotificationModel.find({ recipientUserId: ownerId, type: "moment_share" });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.message, "Alex shared your post.");
  assert.equal(notifications[0]?.contentType, "post");
});

// ---------------------------------------------------------------------------
// Event reaction / comment / share — Interaction Moment -> Event owner
// ---------------------------------------------------------------------------

test("A liking B's Event notifies the Event host, referencing the Event (not the Interaction Moment)", async () => {
  const hostId = newUserId();
  const actorId = newUserId();
  const { eventId, interactionMomentId } = await seedEventWithInteractionMoment(hostId, "Rooftop Mixer");
  const actor = makeUser(actorId, "Alex") as never;

  await service.toggleMomentReaction(interactionMomentId, actor);

  const notification = await NotificationModel.findOne({ recipientUserId: hostId, type: "moment_reaction" });
  assert.ok(notification);
  assert.equal(notification!.contentType, "event");
  assert.equal(notification!.eventId, eventId);
  assert.equal(notification!.momentId, null);
  assert.equal(notification!.eventName, "Rooftop Mixer");
  assert.equal(notification!.message, "Alex liked your event.");
});

test("A commenting on B's Event notifies the Event host, referencing the Event", async () => {
  const hostId = newUserId();
  const actorId = newUserId();
  const { eventId, interactionMomentId } = await seedEventWithInteractionMoment(hostId, "Beach Cleanup");
  const actor = makeUser(actorId, "Alex") as never;

  await service.createMomentComment(interactionMomentId, { text: "Count me in!" }, actor);

  const notification = await NotificationModel.findOne({ recipientUserId: hostId, type: "moment_comment" });
  assert.ok(notification);
  assert.equal(notification!.contentType, "event");
  assert.equal(notification!.eventId, eventId);
  assert.equal(notification!.momentId, null);
  assert.equal(notification!.message, "Alex commented on your event.");
});

test("A sharing B's Event notifies the Event host, referencing the Event", async () => {
  const hostId = newUserId();
  const actorId = newUserId();
  const { eventId, interactionMomentId } = await seedEventWithInteractionMoment(hostId, "Trivia Night");
  const actor = makeUser(actorId, "Alex") as never;

  await service.shareMoment(interactionMomentId, actor);

  const notification = await NotificationModel.findOne({ recipientUserId: hostId, type: "moment_share" });
  assert.ok(notification);
  assert.equal(notification!.contentType, "event");
  assert.equal(notification!.eventId, eventId);
  assert.equal(notification!.momentId, null);
  assert.equal(notification!.message, "Alex shared your event.");
});

// ---------------------------------------------------------------------------
// Self-interaction
// ---------------------------------------------------------------------------

test("liking your own Post succeeds normally but generates no notification", async () => {
  const ownerId = newUserId();
  const momentId = await seedPost(ownerId);

  const summary = await service.toggleMomentReaction(momentId, makeUser(ownerId, "Owner") as never);

  assert.equal(summary.isLiked, true); // interaction itself is unaffected
  const count = await NotificationModel.countDocuments({ recipientUserId: ownerId, type: "moment_reaction" });
  assert.equal(count, 0);
});

test("commenting on your own Post succeeds normally but generates no notification", async () => {
  const ownerId = newUserId();
  const momentId = await seedPost(ownerId);

  const result = await service.createMomentComment(momentId, { text: "note to self" }, makeUser(ownerId, "Owner") as never);

  assert.equal(result.comment.text, "note to self"); // interaction itself is unaffected
  const count = await NotificationModel.countDocuments({ recipientUserId: ownerId, type: "moment_comment" });
  assert.equal(count, 0);
});
