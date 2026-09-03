import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import { Types } from "mongoose";
import { AuthService } from "../src/modules/auth/auth.service.js";

const userId = new Types.ObjectId().toString();
const CORRECT_PASSWORD = "Secret123!";

type Obligations = {
  activePaidEvents?: number;
  pendingPayouts?: number;
  unsettledEarnings?: number;
};

type Overrides = Obligations & {
  passwordHash?: string | null;
  userExists?: boolean;
  deactivateReturnsNull?: boolean;
};

const createService = (overrides: Overrides = {}) => {
  const {
    activePaidEvents = 0,
    pendingPayouts = 0,
    unsettledEarnings = 0,
    passwordHash = bcrypt.hashSync(CORRECT_PASSWORD, 4),
    userExists = true,
    deactivateReturnsNull = false,
  } = overrides;

  const calls: string[] = [];

  const userRepository = {
    findByIdWithPassword: async (id: string) => {
      calls.push("findByIdWithPassword");
      return userExists ? { _id: new Types.ObjectId(id), passwordHash } : null;
    },
    deactivateAccountById: async (id: string) => {
      calls.push("deactivateAccountById");
      return deactivateReturnsNull ? null : { _id: new Types.ObjectId(id), name: "Deleted User" };
    },
  } as never;

  const eventRepository = {
    countActivePaidHostedEventsByUserId: async () => {
      calls.push("countActivePaidHostedEventsByUserId");
      return activePaidEvents;
    },
  } as never;

  const creatorEarningRepository = {
    countUnsettledByCreatorUserId: async () => {
      calls.push("countUnsettledByCreatorUserId");
      return unsettledEarnings;
    },
  } as never;

  const creatorPayoutRepository = {
    findPendingOrProcessingByCreatorUserId: async () => {
      calls.push("findPendingOrProcessingByCreatorUserId");
      return new Array(pendingPayouts).fill({});
    },
  } as never;

  const groupService = {
    removeUserFromAllGroups: async () => {
      calls.push("removeUserFromAllGroups");
    },
  } as never;

  const service = new AuthService(
    userRepository,
    {} as never,
    {} as never,
    {} as never,
    eventRepository,
    creatorEarningRepository,
    creatorPayoutRepository,
    groupService,
  );

  return { service, calls };
};

test("wrong password is rejected with 401 and nothing is deleted", async () => {
  const { service, calls } = createService();

  await assert.rejects(
    () => service.deleteCurrentUser(userId, "not-the-password"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /invalid password/i);
      assert.equal((error as { statusCode?: number }).statusCode, 401);
      return true;
    },
  );

  assert.equal(calls.includes("deactivateAccountById"), false);
  assert.equal(calls.includes("removeUserFromAllGroups"), false);
});

test("account with no local password cannot be deleted via password check", async () => {
  const { service, calls } = createService({ passwordHash: null });

  await assert.rejects(
    () => service.deleteCurrentUser(userId, CORRECT_PASSWORD),
    /invalid password/i,
  );

  assert.equal(calls.includes("deactivateAccountById"), false);
});

test("active paid hosted event blocks deletion with 409", async () => {
  const { service, calls } = createService({ activePaidEvents: 1 });

  await assert.rejects(
    () => service.deleteCurrentUser(userId, CORRECT_PASSWORD),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /complete pending obligations/i);
      assert.equal((error as { statusCode?: number }).statusCode, 409);
      return true;
    },
  );

  assert.equal(calls.includes("deactivateAccountById"), false);
  assert.equal(calls.includes("removeUserFromAllGroups"), false);
});

test("pending payout blocks deletion with 409", async () => {
  const { service } = createService({ pendingPayouts: 1 });

  await assert.rejects(
    () => service.deleteCurrentUser(userId, CORRECT_PASSWORD),
    /complete pending obligations/i,
  );
});

test("unsettled creator earnings block deletion with 409", async () => {
  const { service } = createService({ unsettledEarnings: 1 });

  await assert.rejects(
    () => service.deleteCurrentUser(userId, CORRECT_PASSWORD),
    /complete pending obligations/i,
  );
});

test("correct password with no obligations detaches groups then soft-deletes", async () => {
  const { service, calls } = createService();

  await assert.doesNotReject(() => service.deleteCurrentUser(userId, CORRECT_PASSWORD));

  const groupIndex = calls.indexOf("removeUserFromAllGroups");
  const deactivateIndex = calls.indexOf("deactivateAccountById");

  assert.ok(groupIndex >= 0, "groups should be detached");
  assert.ok(deactivateIndex >= 0, "account should be soft-deleted");
  assert.ok(groupIndex < deactivateIndex, "groups are detached before anonymization");
});
