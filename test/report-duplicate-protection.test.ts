import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { AppError } from "../src/core/errors/app-error.js";
import type { AuthUser } from "../src/modules/auth/auth.interface.js";
import { ReportService } from "../src/modules/reports/report.service.js";

process.env.NODE_ENV = "test";
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const now = new Date("2026-08-07T00:00:00.000Z");
const postXId = new Types.ObjectId();
const postYId = new Types.ObjectId();
const eventXId = new Types.ObjectId();
const roomXId = new Types.ObjectId();
const postOwnerId = new Types.ObjectId();
const eventOwnerId = new Types.ObjectId();
const roomOwnerId = new Types.ObjectId();
const reporterAId = new Types.ObjectId();
const reporterBId = new Types.ObjectId();

const makeAuthUser = (id: Types.ObjectId, name: string): AuthUser => ({
  id: id.toString(),
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

const reporterA = makeAuthUser(reporterAId, "ReporterA");
const reporterB = makeAuthUser(reporterBId, "ReporterB");

type FakeRow = { reporterUserId: string; targetType: string; targetId: string; report: Record<string, unknown> };

// Mirrors report.model.ts's real partial unique index on
// (reporterUserId, targetType, targetId) scoped to post/event — this fake
// store enforces the exact same constraint synchronously (no await between
// the existence check and the insert), so a Promise.all of two concurrent
// `service.create()` calls exercises the same race-safety guarantee the
// real DB unique index provides, without needing a live MongoDB connection.
class FakeReportStore {
  private rows: FakeRow[] = [];

  private isDuplicate(reporterUserId: string, targetType: string, targetId: string): boolean {
    return this.rows.some(
      (row) => row.reporterUserId === reporterUserId && row.targetType === targetType && row.targetId === targetId,
    );
  }

  public createUnique = async (payload: Record<string, unknown>) => {
    const reporterUserId = payload.reporterUserId as string;
    const targetType = payload.targetType as string;
    const targetId = payload.targetId as string;
    const isScoped = targetType === "post" || targetType === "event";

    if (isScoped && this.isDuplicate(reporterUserId, targetType, targetId)) {
      return { status: "duplicate" as const };
    }

    const report = { _id: new Types.ObjectId(), ...payload, createdAt: now, updatedAt: now };
    this.rows.push({ reporterUserId, targetType, targetId, report });
    return { status: "created" as const, report };
  };

  public create = async (payload: Record<string, unknown>) => {
    const report = { _id: new Types.ObjectId(), ...payload, createdAt: now, updatedAt: now };
    this.rows.push({
      reporterUserId: payload.reporterUserId as string,
      targetType: payload.targetType as string,
      targetId: payload.targetId as string,
      report,
    });
    return report;
  };

  public countFor(reporterUserId: string, targetType: string, targetId: string): number {
    return this.rows.filter(
      (row) => row.reporterUserId === reporterUserId && row.targetType === targetType && row.targetId === targetId,
    ).length;
  }

  public total(): number {
    return this.rows.length;
  }
}

const ownerByTargetId = new Map<string, string>([
  [postXId.toString(), postOwnerId.toString()],
  [postYId.toString(), postOwnerId.toString()],
  [eventXId.toString(), eventOwnerId.toString()],
  [roomXId.toString(), roomOwnerId.toString()],
  [roomOwnerId.toString(), roomOwnerId.toString()],
]);

const createService = (store: FakeReportStore = new FakeReportStore()) => {
  const service = new ReportService(
    store as never,
    {
      findById: async (id: string) => ({
        _id: new Types.ObjectId(id),
        name: "Owner",
        email: "owner@example.com",
        role: "user",
        avatarKey: null,
        bio: null,
      }),
    } as never,
    { createDownloadUrl: async () => ({ url: "" }) } as never,
    {} as never,
    {
      findByEventIdAndHolderUserId: async () => ({
        _id: new Types.ObjectId(),
        eventId: eventXId.toString(),
        holderUserId: reporterAId,
        usedAt: now,
      }),
    } as never,
  );

  (service as unknown as { getTargetSnapshot: (type: string, id: string) => Promise<unknown> }).getTargetSnapshot =
    async (_type: string, id: string) => {
      const ownerId = ownerByTargetId.get(id);
      if (!ownerId) {
        throw new AppError("Reported content or user not found", 404);
      }
      return { ownerId, title: "Content", description: null, imageKey: null };
    };

  return { service, store };
};

const reportPostX = (reporter: AuthUser) => ({
  reportedUserId: postOwnerId.toString(),
  targetType: "post" as const,
  targetId: postXId.toString(),
  reason: "Spam",
  details: null,
});

const reportPostY = (reporter: AuthUser) => ({
  reportedUserId: postOwnerId.toString(),
  targetType: "post" as const,
  targetId: postYId.toString(),
  reason: "Spam",
  details: null,
});

const reportEventX = () => ({
  reportedUserId: eventOwnerId.toString(),
  targetType: "event" as const,
  targetId: eventXId.toString(),
  reason: "Spam",
  details: null,
});

test("first report by a user for a post succeeds", async () => {
  const { service, store } = createService();
  const result = await service.create(reportPostX(reporterA), reporterA);

  assert.ok(result.id);
  assert.equal(store.countFor(reporterA.id, "post", postXId.toString()), 1);
});

test("second report by the same user for the same post is rejected as a conflict, not a 500", async () => {
  const { service, store } = createService();
  await service.create(reportPostX(reporterA), reporterA);

  await assert.rejects(
    () => service.create(reportPostX(reporterA), reporterA),
    (error) => error instanceof AppError && error.statusCode === 409,
  );

  // Only one Report document exists — the duplicate attempt did not create a second row.
  assert.equal(store.countFor(reporterA.id, "post", postXId.toString()), 1);
});

test("simultaneous duplicate post report attempts cannot both create a row", async () => {
  const { service, store } = createService();

  const results = await Promise.allSettled([
    service.create(reportPostX(reporterA), reporterA),
    service.create(reportPostX(reporterA), reporterA),
  ]);

  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(
    rejected[0]?.status === "rejected" &&
      rejected[0].reason instanceof AppError &&
      rejected[0].reason.statusCode === 409,
  );
  assert.equal(store.countFor(reporterA.id, "post", postXId.toString()), 1);
});

test("a different user may independently report the same post", async () => {
  const { service, store } = createService();
  await service.create(reportPostX(reporterA), reporterA);
  const result = await service.create(reportPostX(reporterB), reporterB);

  assert.ok(result.id);
  assert.equal(store.countFor(reporterA.id, "post", postXId.toString()), 1);
  assert.equal(store.countFor(reporterB.id, "post", postXId.toString()), 1);
  assert.equal(store.total(), 2);
});

test("the same user may report a different post independently", async () => {
  const { service, store } = createService();
  await service.create(reportPostX(reporterA), reporterA);
  const result = await service.create(reportPostY(reporterA), reporterA);

  assert.ok(result.id);
  assert.equal(store.countFor(reporterA.id, "post", postXId.toString()), 1);
  assert.equal(store.countFor(reporterA.id, "post", postYId.toString()), 1);
});

test("the same user may independently report an event after reporting a post (targetType is part of the uniqueness key)", async () => {
  const { service, store } = createService();
  await service.create(reportPostX(reporterA), reporterA);
  const result = await service.create(reportEventX(), reporterA);

  assert.ok(result.id);
  assert.equal(store.countFor(reporterA.id, "post", postXId.toString()), 1);
  assert.equal(store.countFor(reporterA.id, "event", eventXId.toString()), 1);
});

test("self-report remains rejected", async () => {
  const { service } = createService();
  const selfReporter = makeAuthUser(postOwnerId, "PostOwner");

  await assert.rejects(
    () => service.create(reportPostX(selfReporter), selfReporter),
    (error) => error instanceof AppError && error.statusCode === 400,
  );
});

test("owner mismatch remains rejected", async () => {
  const { service } = createService();

  await assert.rejects(
    () =>
      service.create(
        { ...reportPostX(reporterA), reportedUserId: reporterB.id },
        reporterA,
      ),
    (error) => error instanceof AppError && error.statusCode === 404,
  );
});

test("missing target remains rejected", async () => {
  const { service } = createService();
  const missingTargetId = new Types.ObjectId().toString();

  await assert.rejects(
    () =>
      service.create(
        { ...reportPostX(reporterA), targetId: missingTargetId },
        reporterA,
      ),
    (error) => error instanceof AppError && error.statusCode === 404,
  );
});

test("uniqueness is scoped to post/event only — repeated User/Room reports remain unrestricted, matching existing behavior", async () => {
  const { service, store } = createService();
  const reportUser = () => ({
    reportedUserId: roomOwnerId.toString(),
    targetType: "user" as const,
    targetId: roomOwnerId.toString(),
    reason: "Spam",
    details: null,
  });
  const reportRoom = () => ({
    reportedUserId: roomOwnerId.toString(),
    targetType: "room" as const,
    targetId: roomXId.toString(),
    reason: "Spam",
    details: null,
  });

  const firstUserReport = await service.create(reportUser(), reporterA);
  const secondUserReport = await service.create(reportUser(), reporterA);
  const firstRoomReport = await service.create(reportRoom(), reporterA);
  const secondRoomReport = await service.create(reportRoom(), reporterA);

  assert.ok(firstUserReport.id);
  assert.ok(secondUserReport.id);
  assert.ok(firstRoomReport.id);
  assert.ok(secondRoomReport.id);
  assert.equal(store.countFor(reporterA.id, "user", roomOwnerId.toString()), 2);
  assert.equal(store.countFor(reporterA.id, "room", roomXId.toString()), 2);
});
