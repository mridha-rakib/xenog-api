import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { chatMessageBodySchema } from "../src/modules/chat/chat.validation.js";

test("chat accepts an idempotent shared post attachment", () => {
  const postId = new Types.ObjectId().toString();
  const result = chatMessageBodySchema.safeParse({
    type: "post",
    text: "Post preview",
    attachment: { type: "post", postId },
    clientMessageId: `share:post:${postId}:${Date.now()}`,
  });

  assert.equal(result.success, true);
});

test("chat rejects mismatched and malformed shared item attachments", () => {
  const mismatch = chatMessageBodySchema.safeParse({
    type: "event",
    attachment: { type: "post", postId: new Types.ObjectId().toString() },
  });
  const malformed = chatMessageBodySchema.safeParse({
    type: "post",
    attachment: { type: "post", postId: "missing" },
  });

  assert.equal(mismatch.success, false);
  assert.equal(malformed.success, false);
});
