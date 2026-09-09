import assert from "node:assert/strict";
import test from "node:test";
import {
  PEOPLE_SEARCH_TIER,
  calculatePeopleActivityScore,
  calculatePeopleSearchSecondaryScore,
  calculateRelationshipScore,
  calculateSharedConnectionScore,
  comparePeopleSearchResults,
  escapeRegExp,
  getPeopleSearchLexicalTier,
  normalizePeopleSearchName,
  normalizePeopleSearchQuery,
  rankPeopleSearchCandidates,
  tokenizePeopleSearchName,
  type PeopleSearchRankInput,
} from "../src/modules/user/people-search-ranking.js";

const NOW = new Date("2026-09-07T00:00:00.000Z");

const candidate = (overrides: Partial<PeopleSearchRankInput> & { id: string }): PeopleSearchRankInput => ({
  username: "",
  name: "",
  viewerFollowsCandidate: false,
  candidateFollowsViewer: false,
  sharedConnectionCount: 0,
  activityAt: null,
  ...overrides,
});

const rankIds = (candidates: PeopleSearchRankInput[], query: string): string[] =>
  rankPeopleSearchCandidates(candidates, { normalizedQuery: normalizePeopleSearchQuery(query), now: NOW }).map(
    (result) => result.id,
  );

// ── Query normalization ──────────────────────────────────────────────────

test("normalizePeopleSearchQuery: @, case, whitespace all collapse to the same token", () => {
  assert.equal(normalizePeopleSearchQuery("@Rakib"), "rakib");
  assert.equal(normalizePeopleSearchQuery(" @RAKIB "), "rakib");
  assert.equal(normalizePeopleSearchQuery("@@rakib"), "rakib");
  assert.equal(normalizePeopleSearchQuery("  @rakib  "), "rakib");
  assert.equal(normalizePeopleSearchQuery("Rakib   Ahmed"), "rakib ahmed");
  assert.equal(normalizePeopleSearchQuery("@"), "");
  assert.equal(normalizePeopleSearchQuery("   "), "");
});

test("normalizePeopleSearchQuery applies NFKC (fullwidth + compatibility forms fold)", () => {
  assert.equal(normalizePeopleSearchQuery("ＲＡＫＩＢ"), "rakib");
});

test("escapeRegExp neutralizes every regex metacharacter", () => {
  assert.equal(escapeRegExp(".*+?^${}()|[]\\"), "\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\");
});

test("normalizePeopleSearchName + tokenize split on whitespace and punctuation", () => {
  assert.equal(normalizePeopleSearchName("  Rakib   AHMED "), "rakib ahmed");
  assert.deepEqual(tokenizePeopleSearchName("John Alexson-Smith"), ["john", "alexson", "smith"]);
});

// ── Locked lexical tiers ─────────────────────────────────────────────────

test("getPeopleSearchLexicalTier assigns the locked bands", () => {
  const q = "rakib";
  assert.equal(getPeopleSearchLexicalTier({ normalizedQuery: q, username: "rakib", name: "Someone" }), PEOPLE_SEARCH_TIER.EXACT_USERNAME);
  assert.equal(getPeopleSearchLexicalTier({ normalizedQuery: q, username: "rakib_dev", name: "Someone" }), PEOPLE_SEARCH_TIER.USERNAME_PREFIX);
  assert.equal(getPeopleSearchLexicalTier({ normalizedQuery: q, username: "xyz", name: "Rakib" }), PEOPLE_SEARCH_TIER.EXACT_NAME);
  assert.equal(getPeopleSearchLexicalTier({ normalizedQuery: q, username: "xyz", name: "Rakib Ahmed" }), PEOPLE_SEARCH_TIER.STRONG_NAME);
  assert.equal(getPeopleSearchLexicalTier({ normalizedQuery: q, username: "xyz", name: "John Rakibson" }), PEOPLE_SEARCH_TIER.STRONG_NAME);
  assert.equal(getPeopleSearchLexicalTier({ normalizedQuery: q, username: "developer_rakib", name: "Unrelated" }), PEOPLE_SEARCH_TIER.WEAK_SUBSTRING);
  assert.equal(getPeopleSearchLexicalTier({ normalizedQuery: q, username: "xyz", name: "TheRakibPage" }), PEOPLE_SEARCH_TIER.WEAK_SUBSTRING);
  assert.equal(getPeopleSearchLexicalTier({ normalizedQuery: q, username: "xyz", name: "Unrelated" }), PEOPLE_SEARCH_TIER.NO_MATCH);
});

test("full lexical ordering: exact username > prefix > exact name > strong name > weak substring", () => {
  const candidates = [
    candidate({ id: "E", username: "developer_rakib", name: "Unrelated", sharedConnectionCount: 10, viewerFollowsCandidate: true, candidateFollowsViewer: true, activityAt: NOW }),
    candidate({ id: "D", username: "unrelated_d", name: "Rakib Ahmed" }),
    candidate({ id: "C", username: "unrelated_c", name: "Rakib" }),
    candidate({ id: "B", username: "rakib_dev", name: "Unrelated" }),
    candidate({ id: "A", username: "rakib", name: "Unrelated" }),
  ];

  assert.deepEqual(rankIds(candidates, "rakib"), ["A", "B", "C", "D", "E"]);
});

// ── Exact @username guarantee ────────────────────────────────────────────

test("exact username in T0 outranks a maxed-out weak substring candidate", () => {
  const exact = candidate({ id: "exact", username: "rakib", name: "Nobody Special" });
  const loadedWeak = candidate({
    id: "weak",
    username: "developer_rakib",
    name: "Rakibfanpage",
    viewerFollowsCandidate: true,
    candidateFollowsViewer: true,
    sharedConnectionCount: 50,
    activityAt: NOW,
  });

  assert.deepEqual(rankIds([loadedWeak, exact], "@rakib"), ["exact", "weak"]);
  assert.deepEqual(rankIds([loadedWeak, exact], "RAKIB"), ["exact", "weak"]);
});

test("username prefix outranks a maxed-out weak substring candidate", () => {
  const prefix = candidate({ id: "prefix", username: "rakib_dev", name: "Nobody" });
  const loadedWeak = candidate({
    id: "weak",
    username: "the_rakib_person",
    name: "Rakibcommunity",
    viewerFollowsCandidate: true,
    candidateFollowsViewer: true,
    sharedConnectionCount: 25,
    activityAt: NOW,
  });

  assert.deepEqual(rankIds([loadedWeak, prefix], "rakib"), ["prefix", "weak"]);
});

test("exact display-name outranks a socially/active-loaded weak username substring", () => {
  const exactName = candidate({ id: "name", username: "totally_other", name: "Rakib" });
  const loadedWeak = candidate({
    id: "weak",
    username: "developer_rakib",
    name: "Unrelated",
    viewerFollowsCandidate: true,
    candidateFollowsViewer: true,
    sharedConnectionCount: 40,
    activityAt: NOW,
  });

  assert.deepEqual(rankIds([loadedWeak, exactName], "rakib"), ["name", "weak"]);
});

// ── Secondary signals reorder WITHIN a tier only ─────────────────────────

test("within the username-prefix tier: mutual > viewer-follows > candidate-follows > neither", () => {
  const base = { name: "Nobody" };
  const candidates = [
    candidate({ id: "neither", username: "rakib_a", ...base }),
    candidate({ id: "candidateFollows", username: "rakib_a", ...base, candidateFollowsViewer: true }),
    candidate({ id: "viewerFollows", username: "rakib_a", ...base, viewerFollowsCandidate: true }),
    candidate({ id: "mutual", username: "rakib_a", ...base, viewerFollowsCandidate: true, candidateFollowsViewer: true }),
  ];

  assert.deepEqual(rankIds(candidates, "rakib"), ["mutual", "viewerFollows", "candidateFollows", "neither"]);
});

test("within a tier + same relationship: more shared connections ranks higher, capped at 10", () => {
  const five = candidate({ id: "five", username: "rakib_a", name: "N", sharedConnectionCount: 5 });
  const zero = candidate({ id: "zero", username: "rakib_a", name: "N", sharedConnectionCount: 0 });
  assert.deepEqual(rankIds([zero, five], "rakib"), ["five", "zero"]);

  assert.equal(calculateSharedConnectionScore(10), 1);
  assert.equal(calculateSharedConnectionScore(50), 1);
  assert.equal(calculateSharedConnectionScore(0), 0);
  assert.equal(calculateSharedConnectionScore(1), 0.1);
});

test("within a tier: more recent public activity ranks higher; no activity ranks last", () => {
  const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
  const candidates = [
    candidate({ id: "none", username: "rakib_a", name: "N", activityAt: null }),
    candidate({ id: "old", username: "rakib_a", name: "N", activityAt: days(60) }),
    candidate({ id: "mid", username: "rakib_a", name: "N", activityAt: days(14) }),
    candidate({ id: "today", username: "rakib_a", name: "N", activityAt: days(0) }),
  ];
  assert.deepEqual(rankIds(candidates, "rakib"), ["today", "mid", "old", "none"]);
});

test("activityScore uses an injectable now and decays with age", () => {
  assert.equal(calculatePeopleActivityScore(null, NOW), 0);
  assert.equal(calculatePeopleActivityScore(NOW, NOW), 1);
  assert.ok(Math.abs(calculatePeopleActivityScore(new Date(NOW.getTime() - 14 * 86_400_000), NOW) - 0.5) < 1e-9);
  // Future timestamp is clamped, never > 1.
  assert.equal(calculatePeopleActivityScore(new Date(NOW.getTime() + 86_400_000), NOW), 1);
});

test("relationshipScore uses the strongest state and is never summed", () => {
  assert.equal(calculateRelationshipScore({ viewerFollowsCandidate: true, candidateFollowsViewer: true }), 1);
  assert.equal(calculateRelationshipScore({ viewerFollowsCandidate: true, candidateFollowsViewer: false }), 0.8);
  assert.equal(calculateRelationshipScore({ viewerFollowsCandidate: false, candidateFollowsViewer: true }), 0.6);
  assert.equal(calculateRelationshipScore({ viewerFollowsCandidate: false, candidateFollowsViewer: false }), 0);
});

test("secondary-score formula matches the locked weights and clamps to [0,1]", () => {
  assert.equal(
    calculatePeopleSearchSecondaryScore({
      relationshipScore: 1,
      sharedConnectionScore: 1,
      relevanceScore: 1,
      activityScore: 1,
    }),
    1,
  );
  assert.ok(
    Math.abs(
      calculatePeopleSearchSecondaryScore({
        relationshipScore: 0.8,
        sharedConnectionScore: 0.5,
        relevanceScore: 0.25,
        activityScore: 0,
      }) -
        (0.8 * 0.35 + 0.5 * 0.25 + 0.25 * 0.25 + 0),
    ) < 1e-9,
  );
});

// ── Relevance within a tier ─────────────────────────────────────────────

test("username-prefix relevance rewards a tighter prefix", () => {
  const candidates = [
    candidate({ id: "long", username: "rakib_developer_account", name: "N" }),
    candidate({ id: "mid", username: "rakib", name: "N" }),
    candidate({ id: "tight", username: "rak", name: "N" }),
  ];
  // "rak" query: @rak is exact (T0) so exclude it; compare two prefixes.
  const prefixOnly = [
    candidate({ id: "long", username: "rakib_developer_account", name: "N" }),
    candidate({ id: "short", username: "rakib", name: "N" }),
  ];
  assert.deepEqual(rankIds(prefixOnly, "rak"), ["short", "long"]);
  assert.deepEqual(rankIds(candidates, "rak"), ["tight", "mid", "long"]);
});

// ── Deterministic order ────────────────────────────────────────────────

test("ties break on normalized username ASC then _id ASC and are stable across calls", () => {
  const candidates = [
    candidate({ id: "z", username: "rakib_b", name: "N" }),
    candidate({ id: "a", username: "rakib_b", name: "N" }),
    candidate({ id: "m", username: "rakib_a", name: "N" }),
  ];
  const first = rankIds(candidates, "rakib");
  const second = rankIds([...candidates].reverse(), "rakib");
  assert.deepEqual(first, ["m", "a", "z"]);
  assert.deepEqual(second, ["m", "a", "z"]);
});

test("non-matching candidates are dropped entirely", () => {
  const candidates = [
    candidate({ id: "match", username: "rakib", name: "N" }),
    candidate({ id: "nope", username: "other", name: "Different Person" }),
  ];
  assert.deepEqual(rankIds(candidates, "rakib"), ["match"]);
});

test("comparePeopleSearchResults never lets a weaker tier sort above a stronger one", () => {
  const strongLowScore = {
    id: "s",
    username: "rakib",
    name: "n",
    viewerFollowsCandidate: false,
    candidateFollowsViewer: false,
    sharedConnectionCount: 0,
    activityAt: null,
    tier: PEOPLE_SEARCH_TIER.USERNAME_PREFIX,
    relevanceScore: 0,
    relationshipScore: 0,
    sharedConnectionScore: 0,
    activityScore: 0,
    secondaryScore: 0,
  };
  const weakHighScore = { ...strongLowScore, id: "w", tier: PEOPLE_SEARCH_TIER.WEAK_SUBSTRING, secondaryScore: 1, relevanceScore: 1 };
  assert.ok(comparePeopleSearchResults(strongLowScore, weakHighScore) < 0);
});
