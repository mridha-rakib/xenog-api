import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

import { EventService } from "../src/modules/events/event.service.js";
import { STARTING_SOON_MS } from "../src/modules/events/event-temporal-status.js";

const readSrc = (relPath: string) =>
  readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), "utf8");

const HOUR = 60 * 60 * 1000;
const now = Date.now();

type FakeEvent = {
  _id: { toString: () => string };
  name: string;
  scheduledAt: Date | null;
  endAt: Date | null;
  location: unknown;
  timezone: string | null;
  bannerImageKey: string | null;
};

const makeEvent = (
  id: string,
  scheduledFromNowMs: number | null,
  endFromNowMs: number | null,
): FakeEvent => ({
  _id: { toString: () => id },
  name: `Event ${id}`,
  scheduledAt: scheduledFromNowMs === null ? null : new Date(now + scheduledFromNowMs),
  endAt: endFromNowMs === null ? null : new Date(now + endFromNowMs),
  location: { venue: `Venue ${id}`, address: `Address ${id}` },
  timezone: "America/New_York",
  bannerImageKey: null,
});

type PickerHarness = {
  ownEvents?: FakeEvent[];
  publicEvents?: FakeEvent[];
  foreignEvents?: FakeEvent[];
  paidEventIds?: string[];
  sharedEventIds?: string[];
  memberOrJoinEventIds?: string[];
};

const buildService = (h: PickerHarness) => {
  const calls: { findPostTaggableByIds: string[][]; findMemberOrAcceptedJoinEventIds: number } = {
    findPostTaggableByIds: [],
    findMemberOrAcceptedJoinEventIds: 0,
  };

  const foreign = h.foreignEvents ?? [];

  const eventRepository = {
    findPublicPostTaggable: async () => h.publicEvents ?? [],
    findActiveAndUpcomingByUserId: async () => h.ownEvents ?? [],
    findMemberOrAcceptedJoinEventIds: async () => {
      calls.findMemberOrAcceptedJoinEventIds += 1;
      return h.memberOrJoinEventIds ?? [];
    },
    findPostTaggableByIds: async (ids: string[]) => {
      calls.findPostTaggableByIds.push([...ids]);
      return foreign.filter((event) => ids.includes(event._id.toString()));
    },
  };
  const checkoutPaymentRepository = {
    findPaidTicketEventIdsByUser: async () => h.paidEventIds ?? [],
  };
  const ticketShareRepository = {
    findActiveEventIdsByRecipient: async () => h.sharedEventIds ?? [],
  };
  const storageService = {
    createDownloadUrl: async () => ({ url: "https://cdn.example/banner.png" }),
  };

  const service = new EventService(
    eventRepository as never,
    {} as never, // userRepository
    {} as never, // userFollowRepository
    storageService as never,
    {} as never, // productRepository
    {} as never, // rewardClaimRepository
    checkoutPaymentRepository as never,
    {} as never, // checkoutPaymentService
    {} as never, // creatorEarningRepository
    ticketShareRepository as never,
  );

  return { service, calls };
};

const user = { id: "viewer-1", name: "Viewer" };

// ── Ordering: Live → Starting Soon → Upcoming (soonest→farthest) → Recent ──

test("§11/§16 one deterministic global order regardless of source insertion order", async () => {
  const upcomingFar = makeEvent("upcoming-far", 10 * 24 * HOUR, 11 * 24 * HOUR);
  const live = makeEvent("live", -1 * HOUR, 2 * HOUR);
  const recent = makeEvent("recent-active", -5 * HOUR, null); // started, past 3h live window, inside 12h
  const startingSoon = makeEvent("starting-soon", 0.5 * HOUR, 3 * HOUR);
  const upcomingNear = makeEvent("upcoming-near", 2 * HOUR, 4 * HOUR);

  // Deliberately shuffled across the sources.
  const { service } = buildService({
    ownEvents: [upcomingFar, startingSoon],
    publicEvents: [recent, live],
    foreignEvents: [upcomingNear],
    paidEventIds: ["upcoming-near"],
  });

  const rows = await service.listMyPostTagEvents(user as never);

  assert.deepEqual(
    rows.map((r) => r.id),
    ["live", "starting-soon", "upcoming-near", "upcoming-far", "recent-active"],
  );
  assert.deepEqual(
    rows.map((r) => r.postTagStatus),
    ["live", "starting_soon", "upcoming", "upcoming", "active"],
  );
});

test("§14 upcoming bucket is nearest-first; §15 recent-eligible bucket is most-recent-first", async () => {
  const near = makeEvent("u-near", 4 * HOUR, 6 * HOUR);
  const mid = makeEvent("u-mid", 2 * 24 * HOUR, null);
  const far = makeEvent("u-far", 9 * 24 * HOUR, null);
  const recentOlder = makeEvent("r-older", -9 * HOUR, null);
  const recentNewer = makeEvent("r-newer", -4 * HOUR, null);

  const { service } = buildService({ ownEvents: [far, recentOlder, near, recentNewer, mid] });
  const rows = await service.listMyPostTagEvents(user as never);

  assert.deepEqual(
    rows.map((r) => r.id),
    ["u-near", "u-mid", "u-far", "r-newer", "r-older"],
  );
});

// ── Starting Soon boundary uses the canonical constant ──

test("§13/§39 starting_soon vs upcoming boundary is exactly STARTING_SOON_MS", async () => {
  const inside = makeEvent("inside", STARTING_SOON_MS - 60_000, null);
  const outside = makeEvent("outside", STARTING_SOON_MS + 60_000, null);

  const { service } = buildService({ ownEvents: [inside, outside] });
  const rows = await service.listMyPostTagEvents(user as never);

  assert.equal(rows.find((r) => r.id === "inside")?.postTagStatus, "starting_soon");
  assert.equal(rows.find((r) => r.id === "outside")?.postTagStatus, "upcoming");
});

// ── Foreign-access sources are merged and de-scoped from directly-available ──

test("§4-§9 ticket + shared-ticket + member/accepted-join ids are all resolved via findPostTaggableByIds", async () => {
  const ticketEvt = makeEvent("ticket-evt", 3 * 24 * HOUR, null); // upcoming — NOT yet started
  const sharedEvt = makeEvent("shared-evt", 6 * HOUR, 8 * HOUR);
  const memberEvt = makeEvent("member-evt", 5 * 24 * HOUR, null);

  const { service, calls } = buildService({
    foreignEvents: [ticketEvt, sharedEvt, memberEvt],
    paidEventIds: ["ticket-evt"],
    sharedEventIds: ["shared-evt"],
    memberOrJoinEventIds: ["member-evt"],
  });

  const rows = await service.listMyPostTagEvents(user as never);
  const ids = rows.map((r) => r.id).sort();

  assert.deepEqual(ids, ["member-evt", "shared-evt", "ticket-evt"]);
  assert.equal(calls.findMemberOrAcceptedJoinEventIds, 1);
  assert.equal(calls.findPostTaggableByIds.length, 1);
  assert.deepEqual(
    [...calls.findPostTaggableByIds[0]!].sort(),
    ["member-evt", "shared-evt", "ticket-evt"],
  );
  // Upcoming (not-started) ticket Event is present — the old scheduledAt<=now gate is gone.
  assert.ok(rows.some((r) => r.id === "ticket-evt" && r.postTagStatus === "upcoming"));
});

test("§10 an Event eligible through several paths appears exactly once (id dedupe)", async () => {
  const evt = makeEvent("dual", -1 * HOUR, 2 * HOUR);

  const { service, calls } = buildService({
    ownEvents: [evt],
    foreignEvents: [evt],
    paidEventIds: ["dual"],
    sharedEventIds: ["dual"],
    memberOrJoinEventIds: ["dual"],
  });

  const rows = await service.listMyPostTagEvents(user as never);

  assert.equal(rows.filter((r) => r.id === "dual").length, 1);
  // Already directly available (host) → never re-queried as a foreign id.
  assert.deepEqual(calls.findPostTaggableByIds[0], []);
});

// ── Response shape preserved ──

test("§40 every row keeps id/name/scheduledAt/timezone/location/postTagStatus", async () => {
  const evt = makeEvent("shape", 2 * HOUR, 4 * HOUR);
  const { service } = buildService({ ownEvents: [evt] });
  const [row] = await service.listMyPostTagEvents(user as never);

  assert.equal(row!.id, "shape");
  assert.equal(row!.name, "Event shape");
  assert.ok(row!.scheduledAt instanceof Date);
  assert.equal(row!.timezone, "America/New_York");
  assert.deepEqual(row!.location, { venue: "Venue shape", address: "Address shape" });
  assert.equal(row!.postTagStatus, "upcoming");
  assert.ok("bannerImageUrl" in row!);
});

// ── Repository-level eligibility clauses (source assertions) ──

const repoSrc = readSrc("../src/modules/events/event.repository.ts");

test("§3 findActiveAndUpcomingByUserId keeps published/live + active-or-future window (host draft/completed/cancelled excluded)", () => {
  const fn = repoSrc.slice(
    repoSrc.indexOf("public async findActiveAndUpcomingByUserId"),
    repoSrc.indexOf("public async findPublicPostTaggable"),
  );
  assert.match(fn, /status: \{ \$in: \["published", "live"\] \}/);
  assert.match(fn, /endAt: \{ \$gte: now \}/);
  assert.match(fn, /endAt: null, scheduledAt: \{ \$gte: activeSince \}/);
  assert.doesNotMatch(fn, /"draft"|"completed"|"cancelled"/);
});

test("§4 findPostTaggableByIds has NO scheduledAt<=now gate and reuses the active-or-future window", () => {
  const fn = repoSrc.slice(
    repoSrc.indexOf("public async findPostTaggableByIds"),
    repoSrc.indexOf("public async findMemberOrAcceptedJoinEventIds"),
  );
  assert.match(fn, /_id: \{ \$in: eventIds \}/);
  assert.match(fn, /status: \{ \$in: \["published", "live"\] \}/);
  assert.match(fn, /endAt: \{ \$gte: now \}/);
  // The distinguishing regression fix: no "already started" restriction.
  assert.doesNotMatch(fn, /scheduledAt: \{ \$lte:/);
});

test("§7/§8 findMemberOrAcceptedJoinEventIds = member OR accepted join only, read-only, id projection", () => {
  const fn = repoSrc.slice(
    repoSrc.indexOf("public async findMemberOrAcceptedJoinEventIds"),
    repoSrc.indexOf("public async findPublishedProfileEventsByUserId"),
  );
  assert.match(fn, /memberUserIds: userId/);
  assert.match(fn, /joinRequests: \{ \$elemMatch: \{ userId, status: "accepted" \} \}/);
  assert.match(fn, /status: \{ \$in: \["published", "live"\] \}/);
  assert.match(fn, /\.select\(\{ _id: 1 \}\)/);
  // Never pending/declined, never a mutation.
  assert.doesNotMatch(fn, /"pending"|"declined"/);
  assert.doesNotMatch(fn, /\$set|\$push|\$pull|\$addToSet/);
});

test("§5 findPublicPostTaggable still restricted to public + published/live + window (public behavior preserved)", () => {
  const fn = repoSrc.slice(
    repoSrc.indexOf("public async findPublicPostTaggable"),
    repoSrc.indexOf("public async findLiveActiveByIds"),
  );
  assert.match(fn, /privacy: "public"/);
  assert.match(fn, /status: \{ \$in: \["published", "live"\] \}/);
});

// ── Narrow createMoment authorization alignment (§23-§27) ──

const momentSrc = readSrc("../src/modules/moments/moment.service.ts");
const eventBlock = momentSrc.slice(
  momentSrc.indexOf("if (resolvedEventId) {"),
  momentSrc.indexOf("const taggedFriendIds = "),
);

test("§24 createMoment Event-tag accepts published AND live, still nothing else", () => {
  assert.match(
    eventBlock,
    /event\.status !== "published" && event\.status !== "live"/,
  );
  assert.doesNotMatch(eventBlock, /"draft"|"completed"|"cancelled"/);
});

test("§26 private member is a valid tag access class alongside paid/shared ticket", () => {
  assert.match(eventBlock, /event\.memberUserIds \?\? \[\]\)\.some\(\(id\) => id\.toString\(\) === user\.id\)/);
  assert.match(eventBlock, /if \(!isMember\) \{/);
  // Ticket/share requirement is still enforced for non-members.
  assert.match(eventBlock, /hasUserPaidTicketForEvent/);
  assert.match(eventBlock, /hasActiveShareForRecipientAtEvent/);
  assert.match(eventBlock, /A valid ticket is required to tag this event/);
});

test("§9/§27 locked-event privacy path is NOT newly gated here", () => {
  // The private-only guard is unchanged; locked events are not added to it.
  assert.match(eventBlock, /event\.privacy === "private" && event\.userId\.toString\(\) !== user\.id/);
  assert.doesNotMatch(eventBlock, /privacy === "locked"/);
});

test("§45 no media/audio logic touched inside the Event-tag block", () => {
  assert.doesNotMatch(eventBlock, /mediaItems|audio|validateCreateMomentMediaItems|storageKey/);
});
