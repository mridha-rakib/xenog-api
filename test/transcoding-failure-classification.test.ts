import assert from "node:assert/strict";
import test from "node:test";
import { classifyProcessingFailure } from "../src/modules/transcoding/failure-classification.js";
import { transcodingJobErrorCodes } from "../src/modules/transcoding/transcoding-job.interface.js";

const permanentSourceReasons = [
  "source_missing",
  "source_duration_too_long",
  "source_invalid_dimensions",
  "source_no_video_stream",
  "source_unreadable",
] as const;

for (const reason of permanentSourceReasons) {
  test(`classifyProcessingFailure: "${reason}" is a permanent source failure (source_invalid, not retryable)`, () => {
    const result = classifyProcessingFailure(reason);

    assert.equal(result.errorCode, "source_invalid");
    assert.equal(result.retryable, false);
  });
}

test('classifyProcessingFailure: "source_too_large" is a permanent failure with its own dedicated code', () => {
  const result = classifyProcessingFailure("source_too_large");

  assert.equal(result.errorCode, "source_too_large");
  assert.equal(result.retryable, false);
});

const retryableOperationalReasons: Array<[string, string]> = [
  ["source_probe_unavailable", "probe_failed"],
  ["source_probe_timeout", "probe_failed"],
  ["download_failed", "download_failed"],
  ["encode_failed", "encode_failed"],
  ["encode_timeout", "timeout"],
  ["thumbnail_failed", "thumbnail_failed"],
  ["output_verification_failed", "verification_failed"],
  ["upload_failed", "upload_failed"],
  ["unknown", "unknown"],
];

for (const [reason, expectedCode] of retryableOperationalReasons) {
  test(`classifyProcessingFailure: "${reason}" is retryable and maps to "${expectedCode}"`, () => {
    const result = classifyProcessingFailure(reason as Parameters<typeof classifyProcessingFailure>[0]);

    assert.equal(result.errorCode, expectedCode);
    assert.equal(result.retryable, true);
  });
}

test("every errorCode returned by classifyProcessingFailure is a member of the existing closed enum", () => {
  const allReasons = [...permanentSourceReasons, ...retryableOperationalReasons.map(([reason]) => reason)] as const;

  for (const reason of allReasons) {
    const result = classifyProcessingFailure(reason as Parameters<typeof classifyProcessingFailure>[0]);
    assert.ok(
      (transcodingJobErrorCodes as readonly string[]).includes(result.errorCode),
      `${result.errorCode} is not in the closed transcodingJobErrorCodes enum`,
    );
  }
});
