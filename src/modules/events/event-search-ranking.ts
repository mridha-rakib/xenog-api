/**
 * Pure lexical-tier ranker for free-text Event search.
 *
 * No database access lives here — the repository retrieves a bounded candidate
 * set and hands plain data to `rankEventSearchCandidates`. The primary tier
 * order is immutable; a weaker tier can NEVER outrank a stronger one.
 *
 *   T0 EXACT_TITLE      normalized title === normalized query
 *   T1 TITLE_PREFIX     title / any title token startsWith(query)
 *   T2 CATEGORY         category exact or category token startsWith(query)
 *   T3 MORPHOLOGY       a deterministic morphology variant matches title/category
 *                       by exact or prefix / token-prefix
 *   T4 TYPO             bounded Damerau–Levenshtein against title/category TOKENS ONLY
 *   T5 WEAK_SUBSTRING   query appears internally in the normalized title
 *   T6 LEGACY_LOW       literal normalized substring in host name / host username /
 *                       venue / address / searchLabel (never fuzzy)
 *
 * This is independent of the Event Smart Feed scorer — nothing here imports or
 * mutates `feed/event-smart-feed-ranking.ts` or `/events/feed`.
 */

import {
  createMorphologyVariants,
  damerauLevenshteinDistance,
  normalizeSearchText,
  tokenizeSearchText,
} from "../../core/utils/search-text.js";

export const EVENT_SEARCH_TIER = {
  EXACT_TITLE: 0,
  TITLE_PREFIX: 1,
  CATEGORY: 2,
  MORPHOLOGY: 3,
  TYPO: 4,
  WEAK_SUBSTRING: 5,
  LEGACY_LOW: 6,
  NO_MATCH: 7,
} as const;

export type EventSearchTier = (typeof EVENT_SEARCH_TIER)[keyof typeof EVENT_SEARCH_TIER];

/** Hard cap on how many T4 (bounded-typo) rows may appear in a single result page. */
export const EVENT_SEARCH_TYPO_ROW_CAP = 10;

export interface EventSearchRankInput {
  id: string;
  title: string;
  /** Raw category strings (0..n). */
  categories: string[];
  /** Low-priority, non-fuzzy haystack: host name/username + venue + address + searchLabel. */
  legacyText: string;
  scheduledAt: Date | null;
  publishedAt: Date | null;
}

export interface EventSearchRanked extends EventSearchRankInput {
  tier: number;
  relevance: number;
}

const startsWithAnyToken = (tokens: string[], query: string): boolean =>
  tokens.some((token) => token.startsWith(query));

/**
 * Bounded typo match: only for query length >= 4, distance <= 1 (len 4..7) or
 * <= 2 (len >= 8), and only when |len difference| <= 2. Compared against the
 * supplied tokens (title + category tokens only — never description / address /
 * schedule text / host username).
 */
export const isBoundedTypoMatch = (query: string, tokens: string[]): boolean => {
  if (query.length < 4) return false;
  const maxDistance = query.length <= 7 ? 1 : 2;

  for (const token of tokens) {
    if (Math.abs(query.length - token.length) > 2) continue;
    if (damerauLevenshteinDistance(query, token, maxDistance) <= maxDistance) {
      return true;
    }
  }
  return false;
};

export interface EventSearchTierResult {
  tier: number;
  relevance: number;
}

export const getEventSearchTier = (input: {
  normalizedQuery: string;
  variants: string[];
  title: string;
  categories: string[];
  legacyText: string;
}): EventSearchTierResult => {
  const query = input.normalizedQuery;
  if (!query) {
    return { tier: EVENT_SEARCH_TIER.NO_MATCH, relevance: 0 };
  }

  const normalizedTitle = normalizeSearchText(input.title);
  const titleTokens = tokenizeSearchText(input.title);
  const normalizedCategories = input.categories
    .map((category) => normalizeSearchText(category))
    .filter(Boolean);
  const categoryTokens = normalizedCategories.flatMap((category) => category.split(" "));
  const extraVariants = input.variants.filter((variant) => variant !== query);

  // T0 — exact normalized title.
  if (normalizedTitle && normalizedTitle === query) {
    return { tier: EVENT_SEARCH_TIER.EXACT_TITLE, relevance: 1 };
  }

  // T1 — title prefix / token prefix.
  if (normalizedTitle.startsWith(query) || startsWithAnyToken(titleTokens, query)) {
    const relevance = normalizedTitle.length > 0 ? query.length / normalizedTitle.length : 0;
    return { tier: EVENT_SEARCH_TIER.TITLE_PREFIX, relevance: Math.min(1, relevance) };
  }

  // T2 — category exact / prefix.
  if (
    normalizedCategories.some((category) => category === query || category.startsWith(query)) ||
    startsWithAnyToken(categoryTokens, query)
  ) {
    const exact = normalizedCategories.some((category) => category === query);
    return { tier: EVENT_SEARCH_TIER.CATEGORY, relevance: exact ? 0.9 : 0.7 };
  }

  // T3 — deterministic morphology variant, exact or prefix over title / category.
  for (const variant of extraVariants) {
    const variantHitsTitle =
      normalizedTitle === variant ||
      normalizedTitle.startsWith(variant) ||
      startsWithAnyToken(titleTokens, variant);
    const variantHitsCategory =
      normalizedCategories.some((category) => category === variant || category.startsWith(variant)) ||
      startsWithAnyToken(categoryTokens, variant);
    if (variantHitsTitle || variantHitsCategory) {
      return { tier: EVENT_SEARCH_TIER.MORPHOLOGY, relevance: 0.6 };
    }
  }

  // T4 — bounded typo/fuzzy against title + category tokens only.
  if (isBoundedTypoMatch(query, [...titleTokens, ...categoryTokens])) {
    return { tier: EVENT_SEARCH_TIER.TYPO, relevance: 0.4 };
  }

  // T5 — weak internal substring in the title.
  if (normalizedTitle.includes(query)) {
    const index = normalizedTitle.indexOf(query);
    return { tier: EVENT_SEARCH_TIER.WEAK_SUBSTRING, relevance: 1 / (2 + index) };
  }

  // T6 — legacy low-priority literal substring (never fuzzy).
  if (input.legacyText && normalizeSearchText(input.legacyText).includes(query)) {
    return { tier: EVENT_SEARCH_TIER.LEGACY_LOW, relevance: 0.1 };
  }

  return { tier: EVENT_SEARCH_TIER.NO_MATCH, relevance: 0 };
};

/**
 * Final order:
 *   1. lexical tier ASC
 *   2. relevance DESC (within tier)
 *   3. scheduledAt ASC
 *   4. publishedAt DESC
 *   5. stable _id string ASC
 */
export const compareEventSearchResults = (a: EventSearchRanked, b: EventSearchRanked): number => {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (b.relevance !== a.relevance) return b.relevance - a.relevance;

  const scheduledA = a.scheduledAt ? a.scheduledAt.getTime() : Number.POSITIVE_INFINITY;
  const scheduledB = b.scheduledAt ? b.scheduledAt.getTime() : Number.POSITIVE_INFINITY;
  if (scheduledA !== scheduledB) return scheduledA - scheduledB;

  const publishedA = a.publishedAt ? a.publishedAt.getTime() : 0;
  const publishedB = b.publishedAt ? b.publishedAt.getTime() : 0;
  if (publishedA !== publishedB) return publishedB - publishedA;

  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
};

/**
 * Score every candidate into a tier, drop non-matches, sort by the locked order.
 * Pure — no I/O. `now` is accepted for signature symmetry with other rankers and
 * future decay use; it does not currently affect ordering.
 */
export const rankEventSearchCandidates = (
  candidates: EventSearchRankInput[],
  options: { normalizedQuery: string; now: Date },
): EventSearchRanked[] => {
  const normalizedQuery = normalizeSearchText(options.normalizedQuery);
  const variants = createMorphologyVariants(normalizedQuery);
  const ranked: EventSearchRanked[] = [];

  for (const candidate of candidates) {
    const { tier, relevance } = getEventSearchTier({
      normalizedQuery,
      variants,
      title: candidate.title,
      categories: candidate.categories,
      legacyText: candidate.legacyText,
    });

    if (tier >= EVENT_SEARCH_TIER.NO_MATCH) continue;
    ranked.push({ ...candidate, tier, relevance });
  }

  ranked.sort(compareEventSearchResults);
  return ranked;
};

/**
 * Apply the T4 backfill cap and the final page limit. Bounded-typo rows are
 * capped at `typoCap` regardless of how many exist; they never displace a
 * stronger tier (the input is already tier-sorted). Returns ids in final order.
 */
export const capTypoAndLimitEventSearch = (
  ranked: EventSearchRanked[],
  limit: number,
  typoCap: number = EVENT_SEARCH_TYPO_ROW_CAP,
): EventSearchRanked[] => {
  const out: EventSearchRanked[] = [];
  let typoUsed = 0;

  for (const row of ranked) {
    if (out.length >= limit) break;
    if (row.tier === EVENT_SEARCH_TIER.TYPO) {
      if (typoUsed >= typoCap) continue;
      typoUsed += 1;
    }
    out.push(row);
  }

  return out;
};
