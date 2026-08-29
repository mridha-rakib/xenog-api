import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { AppError } from "../src/core/errors/app-error.js";
import { EventModel } from "../src/modules/events/event.model.js";
import { MomentModel } from "../src/modules/moments/moment.model.js";
import { MomentShareModel } from "../src/modules/moments/moment-share.model.js";
import { MomentService } from "../src/modules/moments/moment.service.js";
import { momentValidation } from "../src/modules/moments/moment.validation.js";
import { UserBlockModel } from "../src/modules/user/user-block.model.js";
import { UserFollowModel } from "../src/modules/user/user-follow.model.js";
import { UserModel } from "../src/modules/user/user.model.js";
import {
  connectTranscodingTestDb,
  disconnectTranscodingTestDb,
  TRANSCODING_TEST_MONGODB_URI,
} from "./helpers/transcoding-test-db.js";

process.env.NODE_ENV = "test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const now = new Date("2026-08-11T00:00:00.000Z");
const service = new MomentService();
const createdUserIds: Types.ObjectId[] = [];
const createdFollowIds: Types.ObjectId[] = [];
const createdBlockIds: Types.ObjectId[] = [];
const createdEventIds: Types.ObjectId[] = [];
const createdMomentIds: Types.ObjectId[] = [];
const createdShareIds: Types.ObjectId[] = [];

const makeUser = (id: string, name = "Tester") => ({
  id,
  name,
  username: name.toLowerCase().replace(/\s+/g, ""),
  email: `${name.toLowerCase().replace(/\s+/g, ".")}@example.com`,
  accountType: "personal",
  currentLocationSharingEnabled: false,
  notificationsEnabled: true,
  role: "user",
  isActive: true,
  emailVerified: true,
  createdAt: now,
  updatedAt: now,
});

const seedUser = async (name: string) => {
  const suffix = new Types.ObjectId().toString().slice(-6);
  const user = await UserModel.create({
    name,
    username: `${name.toLowerCase().replace(/\s+/g, "")}${suffix}`,
    email: `${name.toLowerCase().replace(/\s+/g, ".")}.${suffix}@example.com`,
    passwordHash: "test",
    accountType: "personal",
    notificationsEnabled: true,
    role: "user",
    isActive: true,
    emailVerified: true,
  });
  createdUserIds.push(user._id);
  return user._id.toString();
};

const createMutualFriendship = async (firstUserId: string, secondUserId: string) => {
  const forward = await UserFollowModel.create({ followerId: firstUserId, followingId: secondUserId });
  const reverse = await UserFollowModel.create({ followerId: secondUserId, followingId: firstUserId });
  createdFollowIds.push(forward._id, reverse._id);
};

const blockUser = async (blockerId: string, blockedId: string) => {
  const block = await UserBlockModel.create({ blockerId, blockedId });
  createdBlockIds.push(block._id);
};

const seedPostMoment = async (ownerId: string) => {
  const moment = await MomentModel.create({
    userId: ownerId,
    mode: "feed",
    caption: "Beautiful day",
    hashtags: [],
    audience: "public",
    taggedPeople: [],
    taggedFriendIds: [],
    mediaItems: [],
  });
  createdMomentIds.push(moment._id);
  return moment;
};

const seedEventMoment = async (hostId: string) => {
  const event = await EventModel.create({
    userId: hostId,
    status: "published",
    privacy: "public",
    name: "Rooftop Mixer",
    category: "Social Meetups",
    categories: ["Social Meetups"],
  });
  createdEventIds.push(event._id);

  const interactionMoment = await MomentModel.create({
    userId: hostId,
    mode: "event",
    audience: "public",
    caption: null,
    hashtags: [],
    taggedPeople: [],
    taggedFriendIds: [],
    mediaItems: [],
    isEventAnnouncement: true,
    eventId: event._id,
    eventTitle: "Rooftop Mixer",
  });
  createdMomentIds.push(interactionMoment._id);

  return { event, interactionMoment };
};

const seedShareScenario = async (options: { originalType?: "post" | "event" } = {}) => {
  const originalAuthorId = await seedUser("Original Author");
  const reposterId = await seedUser("Reposter");
  const source = options.originalType === "event"
    ? await seedEventMoment(originalAuthorId)
    : { event: null, interactionMoment: await seedPostMoment(originalAuthorId) };
  const moment = source.interactionMoment;

  const share = await MomentShareModel.create({
    userId: reposterId,
    momentId: moment._id,
    caption: "Everyone should see this",
    taggedFriendIds: [],
    originalType: options.originalType ?? "post",
    originalId: options.originalType === "event" ? source.event!._id : moment._id,
    clientRequestId: null,
  });
  createdShareIds.push(share._id);

  return {
    originalAuthorId,
    reposterId,
    momentId: moment._id.toString(),
    shareId: share._id.toString(),
    eventId: source.event?._id.toString() ?? null,
  };
};

test.before(async () => {
  await connectTranscodingTestDb(TRANSCODING_TEST_MONGODB_URI);
});

test.after(async () => {
  if (createdBlockIds.length) await UserBlockModel.deleteMany({ _id: { $in: createdBlockIds } });
  if (createdFollowIds.length) await UserFollowModel.deleteMany({ _id: { $in: createdFollowIds } });
  if (createdShareIds.length) await MomentShareModel.deleteMany({ _id: { $in: createdShareIds } });
  if (createdMomentIds.length) await MomentModel.deleteMany({ _id: { $in: createdMomentIds } });
  if (createdEventIds.length) await EventModel.deleteMany({ _id: { $in: createdEventIds } });
  if (createdUserIds.length) await UserModel.deleteMany({ _id: { $in: createdUserIds } });
  await disconnectTranscodingTestDb();
});

test("updateMomentShare validation accepts caption-only, tags-only, and caption+tags payloads", () => {
  const shareId = new Types.ObjectId().toString();
  const friendId = new Types.ObjectId().toString();

  assert.equal(momentValidation.updateMomentShare.safeParse({
    params: { shareId },
    body: { caption: "Really worth checking out" },
  }).success, true);

  assert.equal(momentValidation.updateMomentShare.safeParse({
    params: { shareId },
    body: { taggedFriendIds: [friendId, friendId] },
  }).success, true);

  const both = momentValidation.updateMomentShare.safeParse({
    params: { shareId },
    body: { caption: "Updated", taggedFriendIds: [friendId, friendId] },
  });
  assert.equal(both.success, true);
  if (both.success) {
    assert.deepEqual(both.data.body.taggedFriendIds, [friendId]);
  }

  assert.equal(momentValidation.updateMomentShare.safeParse({
    params: { shareId },
    body: { caption: "x", extra: true },
  }).success, false);
});

test("owner can edit repost tags only and the response includes resolved tagged friends", async () => {
  const seeded = await seedShareScenario();
  const friendId = await seedUser("Close Friend");
  await createMutualFriendship(seeded.reposterId, friendId);

  const updated = await service.updateMomentShare(
    seeded.shareId,
    makeUser(seeded.reposterId, "Reposter") as never,
    { taggedFriendIds: [friendId] },
  );

  assert.equal(updated.repostCaption, null);
  assert.deepEqual(updated.taggedFriends?.map((friend) => friend.id), [friendId]);
});

test("owner can edit repost caption and tags together", async () => {
  const seeded = await seedShareScenario();
  const firstFriendId = await seedUser("First Friend");
  const secondFriendId = await seedUser("Second Friend");
  await createMutualFriendship(seeded.reposterId, firstFriendId);
  await createMutualFriendship(seeded.reposterId, secondFriendId);

  const updated = await service.updateMomentShare(
    seeded.shareId,
    makeUser(seeded.reposterId, "Reposter") as never,
    { caption: "Looks amazing", taggedFriendIds: [firstFriendId, secondFriendId] },
  );

  assert.equal(updated.repostCaption, "Looks amazing");
  assert.deepEqual(updated.taggedFriends?.map((friend) => friend.id), [firstFriendId, secondFriendId]);
});

test("omitting taggedFriendIds preserves existing tags, while an empty array removes all tags", async () => {
  const seeded = await seedShareScenario();
  const friendId = await seedUser("Persisted Friend");
  await createMutualFriendship(seeded.reposterId, friendId);
  await MomentShareModel.updateOne({ _id: seeded.shareId }, { $set: { taggedFriendIds: [friendId] } });

  const preserved = await service.updateMomentShare(
    seeded.shareId,
    makeUser(seeded.reposterId, "Reposter") as never,
    { caption: "Caption only" },
  );
  assert.deepEqual(preserved.taggedFriends?.map((friend) => friend.id), [friendId]);

  const cleared = await service.updateMomentShare(
    seeded.shareId,
    makeUser(seeded.reposterId, "Reposter") as never,
    { taggedFriendIds: [] },
  );
  assert.deepEqual(cleared.taggedFriends, []);
});

test("duplicate tag ids are deduplicated on update", async () => {
  const seeded = await seedShareScenario();
  const friendId = await seedUser("Deduped Friend");
  await createMutualFriendship(seeded.reposterId, friendId);

  const updated = await service.updateMomentShare(
    seeded.shareId,
    makeUser(seeded.reposterId, "Reposter") as never,
    { taggedFriendIds: [friendId, friendId] },
  );

  assert.deepEqual(updated.taggedFriends?.map((friend) => friend.id), [friendId]);
});

test("non-friends and blocked users are rejected by the repost tag validation", async () => {
  const seeded = await seedShareScenario();
  const strangerId = await seedUser("Stranger");
  const blockedFriendId = await seedUser("Blocked Friend");
  await createMutualFriendship(seeded.reposterId, blockedFriendId);
  await blockUser(seeded.reposterId, blockedFriendId);

  await assert.rejects(
    service.updateMomentShare(
      seeded.shareId,
      makeUser(seeded.reposterId, "Reposter") as never,
      { taggedFriendIds: [strangerId] },
    ),
    /You can only tag friends in a repost/,
  );

  await assert.rejects(
    service.updateMomentShare(
      seeded.shareId,
      makeUser(seeded.reposterId, "Reposter") as never,
      { taggedFriendIds: [blockedFriendId] },
    ),
    /You can only tag friends in a repost/,
  );
});

test("non-owners cannot update repost tags", async () => {
  const seeded = await seedShareScenario();
  const friendId = await seedUser("Unauthorized Friend");
  await createMutualFriendship(seeded.reposterId, friendId);
  const otherUserId = await seedUser("Other User");

  await assert.rejects(
    service.updateMomentShare(
      seeded.shareId,
      makeUser(otherUserId, "Other User") as never,
      { taggedFriendIds: [friendId] },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 403);
      return true;
    },
  );
});

test("shared Post and shared Event use the same tag-edit path", async () => {
  const postSeeded = await seedShareScenario({ originalType: "post" });
  const eventSeeded = await seedShareScenario({ originalType: "event" });
  const postFriendId = await seedUser("Post Friend");
  const eventFriendId = await seedUser("Event Friend");
  await createMutualFriendship(postSeeded.reposterId, postFriendId);
  await createMutualFriendship(eventSeeded.reposterId, eventFriendId);

  const postUpdated = await service.updateMomentShare(
    postSeeded.shareId,
    makeUser(postSeeded.reposterId, "Reposter") as never,
    { taggedFriendIds: [postFriendId] },
  );
  const eventUpdated = await service.updateMomentShare(
    eventSeeded.shareId,
    makeUser(eventSeeded.reposterId, "Reposter") as never,
    { taggedFriendIds: [eventFriendId] },
  );

  assert.equal(postUpdated.originalItem?.type, "post");
  assert.equal(eventUpdated.originalItem?.type, "event");
  assert.deepEqual(postUpdated.taggedFriends?.map((friend) => friend.id), [postFriendId]);
  assert.deepEqual(eventUpdated.taggedFriends?.map((friend) => friend.id), [eventFriendId]);
});

test("owner can delete only their own repost, leaving the original post and other users' reposts intact", async () => {
  const seeded = await seedShareScenario();
  const anotherReposterId = await seedUser("Another Reposter");
  const anotherShare = await MomentShareModel.create({
    userId: anotherReposterId,
    momentId: seeded.momentId,
    caption: "Different repost",
    taggedFriendIds: [],
    originalType: "post",
    originalId: seeded.momentId,
    clientRequestId: null,
  });
  createdShareIds.push(anotherShare._id);

  assert.equal(await MomentShareModel.countDocuments({ momentId: seeded.momentId }), 2);
  await service.deleteMomentShare(seeded.shareId, makeUser(seeded.reposterId, "Reposter") as never);

  assert.equal(await MomentShareModel.findById(seeded.shareId), null);
  assert.ok(await MomentModel.findById(seeded.momentId));
  assert.ok(await MomentShareModel.findById(anotherShare._id));
  assert.equal(await MomentShareModel.countDocuments({ momentId: seeded.momentId }), 1);
});

test("owner can delete an event repost without deleting the original event or interaction moment", async () => {
  const seeded = await seedShareScenario({ originalType: "event" });

  await service.deleteMomentShare(seeded.shareId, makeUser(seeded.reposterId, "Reposter") as never);

  assert.equal(await MomentShareModel.findById(seeded.shareId), null);
  assert.ok(await EventModel.findById(seeded.eventId));
  assert.ok(await MomentModel.findById(seeded.momentId));
});

test("non-owners cannot delete another user's repost and deleting an unknown repost returns 404", async () => {
  const seeded = await seedShareScenario();
  const otherUserId = await seedUser("Other User");

  await assert.rejects(
    service.deleteMomentShare(seeded.shareId, makeUser(otherUserId, "Other User") as never),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 403);
      return true;
    },
  );

  await assert.rejects(
    service.deleteMomentShare(new Types.ObjectId().toString(), makeUser(seeded.reposterId, "Reposter") as never),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 404);
      return true;
    },
  );
});
