// Shared MongoDB test-database safety guard for every transcoding
// integration test. Deliberately does NOT import "../../src/config/env.js"
// (or anything that transitively does): ESM import hoisting means static
// imports are evaluated before any top-level statement in the importing test
// file runs, so if a test file's own module graph pulled in env.ts — which
// calls dotenv.config() and can populate process.env.MONGODB_URI from this
// repo's real (Atlas) .env — before that test file got a chance to set its
// own safe local override, the test could silently connect to production.
// This module reads process.env directly, never through the parsed Zod env
// singleton, and never connects anywhere itself — it only classifies a URI a
// caller is about to use and throws before any connection is attempted.

import mongoose from "mongoose";

/** Every transcoding integration test must use this exact isolated local database, never process.env.MONGODB_URI. */
export const TRANSCODING_TEST_MONGODB_URI = "mongodb://127.0.0.1:27017/xenog-test";

const PRODUCTION_DATABASE_NAME_DENYLIST = new Set(["xenog_db"]);

export interface MongoUriSafetyResult {
  ok: boolean;
  reason?: string;
  /** Sanitized (never the full URI, never credentials) — safe to log. */
  sanitizedHost?: string;
  sanitizedDb?: string;
}

/** Reads the raw configured production URI's database name for comparison, without ever logging or returning the URI itself. */
const readConfiguredProductionDbName = (): string | null => {
  const raw = process.env.MONGODB_URI;

  if (!raw) {
    return null;
  }

  try {
    const parsed = new URL(raw);
    const dbName = parsed.pathname.replace(/^\//, "").split("?")[0];
    return dbName || null;
  } catch {
    return null;
  }
};

const readConfiguredProductionHost = (): string | null => {
  const raw = process.env.MONGODB_URI;

  if (!raw) {
    return null;
  }

  try {
    return new URL(raw).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Classifies whether `uri` is safe to use as a MongoDB integration test
 * database, without ever attempting to connect to it. Rejects: the
 * `mongodb+srv` scheme (Atlas-style), any non-loopback host, the known
 * production database name (`xenog_db`) or one dynamically read from the
 * currently configured production `MONGODB_URI`, and an exact match against
 * that configured production URI.
 */
export const classifyMongoUriSafety = (uri: string): MongoUriSafetyResult => {
  let parsed: URL;

  try {
    parsed = new URL(uri);
  } catch {
    return { ok: false, reason: "unparseable_test_mongo_uri" };
  }

  const protocol = parsed.protocol.replace(/:$/, "");
  const hostname = parsed.hostname.toLowerCase();
  const dbName = parsed.pathname.replace(/^\//, "").split("?")[0];

  if (protocol === "mongodb+srv") {
    return { ok: false, reason: "srv_scheme_not_allowed_in_tests", sanitizedHost: hostname };
  }

  if (!LOOPBACK_HOSTS.has(hostname)) {
    return { ok: false, reason: "non_local_host_not_allowed_in_tests", sanitizedHost: hostname };
  }

  // Exact match against the currently configured production URI is checked
  // before the (broader) db-name/host checks below, since it is the most
  // specific possible signal — and, precisely because it is a full-string
  // match, it always implies a db-name match too, so it must run first to
  // ever be the reported reason.
  const configuredProductionUri = process.env.MONGODB_URI;

  if (configuredProductionUri && configuredProductionUri === uri) {
    return { ok: false, reason: "matches_configured_production_uri" };
  }

  if (PRODUCTION_DATABASE_NAME_DENYLIST.has(dbName) || dbName === readConfiguredProductionDbName()) {
    return { ok: false, reason: "production_database_name_not_allowed_in_tests", sanitizedDb: dbName };
  }

  const configuredProductionHost = readConfiguredProductionHost();

  if (configuredProductionHost && !LOOPBACK_HOSTS.has(configuredProductionHost) && hostname === configuredProductionHost) {
    return { ok: false, reason: "matches_configured_production_host", sanitizedHost: hostname };
  }

  return { ok: true, sanitizedHost: hostname, sanitizedDb: dbName };
};

/**
 * Throws — before any connection is attempted — if `uri` is not a safe
 * isolated local test database. Never includes the URI or any credential in
 * the thrown message; only the sanitized classification reason.
 */
export const assertSafeTestMongoUri = (uri: string): void => {
  const result = classifyMongoUriSafety(uri);

  if (!result.ok) {
    process.stderr.write(
      `[transcoding-test-db] refusing unsafe MongoDB test URI: reason=${result.reason} host=${result.sanitizedHost ?? "?"} db=${result.sanitizedDb ?? "?"}\n`,
    );
    throw new Error(
      `Refusing to run a MongoDB integration test against an unsafe URI (${result.reason}). ` +
        "Use an isolated local test database such as mongodb://127.0.0.1:27017/xenog-test.",
    );
  }
};

/** Guards, then connects (idempotent — a no-op if already connected). */
export const connectTranscodingTestDb = async (uri: string = TRANSCODING_TEST_MONGODB_URI): Promise<void> => {
  assertSafeTestMongoUri(uri);

  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(uri);
  }
};

export const disconnectTranscodingTestDb = async (): Promise<void> => {
  await mongoose.disconnect();
};
