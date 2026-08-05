import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSafeTestMongoUri,
  classifyMongoUriSafety,
  TRANSCODING_TEST_MONGODB_URI,
} from "./helpers/transcoding-test-db.js";

// This suite deliberately never calls mongoose.connect anywhere — every
// assertion below proves the guard rejects (or accepts) a URI purely by
// string classification, before any network connection would ever be
// attempted.

test("classifyMongoUriSafety: the standard isolated local test URI is safe", () => {
  const result = classifyMongoUriSafety(TRANSCODING_TEST_MONGODB_URI);
  assert.equal(result.ok, true);
  assert.equal(result.sanitizedHost, "127.0.0.1");
  assert.equal(result.sanitizedDb, "xenog-test");
});

test("classifyMongoUriSafety: localhost loopback with a non-production db name is safe", () => {
  const result = classifyMongoUriSafety("mongodb://localhost:27017/xenog-test");
  assert.equal(result.ok, true);
});

test("classifyMongoUriSafety: an Atlas-style mongodb+srv URI is rejected regardless of host/db", () => {
  const result = classifyMongoUriSafety("mongodb+srv://user:pass@cluster0.example.mongodb.net/xenog_db");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "srv_scheme_not_allowed_in_tests");
});

test("classifyMongoUriSafety: a non-loopback host is rejected even with mongodb:// scheme", () => {
  const result = classifyMongoUriSafety("mongodb://db.internal.example.com:27017/xenog-test");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "non_local_host_not_allowed_in_tests");
});

test("classifyMongoUriSafety: the production database name is rejected even on a loopback host", () => {
  const result = classifyMongoUriSafety("mongodb://127.0.0.1:27017/xenog_db");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "production_database_name_not_allowed_in_tests");
});

test("classifyMongoUriSafety: an unparseable URI is rejected", () => {
  const result = classifyMongoUriSafety("not a mongo uri at all");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unparseable_test_mongo_uri");
});

test("classifyMongoUriSafety: a URI identical to the currently configured production MONGODB_URI is rejected", () => {
  const previous = process.env.MONGODB_URI;
  process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/xenog-test-shadow";

  try {
    const result = classifyMongoUriSafety("mongodb://127.0.0.1:27017/xenog-test-shadow");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "matches_configured_production_uri");
  } finally {
    if (previous === undefined) {
      delete process.env.MONGODB_URI;
    } else {
      process.env.MONGODB_URI = previous;
    }
  }
});

test("assertSafeTestMongoUri: throws for an Atlas-like URI without attempting any connection", () => {
  assert.throws(
    () => assertSafeTestMongoUri("mongodb+srv://user:secret@cluster0.example.mongodb.net/xenog_db"),
    /Refusing to run a MongoDB integration test/,
  );
});

test("assertSafeTestMongoUri: the thrown error never contains the rejected URI or any credential", () => {
  const uri = "mongodb+srv://admin:super-secret-password@prod-cluster.example.mongodb.net/xenog_db";

  try {
    assertSafeTestMongoUri(uri);
    assert.fail("expected assertSafeTestMongoUri to throw");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.doesNotMatch(message, /super-secret-password/);
    assert.doesNotMatch(message, /prod-cluster/);
    assert.doesNotMatch(message, /admin:/);
  }
});

test("assertSafeTestMongoUri: does not throw for the standard isolated local test URI", () => {
  assert.doesNotThrow(() => assertSafeTestMongoUri(TRANSCODING_TEST_MONGODB_URI));
});
