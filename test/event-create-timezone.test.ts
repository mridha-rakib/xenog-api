import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { EventService } from "../src/modules/events/event.service.js";
import type { SaveEventDraftDto } from "../src/modules/events/event.interface.js";

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
const ownerId = new Types.ObjectId();
const user = { id: ownerId.toString(), name: "Owner", role: "user" } as never;

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

type Captured = { create?: Record<string, unknown>; update?: Record<string, unknown> };

const makeService = (captured: Captured, existing?: Record<string, unknown> | null) => {
  const eventRepository = {
    create: async (payload: Record<string, unknown>) => {
      captured.create = payload;
      return { ...baseEventDoc(), ...payload, _id: new Types.ObjectId() };
    },
    updateDraftByIdForUser: async (_id: string, _userId: string, payload: Record<string, unknown>) => {
      captured.update = payload;
      return { ...baseEventDoc(), ...existing, ...payload, _id: new Types.ObjectId() };
    },
    findByIdForUser: async () => (existing ? { ...baseEventDoc(), ...existing } : null),
  };

  return new EventService(
    eventRepository as never,
    { findById: async () => host } as never,
    { countFollowers: async () => 0, isFollowing: async () => false } as never,
    { createDownloadUrl: async () => ({ url: "" }) } as never,
    {} as never,
    {} as never,
    { hasUserPaidTicketForEvent: async () => false } as never,
    {} as never,
    {} as never,
    { hasActiveShareForRecipientAtEvent: async () => false } as never,
    {} as never,
    {} as never,
    {} as never, // eventSaveRepository
    {} as never, // liveRoomRepository
    {} as never, // momentRepository
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { findConflictingForEventSchedule: async () => [] } as never, // eventWindowRepository
    {} as never,
    () => now,
    undefined,
    {
      findReportedTargetIds: async () => new Set<string>(),
      hasReported: async () => false,
    } as never,
  );
};

const baseEventDoc = () => ({
  _id: new Types.ObjectId(),
  userId: ownerId,
  status: "draft",
  name: "TZ Event",
  description: "desc",
  bannerImageKey: null,
  bannerOriginalImageKey: null,
  bannerImageDisplay: null,
  ageRestriction: "all_ages",
  category: "Live Music & Concerts",
  categories: ["Live Music & Concerts"],
  hashtags: [],
  scheduledAt: null,
  endAt: null,
  timezone: null,
  location: null,
  tickets: [],
  rewards: [],
  privacy: "public",
  memberUserIds: [],
  joinRequests: [],
  publishedAt: null,
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
  createdAt: now,
  updatedAt: now,
});

const NY_COORDS = { latitude: 40.7128, longitude: -74.006 };
const LA_COORDS = { latitude: 34.0522, longitude: -118.2437 };
const DHAKA_COORDS = { latitude: 23.8103, longitude: 90.4125 };

const draftDto = (over: Partial<SaveEventDraftDto>): SaveEventDraftDto =>
  ({
    name: "TZ Event",
    description: "desc",
    categories: ["Live Music & Concerts"],
    ...over,
  }) as SaveEventDraftDto;

const withProcessTz = async <T>(tz: string, run: () => Promise<T>): Promise<T> => {
  const original = process.env.TZ;
  process.env.TZ = tz;
  try {
    return await run();
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
};

// ── §11 / §38 new Event: explicit venue-local wall-clock + resolved zone ─────

test("§11 Dhaka creator + New York venue + Sep 20 7PM → America/New_York, 23:00Z", async () => {
  await withProcessTz("Asia/Dhaka", async () => {
    const captured: Captured = {};
    await makeService(captured).saveDraft(
      user,
      draftDto({
        location: { venue: "MSG", address: "NYC", ...NY_COORDS },
        // Device-derived ISO the old client would also send — must be overridden.
        scheduledAt: "2026-09-20T13:00:00.000Z",
        endAt: "2026-09-20T15:00:00.000Z",
        scheduledLocalDate: "2026-09-20",
        scheduledLocalTime: "19:00",
        endLocalDate: "2026-09-20",
        endLocalTime: "21:00",
      }),
    );

    assert.equal(captured.create?.timezone, "America/New_York");
    assert.equal(
      (captured.create?.scheduledAt as Date).toISOString(),
      "2026-09-20T23:00:00.000Z",
    );
    assert.equal((captured.create?.endAt as Date).toISOString(), "2026-09-21T01:00:00.000Z");
    // Transport-only fields never reach the repository.
    assert.equal("scheduledLocalDate" in (captured.create ?? {}), false);
    assert.equal("scheduledLocalTime" in (captured.create ?? {}), false);
    assert.equal("endLocalDate" in (captured.create ?? {}), false);
    assert.equal("endLocalTime" in (captured.create ?? {}), false);
  });
});

test("§14 same input under a Los Angeles process timezone yields the SAME UTC instant", async () => {
  const run = (tz: string) =>
    withProcessTz(tz, async () => {
      const captured: Captured = {};
      await makeService(captured).saveDraft(
        user,
        draftDto({
          location: { venue: "MSG", ...NY_COORDS },
          scheduledLocalDate: "2026-09-20",
          scheduledLocalTime: "19:00",
          endLocalDate: "2026-09-20",
          endLocalTime: "21:00",
        }),
      );
      return (captured.create?.scheduledAt as Date).toISOString();
    });

  assert.equal(await run("America/Los_Angeles"), "2026-09-20T23:00:00.000Z");
  assert.equal(await run("Etc/UTC"), "2026-09-20T23:00:00.000Z");
  assert.equal(await run("Asia/Dhaka"), "2026-09-20T23:00:00.000Z");
});

test("§13 New York winter date resolves with EST (not a fixed summer offset)", async () => {
  const captured: Captured = {};
  await makeService(captured).saveDraft(
    user,
    draftDto({
      location: { venue: "MSG", ...NY_COORDS },
      scheduledLocalDate: "2026-01-20",
      scheduledLocalTime: "19:00",
      endLocalDate: "2026-01-20",
      endLocalTime: "21:00",
    }),
  );
  assert.equal(captured.create?.timezone, "America/New_York");
  assert.equal((captured.create?.scheduledAt as Date).toISOString(), "2026-01-21T00:00:00.000Z");
});

test("§15 local Event (Dhaka venue) still resolves to Asia/Dhaka at 7PM Dhaka", async () => {
  const captured: Captured = {};
  await makeService(captured).saveDraft(
    user,
    draftDto({
      location: { venue: "Hall", ...DHAKA_COORDS },
      scheduledLocalDate: "2026-09-20",
      scheduledLocalTime: "19:00",
      endLocalDate: "2026-09-20",
      endLocalTime: "21:00",
    }),
  );
  assert.equal(captured.create?.timezone, "Asia/Dhaka");
  assert.equal((captured.create?.scheduledAt as Date).toISOString(), "2026-09-20T13:00:00.000Z");
});

// ── §16 no coordinates → no invented timezone, absolute instant preserved ───

test("§16 venue without coordinates → timezone null, scheduledAt = payload absolute", async () => {
  const captured: Captured = {};
  await makeService(captured).saveDraft(
    user,
    draftDto({
      location: { venue: "Somewhere", address: "No coords" },
      scheduledAt: new Date("2026-09-20T18:30:00.000Z"),
      endAt: new Date("2026-09-20T20:30:00.000Z"),
      scheduledLocalDate: "2026-09-20",
      scheduledLocalTime: "19:00",
      endLocalDate: "2026-09-20",
      endLocalTime: "21:00",
    }),
  );
  assert.equal(captured.create?.timezone ?? null, null);
  assert.equal((captured.create?.scheduledAt as Date).toISOString(), "2026-09-20T18:30:00.000Z");
});

// ── §17 venue change on a timezone-known Event preserves wall-clock ─────────

test("§14/§17 New York 7PM → Los Angeles venue keeps 7PM local, moves the instant", async () => {
  const captured: Captured = {};
  const existing = {
    status: "draft",
    timezone: "America/New_York",
    scheduledAt: new Date("2026-09-20T23:00:00.000Z"), // 19:00 New York
    endAt: new Date("2026-09-21T01:00:00.000Z"), // 21:00 New York
    location: { venue: "MSG", ...NY_COORDS },
  };
  await makeService(captured, existing).saveDraft(
    user,
    draftDto({ location: { venue: "Hollywood Bowl", ...LA_COORDS } }),
    "draft-1",
  );

  assert.equal(captured.update?.timezone, "America/Los_Angeles");
  assert.equal((captured.update?.scheduledAt as Date).toISOString(), "2026-09-21T02:00:00.000Z");
  assert.equal((captured.update?.endAt as Date).toISOString(), "2026-09-21T04:00:00.000Z");
  assert.notEqual(
    (captured.update?.scheduledAt as Date).getTime(),
    existing.scheduledAt.getTime(),
  );
});

// ── §19 same-zone venue change does not rewrite the instant ────────────────

test("§19 venue change that resolves to the SAME zone leaves scheduledAt untouched", async () => {
  const captured: Captured = {};
  const existing = {
    status: "draft",
    timezone: "America/New_York",
    scheduledAt: new Date("2026-09-20T23:00:00.000Z"),
    endAt: new Date("2026-09-21T01:00:00.000Z"),
    location: { venue: "MSG", ...NY_COORDS },
  };
  await makeService(captured, existing).saveDraft(
    user,
    draftDto({ location: { venue: "Barclays Center", latitude: 40.6826, longitude: -73.9754 } }),
    "draft-1",
  );

  assert.equal(captured.update?.timezone, "America/New_York");
  assert.equal("scheduledAt" in (captured.update ?? {}), false);
  assert.equal("endAt" in (captured.update ?? {}), false);
});

// ── §21 legacy timezone-unknown Event: never guess, never shift ────────────

test("§21 legacy Event (timezone null) + venue change + no date/time edit → no shift, no guess", async () => {
  const captured: Captured = {};
  const existing = {
    status: "draft",
    timezone: null,
    scheduledAt: new Date("2026-09-20T13:00:00.000Z"),
    endAt: new Date("2026-09-20T15:00:00.000Z"),
    location: { venue: "Old place", latitude: 1, longitude: 1 },
  };
  await makeService(captured, existing).saveDraft(
    user,
    draftDto({ location: { venue: "New York place", ...NY_COORDS } }),
    "draft-1",
  );

  assert.equal(captured.update?.timezone ?? null, null);
  assert.equal("scheduledAt" in (captured.update ?? {}), false);
  assert.equal("endAt" in (captured.update ?? {}), false);
});

test("§43 legacy Event: an EXPLICIT date/time edit uses the new venue timezone", async () => {
  const captured: Captured = {};
  const existing = {
    status: "draft",
    timezone: null,
    scheduledAt: new Date("2026-09-20T13:00:00.000Z"),
    endAt: new Date("2026-09-20T15:00:00.000Z"),
    location: { venue: "Old place", latitude: 1, longitude: 1 },
  };
  await makeService(captured, existing).saveDraft(
    user,
    draftDto({
      location: { venue: "NYC", ...NY_COORDS },
      scheduledLocalDate: "2026-10-01",
      scheduledLocalTime: "20:00",
      endLocalDate: "2026-10-01",
      endLocalTime: "22:00",
    }),
    "draft-1",
  );

  assert.equal(captured.update?.timezone, "America/New_York");
  assert.equal((captured.update?.scheduledAt as Date).toISOString(), "2026-10-02T00:00:00.000Z");
});

// ── §8 server coordinates win over a client-sent timezone ──────────────────

test("§8 client-sent timezone is ignored when coordinates resolve a zone", async () => {
  const captured: Captured = {};
  await makeService(captured).saveDraft(
    user,
    draftDto({
      location: { venue: "MSG", ...NY_COORDS },
      timezone: "Asia/Dhaka",
      scheduledLocalDate: "2026-09-20",
      scheduledLocalTime: "19:00",
      endLocalDate: "2026-09-20",
      endLocalTime: "21:00",
    }),
  );
  assert.equal(captured.create?.timezone, "America/New_York");
});

// ── §12 publish path carries the same conversion ──────────────────────────

test("§12 publish resolves and converts identically to draft save", async () => {
  const captured: Captured = {};
  await makeService(captured).publish(
    user,
    {
      name: "Published TZ Event",
      description: "desc",
      ageRestriction: "all_ages",
      categories: ["Live Music & Concerts"],
      scheduledAt: new Date("2026-09-20T13:00:00.000Z"),
      endAt: new Date("2026-09-20T15:00:00.000Z"),
      scheduledLocalDate: "2026-09-20",
      scheduledLocalTime: "19:00",
      endLocalDate: "2026-09-20",
      endLocalTime: "22:00",
      location: { venue: "MSG", address: "NYC", ...NY_COORDS },
      tickets: [],
      privacy: "public",
    } as never,
  );

  assert.equal(captured.create?.timezone, "America/New_York");
  assert.equal((captured.create?.scheduledAt as Date).toISOString(), "2026-09-20T23:00:00.000Z");
  assert.equal((captured.create?.endAt as Date).toISOString(), "2026-09-21T02:00:00.000Z");
});
