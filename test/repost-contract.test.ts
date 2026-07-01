import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { MomentShareModel } from "../src/modules/moments/moment-share.model.js";
import { momentValidation } from "../src/modules/moments/moment.validation.js";

test("repost accepts an optional caption, friend tags, and idempotency key", () => {
  const momentId = new Types.ObjectId().toString();
  const friendId = new Types.ObjectId().toString();
  const parsed = momentValidation.shareMoment.safeParse({
    params: { id: momentId },
    body: {
      caption: "Going to this one",
      taggedFriendIds: [friendId, friendId],
      clientRequestId: `repost:event:${momentId}:request`,
    },
  });

  assert.equal(parsed.success, true);
  if (parsed.success) assert.deepEqual(parsed.data.body.taggedFriendIds, [friendId]);
});

test("repost rejects malformed tags and unknown payload fields", () => {
  const momentId = new Types.ObjectId().toString();
  assert.equal(momentValidation.shareMoment.safeParse({
    params: { id: momentId },
    body: { taggedFriendIds: ["not-a-user"] },
  }).success, false);
  assert.equal(momentValidation.shareMoment.safeParse({
    params: { id: momentId },
    body: { snapshot: { unsafe: true } },
  }).success, false);
});

test("reposts retain the unique user and original moment idempotency index", () => {
  const uniqueIndex = MomentShareModel.schema.indexes().find(([fields, options]) => (
    fields.userId === 1 && fields.momentId === 1 && options.unique === true
  ));
  assert.ok(uniqueIndex);
});
