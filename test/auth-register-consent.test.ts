import assert from "node:assert/strict";
import test from "node:test";
import { authValidation } from "../src/modules/auth/auth.validation.js";
import { AuthService } from "../src/modules/auth/auth.service.js";

const baseBody = {
  name: "Acme Events",
  username: "acme_events",
  email: "owner@acme.com",
  password: "Str0ng!Pass",
  accountType: "business" as const,
};

const parseRegister = (body: Record<string, unknown>) =>
  authValidation.register.safeParse({ body });

test("register schema rejects a body with no acceptedLegal", () => {
  const result = parseRegister({ ...baseBody });
  assert.equal(result.success, false);
  const messages = result.error!.issues.map((issue) => issue.message);
  assert.ok(messages.includes("You must accept the Terms & Conditions and Privacy Policy"));
});

test("register schema rejects acceptedLegal: false", () => {
  const result = parseRegister({ ...baseBody, acceptedLegal: false });
  assert.equal(result.success, false);
  const messages = result.error!.issues.map((issue) => issue.message);
  assert.ok(messages.includes("You must accept the Terms & Conditions and Privacy Policy"));
});

test("register schema accepts acceptedLegal: true with an optional locale", () => {
  const result = parseRegister({ ...baseBody, acceptedLegal: true, locale: "en-GB" });
  assert.equal(result.success, true);
  assert.equal(result.data!.body.locale, "en-GB");
});

test("register schema accepts acceptedLegal: true without a locale", () => {
  const result = parseRegister({ ...baseBody, acceptedLegal: true });
  assert.equal(result.success, true);
});

const termsUpdatedAt = new Date("2026-08-01T10:00:00.000Z");
const privacyUpdatedAt = new Date("2026-08-15T12:30:00.000Z");

const buildService = () => {
  const consentRecords: Record<string, unknown>[] = [];

  const userRepository = {
    findByEmailWithVerification: async () => null,
    findByUsername: async () => null,
    create: async (record: Record<string, unknown>) => ({
      _id: { toString: () => "user-123" },
      email: record.email,
      name: record.name,
    }),
  };
  const emailService = { sendVerificationCode: async () => undefined };
  const legalDocumentService = {
    getDocument: async (type: "terms" | "privacy") => ({
      updatedAt: type === "terms" ? termsUpdatedAt : privacyUpdatedAt,
    }),
  };
  const userConsentRepository = {
    record: async (payload: Record<string, unknown>) => {
      consentRecords.push(payload);
      return payload;
    },
  };

  const service = new AuthService(
    userRepository as never,
    emailService as never,
    legalDocumentService as never,
    userConsentRepository as never,
  );

  return { service, consentRecords };
};

test("register writes an auditable UserConsent record after user creation", async () => {
  const { service, consentRecords } = buildService();

  await service.register({ ...baseBody, acceptedLegal: true, locale: "fr-FR" });

  assert.equal(consentRecords.length, 1);
  const record = consentRecords[0]!;
  assert.equal(record.userId, "user-123");
  assert.equal(record.context, "signup");
  assert.equal(record.termsVersion, termsUpdatedAt.toISOString());
  assert.equal(record.privacyVersion, privacyUpdatedAt.toISOString());
  assert.equal(record.locale, "fr-FR");
  assert.ok(record.acceptedAt instanceof Date);
});

test("register falls back to Accept-Language, then en-US, for locale", async () => {
  const withHeader = buildService();
  await withHeader.service.register(
    { ...baseBody, acceptedLegal: true },
    { acceptLanguage: "de-DE,de;q=0.9" },
  );
  assert.equal(withHeader.consentRecords[0]!.locale, "de-DE");

  const withNothing = buildService();
  await withNothing.service.register({ ...baseBody, acceptedLegal: true });
  assert.equal(withNothing.consentRecords[0]!.locale, "en-US");
});
