import assert from "node:assert/strict";
import test from "node:test";
import {
  createMorphologyVariants,
  damerauLevenshteinDistance,
  escapeSearchRegExp,
  normalizeSearchText,
  tokenizeSearchText,
} from "../src/core/utils/search-text.js";

// --- normalizeSearchText: case-insensitive -----------------------------------

test("case variants normalize to the same token", () => {
  const forms = ["party", "PARTY", "Party", "PaRtY"];
  const normalized = new Set(forms.map((form) => normalizeSearchText(form)));
  assert.deepEqual([...normalized], ["party"]);
});

// --- normalizeSearchText: punctuation --------------------------------------

test("surrounding punctuation becomes a token boundary", () => {
  for (const q of ["party!", "party?", "party.", "party,", '"party"', "(party)", "  party  "]) {
    assert.equal(normalizeSearchText(q), "party", q);
  }
  assert.equal(normalizeSearchText("party, night"), "party night");
});

test("meaningful inner punctuation is preserved as one token", () => {
  assert.equal(normalizeSearchText("New Year's"), "new year's");
  assert.equal(normalizeSearchText("part-time"), "part-time");
  assert.equal(normalizeSearchText("party_night"), "party_night");
});

test("punctuation-only / whitespace-only input normalizes to empty", () => {
  for (const q of [".", "...", "!!!", "---", "()", "   ", "#", "##", " # "]) {
    assert.equal(normalizeSearchText(q), "", JSON.stringify(q));
  }
});

// --- normalizeSearchText: Unicode ----------------------------------------

test("Unicode letters are preserved; NFKC compatibility forms fold; diacritics are NOT stripped", () => {
  assert.equal(normalizeSearchText("ｐａｒｔｙ"), "party"); // fullwidth -> ascii via NFKC
  assert.equal(normalizeSearchText("Ⅳ"), "iv"); // roman numeral compatibility fold
  assert.equal(normalizeSearchText("Café"), "café"); // é kept, not folded to e
  assert.equal(normalizeSearchText("পার্টি"), "পার্টি"); // Bangla preserved
  assert.equal(normalizeSearchText("حفلة"), "حفلة"); // Arabic preserved
});

// --- escapeSearchRegExp -------------------------------------------------

test("escapeSearchRegExp neutralizes every regex metacharacter", () => {
  assert.equal(escapeSearchRegExp(".*+?^${}()|[]\\"), "\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\");
  assert.equal(escapeSearchRegExp("party?"), "party\\?");
});

// --- tokenizeSearchText ------------------------------------------------

test("tokenizeSearchText splits on normalized whitespace only", () => {
  assert.deepEqual(tokenizeSearchText("Party Night!"), ["party", "night"]);
  assert.deepEqual(tokenizeSearchText("part-time event"), ["part-time", "event"]);
});

// --- createMorphologyVariants ----------------------------------------

test("morphology variants: bounded, <=3 including original, no recursion", () => {
  assert.deepEqual(createMorphologyVariants("partys"), ["partys", "party"]);
  assert.deepEqual(createMorphologyVariants("events"), ["events", "event"]);
  assert.deepEqual(createMorphologyVariants("classes"), ["classes", "class", "classe"]);
  assert.deepEqual(createMorphologyVariants("parties"), ["parties", "party"]);
  assert.deepEqual(createMorphologyVariants("cities"), ["cities", "city"]);
  for (const q of ["partys", "classes", "parties"]) {
    assert.ok(createMorphologyVariants(q).length <= 3);
  }
});

test("morphology variants: query shorter than 4 chars gets no expansion", () => {
  assert.deepEqual(createMorphologyVariants("pa"), ["pa"]);
  assert.deepEqual(createMorphologyVariants("par"), ["par"]);
  assert.deepEqual(createMorphologyVariants("cts"), ["cts"]);
});

test("morphology variants: 'y' plural alternate never replaces the original", () => {
  const variants = createMorphologyVariants("party");
  assert.equal(variants[0], "party");
  assert.ok(variants.includes("parties"));
  assert.ok(variants.length <= 3);
});

test("morphology variants: multi-word queries are left alone", () => {
  assert.deepEqual(createMorphologyVariants("summer parties"), ["summer parties"]);
});

// --- damerauLevenshteinDistance -------------------------------------

test("damerauLevenshteinDistance: substitution / deletion / insertion / transposition = 1", () => {
  assert.equal(damerauLevenshteinDistance("party", "party"), 0);
  assert.equal(damerauLevenshteinDistance("party", "parts"), 1); // substitution
  assert.equal(damerauLevenshteinDistance("party", "paty"), 1); // deletion
  assert.equal(damerauLevenshteinDistance("party", "partyx"), 1); // insertion
  assert.equal(damerauLevenshteinDistance("party", "praty"), 1); // transposition
  assert.equal(damerauLevenshteinDistance("party", "depart"), 3);
  assert.ok(damerauLevenshteinDistance("party", "counterparty") >= 7);
});

test("damerauLevenshteinDistance: early-exit cap returns max+1 when exceeded", () => {
  assert.equal(damerauLevenshteinDistance("party", "counterparty", 1), 2);
  assert.equal(damerauLevenshteinDistance("pxyzty", "party", 1), 2);
});
