import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const eventId = new Types.ObjectId();
const hostId = new Types.ObjectId();
const reviewerId = new Types.ObjectId();
const usageId = new Types.ObjectId();
const reviewId = new Types.ObjectId();

const reviewer = {
  id: reviewerId.toString(),
  name: "Attendee",
  username: "attendee",
  email: "attendee@example.com",
  accountType: "personal",
  role: "user",
};

const createEventService = async (overrides: {
  eventStatus?: string;
  hasAttendance?: boolean;
  hasExistingReview?: boolean;
} = {}) => {
  const { EventService } = await import("../src/modules/events/event.service.js");
  const event = {
    _id: eventId,
    userId: hostId,
    status: overrides.eventStatus ?? "completed",
    name: "Completed Event",
  };
  const review = {
    _id: reviewId,
    eventId,
    hostUserId: hostId,
    reviewerUserId: reviewerId,
    ticketUsageId: usageId,
    rating: "like",
    text: "Great host",
    createdAt: new Date("2026-07-07T00:00:00.000Z"),
    updatedAt: new Date("2026-07-07T00:00:00.000Z"),
  };
  let createdReviews = 0;

  const service = new EventService(
    { findById: async () => event },
    { findById: async () => ({ _id: reviewerId, name: "Attendee", username: "attendee", avatarKey: null }) },
    {} as never,
    { createDownloadUrl: async () => ({ url: "" }) },
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {
      findByEventIdAndHolderUserId: async () =>
        overrides.hasAttendance === false
          ? null
          : {
              _id: usageId,
            },
    },
    {
      findByEventIdAndReviewerUserId: async () => (overrides.hasExistingReview ? review : null),
      create: async () => {
        createdReviews += 1;
        return review;
      },
    },
  );

  return { service, getCreatedReviews: () => createdReviews };
};

test("checked-in attendee can review completed event host once", async () => {
  const fixture = await createEventService();
  const result = await fixture.service.submitHostReview(reviewer as never, eventId.toString(), {
    liked: true,
    text: "Great host",
  });

  assert.equal(result.id, reviewId.toString());
  assert.equal(result.liked, true);
  assert.equal(result.text, "Great host");
  assert.equal(result.event?.name, "Completed Event");
  assert.equal(fixture.getCreatedReviews(), 1);
});

test("non checked-in attendee cannot review host", async () => {
  const fixture = await createEventService({ hasAttendance: false });

  await assert.rejects(
    () => fixture.service.submitHostReview(reviewer as never, eventId.toString(), { liked: true }),
    /Only checked-in attendees can review this host/,
  );
  assert.equal(fixture.getCreatedReviews(), 0);
});

test("duplicate host review is rejected before creating another record", async () => {
  const fixture = await createEventService({ hasExistingReview: true });

  await assert.rejects(
    () => fixture.service.submitHostReview(reviewer as never, eventId.toString(), { liked: false }),
    /already reviewed/,
  );
  assert.equal(fixture.getCreatedReviews(), 0);
});

test("host cannot review own event", async () => {
  const fixture = await createEventService();
  const hostUser = { ...reviewer, id: hostId.toString() };

  await assert.rejects(
    () => fixture.service.submitHostReview(hostUser as never, eventId.toString(), { liked: true }),
    /cannot review your own event/,
  );
  assert.equal(fixture.getCreatedReviews(), 0);
});

test("review is blocked before event completion", async () => {
  const fixture = await createEventService({ eventStatus: "live" });

  await assert.rejects(
    () => fixture.service.submitHostReview(reviewer as never, eventId.toString(), { liked: true }),
    /after the event is completed/,
  );
  assert.equal(fixture.getCreatedReviews(), 0);
});
