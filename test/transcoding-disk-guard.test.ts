import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import {
  DiskGuardLogGate,
  checkDiskCapacity,
  estimateJobDiskBudgetBytes,
} from "../src/modules/transcoding/disk-guard.js";

// ---------------------------------------------------------------------------
// checkDiskCapacity — real read-only statfs() against the local filesystem.
// ---------------------------------------------------------------------------

test("checkDiskCapacity reports enough disk when the threshold is trivially low", async () => {
  const result = await checkDiskCapacity(os.tmpdir(), 1);

  assert.equal(result.ok, true);
  assert.ok(typeof result.freeBytes === "number" && result.freeBytes > 0);
  assert.ok(typeof result.totalBytes === "number" && result.totalBytes > 0);
});

test("checkDiskCapacity reports low disk when the threshold is absurdly high", async () => {
  const result = await checkDiskCapacity(os.tmpdir(), Number.MAX_SAFE_INTEGER);

  assert.equal(result.ok, false);
});

test("checkDiskCapacity fails safely (does not throw) for a nonexistent path", async () => {
  const result = await checkDiskCapacity("/this/path/definitely/does/not/exist/xyz", 1);

  assert.equal(result.ok, false);
  assert.equal(result.freeBytes, null);
  assert.ok(result.error);
});

// ---------------------------------------------------------------------------
// estimateJobDiskBudgetBytes
// ---------------------------------------------------------------------------

test("estimateJobDiskBudgetBytes is conservative: roughly 3x the max source size plus a small flat allowance", () => {
  const maxSourceBytes = 200 * 1024 * 1024;
  const budget = estimateJobDiskBudgetBytes(maxSourceBytes);

  assert.ok(budget >= maxSourceBytes * 3);
  assert.ok(budget <= maxSourceBytes * 3 + 10 * 1024 * 1024);
});

// ---------------------------------------------------------------------------
// DiskGuardLogGate — deterministic with an explicit fake clock.
// ---------------------------------------------------------------------------

test("DiskGuardLogGate logs once on the first blocked observation", () => {
  const gate = new DiskGuardLogGate(60_000);

  assert.equal(gate.shouldLog(true, 0), true);
});

test("DiskGuardLogGate does not log repeatedly while still blocked within the rate limit", () => {
  const gate = new DiskGuardLogGate(60_000);

  assert.equal(gate.shouldLog(true, 0), true);
  assert.equal(gate.shouldLog(true, 1_000), false);
  assert.equal(gate.shouldLog(true, 30_000), false);
  assert.equal(gate.shouldLog(true, 59_999), false);
});

test("DiskGuardLogGate logs again once the rate-limit interval elapses while still blocked", () => {
  const gate = new DiskGuardLogGate(60_000);

  assert.equal(gate.shouldLog(true, 0), true);
  assert.equal(gate.shouldLog(true, 60_000), true);
  assert.equal(gate.shouldLog(true, 60_001), false);
  assert.equal(gate.shouldLog(true, 120_001), true);
});

test("DiskGuardLogGate logs the recovery transition immediately, not waiting for the rate limit", () => {
  const gate = new DiskGuardLogGate(60_000);

  assert.equal(gate.shouldLog(true, 0), true);
  assert.equal(gate.shouldLog(true, 500), false);
  assert.equal(gate.shouldLog(false, 900), true); // recovered
});

test("DiskGuardLogGate never logs while capacity has always been fine (no spam for the normal case)", () => {
  const gate = new DiskGuardLogGate(60_000);

  assert.equal(gate.shouldLog(false, 0), false);
  assert.equal(gate.shouldLog(false, 60_000), false);
  assert.equal(gate.shouldLog(false, 120_000), false);
});

test("DiskGuardLogGate.isCurrentlyBlocked reflects the most recent observation", () => {
  const gate = new DiskGuardLogGate(60_000);

  assert.equal(gate.isCurrentlyBlocked, false);
  gate.shouldLog(true, 0);
  assert.equal(gate.isCurrentlyBlocked, true);
  gate.shouldLog(false, 1000);
  assert.equal(gate.isCurrentlyBlocked, false);
});
