import assert from "node:assert/strict";
import test from "node:test";
import { MomentModel } from "../src/modules/moments/moment.model.js";
import { MomentRepository } from "../src/modules/moments/moment.repository.js";

// Mirrors the existing withMockedEventFind pattern (test/event-filtering.test.ts) —
// captures the Mongo query object MomentModel.find receives so we can assert on
// its shape without needing a live database.
const withMockedMomentFind = async <T>(
  moments: unknown[],
  run: (captured: { query?: Record<string, unknown> }) => Promise<T>,
): Promise<T> => {
  const captured: { query?: Record<string, unknown> } = {};
  const originalFind = MomentModel.find;

  MomentModel.find = ((query: Record<string, unknown>) => {
    captured.query = query;

    const result = {
      sort: () => result,
      limit: (limit: number) => Promise.resolve(limit ? moments.slice(0, limit) : moments),
    };

    return result;
  }) as typeof MomentModel.find;

  try {
    return await run(captured);
  } finally {
    MomentModel.find = originalFind;
  }
};

test("Moment feed query without radius is untouched (no location filter added)", async () => {
  const repository = new MomentRepository();

  await withMockedMomentFind([], async (captured) => {
    await repository.findFeed({ limit: 50 });

    assert.equal(captured.query?.["location.latitude"], undefined);
    assert.equal(captured.query?.["location.longitude"], undefined);
    // Every other existing clause stays exactly as before.
    assert.equal(captured.query?.mode, "feed");
    assert.equal(captured.query?.audience, "public");
  });
});

test("Moment feed query with explicit latitude/longitude/radiusKm adds a bounding-box location filter", async () => {
  const repository = new MomentRepository();

  await withMockedMomentFind([], async (captured) => {
    await repository.findFeed({ limit: 50, latitude: 40, longitude: -73, radiusKm: 50 });

    const latitudeFilter = captured.query?.["location.latitude"] as { $gte: number; $lte: number } | undefined;
    const longitudeFilter = captured.query?.["location.longitude"] as { $gte: number; $lte: number } | undefined;

    assert.ok(latitudeFilter);
    assert.ok(longitudeFilter);
    assert.ok(latitudeFilter.$gte < 40 && latitudeFilter.$lte > 40);
    assert.ok(longitudeFilter.$gte < -73 && longitudeFilter.$lte > -73);
    // Tighter than a full-globe range — proves it's actually radius-bounded.
    assert.ok(latitudeFilter.$lte - latitudeFilter.$gte < 5);
  });
});

test("Moment feed query with a partial location (missing radiusKm) does not add a location filter", async () => {
  const repository = new MomentRepository();

  await withMockedMomentFind([], async (captured) => {
    await repository.findFeed({ limit: 50, latitude: 40, longitude: -73 });

    assert.equal(captured.query?.["location.latitude"], undefined);
  });
});

test("a wider radius produces a wider bounding box than a narrower radius", async () => {
  const repository = new MomentRepository();
  const boxWidth = async (radiusKm: number) => {
    let width = 0;

    await withMockedMomentFind([], async (captured) => {
      await repository.findFeed({ limit: 50, latitude: 40, longitude: -73, radiusKm });
      const latitudeFilter = captured.query?.["location.latitude"] as { $gte: number; $lte: number };
      width = latitudeFilter.$lte - latitudeFilter.$gte;
    });

    return width;
  };

  assert.ok((await boxWidth(100)) > (await boxWidth(10)));
});
