import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { MomentModel } from "../src/modules/moments/moment.model.js";
import { momentValidation } from "../src/modules/moments/moment.validation.js";

// CRT-012: createMoment (POST /moments) retry-safety. Mirrors the existing
// repost/share idempotency test style (repost-contract.test.ts) — schema
// acceptance plus the actual Mongo index that enforces the uniqueness
// boundary, since that index (not a check-then-insert) is the real authority
// against a concurrent same-id race.

test("createMoment accepts an optional clientRequestId", () => {
  const parsed = momentValidation.createMoment.safeParse({
    body: {
      mode: "feed",
      caption: "Hello world",
      audience: "public",
      clientRequestId: "post:1234567890:abc123",
    },
  });

  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.body.clientRequestId, "post:1234567890:abc123");
  }
});

test("createMoment continues to work when clientRequestId is omitted (legacy clients)", () => {
  const parsed = momentValidation.createMoment.safeParse({
    body: {
      mode: "feed",
      caption: "Hello world",
      audience: "public",
    },
  });

  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.body.clientRequestId, undefined);
  }
});

test("createMoment rejects a clientRequestId that is present but too short or malformed", () => {
  assert.equal(momentValidation.createMoment.safeParse({
    body: { mode: "feed", caption: "x", audience: "public", clientRequestId: "short" },
  }).success, false);

  assert.equal(momentValidation.createMoment.safeParse({
    body: { mode: "feed", caption: "x", audience: "public", clientRequestId: "has a space!!" },
  }).success, false);
});

test("createMoment rejects an oversized clientRequestId", () => {
  assert.equal(momentValidation.createMoment.safeParse({
    body: { mode: "feed", caption: "x", audience: "public", clientRequestId: "a".repeat(101) },
  }).success, false);
});

test("createMoment accepts a null clientRequestId", () => {
  const parsed = momentValidation.createMoment.safeParse({
    body: { mode: "feed", caption: "x", audience: "public", clientRequestId: null },
  });

  assert.equal(parsed.success, true);
});

test("Moment schema exposes a clientRequestId field distinct from sourceClientRequestId (Story-share origin tag)", () => {
  assert.ok(MomentModel.schema.path("clientRequestId"));
  assert.ok(MomentModel.schema.path("sourceClientRequestId"));
});

test("Moments enforce a per-creator (not global) clientRequestId uniqueness boundary", () => {
  const uniqueIndex = MomentModel.schema.indexes().find(([fields, options]) => (
    fields.userId === 1 && fields.clientRequestId === 1 && options.unique === true
  ));

  assert.ok(uniqueIndex, "expected a unique (userId, clientRequestId) index");

  const [, options] = uniqueIndex as [Record<string, number>, Record<string, unknown>];
  // Partial, not `sparse: true` — only documents that actually carry a
  // clientRequestId are indexed, so legacy/omitted-id Moments (and two
  // different users who never supply one) are never affected.
  assert.deepEqual(options.partialFilterExpression, { clientRequestId: { $type: "string" } });
});

test("the clientRequestId index can never dedupe across two different users", () => {
  // The index is compound on (userId, clientRequestId), so the same string
  // reused by two different users produces two distinct index keys, never a
  // collision — this is what actually guarantees no cross-user dedupe, not
  // just service-layer scoping.
  const uniqueIndex = MomentModel.schema.indexes().find(([fields, options]) => (
    fields.userId === 1 && fields.clientRequestId === 1 && options.unique === true
  ));
  const [fields] = uniqueIndex as [Record<string, number>, Record<string, unknown>];

  assert.deepEqual(Object.keys(fields), ["userId", "clientRequestId"]);
});

test("createMoment still requires caption or media when a clientRequestId is present", () => {
  // The idempotency key is orthogonal to CRT-011 content validation — it must
  // never bypass the existing "write something or attach media" rule.
  const parsed = momentValidation.createMoment.safeParse({
    body: {
      mode: "feed",
      audience: "public",
      clientRequestId: "post:1234567890:abc123",
    },
  });

  assert.equal(parsed.success, false);
});

test("clientRequestId format matches the existing shareMoment idempotency key convention", () => {
  const momentId = new Types.ObjectId().toString();
  const shareParsed = momentValidation.shareMoment.safeParse({
    params: { id: momentId },
    body: { clientRequestId: "repost:event:x:1" },
  });
  const createParsed = momentValidation.createMoment.safeParse({
    body: { mode: "feed", caption: "x", audience: "public", clientRequestId: "repost:event:x:1" },
  });

  assert.equal(shareParsed.success, true);
  assert.equal(createParsed.success, true);
});
