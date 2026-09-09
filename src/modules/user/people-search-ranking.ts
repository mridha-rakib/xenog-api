/**
 * Pure People/User search ranking model.
 *
 * No database access lives here — callers retrieve + batch-enrich candidates and
 * hand plain data to `rankPeopleSearchCandidates`. This keeps the locked
 * lexical-tier invariant independently unit-testable:
 *
 *   T0 exact username  >  T1 username prefix  >  T2 exact display-name
 *     >  T3 strong display-name prefix/token  >  T4 weak substring
 *
 * Secondary signals (relationship / shared connections / relevance / activity)
 * only reorder candidates WITHIN the same tier. They can never move a weaker-tier
 * candidate above a stronger-tier one — `comparePeopleSearchResults` sorts by
 * tier first, unconditionally.
 */

export const PEOPLE_SEARCH_TIER = {
  EXACT_USERNAME: 0,
  USERNAME_PREFIX: 1,
  EXACT_NAME: 2,
  STRONG_NAME: 3,
  WEAK_SUBSTRING: 4,
  NO_MATCH: 5,
} as const;

export type PeopleSearchTier = (typeof PEOPLE_SEARCH_TIER)[keyof typeof PEOPLE_SEARCH_TIER];

export interface PeopleSearchRankInput {
  id: string;
  /** Stored username (already lowercase in schema); "" when the account has none. */
  username: string;
  /** Raw display name. */
  name: string;
  viewerFollowsCandidate: boolean;
  candidateFollowsViewer: boolean;
  sharedConnectionCount: number;
  /** Latest eligible public-content timestamp, or null when there is none. */
  activityAt: Date | null;
}

export interface PeopleSearchRanked extends PeopleSearchRankInput {
  tier: number;
  relevanceScore: number;
  relationshipScore: number;
  sharedConnectionScore: number;
  activityScore: number;
  secondaryScore: number;
}

const clamp01 = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
};

/** Escape every regex metacharacter so a user query is matched literally. */
export const escapeRegExp = (input: string): string => input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Normalize a raw People-search query.
 * Order: trim -> NFKC -> strip leading '@'(s) -> trim -> lowercase -> collapse internal whitespace.
 */
export const normalizePeopleSearchQuery = (input: string): string =>
  (input ?? "")
    .trim()
    .normalize("NFKC")
    .replace(/^@+/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

/** Normalize a display name for comparison: NFKC -> lowercase -> trim -> collapse whitespace. */
export const normalizePeopleSearchName = (input: string): string =>
  (input ?? "").normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");

/** Split a display name into normalized tokens on whitespace / punctuation boundaries. */
export const tokenizePeopleSearchName = (input: string): string[] =>
  normalizePeopleSearchName(input)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

export const getPeopleSearchLexicalTier = (input: {
  normalizedQuery: string;
  username: string;
  name: string;
}): number => {
  const query = input.normalizedQuery;

  if (!query) {
    return PEOPLE_SEARCH_TIER.NO_MATCH;
  }

  const username = (input.username ?? "").toLowerCase();
  const normalizedName = normalizePeopleSearchName(input.name);
  const tokens = tokenizePeopleSearchName(input.name);

  if (username && username === query) {
    return PEOPLE_SEARCH_TIER.EXACT_USERNAME;
  }
  if (username && username.startsWith(query)) {
    return PEOPLE_SEARCH_TIER.USERNAME_PREFIX;
  }
  if (normalizedName && normalizedName === query) {
    return PEOPLE_SEARCH_TIER.EXACT_NAME;
  }
  if (normalizedName.startsWith(query) || tokens.some((token) => token.startsWith(query))) {
    return PEOPLE_SEARCH_TIER.STRONG_NAME;
  }
  if ((username && username.includes(query)) || normalizedName.includes(query)) {
    return PEOPLE_SEARCH_TIER.WEAK_SUBSTRING;
  }
  return PEOPLE_SEARCH_TIER.NO_MATCH;
};

const substringFieldScore = (query: string, field: string): number => {
  const matchIndex = field.indexOf(query);
  if (matchIndex < 0) {
    return 0;
  }
  const positionScore = 1 / (1 + matchIndex);
  const coverageScore = field.length > 0 ? query.length / field.length : 0;
  return clamp01(positionScore * 0.6 + coverageScore * 0.4);
};

/** Deterministic lexical closeness within the candidate's own tier. Always [0,1]. */
export const calculatePeopleSearchRelevance = (input: {
  tier: number;
  normalizedQuery: string;
  username: string;
  name: string;
}): number => {
  const query = input.normalizedQuery;
  const username = (input.username ?? "").toLowerCase();
  const normalizedName = normalizePeopleSearchName(input.name);
  const tokens = tokenizePeopleSearchName(input.name);

  switch (input.tier) {
    case PEOPLE_SEARCH_TIER.EXACT_USERNAME:
      return 1;
    case PEOPLE_SEARCH_TIER.USERNAME_PREFIX:
      return clamp01(username.length > 0 ? query.length / username.length : 0);
    case PEOPLE_SEARCH_TIER.EXACT_NAME:
      return 1;
    case PEOPLE_SEARCH_TIER.STRONG_NAME:
      if (normalizedName.startsWith(query)) {
        return 0.9;
      }
      if (tokens.some((token) => token.startsWith(query))) {
        return 0.8;
      }
      return 0.8;
    case PEOPLE_SEARCH_TIER.WEAK_SUBSTRING: {
      const usernameScore = username.includes(query) ? substringFieldScore(query, username) : 0;
      const nameScore = normalizedName.includes(query) ? substringFieldScore(query, normalizedName) : 0;
      return clamp01(Math.max(usernameScore, nameScore));
    }
    default:
      return 0;
  }
};

/** Strongest matching directional follow state -> [0,1]. Never summed. */
export const calculateRelationshipScore = (input: {
  viewerFollowsCandidate: boolean;
  candidateFollowsViewer: boolean;
}): number => {
  if (input.viewerFollowsCandidate && input.candidateFollowsViewer) {
    return 1;
  }
  if (input.viewerFollowsCandidate) {
    return 0.8;
  }
  if (input.candidateFollowsViewer) {
    return 0.6;
  }
  return 0;
};

/** min(count, 10) / 10 — bounded so large mutual counts cannot dominate. */
export const calculateSharedConnectionScore = (count: number): number => {
  const safeCount = Number.isFinite(count) && count > 0 ? count : 0;
  return Math.min(safeCount, 10) / 10;
};

/** Recency decay of the latest eligible public-content timestamp. Injectable `now` for tests. */
export const calculatePeopleActivityScore = (activityAt: Date | null | undefined, now: Date): number => {
  if (!activityAt) {
    return 0;
  }
  const ageMs = now.getTime() - activityAt.getTime();
  const ageDays = Math.max(0, ageMs / 86_400_000);
  return clamp01(1 / (1 + ageDays / 14));
};

export const calculatePeopleSearchSecondaryScore = (input: {
  relationshipScore: number;
  sharedConnectionScore: number;
  relevanceScore: number;
  activityScore: number;
}): number =>
  clamp01(
    input.relationshipScore * 0.35 +
      input.sharedConnectionScore * 0.25 +
      input.relevanceScore * 0.25 +
      input.activityScore * 0.15,
  );

/**
 * Final order:
 *   1. lexical tier ASC
 *   2. secondaryScore DESC
 *   3. relevanceScore DESC
 *   4. normalized username ASC
 *   5. stable _id string ASC
 */
export const comparePeopleSearchResults = (a: PeopleSearchRanked, b: PeopleSearchRanked): number => {
  if (a.tier !== b.tier) {
    return a.tier - b.tier;
  }
  if (b.secondaryScore !== a.secondaryScore) {
    return b.secondaryScore - a.secondaryScore;
  }
  if (b.relevanceScore !== a.relevanceScore) {
    return b.relevanceScore - a.relevanceScore;
  }
  const usernameA = a.username || "";
  const usernameB = b.username || "";
  if (usernameA !== usernameB) {
    return usernameA < usernameB ? -1 : 1;
  }
  if (a.id !== b.id) {
    return a.id < b.id ? -1 : 1;
  }
  return 0;
};

/**
 * Score every candidate into a tier + secondary score and return them in final
 * ranked order. Candidates that match no tier are dropped. Pure — no I/O.
 */
export const rankPeopleSearchCandidates = (
  candidates: PeopleSearchRankInput[],
  options: { normalizedQuery: string; now: Date },
): PeopleSearchRanked[] => {
  const query = options.normalizedQuery;
  const ranked: PeopleSearchRanked[] = [];

  for (const candidate of candidates) {
    const username = (candidate.username ?? "").toLowerCase();
    const tier = getPeopleSearchLexicalTier({ normalizedQuery: query, username, name: candidate.name });

    if (tier > PEOPLE_SEARCH_TIER.WEAK_SUBSTRING) {
      continue;
    }

    const relevanceScore = calculatePeopleSearchRelevance({
      tier,
      normalizedQuery: query,
      username,
      name: candidate.name,
    });
    const relationshipScore = calculateRelationshipScore(candidate);
    const sharedConnectionScore = calculateSharedConnectionScore(candidate.sharedConnectionCount);
    const activityScore = calculatePeopleActivityScore(candidate.activityAt ?? null, options.now);
    const secondaryScore = calculatePeopleSearchSecondaryScore({
      relationshipScore,
      sharedConnectionScore,
      relevanceScore,
      activityScore,
    });

    ranked.push({
      ...candidate,
      username,
      tier,
      relevanceScore,
      relationshipScore,
      sharedConnectionScore,
      activityScore,
      secondaryScore,
    });
  }

  ranked.sort(comparePeopleSearchResults);
  return ranked;
};
