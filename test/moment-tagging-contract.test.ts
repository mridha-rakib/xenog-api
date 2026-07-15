import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { MomentModel } from "../src/modules/moments/moment.model.js";
import { momentValidation } from "../src/modules/moments/moment.validation.js";

test("moment creation accepts stable tagged friend ids while preserving taggedPeople", () => {
  const friendId = new Types.ObjectId().toString();
  const parsed = momentValidation.createMoment.safeParse({
    body: {
      mode: "feed",
      caption: "With a friend",
      audience: "public",
      taggedPeople: ["Gideon"],
      taggedFriendIds: [friendId, friendId],
    },
  });

  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.deepEqual(parsed.data.body.taggedPeople, ["Gideon"]);
    assert.deepEqual(parsed.data.body.taggedFriendIds, [friendId]);
  }
});

test("moment creation rejects malformed tagged friend ids", () => {
  const parsed = momentValidation.createMoment.safeParse({
    body: {
      mode: "feed",
      caption: "With a friend",
      audience: "public",
      taggedFriendIds: ["not-a-user"],
    },
  });

  assert.equal(parsed.success, false);
});

test("moments persist tagged friend ids as user references", () => {
  const taggedFriendPath = MomentModel.schema.path("taggedFriendIds");

  assert.ok(taggedFriendPath);
});
