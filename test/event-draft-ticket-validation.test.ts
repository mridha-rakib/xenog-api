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

// EVT-013 — Batch 2, Part A: validateTicketSalesEndDates (the SAME validator
// already wired into publishBody) is now also wired into draftBody/
// draftPatchBody, so a ticket's salesEndAt-vs-event.endAt violation is
// rejected at the Zod boundary for Save Draft / Update Draft too, not only
// at Publish. This is defense-in-depth only — EventService's own
// assertTicketDatesFitEventSchedule (proven in event-ticket-management.test.ts
// and event-ticket-integrity.test.ts) remains the authoritative check and is
// unchanged by this file.

const FUTURE = new Date("2026-09-20T18:00:00.000Z");
const FUTURE_PLUS_2H = new Date("2026-09-20T20:00:00.000Z");
const FUTURE_PLUS_1H = new Date("2026-09-20T19:00:00.000Z");
const eventId = new Types.ObjectId().toString();

const validTicket = (overrides: Record<string, unknown> = {}) => ({
  name: "General",
  salesEndAt: new Date("2026-09-20T19:30:00.000Z"), // before FUTURE_PLUS_2H (endAt)
  type: "free",
  capacity: 10,
  ...overrides,
});

const draftBasePayload = (overrides: Record<string, unknown> = {}) => ({
  name: "Draft Event",
  description: "desc",
  scheduledAt: FUTURE,
  endAt: FUTURE_PLUS_2H,
  tickets: [validTicket()],
  ...overrides,
});

test("draft create: salesEndAt before endAt is accepted", async () => {
  const { eventValidation } = await import("../src/modules/events/event.validation.js");

  const result = eventValidation.saveDraft.safeParse({
    body: draftBasePayload(),
  });

  assert.equal(result.success, true);
});

test("draft create: salesEndAt equal to endAt is rejected", async () => {
  const { eventValidation } = await import("../src/modules/events/event.validation.js");

  const result = eventValidation.saveDraft.safeParse({
    body: draftBasePayload({
      tickets: [validTicket({ salesEndAt: FUTURE_PLUS_2H })],
    }),
  });

  assert.equal(result.success, false);
});

test("draft create: salesEndAt after endAt is rejected", async () => {
  const { eventValidation } = await import("../src/modules/events/event.validation.js");

  const result = eventValidation.saveDraft.safeParse({
    body: draftBasePayload({
      tickets: [validTicket({ salesEndAt: new Date("2026-09-21T00:00:00.000Z") })],
    }),
  });

  assert.equal(result.success, false);
});

test("draft PATCH (update draft): salesEndAt after the submitted endAt is rejected", async () => {
  const { eventValidation } = await import("../src/modules/events/event.validation.js");

  const result = eventValidation.updateDraft.safeParse({
    params: { id: eventId },
    body: {
      endAt: FUTURE_PLUS_1H,
      tickets: [validTicket({ salesEndAt: FUTURE_PLUS_2H })],
    },
  });

  assert.equal(result.success, false);
});

test("draft PATCH: a partial payload with no endAt and no tickets is unaffected (incomplete-draft tolerance preserved)", async () => {
  const { eventValidation } = await import("../src/modules/events/event.validation.js");

  const result = eventValidation.updateDraft.safeParse({
    params: { id: eventId },
    body: { name: "Renamed draft" },
  });

  assert.equal(result.success, true);
});

test("draft PATCH: endAt present but tickets omitted from this payload does not trigger the Zod-level check (service layer is authoritative for that case)", async () => {
  const { eventValidation } = await import("../src/modules/events/event.validation.js");

  const result = eventValidation.updateDraft.safeParse({
    params: { id: eventId },
    body: { endAt: FUTURE_PLUS_1H },
  });

  assert.equal(result.success, true);
});

test("draft create: an unrelated schedule error (end before start) is still reported exactly as before, unaffected by the new ticket check", async () => {
  const { eventValidation } = await import("../src/modules/events/event.validation.js");

  const result = eventValidation.saveDraft.safeParse({
    body: draftBasePayload({
      scheduledAt: FUTURE_PLUS_2H,
      endAt: FUTURE,
      tickets: [],
    }),
  });

  assert.equal(result.success, false);
});

test("draft create: publish validation is unaffected by this change (still rejects the same violation)", async () => {
  const { eventValidation } = await import("../src/modules/events/event.validation.js");

  const result = eventValidation.publish.safeParse({
    body: {
      name: "Publish Event",
      description: "desc",
      bannerImageKey: "events/banners/fixture-banner.jpg",
      ageRestriction: "all_ages",
      categories: ["Live Music & Concerts"],
      scheduledAt: FUTURE,
      endAt: FUTURE_PLUS_2H,
      location: { venue: "Test Venue" },
      tickets: [validTicket({ salesEndAt: FUTURE_PLUS_2H })],
      privacy: "public",
    },
  });

  assert.equal(result.success, false);
});
