import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { AppError } from "../src/core/errors/app-error.js";
import type { AuthUser } from "../src/modules/auth/auth.interface.js";
import { ReportService } from "../src/modules/reports/report.service.js";

process.env.NODE_ENV = "test";
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const eventId = new Types.ObjectId();
const hostId = new Types.ObjectId();
const reporterId = new Types.ObjectId();
const postId = new Types.ObjectId();
const reportId = new Types.ObjectId();
const usageId = new Types.ObjectId();
const now = new Date("2026-07-11T00:00:00.000Z");

const createReporter = (accountType: "personal" | "business"): AuthUser => ({
  id: reporterId.toString(),
  name: `${accountType} reporter`,
  username: `${accountType}_reporter`,
  email: `${accountType}@example.com`,
  accountType,
  currentLocationSharingEnabled: false,
  notificationsEnabled: true,
  role: "user",
  isActive: true,
  emailVerified: true,
  createdAt: now,
  updatedAt: now,
});

const createService = (overrides: { hasAttendance?: boolean } = {}) => {
  const createdReports: unknown[] = [];
  const service = new ReportService(
    {
      create: async (payload: unknown) => {
        createdReports.push(payload);
        return {
          _id: reportId,
          ...(payload as Record<string, unknown>),
          createdAt: now,
          updatedAt: now,
        };
      },
    } as never,
    {
      findById: async (id: string) => ({
        _id: new Types.ObjectId(id),
        name: id === hostId.toString() ? "Event Host" : "Reported User",
        email: id === hostId.toString() ? "host@example.com" : "reported@example.com",
        role: "user",
        avatarKey: null,
        bio: null,
      }),
    } as never,
    { createDownloadUrl: async () => ({ url: "" }) } as never,
    {} as never,
    {
      findByEventIdAndHolderUserId: async () =>
        overrides.hasAttendance === false
          ? null
          : {
              _id: usageId,
              eventId: eventId.toString(),
              holderUserId: reporterId,
              usedAt: now,
            },
    } as never,
  );

  (service as unknown as { getTargetSnapshot: (type: string, id: string) => Promise<unknown> }).getTargetSnapshot =
    async (type: string) => {
      if (type === "event") {
        return { ownerId: hostId.toString(), title: "Checked Event", description: null, imageKey: null };
      }

      return { ownerId: hostId.toString(), title: type === "post" ? "Post" : "User", description: null, imageKey: null };
    };

  return { service, createdReports };
};

const createEventReportPayload = () => ({
  reportedUserId: hostId.toString(),
  targetType: "event" as const,
  targetId: eventId.toString(),
  reason: "Spam",
  details: "Ticketed report",
});

test("checked-in personal account can report an event", async () => {
  const { service, createdReports } = createService();
  const result = await service.create(createEventReportPayload(), createReporter("personal"));

  assert.equal(result.id, reportId.toString());
  assert.equal(createdReports.length, 1);
});

test("checked-in business account can report an event", async () => {
  const { service, createdReports } = createService();
  const result = await service.create(createEventReportPayload(), createReporter("business"));

  assert.equal(result.id, reportId.toString());
  assert.equal(createdReports.length, 1);
});

test("non-checked-in personal account cannot report an event", async () => {
  const { service, createdReports } = createService({ hasAttendance: false });

  await assert.rejects(
    () => service.create(createEventReportPayload(), createReporter("personal")),
    (error) => error instanceof AppError && error.statusCode === 403,
  );
  assert.equal(createdReports.length, 0);
});

test("non-checked-in business account cannot report an event", async () => {
  const { service, createdReports } = createService({ hasAttendance: false });

  await assert.rejects(
    () => service.create(createEventReportPayload(), createReporter("business")),
    (error) => error instanceof AppError && error.statusCode === 403,
  );
  assert.equal(createdReports.length, 0);
});

test("ticket ownership without TicketUsage does not permit event reporting", async () => {
  const { service, createdReports } = createService({ hasAttendance: false });

  await assert.rejects(
    () => service.create(createEventReportPayload(), createReporter("personal")),
    (error) => error instanceof AppError && error.statusCode === 403,
  );
  assert.equal(createdReports.length, 0);
});

test("event attendance or registration without TicketUsage does not permit event reporting", async () => {
  const { service, createdReports } = createService({ hasAttendance: false });

  await assert.rejects(
    () => service.create(createEventReportPayload(), createReporter("business")),
    (error) => error instanceof AppError && error.statusCode === 403,
  );
  assert.equal(createdReports.length, 0);
});

test("direct event report service calls cannot bypass the checked-in requirement", async () => {
  const { service, createdReports } = createService({ hasAttendance: false });

  await assert.rejects(
    () => service.create(createEventReportPayload(), createReporter("personal")),
    (error) => error instanceof AppError && error.statusCode === 403,
  );
  assert.equal(createdReports.length, 0);
});

test("non-event report behavior remains unchanged", async () => {
  const { service, createdReports } = createService({ hasAttendance: false });
  const result = await service.create(
    {
      reportedUserId: hostId.toString(),
      targetType: "post",
      targetId: postId.toString(),
      reason: "Spam",
      details: null,
    },
    createReporter("personal"),
  );

  assert.equal(result.id, reportId.toString());
  assert.equal(createdReports.length, 1);
});
