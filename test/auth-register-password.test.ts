import assert from "node:assert/strict";
import test from "node:test";
import { authValidation } from "../src/modules/auth/auth.validation.js";
import { PASSWORD_RULE_MESSAGES } from "../src/modules/auth/password.schema.js";

const baseBody = {
  name: "Acme Events",
  username: "acme_events",
  email: "owner@acme.com",
  accountType: "business" as const,
  acceptedLegal: true,
};

const parseRegister = (password: string) =>
  authValidation.register.safeParse({ body: { ...baseBody, password } });

test("accepts a password meeting every approved rule", () => {
  const result = parseRegister("Str0ng!Pass");
  assert.equal(result.success, true);
});

test("rejects a password shorter than 8 characters", () => {
  const result = parseRegister("Ab1!c");
  assert.equal(result.success, false);
  const messages = result.error!.issues.map((issue) => issue.message);
  assert.ok(messages.includes(PASSWORD_RULE_MESSAGES.minLength));
});

test("rejects a password with no lowercase letter", () => {
  const result = parseRegister("PASSW0RD!!");
  assert.equal(result.success, false);
  const messages = result.error!.issues.map((issue) => issue.message);
  assert.ok(messages.includes(PASSWORD_RULE_MESSAGES.lowercase));
});

test("rejects a password with no uppercase letter", () => {
  const result = parseRegister("passw0rd!!");
  assert.equal(result.success, false);
  const messages = result.error!.issues.map((issue) => issue.message);
  assert.ok(messages.includes(PASSWORD_RULE_MESSAGES.uppercase));
});

test("rejects a password with no number", () => {
  const result = parseRegister("Password!!");
  assert.equal(result.success, false);
  const messages = result.error!.issues.map((issue) => issue.message);
  assert.ok(messages.includes(PASSWORD_RULE_MESSAGES.number));
});

test("rejects a password with no special character", () => {
  const result = parseRegister("Password11");
  assert.equal(result.success, false);
  const messages = result.error!.issues.map((issue) => issue.message);
  assert.ok(messages.includes(PASSWORD_RULE_MESSAGES.special));
});

test("reports every unmet rule at once and anchors them to body.password", () => {
  const result = parseRegister("aaaaaaaa");
  assert.equal(result.success, false);
  const passwordIssues = result.error!.issues.filter(
    (issue) => issue.path.join(".") === "body.password",
  );
  const messages = passwordIssues.map((issue) => issue.message);
  assert.ok(messages.includes(PASSWORD_RULE_MESSAGES.uppercase));
  assert.ok(messages.includes(PASSWORD_RULE_MESSAGES.number));
  assert.ok(messages.includes(PASSWORD_RULE_MESSAGES.special));
});

test("still enforces the existing 128 character ceiling", () => {
  const result = parseRegister(`A1!${"a".repeat(130)}`);
  assert.equal(result.success, false);
});
