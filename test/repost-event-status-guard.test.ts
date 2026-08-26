import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { EventModel } from "../src/modules/events/event.model.js";
import { MomentModel } from "../src/modules/moments/moment.model.js";
import { MomentService } from "../src/modules/moments/moment.service.js";
import {
  connectTranscodingTestDb,
  disconnectTranscodingTestDb,
  TRANSCODING_TEST_MONGODB_URI,
} from "./helpers/transcoding-test-db.js";

// Covers the "public LIVE event repost rejected" fix in
// MomentService.shareMoment (src/modules/moments/moment.service.ts).
//
// Root cause: the event-announcement guard only accepted
// event.status === "published", so a genuinely public event that had
// started (status flips to "live" via a real DB transition — see
// EventRepository's startEvent-style updates) was rejected with
// "Only public events can be reposted" even though nothing about its
// privacy had changed. The fix widens the guard to the same
// ["published", "live"] active-status pair already used elsewhere in
// event.service.ts (e.g. submitJoinRequest), without touching
// event.privacy or moment.audience enforcement at all.

process.env.NODE_ENV = "test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const now = new Date("2026-08-26T00:00:00.000Z");
const service = new MomentService();

const createdMomentIds: Types.ObjectId[] = [];
const createdEventIds: Types.ObjectId[] = [];

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

const seedEventWithAnnouncement = async (
  hostId: string,
  eventOverrides: { status: string; privacy: string },
  momentOverrides: { audience?: string } = {},
) => {
  const event = await EventModel.create({
    userId: hostId,
    status: eventOverrides.status,
    privacy: eventOverrides.privacy,
    name: "Rooftop Mixer",
    category: "Social Meetups",
    categories: ["Social Meetups"],
  });
  createdEventIds.push(event._id);

  const interactionMoment = await MomentModel.create({
    userId: hostId,
    mode: "event",
    audience: momentOverrides.audience ?? "public",
    hashtags: [],
    taggedPeople: [],
    taggedFriendIds: [],
    mediaItems: [],
    isEventAnnouncement: true,
    eventId: event._id,
    eventTitle: event.name,
  });
  createdMomentIds.push(interactionMoment._id);

  return { eventId: event._id.toString(), interactionMomentId: interactionMoment._id.toString() };
};

const newUserId = (): string => new Types.ObjectId().toString();

test.before(async () => {
  await connectTranscodingTestDb(TRANSCODING_TEST_MONGODB_URI);
});

test.after(async () => {
  await MomentModel.deleteMany({ _id: { $in: createdMomentIds } });
  await EventModel.deleteMany({ _id: { $in: createdEventIds } });
  await disconnectTranscodingTestDb();
});

test("Test 1 — published public event: repost succeeds (existing behavior preserved)", async () => {
  const hostId = newUserId();
  const actorId = newUserId();
  const { interactionMomentId } = await seedEventWithAnnouncement(hostId, {
    status: "published",
    privacy: "public",
  });
  const actor = makeUser(actorId, "Alex") as never;

  const share = await service.shareMoment(interactionMomentId, actor);
  assert.ok(share);
});

test("Test 2 — live public event: repost now succeeds (the regression this fix targets)", async () => {
  const hostId = newUserId();
  const actorId = newUserId();
  const { interactionMomentId } = await seedEventWithAnnouncement(hostId, {
    status: "live",
    privacy: "public",
  });
  const actor = makeUser(actorId, "Alex") as never;

  const share = await service.shareMoment(interactionMomentId, actor);
  assert.ok(share);
});

test("Test 3 — live non-public event: repost is still rejected", async () => {
  const hostId = newUserId();
  const actorId = newUserId();
  const { interactionMomentId } = await seedEventWithAnnouncement(hostId, {
    status: "live",
    privacy: "private",
  });
  const actor = makeUser(actorId, "Alex") as never;

  await assert.rejects(
    () => service.shareMoment(interactionMomentId, actor),
    /Only public events can be reposted/,
  );
});

test("Test 4 — draft public event: repost is still rejected", async () => {
  const hostId = newUserId();
  const actorId = newUserId();
  const { interactionMomentId } = await seedEventWithAnnouncement(hostId, {
    status: "draft",
    privacy: "public",
  });
  const actor = makeUser(actorId, "Alex") as never;

  await assert.rejects(
    () => service.shareMoment(interactionMomentId, actor),
    /Only public events can be reposted/,
  );
});

test("Test 5 — cancelled public event: repost is still rejected", async () => {
  const hostId = newUserId();
  const actorId = newUserId();
  const { interactionMomentId } = await seedEventWithAnnouncement(hostId, {
    status: "cancelled",
    privacy: "public",
  });
  const actor = makeUser(actorId, "Alex") as never;

  await assert.rejects(
    () => service.shareMoment(interactionMomentId, actor),
    /Only public events can be reposted/,
  );
});

test("Test 6 — a public+live event whose announcement moment is not itself public is still rejected on the pre-existing audience rule", async () => {
  const hostId = newUserId();
  const actorId = newUserId();
  const { interactionMomentId } = await seedEventWithAnnouncement(
    hostId,
    { status: "live", privacy: "public" },
    { audience: "friends" },
  );
  const actor = makeUser(actorId, "Alex") as never;

  await assert.rejects(
    () => service.shareMoment(interactionMomentId, actor),
    /Only public posts can be shared/,
  );
});
