import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Types } from "mongoose";
import { chatMessageTypes } from "../src/modules/chat/chat.interface.js";
import { chatMessageBodySchema } from "../src/modules/chat/chat.validation.js";

const gatewaySource = readFileSync(
  join(process.cwd(), "src/modules/realtime/socketio.gateway.ts"),
  "utf8",
);

test("Socket.IO validation uses the canonical REST message type list", () => {
  assert.match(gatewaySource, /import \{ chatMessageTypes \} from "\.\.\/chat\/chat\.interface\.js"/);
  assert.match(gatewaySource, /messageType: z\.enum\(chatMessageTypes\)\.optional\(\)/);
});

test("the canonical chat contract still accepts every supported message type", () => {
  const objectId = new Types.ObjectId().toString();
  const payloadByType = {
    text: { type: "text", text: "Hello" },
    image: { type: "image", attachment: { type: "image", key: "chat/image.jpg", mimeType: "image/jpeg", size: 10 } },
    video: { type: "video", attachment: { type: "video", key: "chat/video.mp4", mimeType: "video/mp4", size: 10 } },
    audio: { type: "audio", attachment: { type: "audio", key: "chat/audio.m4a", mimeType: "audio/mp4", size: 10 } },
    location: { type: "location", attachment: { type: "location", latitude: 23.81, longitude: 90.41 } },
    event: { type: "event", attachment: { type: "event", eventId: objectId } },
    post: { type: "post", attachment: { type: "post", postId: objectId } },
  } as const;

  assert.deepEqual(chatMessageTypes, Object.keys(payloadByType));
  for (const type of chatMessageTypes) {
    assert.equal(chatMessageBodySchema.safeParse(payloadByType[type]).success, true, type);
  }
});

test("handshake authentication failures expose the stable client recovery code", () => {
  assert.match(gatewaySource, /authError\.data = \{ code: "AUTHENTICATION_REQUIRED" \}/);
});
