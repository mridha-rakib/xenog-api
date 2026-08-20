import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const repositorySource = readFileSync(join(process.cwd(), "src/modules/event-windows/event-window.repository.ts"), "utf8");
const eventWindowInterfaceSource = readFileSync(join(process.cwd(), "src/modules/event-windows/event-window.interface.ts"), "utf8");
const eventWindowServiceSource = readFileSync(join(process.cwd(), "src/modules/event-windows/event-window.service.ts"), "utf8");
const userServiceSource = readFileSync(join(process.cwd(), "src/modules/user/user.service.ts"), "utf8");
const userRouteSource = readFileSync(join(process.cwd(), "src/modules/user/user.route.ts"), "utf8");

test("profile stats count distinct accepted windowIds for the target user", () => {
  assert.match(repositorySource, /countDistinctAcceptedWindowsByUser/);
  assert.match(repositorySource, /distinct\("windowId", \{ userId, status: "accepted" \}\)/);
  assert.match(userServiceSource, /countDistinctAcceptedWindowsByUser\(targetUserId\)/);
});

test("Profile Windows event grouping is based on target user's accepted posts and distinct windows", () => {
  assert.match(repositorySource, /listAcceptedPostEventGroupsByUser/);
  assert.match(repositorySource, /\$match: \{ userId: new Types\.ObjectId\(userId\), status: "accepted" \}/);
  assert.match(repositorySource, /windowIds: \{ \$addToSet: "\$windowId" \}/);
  assert.match(repositorySource, /windowCount: \{ \$size: "\$windowIds" \}/);
});

test("Profile Window posts endpoint queries only target user's accepted posts for the selected event", () => {
  assert.match(repositorySource, /listAcceptedPostsByUserForEvent/);
  assert.match(repositorySource, /find\(\{ userId, eventId, status: "accepted" \}\)/);
  assert.match(userServiceSource, /listAcceptedPostsByUserForEvent\(targetUserId, eventId, skip, limit\)/);
});

test("profile windows routes live under users and do not touch Home participated windows route", () => {
  assert.match(userRouteSource, /"\/:id\/profile-windows"/);
  assert.match(userRouteSource, /"\/:id\/profile-windows\/:eventId\/posts"/);
  assert.doesNotMatch(userRouteSource, /\/events\/windows\/participated/);
});

test("Profile Window post service preserves existing event and window visibility gates", () => {
  assert.match(userServiceSource, /assertProfileAccessible\(viewer, targetUserId\)/);
  assert.match(userServiceSource, /canAccessEventForProfileWindows\(viewer, event\)/);
  assert.match(userServiceSource, /canViewProfileWindowPost\(viewer, event, window\)/);
  assert.match(userServiceSource, /findAcceptedPostByUser\(window\._id\.toString\(\), viewer\.id\)/);
});

test("Event Window post responses include optional current author avatar metadata", () => {
  assert.match(eventWindowInterfaceSource, /export interface EventWindowPostAuthorResponse/);
  assert.match(eventWindowInterfaceSource, /author\?: EventWindowPostAuthorResponse \| null/);
  assert.match(eventWindowServiceSource, /getPostAuthorsById\(pagePosts\)/);
  assert.match(eventWindowServiceSource, /this\.storageService\.createDownloadUrl\(user\.avatarKey\)/);
  assert.match(eventWindowServiceSource, /avatarUrl,/);
  assert.match(eventWindowServiceSource, /userRepository\.findByIds\(userIds\)/);
});

test("Profile Window posts include target user's current avatar metadata without changing ownership filtering", () => {
  assert.match(userServiceSource, /this\.userRepository\.findById\(targetUserId\)/);
  assert.match(userServiceSource, /author,/);
  assert.match(userServiceSource, /this\.storageService\.createDownloadUrl\(user\.avatarKey\)/);
  assert.match(userServiceSource, /avatarUrl,/);
  assert.match(userServiceSource, /listAcceptedPostsByUserForEvent\(targetUserId, eventId, skip, limit\)/);
});
