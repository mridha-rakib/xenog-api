import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeErrorSummary } from "../src/core/utils/errorSanitizer.js";

test("returns a plain short message unchanged", () => {
  assert.equal(sanitizeErrorSummary("ffmpeg exited with code 1"), "ffmpeg exited with code 1");
});

test("accepts an Error instance and uses its message", () => {
  assert.equal(sanitizeErrorSummary(new Error("source probe failed")), "source probe failed");
});

test("collapses newlines and repeated whitespace into a single line", () => {
  const input = "line one\nline two\n\n\tline three   with   spaces";
  const result = sanitizeErrorSummary(input);

  assert.doesNotMatch(result, /\n/);
  assert.equal(result, "line one line two line three with spaces");
});

test("redacts an http(s) URL, e.g. a signed S3 URL", () => {
  const input = "upload failed for https://bucket.s3.amazonaws.com/videos/originals/abc.mp4?X-Amz-Signature=deadbeef";
  const result = sanitizeErrorSummary(input);

  assert.doesNotMatch(result, /https?:\/\//);
  assert.doesNotMatch(result, /X-Amz-Signature/);
  assert.match(result, /\[redacted]/);
});

test("redacts a long token-like value", () => {
  const token = "a".repeat(60);
  const result = sanitizeErrorSummary(`auth failed with token ${token}`);

  assert.doesNotMatch(result, new RegExp(token));
  assert.match(result, /\[redacted]/);
});

test("redacts a Stripe-style secret key", () => {
  const result = sanitizeErrorSummary("stripe error using sk_live_abcDEF123456");

  assert.doesNotMatch(result, /sk_live_abcDEF123456/);
});

test("redacts an AWS access key id", () => {
  const result = sanitizeErrorSummary("credentials rejected: AKIAABCDEFGHIJKLMNOP");

  assert.doesNotMatch(result, /AKIAABCDEFGHIJKLMNOP/);
});

test("redacts a POSIX temp path", () => {
  const result = sanitizeErrorSummary("could not read /tmp/transcode-job-8f21/source.mp4");

  assert.doesNotMatch(result, /\/tmp\//);
  assert.match(result, /\[path]/);
});

test("redacts a Windows drive path", () => {
  const result = sanitizeErrorSummary(String.raw`could not read C:\worker\tmp\job-8f21\source.mp4`);

  assert.doesNotMatch(result, /C:\\/);
});

test("bounds the summary to the requested max length", () => {
  const longMessage = "x".repeat(1000);
  const result = sanitizeErrorSummary(longMessage, 50);

  assert.ok(result.length <= 50);
});

test("bounds to the default max length when none is given", () => {
  const longMessage = "y".repeat(5000);
  const result = sanitizeErrorSummary(longMessage);

  assert.ok(result.length <= 300);
});

test("never returns an empty string", () => {
  assert.equal(sanitizeErrorSummary(""), "unknown error");
  assert.equal(sanitizeErrorSummary(null), "unknown error");
  assert.equal(sanitizeErrorSummary(undefined), "unknown error");
});

test("stringifies a non-Error, non-string thrown value safely", () => {
  const result = sanitizeErrorSummary({ code: "ECONNRESET" });

  assert.equal(typeof result, "string");
  assert.ok(result.length > 0);
});
