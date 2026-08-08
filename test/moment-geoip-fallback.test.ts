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

const momentServiceModulePromise = import("../src/modules/moments/moment.service.js");
const geoIpModulePromise = import("../src/modules/geoip/geoip.service.js");

const userId = new Types.ObjectId();
const now = new Date("2026-08-09T00:00:00.000Z");

const authUser = {
  id: userId.toString(),
  name: "Poster",
  username: "poster",
  email: "poster@example.com",
  accountType: "personal",
  currentLocationSharingEnabled: false,
  notificationsEnabled: true,
  role: "user",
  isActive: true,
  emailVerified: true,
  createdAt: now,
  updatedAt: now,
};

const createPayload = {
  mode: "feed" as const,
  caption: "hello",
  audience: "public" as const,
  mediaItems: [],
};

const makeUser = (overrides: Record<string, unknown> = {}) => ({
  _id: userId,
  name: "Poster",
  username: "poster",
  email: "poster@example.com",
  accountType: "personal",
  avatarKey: null,
  avatarUrl: null,
  role: "user",
  isActive: true,
  emailVerified: true,
  currentLocationSharingEnabled: false,
  currentLocation: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const createService = async (options: {
  user: Record<string, unknown>;
  geoIpService: { lookup: (ip?: string | null) => Promise<unknown> };
  createdPayload?: { value?: Record<string, unknown> };
}) => {
  const { MomentService } = await momentServiceModulePromise;
  const createdPayload = options.createdPayload ?? {};

  return new MomentService(
    {
      create: async (payload: Record<string, unknown>) => {
        createdPayload.value = payload;
        return {
          _id: new Types.ObjectId(),
          userId,
          mode: payload.mode,
          caption: payload.caption,
          hashtags: payload.hashtags,
          audience: payload.audience,
          taggedPeople: payload.taggedPeople,
          taggedFriendIds: payload.taggedFriendIds,
          eventTitle: payload.eventTitle,
          eventId: payload.eventId,
          eventCode: payload.eventCode,
          mediaItems: payload.mediaItems,
          location: payload.location,
          createdAt: now,
          updatedAt: now,
        };
      },
    } as never,
    { createDownloadUrl: async () => ({ url: "" }) } as never,
    {
      findById: async () => options.user,
      findByIds: async () => [],
      findActiveUsersByIds: async () => [],
    } as never,
    {} as never,
    { findFollowingIds: async () => [], findMutualFriendIds: async () => [] } as never,
    { findBlockedIds: async () => [], findBlockerIds: async () => [], isBlocked: async () => false } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    undefined,
    undefined,
    { findReportedTargetIds: async () => new Set<string>(), hasReported: async () => false } as never,
    options.geoIpService as never,
  );
};

test("createMoment keeps permitted GPS snapshot and does not use GeoIP", async () => {
  let geoIpLookupCount = 0;
  const createdPayload: { value?: Record<string, unknown> } = {};
  const service = await createService({
    user: makeUser({
      currentLocationSharingEnabled: true,
      currentLocation: {
        latitude: 23.8103,
        longitude: 90.4125,
        accuracy: 12,
        updatedAt: now,
      },
    }),
    geoIpService: {
      lookup: async () => {
        geoIpLookupCount += 1;
        return { source: "ip", city: "Dhaka", countryCode: "BD" };
      },
    },
    createdPayload,
  });

  const moment = await service.createMoment(createPayload, authUser as never, { clientIp: "8.8.8.8" });

  assert.equal(geoIpLookupCount, 0);
  assert.deepEqual(moment.location, {
    source: "gps",
    latitude: 23.8103,
    longitude: 90.4125,
    accuracy: 12,
    capturedAt: now,
  });
  assert.equal((createdPayload.value?.location as { source?: string } | undefined)?.source, "gps");
});

test("createMoment stores IP regional snapshot when GPS is unavailable", async () => {
  const service = await createService({
    user: makeUser(),
    geoIpService: {
      lookup: async () => ({
        source: "ip",
        city: "Dhaka",
        region: "Dhaka Division",
        regionCode: "C",
        country: "Bangladesh",
        countryCode: "BD",
      }),
    },
  });

  const moment = await service.createMoment(createPayload, authUser as never, { clientIp: "8.8.8.8" });

  assert.equal(moment.location?.source, "ip");
  assert.equal(moment.location?.city, "Dhaka");
  assert.equal(moment.location?.region, "Dhaka Division");
  assert.equal(moment.location?.country, "Bangladesh");
  assert.ok(moment.location?.capturedAt instanceof Date);
});

test("createMoment still succeeds for private request IP without location", async () => {
  const { GeoIpService } = await geoIpModulePromise;
  const service = await createService({
    user: makeUser(),
    geoIpService: new GeoIpService("package.json", async () => {
      throw new Error("private IP should not open database");
    }),
  });

  const moment = await service.createMoment(createPayload, authUser as never, { clientIp: "192.168.1.5" });

  assert.equal(moment.location, undefined);
});

test("createMoment still succeeds when GeoIP database is unavailable", async () => {
  const { GeoIpService } = await geoIpModulePromise;
  const service = await createService({
    user: makeUser(),
    geoIpService: new GeoIpService("missing-GeoLite2-City.mmdb", async () => {
      throw new Error("should not open missing database");
    }),
  });

  const moment = await service.createMoment(createPayload, authUser as never, { clientIp: "8.8.8.8" });

  assert.equal(moment.location, undefined);
});
