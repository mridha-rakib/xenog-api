/**
 * Pure, dependency-free text helpers for free-text Search (Events + hashtag
 * expansion). Deliberately SEPARATE from People search normalization
 * (`people-search-ranking.ts`) and from `normalizeHashtag` — those are their own
 * concepts and must not be coupled to this.
 *
 * No database access, no framework: every function here is pure and unit-tested
 * in isolation (see api/test/search-text.test.ts).
 */

const CURLY_APOSTROPHES = /[‘’ʼ]/g;
// Includes \p{M} (combining marks) so Indic / Arabic vowel signs stay attached
// to their base letter instead of being treated as token boundaries.
const WORD_CHAR = /[\p{L}\p{N}\p{M}_]/u;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

/**
 * Normalize free-text search input.
 *
 *   trim -> NFKC -> lowercase -> punctuation becomes a token boundary
 *   (except an apostrophe or hyphen sitting BETWEEN two letters/numbers,
 *   which is kept so "new year's" / "part-time" stay single tokens) ->
 *   collapse repeated whitespace -> trim.
 *
 * Unicode letters/numbers (Bangla, Arabic, accented Latin, …) are preserved.
 * Nothing is ASCII-folded and diacritics are never stripped.
 */
export const normalizeSearchText = (input: string | null | undefined): string => {
  const source = String(input ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(CURLY_APOSTROPHES, "'");

  let out = "";
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;

    if (WORD_CHAR.test(ch)) {
      out += ch;
      continue;
    }

    if (ch === "'" || ch === "-") {
      const prev = source[i - 1];
      const next = source[i + 1];
      if (prev && next && LETTER_OR_NUMBER.test(prev) && LETTER_OR_NUMBER.test(next)) {
        out += ch;
        continue;
      }
    }

    out += " ";
  }

  return out.replace(/\s+/g, " ").trim();
};

/** Escape every regex metacharacter so `input` is matched literally in a Mongo `$regex`. */
export const escapeSearchRegExp = (input: string): string =>
  input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Split already-normalizable text into normalized whitespace-delimited tokens. */
export const tokenizeSearchText = (input: string | null | undefined): string[] => {
  const normalized = normalizeSearchText(input);
  return normalized ? normalized.split(" ").filter(Boolean) : [];
};

/**
 * Deterministic, bounded morphology variant generator — NO dependency, NO
 * dictionary, NO stemmer. Returns a set of at most 3 strings INCLUDING the
 * original query. Only fires for single-token queries of length >= 4.
 *
 *   partys  -> [partys, party]
 *   events  -> [events, event]
 *   classes -> [classes, class]
 *   parties -> [parties, party]
 *   cities  -> [cities, city]
 *   party   -> [party, parties]   (plural alternate, never replaces the original)
 *
 * No recursion, no combinatorial expansion.
 */
export const createMorphologyVariants = (normalizedQuery: string): string[] => {
  const query = normalizedQuery.trim();
  const variants: string[] = [query];

  const add = (candidate: string) => {
    if (
      candidate.length >= 3 &&
      candidate !== query &&
      !variants.includes(candidate) &&
      variants.length < 3
    ) {
      variants.push(candidate);
    }
  };

  if (query.length < 4 || query.includes(" ") || !/^[\p{L}\p{N}\p{M}_'-]+$/u.test(query)) {
    return variants;
  }

  if (query.endsWith("ies") && query.length >= 5) {
    add(`${query.slice(0, -3)}y`);
  } else if (query.endsWith("es") && query.length >= 5) {
    add(query.slice(0, -2));
    add(query.slice(0, -1));
  } else if (query.endsWith("s") && !query.endsWith("ss")) {
    add(query.slice(0, -1));
  } else if (query.endsWith("y")) {
    add(`${query.slice(0, -1)}ies`);
  }

  return variants;
};

/**
 * Damerau–Levenshtein (optimal string alignment) distance with an early-exit
 * cap. Returns `max + 1` as soon as every cell in a row exceeds `max`, so the
 * caller can treat any value > max as "too far". Pure.
 */
export const damerauLevenshteinDistance = (a: string, b: string, max = Infinity): number => {
  if (a === b) return 0;
  const lenA = a.length;
  const lenB = b.length;
  if (lenA === 0) return lenB;
  if (lenB === 0) return lenA;
  if (Math.abs(lenA - lenB) > max) return max + 1;

  const prevPrev = new Array<number>(lenB + 1).fill(0);
  const prev = new Array<number>(lenB + 1);
  const curr = new Array<number>(lenB + 1);

  for (let j = 0; j <= lenB; j += 1) prev[j] = j;

  for (let i = 1; i <= lenA; i += 1) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= lenB; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        prev[j]! + 1, // deletion
        curr[j - 1]! + 1, // insertion
        prev[j - 1]! + cost, // substitution
      );
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        value = Math.min(value, prevPrev[j - 2]! + 1); // transposition
      }
      curr[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= lenB; j += 1) {
      prevPrev[j] = prev[j]!;
      prev[j] = curr[j]!;
    }
  }

  return prev[lenB]!;
};
