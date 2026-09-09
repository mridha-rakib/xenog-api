import assert from "node:assert/strict";
import test from "node:test";
import {
  EVENT_SEARCH_TIER,
  capTypoAndLimitEventSearch,
  compareEventSearchResults,
  getEventSearchTier,
  isBoundedTypoMatch,
  rankEventSearchCandidates,
  type EventSearchRankInput,
} from "../src/modules/events/event-search-ranking.js";
import { createMorphologyVariants, normalizeSearchText } from "../src/core/utils/search-text.js";

const now = new Date("2026-09-08T00:00:00.000Z");

const candidate = (over: Partial<EventSearchRankInput> & { id: string }): EventSearchRankInput => ({
  title: "",
  categories: [],
  legacyText: "",
  scheduledAt: new Date("2026-10-01T00:00:00.000Z"),
  publishedAt: new Date("2026-09-01T00:00:00.000Z"),
  ...over,
});

const tierOf = (query: string, input: Partial<EventSearchRankInput>) =>
  getEventSearchTier({
    normalizedQuery: normalizeSearchText(query),
    variants: createMorphologyVariants(normalizeSearchText(query)),
    title: input.title ?? "",
    categories: input.categories ?? [],
    legacyText: input.legacyText ?? "",
  }).tier;

// --- case-insensitive -------------------------------------------------

test("party / PARTY / Party / PaRtY all resolve to the same (exact-title) tier", () => {
  for (const q of ["party", "PARTY", "Party", "PaRtY"]) {
    assert.equal(tierOf(q, { title: "Party" }), EVENT_SEARCH_TIER.EXACT_TITLE, q);
  }
});

test("punctuation-wrapped query still matches the plain title", () => {
  for (const q of ["party!", "party?", '"party"', "(party)"]) {
    assert.equal(tierOf(q, { title: "Party Night" }), EVENT_SEARCH_TIER.TITLE_PREFIX, q);
  }
});

// --- partial word: prefix beats internal substring -------------------

test("partial-word: prefix / token-prefix ranks above internal substring", () => {
  assert.equal(tierOf("part", { title: "Party" }), EVENT_SEARCH_TIER.TITLE_PREFIX);
  assert.equal(tierOf("part", { title: "Party Night" }), EVENT_SEARCH_TIER.TITLE_PREFIX);
  assert.equal(tierOf("part", { title: "Part-time Event" }), EVENT_SEARCH_TIER.TITLE_PREFIX);
  assert.equal(tierOf("part", { title: "Counterparty Conference" }), EVENT_SEARCH_TIER.WEAK_SUBSTRING);
  // "Department Meeting" — internal substring only (falls to weak / no-match, never prefix).
  assert.ok(tierOf("part", { title: "Department Meeting" }) >= EVENT_SEARCH_TIER.WEAK_SUBSTRING);
});

test("ranked order: Party Night (prefix) outranks Counterparty Conference (substring) for 'part'", () => {
  const ranked = rankEventSearchCandidates(
    [
      candidate({ id: "counter", title: "Counterparty Conference" }),
      candidate({ id: "night", title: "Party Night" }),
    ],
    { normalizedQuery: "part", now },
  );
  assert.deepEqual(ranked.map((r) => r.id), ["night", "counter"]);
});

// --- morphology ------------------------------------------------------

test("morphology: 'partys' / 'parties' reach party titles/categories via variant tier", () => {
  assert.equal(tierOf("partys", { title: "Party Night" }), EVENT_SEARCH_TIER.MORPHOLOGY);
  assert.equal(tierOf("partys", { title: "Party" }), EVENT_SEARCH_TIER.MORPHOLOGY);
  assert.equal(tierOf("partys", { title: "X", categories: ["Party"] }), EVENT_SEARCH_TIER.MORPHOLOGY);
  assert.equal(tierOf("parties", { title: "Party Night" }), EVENT_SEARCH_TIER.MORPHOLOGY);
});

// --- bounded typo --------------------------------------------------

test("isBoundedTypoMatch: transposition / deletion / insertion within gates", () => {
  assert.equal(isBoundedTypoMatch("praty", ["party", "night"]), true);
  assert.equal(isBoundedTypoMatch("paty", ["party"]), true);
  assert.equal(isBoundedTypoMatch("partyx", ["party"]), true);
});

test("isBoundedTypoMatch: nonsense and short queries are rejected", () => {
  assert.equal(isBoundedTypoMatch("pxyzty", ["party"]), false);
  assert.equal(isBoundedTypoMatch("pa", ["party"]), false); // length < 4
  assert.equal(isBoundedTypoMatch("par", ["party"]), false);
  assert.equal(isBoundedTypoMatch("party", ["counterparty"]), false); // |len diff| > 2
});

test("typo tier only applies to title/category tokens, never to legacyText", () => {
  // 'praty' is DL1 from 'party' but 'party' only appears in the host/venue haystack.
  assert.equal(
    tierOf("praty", { title: "Music Fest", legacyText: "hosted by party planners" }),
    EVENT_SEARCH_TIER.NO_MATCH,
  );
});

// --- tiers never cross --------------------------------------------

test("locked order for 'partys': exact 'Partys' > morphology 'Party Night' > typo 'Partis' > weak > absent", () => {
  const ranked = rankEventSearchCandidates(
    [
      candidate({ id: "unrelated", title: "Cooking Workshop" }),
      candidate({ id: "weak", title: "Bipartys Meetup" }), // 'partys' only as an internal substring
      candidate({ id: "typo", title: "Partis Festival" }), // DL1 from 'partys', not a prefix
      candidate({ id: "morph", title: "Party Night" }), // variant 'party' is a token prefix
      candidate({ id: "exact", title: "Partys" }),
    ],
    { normalizedQuery: "partys", now },
  );
  assert.deepEqual(ranked.map((r) => r.id), ["exact", "morph", "typo", "weak"]);
  assert.equal(ranked.find((r) => r.id === "unrelated"), undefined);
});

test("exact title always outranks a fuzzy match regardless of dates", () => {
  const ranked = rankEventSearchCandidates(
    [
      candidate({ id: "fuzzy", title: "Praty", scheduledAt: new Date("2026-09-09T00:00:00.000Z") }),
      candidate({ id: "exact", title: "Party", scheduledAt: new Date("2027-01-01T00:00:00.000Z") }),
    ],
    { normalizedQuery: "party", now },
  );
  assert.equal(ranked[0]!.id, "exact");
});

// --- typo cap / rank-before-limit -------------------------------

test("capTypoAndLimitEventSearch: T4 rows are capped at 10 and never displace stronger tiers", () => {
  const strong = Array.from({ length: 3 }, (_, i) =>
    candidate({ id: `strong-${i}`, title: "Party" }),
  );
  const fuzzy = Array.from({ length: 40 }, (_, i) =>
    candidate({ id: `fuzzy-${i}`, title: "Praty" }),
  );
  const ranked = rankEventSearchCandidates([...fuzzy, ...strong], { normalizedQuery: "party", now });
  const capped = capTypoAndLimitEventSearch(ranked, 50, 10);
  const typoCount = capped.filter((r) => r.tier === EVENT_SEARCH_TIER.TYPO).length;
  assert.equal(typoCount, 10);
  assert.equal(capped.slice(0, 3).every((r) => r.tier === EVENT_SEARCH_TIER.EXACT_TITLE), true);
});

test("capTypoAndLimitEventSearch: honours the page limit", () => {
  const ranked = rankEventSearchCandidates(
    Array.from({ length: 20 }, (_, i) => candidate({ id: `p-${i}`, title: "Party" })),
    { normalizedQuery: "party", now },
  );
  assert.equal(capTypoAndLimitEventSearch(ranked, 5, 10).length, 5);
});

// --- comparator --------------------------------------------------

test("compareEventSearchResults never lets a weaker tier sort above a stronger one", () => {
  const a = { id: "a", tier: EVENT_SEARCH_TIER.WEAK_SUBSTRING, relevance: 1, scheduledAt: now, publishedAt: now } as never;
  const b = { id: "b", tier: EVENT_SEARCH_TIER.EXACT_TITLE, relevance: 0, scheduledAt: now, publishedAt: now } as never;
  assert.ok(compareEventSearchResults(a, b) > 0);
  assert.ok(compareEventSearchResults(b, a) < 0);
});

test("within a tier: earlier scheduledAt first, then newer publishedAt, then stable _id", () => {
  const ranked = rankEventSearchCandidates(
    [
      candidate({ id: "bbb", title: "Party", scheduledAt: new Date("2026-10-02T00:00:00.000Z") }),
      candidate({ id: "aaa", title: "Party", scheduledAt: new Date("2026-10-01T00:00:00.000Z") }),
      candidate({ id: "ccc", title: "Party", scheduledAt: new Date("2026-10-01T00:00:00.000Z") }),
    ],
    { normalizedQuery: "party", now },
  );
  assert.deepEqual(ranked.map((r) => r.id), ["aaa", "ccc", "bbb"]);
});

test("results are deterministic across repeated identical calls", () => {
  const input = [
    candidate({ id: "1", title: "Party Night" }),
    candidate({ id: "2", title: "Summer Party" }),
    candidate({ id: "3", title: "Praty" }),
  ];
  const a = rankEventSearchCandidates(input, { normalizedQuery: "party", now }).map((r) => r.id);
  const b = rankEventSearchCandidates(input, { normalizedQuery: "party", now }).map((r) => r.id);
  assert.deepEqual(a, b);
});
