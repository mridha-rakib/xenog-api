import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/xenog-test";
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? "test-access-key";
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? "test-secret-key";
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET ?? "test-bucket";
process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ?? "development-access-secret-change-before-production";

const geoIpModulePromise = import("../src/modules/geoip/geoip.service.js");

test("normalizes public IPv4 and IPv4-mapped IPv6 client IPs", async () => {
  const { getPublicClientIp, normalizeClientIp } = await geoIpModulePromise;

  assert.equal(normalizeClientIp("8.8.8.8"), "8.8.8.8");
  assert.equal(normalizeClientIp("::ffff:8.8.8.8"), "8.8.8.8");
  assert.equal(getPublicClientIp("8.8.8.8"), "8.8.8.8");
  assert.equal(getPublicClientIp("::ffff:8.8.8.8"), "8.8.8.8");
});

test("rejects private, internal, invalid, and empty client IPs without throwing", async () => {
  const { getPublicClientIp } = await geoIpModulePromise;

  for (const value of [
    "127.0.0.1",
    "::1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.1.1",
    "::",
    "fe80::1",
    "not-an-ip",
    "",
    null,
    undefined,
  ]) {
    assert.equal(getPublicClientIp(value), null);
  }
});

test("local database result is normalized to minimal regional fields", async () => {
  const { GeoIpService } = await geoIpModulePromise;
  const service = new GeoIpService("package.json", async () => ({
    city: () => ({
      city: { geonameId: 1, names: { en: "Dhaka" } },
      subdivisions: [{ geonameId: 2, isoCode: "C", names: { en: "Dhaka Division" } }],
      country: { geonameId: 3, isoCode: "BD", isInEuropeanUnion: false, names: { en: "Bangladesh" } },
      traits: { isAnonymous: false } as never,
    }),
  }));

  assert.deepEqual(await service.lookup("8.8.8.8"), {
    source: "ip",
    city: "Dhaka",
    region: "Dhaka Division",
    regionCode: "C",
    country: "Bangladesh",
    countryCode: "BD",
  });
});

test("unknown public IP returns null", async () => {
  const { GeoIpService } = await geoIpModulePromise;
  const service = new GeoIpService("package.json", async () => ({
    city: () => {
      throw new Error("Address not found");
    },
  }));

  assert.equal(await service.lookup("8.8.8.8"), null);
});

test("missing database is unavailable without opening a reader", async () => {
  const { GeoIpService } = await geoIpModulePromise;
  let openCount = 0;
  const service = new GeoIpService("missing-GeoLite2-City.mmdb", async () => {
    openCount += 1;
    throw new Error("should not open");
  });

  assert.equal(await service.lookup("8.8.8.8"), null);
  assert.equal(openCount, 0);
});

test("database initialization failure is graceful and cached", async () => {
  const { GeoIpService } = await geoIpModulePromise;
  let openCount = 0;
  const service = new GeoIpService("package.json", async () => {
    openCount += 1;
    throw new Error("corrupt database");
  });

  assert.equal(await service.lookup("8.8.8.8"), null);
  assert.equal(await service.lookup("1.1.1.1"), null);
  assert.equal(openCount, 1);
});
