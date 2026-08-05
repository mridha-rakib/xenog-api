import assert from "node:assert/strict";
import { mkdir, readdir, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  assertPathWithinRoot,
  cleanupWorkspace,
  createJobWorkspace,
  resolveJobWorkspacePath,
  sweepStaleWorkspaces,
} from "../src/modules/transcoding/temp-workspace.js";

const testRoot = path.join(os.tmpdir(), `xenog-transcoding-test-${randomUUID()}`);

test.before(async () => {
  await mkdir(testRoot, { recursive: true });
});

test.after(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(testRoot, { recursive: true, force: true });
});

test("resolveJobWorkspacePath builds a path under the configured root from job id + suffix", () => {
  const resolved = resolveJobWorkspacePath(testRoot, "507f1f77bcf86cd799439011", "abc123");

  assert.ok(resolved.startsWith(path.resolve(testRoot)));
  assert.ok(resolved.includes("507f1f77bcf86cd799439011-abc123"));
});

test("resolveJobWorkspacePath sanitizes a job id containing path-traversal characters", () => {
  const resolved = resolveJobWorkspacePath(testRoot, "../../etc/passwd", "suffix");

  // The traversal characters are stripped before being used as a path
  // segment, and the result is always re-verified to stay under the root.
  assert.ok(resolved.startsWith(path.resolve(testRoot)));
  assert.equal(resolved.includes(".."), false);
});

test("assertPathWithinRoot accepts a genuinely nested path", () => {
  assert.doesNotThrow(() => assertPathWithinRoot(testRoot, path.join(testRoot, "job-1")));
});

test("assertPathWithinRoot rejects a path that escapes the root via traversal", () => {
  assert.throws(() => assertPathWithinRoot(testRoot, path.join(testRoot, "..", "escaped")));
});

test("assertPathWithinRoot rejects an unrelated absolute path", () => {
  assert.throws(() => assertPathWithinRoot(testRoot, os.homedir()));
});

test("assertPathWithinRoot rejects the root itself (a job dir must be a real subdirectory)", () => {
  assert.throws(() => assertPathWithinRoot(testRoot, testRoot));
});

test("createJobWorkspace creates a restrictive-permission directory with the expected file paths", async () => {
  const workspace = await createJobWorkspace(testRoot, "job-create-1", "suffixA");

  const stats = await stat(workspace.dir);
  assert.equal(stats.isDirectory(), true);
  assert.equal(workspace.sourcePath, path.join(workspace.dir, "source"));
  assert.equal(workspace.optimizedPath, path.join(workspace.dir, "optimized.mp4"));
  assert.equal(workspace.thumbnailPath, path.join(workspace.dir, "thumbnail.jpg"));

  await cleanupWorkspace(workspace.dir);
});

test("cleanupWorkspace removes the directory and returns true on success", async () => {
  const workspace = await createJobWorkspace(testRoot, "job-cleanup-1", "suffixB");
  await writeFile(workspace.sourcePath, "fake video bytes");

  const result = await cleanupWorkspace(workspace.dir);

  assert.equal(result, true);
  await assert.rejects(() => stat(workspace.dir));
});

test("cleanupWorkspace does not throw for an already-missing directory", async () => {
  const result = await cleanupWorkspace(path.join(testRoot, "never-existed"));

  assert.equal(result, true);
});

test("sweepStaleWorkspaces removes only directories older than the threshold", async () => {
  const oldWorkspace = await createJobWorkspace(testRoot, "job-old", "stale");
  const freshWorkspace = await createJobWorkspace(testRoot, "job-fresh", "new");

  // Backdate the "old" workspace's mtime well past the sweep threshold.
  const oldTime = new Date(Date.now() - 60 * 60 * 1000);
  await utimes(oldWorkspace.dir, oldTime, oldTime);

  const result = await sweepStaleWorkspaces(testRoot, 30 * 60 * 1000);

  assert.equal(result.removed >= 1, true);
  await assert.rejects(() => stat(oldWorkspace.dir));
  const freshStats = await stat(freshWorkspace.dir);
  assert.equal(freshStats.isDirectory(), true);

  await cleanupWorkspace(freshWorkspace.dir);
});

test("sweepStaleWorkspaces never removes a directory listed as active, even if it is old", async () => {
  const activeWorkspace = await createJobWorkspace(testRoot, "job-active", "owned");
  const oldTime = new Date(Date.now() - 60 * 60 * 1000);
  await utimes(activeWorkspace.dir, oldTime, oldTime);

  const activeDirName = path.basename(activeWorkspace.dir);
  const result = await sweepStaleWorkspaces(testRoot, 30 * 60 * 1000, new Set([activeDirName]));

  assert.equal(result.skippedActive >= 1, true);
  const stats = await stat(activeWorkspace.dir);
  assert.equal(stats.isDirectory(), true);

  await cleanupWorkspace(activeWorkspace.dir);
});

test("sweepStaleWorkspaces on a nonexistent root returns zero counts without throwing", async () => {
  const result = await sweepStaleWorkspaces(path.join(testRoot, "does-not-exist"), 1000);

  assert.deepEqual(result, { scanned: 0, removed: 0, skippedActive: 0, failed: 0 });
});

test("sweepStaleWorkspaces ignores entries that do not look like job workspace names", async () => {
  const strangeDir = path.join(testRoot, "not a job dir!!");
  await mkdir(strangeDir, { recursive: true });
  const oldTime = new Date(Date.now() - 60 * 60 * 1000);
  await utimes(strangeDir, oldTime, oldTime);

  const result = await sweepStaleWorkspaces(testRoot, 30 * 60 * 1000);

  const stillThere = await readdir(testRoot);
  assert.ok(stillThere.includes("not a job dir!!"));

  const { rm } = await import("node:fs/promises");
  await rm(strangeDir, { recursive: true, force: true });
  void result;
});
