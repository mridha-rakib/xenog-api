import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import type { AuthUser } from "../src/modules/auth/auth.interface.js";
import { ReportService } from "../src/modules/reports/report.service.js";

// Regression test for the Admin Dashboard "content not viewable" bug: a
// reported post's snapshot must carry the underlying media item's type
// (image/video/audio) all the way through to the admin response, so the
// dashboard can render a <video> element instead of feeding a video URL
// into an <img> tag (see report.service.ts getTargetSnapshot/toResponse
// and xenog-dashboard ReportDetails.jsx).

process.env.NODE_ENV = "test";
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const now = new Date("2026-08-08T00:00:00.000Z");
const targetOwnerId = new Types.ObjectId();
const targetId = new Types.ObjectId();
const reporterId = new Types.ObjectId();
const reportId = new Types.ObjectId();

const reporter: AuthUser = {
  id: reporterId.toString(),
  name: "Reporter",
  username: "reporter",
  email: "reporter@example.com",
  accountType: "personal",
  currentLocationSharingEnabled: false,
  notificationsEnabled: true,
  role: "user",
  isActive: true,
  emailVerified: true,
  createdAt: now,
  updatedAt: now,
};

const createServiceForSnapshot = (
  snapshot: { imageKey?: string | null; imageUrl?: string | null; mediaType?: "image" | "video" | "audio" | null },
) => {
  const service = new ReportService(
    {
      createUnique: async (payload: Record<string, unknown>) => ({
        status: "created" as const,
        report: { _id: reportId, ...payload, createdAt: now, updatedAt: now },
      }),
      create: async (payload: Record<string, unknown>) => ({ _id: reportId, ...payload, createdAt: now, updatedAt: now }),
    } as never,
    {
      findById: async (id: string) => ({
        _id: new Types.ObjectId(id),
        name: "Target Owner",
        email: "owner@example.com",
        role: "user",
        avatarKey: null,
        bio: null,
      }),
    } as never,
    { createDownloadUrl: async (key: string) => ({ url: `https://cdn.example.com/${key}` }) } as never,
    {} as never,
    { findByEventIdAndHolderUserId: async () => ({ _id: new Types.ObjectId(), eventId: targetId.toString(), holderUserId: reporterId, usedAt: now }) } as never,
  );

  (service as unknown as { getTargetSnapshot: (type: string, id: string) => Promise<unknown> }).getTargetSnapshot =
    async () => ({ ownerId: targetOwnerId.toString(), title: "Post", description: "caption", ...snapshot });

  return service;
};

const reportPayload = () => ({
  reportedUserId: targetOwnerId.toString(),
  targetType: "post" as const,
  targetId: targetId.toString(),
  reason: "Inappropriate content",
  details: null,
});

void test("a reported post whose media item is a video carries mediaType 'video' into the admin response", async () => {
  const service = createServiceForSnapshot({ imageKey: "moments/video-1.mp4", mediaType: "video" });
  const report = await service.create(reportPayload(), reporter);
  assert.equal(report.content.mediaType, "video");
  assert.ok(report.content.imageUrl);
});

void test("a reported post whose media item is an image carries mediaType 'image' into the admin response", async () => {
  const service = createServiceForSnapshot({ imageKey: "moments/photo-1.jpg", mediaType: "image" });
  const report = await service.create(reportPayload(), reporter);
  assert.equal(report.content.mediaType, "image");
});

void test("a reported post with no media item carries a null mediaType (no image, no video) without crashing", async () => {
  const service = createServiceForSnapshot({ imageKey: null, imageUrl: null, mediaType: null });
  const report = await service.create(reportPayload(), reporter);
  assert.equal(report.content.mediaType, null);
  assert.equal(report.content.imageUrl, null);
});
