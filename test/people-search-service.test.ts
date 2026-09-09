import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import type { AuthUser } from "../src/modules/auth/auth.interface.js";
import type { IUser } from "../src/modules/user/user.interface.js";
import { UserService } from "../src/modules/user/user.service.js";
import {
  escapeRegExp,
  getPeopleSearchLexicalTier,
  normalizePeopleSearchName,
  normalizePeopleSearchQuery,
} from "../src/modules/user/people-search-ranking.js";

type Follow = { followerId: string; followingId: string };
type Block = { blockerId: string; blockedId: string };

const oid = (seed: number): string => new Types.ObjectId(seed.toString(16).padStart(24, "0")).toString();

const createAuthUser = (id: string): AuthUser => ({
  id,
  name: "Viewer",
  username: "viewer",
  email: `${id}@example.test`,
  accountType: "personal",
  currentLocationSharingEnabled: false,
  notificationsEnabled: true,
  role: "user",
  isActive: true,
  emailVerified: true,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
});

const createUser = (id: string, username: string | undefined, name: string, overrides: Partial<IUser> = {}): IUser =>
  ({
    _id: new Types.ObjectId(id),
    name,
    username,
    email: `${id}@example.test`,
    accountType: "personal",
    role: "user",
    isActive: true,
    emailVerified: true,
    deletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  }) as IUser;

interface Counters {
  candidateQueries: number;
  sharedConnectionCalls: number;
  momentActivityCalls: number;
  eventActivityCalls: number;
  followingCalls: number;
  followerCalls: number;
  mutualCalls: number;
}

const createService = (options: {
  viewerId: string;
  users: IUser[];
  follows?: Follow[];
  blocks?: Block[];
  momentActivity?: Record<string, Date>;
  eventActivity?: Record<string, Date>;
}) => {
  const usersById = new Map(options.users.map((user) => [user._id.toString(), user]));
  const follows = options.follows ?? [];
  const blocks = options.blocks ?? [];
  const counters: Counters = {
    candidateQueries: 0,
    sharedConnectionCalls: 0,
    momentActivityCalls: 0,
    eventActivityCalls: 0,
    followingCalls: 0,
    followerCalls: 0,
    mutualCalls: 0,
  };

  const isEligible = (user: IUser, excludedIds: Set<string>): boolean =>
    !excludedIds.has(user._id.toString()) &&
    user.role === "user" &&
    user.isActive === true &&
    user.emailVerified === true &&
    (user.deletedAt ?? null) === null;

  const userRepository = {
    // Simulates the real MongoDB banded retrieval: eligibility first, exact
    // fetched directly, strong bands before a bounded weak backfill.
    findPeopleSearchCandidates: async (params: {
      normalizedQuery: string;
      excludedIds: string[];
      prefixLimit: number;
      nameLimit: number;
      totalTarget: number;
    }) => {
      counters.candidateQueries += 1;
      const query = params.normalizedQuery;
      const excluded = new Set(params.excludedIds);
      escapeRegExp(query); // parity with production path

      const eligible = [...usersById.values()].filter((user) => isEligible(user, excluded));

      const exact =
        eligible.find((user) => (user.username ?? "").toLowerCase() === query) ?? null;

      const prefix = eligible
        .filter((user) => (user.username ?? "").toLowerCase().startsWith(query) && user !== exact)
        .slice(0, params.prefixLimit);
      const nameMatches = eligible
        .filter((user) => {
          const normalizedName = normalizePeopleSearchName(user.name);
          return (
            user !== exact &&
            (normalizedName.startsWith(query) ||
              normalizedName.split(" ").some((token) => token.startsWith(query)))
          );
        })
        .slice(0, params.nameLimit);

      const collected = new Map<string, IUser>();
      if (exact) collected.set(exact._id.toString(), exact);
      for (const user of [...prefix, ...nameMatches]) collected.set(user._id.toString(), user);

      const remaining = params.totalTarget - collected.size;
      if (remaining > 0) {
        const weak = eligible
          .filter(
            (user) =>
              !collected.has(user._id.toString()) &&
              user !== exact &&
              ((user.username ?? "").toLowerCase().includes(query) ||
                normalizePeopleSearchName(user.name).includes(query)),
          )
          .slice(0, remaining);
        for (const user of weak) collected.set(user._id.toString(), user);
      }

      const exactId = exact?._id.toString();
      return {
        exact,
        candidates: [...collected.values()].filter((user) => user._id.toString() !== exactId),
      };
    },
  };

  const userFollowRepository = {
    findFollowingIds: async (followerId: string) => {
      counters.followingCalls += 1;
      return follows.filter((f) => f.followerId === followerId).map((f) => f.followingId);
    },
    findFollowerIdsForUser: async (userId: string) => {
      counters.followerCalls += 1;
      return follows.filter((f) => f.followingId === userId).map((f) => f.followerId);
    },
    findMutualFriendIds: async (userId: string) => {
      counters.mutualCalls += 1;
      const following = new Set(follows.filter((f) => f.followerId === userId).map((f) => f.followingId));
      return follows
        .filter((f) => f.followingId === userId && following.has(f.followerId))
        .map((f) => f.followerId);
    },
    findSharedConnectionCounts: async (viewerConnectionIds: string[], candidateIds: string[]) => {
      counters.sharedConnectionCalls += 1;
      const connectionSet = new Set(viewerConnectionIds);
      const candidateSet = new Set(candidateIds);
      const counts = new Map<string, number>();
      for (const candidateId of candidateIds) {
        let shared = 0;
        for (const connectionId of connectionSet) {
          const connFollowsCandidate = follows.some(
            (f) => f.followerId === connectionId && f.followingId === candidateId,
          );
          const candidateFollowsConn = follows.some(
            (f) => f.followerId === candidateId && f.followingId === connectionId,
          );
          if (connFollowsCandidate && candidateFollowsConn && candidateSet.has(candidateId)) {
            shared += 1;
          }
        }
        if (shared > 0) counts.set(candidateId, shared);
      }
      return counts;
    },
  };

  const momentRepository = {
    findLatestPublicMomentAtByUserIds: async (userIds: string[]) => {
      counters.momentActivityCalls += 1;
      const map = new Map<string, Date>();
      for (const id of userIds) {
        if (options.momentActivity?.[id]) map.set(id, options.momentActivity[id]!);
      }
      return map;
    },
  };

  const eventRepository = {
    findLatestPublicActivityAtByUserIds: async (userIds: string[]) => {
      counters.eventActivityCalls += 1;
      const map = new Map<string, Date>();
      for (const id of userIds) {
        if (options.eventActivity?.[id]) map.set(id, options.eventActivity[id]!);
      }
      return map;
    },
  };

  const userBlockRepository = {
    findBlockedIds: async (blockerId: string) =>
      blocks.filter((b) => b.blockerId === blockerId).map((b) => b.blockedId),
    findBlockerIds: async (blockedId: string) =>
      blocks.filter((b) => b.blockedId === blockedId).map((b) => b.blockerId),
  };

  const storageService = {
    createDownloadUrl: async (key: string) => ({ url: `https://cdn.example.test/${key}` }),
  };

  const service = new UserService(
    userRepository as never,
    userFollowRepository as never,
    userBlockRepository as never,
    storageService as never,
    {} as never,
    eventRepository as never,
    {} as never,
    {} as never,
    momentRepository as never,
  );

  return { service, counters };
};

const VIEWER = oid(1);

test("normalized @Rakib / rakib / RAKIB / padded all resolve to the same exact-username winner", async () => {
  const users = [
    createUser(oid(10), "rakib", "Old Account", { createdAt: new Date("2020-01-01T00:00:00.000Z") }),
    createUser(oid(11), "rakib_dev", "Prefix Person"),
    createUser(oid(12), "developer_rakib", "Weak Person"),
  ];

  for (const raw of ["@Rakib", "rakib", "RAKIB", "  @rakib  "]) {
    const { service } = createService({ viewerId: VIEWER, users });
    const results = await service.searchPeople(createAuthUser(VIEWER), raw, 50);
    assert.equal(results[0]?.id, oid(10), `first result for "${raw}"`);
  }
});

test("empty / punctuation-only normalized query returns [] and issues no candidate query", async () => {
  const { service, counters } = createService({ viewerId: VIEWER, users: [createUser(oid(10), "rakib", "R")] });
  assert.deepEqual(await service.searchPeople(createAuthUser(VIEWER), "   ", 50), []);
  assert.deepEqual(await service.searchPeople(createAuthUser(VIEWER), "@@", 50), []);
  assert.equal(counters.candidateQueries, 0);
});

test("exact @username older than 50 newer accounts is still returned at the top", async () => {
  const users: IUser[] = [
    createUser(oid(10), "rakib", "The Real Rakib", { createdAt: new Date("2019-01-01T00:00:00.000Z") }),
  ];
  for (let i = 0; i < 80; i += 1) {
    // Newer accounts whose name contains "rakib" -> weak-tier substring matches.
    users.push(
      createUser(oid(100 + i), `person_${i}`, `Superrakib Number ${i}`, {
        createdAt: new Date(`2026-08-${String((i % 27) + 1).padStart(2, "0")}T00:00:00.000Z`),
      }),
    );
  }

  const { service } = createService({ viewerId: VIEWER, users });
  const results = await service.searchPeople(createAuthUser(VIEWER), "@rakib", 20);

  assert.equal(results[0]?.id, oid(10));
  assert.equal(results.length, 20);
});

test("followed exact @username remains searchable and reports isFollowing=true", async () => {
  const rakibId = oid(10);
  const { service } = createService({
    viewerId: VIEWER,
    users: [createUser(rakibId, "rakib", "Followed Rakib")],
    follows: [{ followerId: VIEWER, followingId: rakibId }],
  });

  const results = await service.searchPeople(createAuthUser(VIEWER), "@rakib", 50);
  assert.equal(results[0]?.id, rakibId);
  assert.equal(results[0]?.isFollowing, true);
});

test("hard eligibility removes blocked / blocker / deleted / inactive / unverified / self exact usernames", async () => {
  const scenarios: Array<{ label: string; user: IUser; blocks?: Block[]; isSelf?: boolean }> = [
    { label: "viewer blocked candidate", user: createUser(oid(20), "rakib", "R"), blocks: [{ blockerId: VIEWER, blockedId: oid(20) }] },
    { label: "candidate blocked viewer", user: createUser(oid(21), "rakib", "R"), blocks: [{ blockerId: oid(21), blockedId: VIEWER }] },
    { label: "deleted", user: createUser(oid(22), "rakib", "R", { deletedAt: new Date() }) },
    { label: "inactive", user: createUser(oid(23), "rakib", "R", { isActive: false }) },
    { label: "unverified", user: createUser(oid(24), "rakib", "R", { emailVerified: false }) },
  ];

  for (const scenario of scenarios) {
    const { service } = createService({ viewerId: VIEWER, users: [scenario.user], blocks: scenario.blocks });
    const results = await service.searchPeople(createAuthUser(VIEWER), "@rakib", 50);
    assert.equal(results.length, 0, scenario.label);
  }

  // Self: viewer's own exact-username account must not appear.
  const selfViewer = oid(30);
  const { service: selfService } = createService({
    viewerId: selfViewer,
    users: [createUser(selfViewer, "rakib", "Me", { username: "rakib" })],
  });
  assert.deepEqual(await selfService.searchPeople(createAuthUser(selfViewer), "@rakib", 50), []);
});

test("exact username beats a weak substring loaded with every secondary signal", async () => {
  const exactId = oid(10);
  const weakId = oid(11);
  const friendA = oid(40);
  const friendB = oid(41);

  const { service } = createService({
    viewerId: VIEWER,
    users: [
      createUser(exactId, "rakib", "No Signals Here"),
      createUser(weakId, "developer_rakib", "Superrakibcommunity"),
      createUser(friendA, "frienda", "Friend A"),
      createUser(friendB, "friendb", "Friend B"),
    ],
    follows: [
      // viewer <-> weakId mutual
      { followerId: VIEWER, followingId: weakId },
      { followerId: weakId, followingId: VIEWER },
      // viewer mutual friends A and B
      { followerId: VIEWER, followingId: friendA },
      { followerId: friendA, followingId: VIEWER },
      { followerId: VIEWER, followingId: friendB },
      { followerId: friendB, followingId: VIEWER },
      // A and B mutually follow weakId -> shared connections
      { followerId: friendA, followingId: weakId },
      { followerId: weakId, followingId: friendA },
      { followerId: friendB, followingId: weakId },
      { followerId: weakId, followingId: friendB },
    ],
    momentActivity: { [weakId]: new Date() },
  });

  const results = await service.searchPeople(createAuthUser(VIEWER), "@rakib", 50);
  assert.equal(results[0]?.id, exactId);
});

test("rank-before-limit: strong lexical results survive a flood of weak matches beyond the limit", async () => {
  const exactId = oid(10);
  const prefixId = oid(11);
  const exactNameId = oid(12);
  const users: IUser[] = [
    createUser(exactId, "sam", "Zzz Person"),
    createUser(prefixId, "samuel", "Zzz Person"),
    createUser(exactNameId, "zzz_other", "Sam"),
  ];
  for (let i = 0; i < 60; i += 1) {
    users.push(createUser(oid(200 + i), `its_sam_${i}`, `Person Awesamsauce ${i}`));
  }

  const { service } = createService({ viewerId: VIEWER, users });
  const results = await service.searchPeople(createAuthUser(VIEWER), "sam", 5);

  assert.equal(results.length, 5);
  assert.deepEqual(results.slice(0, 3).map((r) => r.id), [exactId, prefixId, exactNameId]);
});

test("enrichment is batched — one query each regardless of candidate count (no N+1)", async () => {
  const users: IUser[] = [createUser(oid(10), "rakib", "Exact")];
  for (let i = 0; i < 40; i += 1) {
    users.push(createUser(oid(300 + i), `rakib_${i}`, `Prefix ${i}`));
  }

  const { service, counters } = createService({ viewerId: VIEWER, users });
  await service.searchPeople(createAuthUser(VIEWER), "rakib", 50);

  assert.equal(counters.candidateQueries, 1);
  assert.equal(counters.sharedConnectionCalls, 1);
  assert.equal(counters.momentActivityCalls, 1);
  assert.equal(counters.eventActivityCalls, 1);
  assert.equal(counters.followingCalls, 1);
  assert.equal(counters.followerCalls, 1);
  assert.equal(counters.mutualCalls, 1);
});

test("regex-special query is treated literally and does not throw", async () => {
  const users = [
    createUser(oid(10), "rakib", "R"),
    createUser(oid(11), "abc", "A.*B"),
  ];
  const { service } = createService({ viewerId: VIEWER, users });
  const results = await service.searchPeople(createAuthUser(VIEWER), ".*", 50);
  // ".*" normalizes to ".*"; only a literal ".*" substring match should qualify.
  assert.deepEqual(results.map((r) => r.id), [oid(11)]);
  assert.equal(getPeopleSearchLexicalTier({ normalizedQuery: normalizePeopleSearchQuery(".*"), username: "abc", name: "A.*B" }), 4);
});

test("results are deterministic across repeated identical calls", async () => {
  const users = [
    createUser(oid(50), "rakib_b", "N"),
    createUser(oid(51), "rakib_b", "N"),
    createUser(oid(52), "rakib_a", "N"),
  ];
  const { service } = createService({ viewerId: VIEWER, users });
  const a = (await service.searchPeople(createAuthUser(VIEWER), "rakib", 50)).map((r) => r.id);
  const b = (await service.searchPeople(createAuthUser(VIEWER), "rakib", 50)).map((r) => r.id);
  assert.deepEqual(a, b);
});
