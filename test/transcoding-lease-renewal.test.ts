import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { runWithPeriodicLeaseRenewal } from "../src/modules/transcoding/lease-renewal.js";

test("runWithPeriodicLeaseRenewal: calls renew repeatedly while work is in flight, then stops", async () => {
  let renewCount = 0;

  const result = await runWithPeriodicLeaseRenewal({
    intervalMs: 10,
    renew: async () => {
      renewCount += 1;
      return true;
    },
    onLeaseLost: () => assert.fail("should not lose the lease in this test"),
    work: async () => {
      await delay(55);
      return "done";
    },
  });

  assert.equal(result, "done");
  assert.ok(renewCount >= 3, `expected several renewals, got ${renewCount}`);

  const countAfterCompletion = renewCount;
  await delay(30);
  assert.equal(renewCount, countAfterCompletion, "timer must be cleared once work resolves");
});

test("runWithPeriodicLeaseRenewal: invokes onLeaseLost when a renewal reports the lease is gone", async () => {
  let lost = false;

  await runWithPeriodicLeaseRenewal({
    intervalMs: 10,
    renew: async () => false,
    onLeaseLost: () => {
      lost = true;
    },
    work: async () => {
      await delay(30);
      return null;
    },
  });

  assert.equal(lost, true);
});

test("runWithPeriodicLeaseRenewal: a renew() rejection is swallowed, not treated as lease loss", async () => {
  let lost = false;
  let attempts = 0;

  const result = await runWithPeriodicLeaseRenewal({
    intervalMs: 10,
    renew: async () => {
      attempts += 1;
      throw new Error("transient db error");
    },
    onLeaseLost: () => {
      lost = true;
    },
    work: async () => {
      await delay(35);
      return "ok";
    },
  });

  assert.equal(result, "ok");
  assert.equal(lost, false);
  assert.ok(attempts >= 2);
});

test("runWithPeriodicLeaseRenewal: clears the timer even when work throws", async () => {
  let renewCount = 0;

  await assert.rejects(
    runWithPeriodicLeaseRenewal({
      intervalMs: 10,
      renew: async () => {
        renewCount += 1;
        return true;
      },
      onLeaseLost: () => undefined,
      work: async () => {
        await delay(25);
        throw new Error("encode failed");
      },
    }),
    /encode failed/,
  );

  const countAfterFailure = renewCount;
  await delay(30);
  assert.equal(renewCount, countAfterFailure, "timer must be cleared even after work rejects");
});

test("runWithPeriodicLeaseRenewal: overlapping renewals do not stack (busy-guard)", async () => {
  let concurrentCalls = 0;
  let maxConcurrent = 0;

  await runWithPeriodicLeaseRenewal({
    intervalMs: 5,
    renew: async () => {
      concurrentCalls += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
      await delay(20);
      concurrentCalls -= 1;
      return true;
    },
    onLeaseLost: () => undefined,
    work: async () => {
      await delay(50);
      return "done";
    },
  });

  assert.equal(maxConcurrent, 1, "a slow renew() must not overlap with the next tick's renew()");
});
