// The fuzzy search scoring — every case here was a MEASURED zero-result
// failure before (findings/search.md).
const test = require("node:test");
const assert = require("node:assert");

const si = require("../src/media/searchindex");
const { norm, editWithin, fuzzyWordMatch, scoreTitle, entryFor } = si._internals;

const entry = (title, year = 2020) => entryFor({ title, year, type: "movie" }, true);
const score = (q, title) => {
  const nq = norm(q);
  return scoreTitle(nq, nq.split(" ").filter(Boolean), entry(title));
};

test("exact and prefix tiers outrank everything", () => {
  assert.equal(score("arrival", "Arrival"), 100);
  assert.equal(score("arr", "Arrival"), 90);
});

test("'arival' (typo) finds Arrival — the bug that hid owned titles", () => {
  assert.ok(score("arival", "Arrival") >= 55);
});

test("'intersteller' finds Interstellar (edit distance 2 on a long word)", () => {
  assert.ok(score("intersteller", "Interstellar") >= 55);
});

test("punctuation is no longer load-bearing: 'honey dont' finds Honey Don't!", () => {
  assert.ok(score("honey dont", "Honey Don't!") >= 55);
});

test("word-start queries match out of order: 'thursday club'", () => {
  assert.ok(score("thursday club", "The Thursday Murder Club") >= 80);
});

test("transposed letters match: 'murders in teh building'", () => {
  assert.ok(score("murders in teh building", "Only Murders in the Building") >= 55);
});

test("short words get NO fuzzy budget — 'dune' must not match 'duel'", () => {
  assert.equal(score("dune", "Duel"), 0);
});

test("3-letter words: transposition-only tolerance", () => {
  assert.ok(score("teh office", "The Office") >= 55); // teh → the (swap)
  assert.equal(score("man", "Men"), 0); // substitution at length 3 = noise
  assert.equal(score("man", "Main"), 0); // insertion at length 3 = noise
});

test("unrelated titles score zero", () => {
  assert.equal(score("arrival", "Inception"), 0);
});

test("hebrew queries survive normalization instead of collapsing to empty", () => {
  assert.equal(norm("הסופרנוס!"), "הסופרנוס");
  assert.ok(norm("הסופרנוס").length > 0);
});

test("editWithin: bounds, transposition, and budget honesty", () => {
  assert.ok(editWithin("teh", "the", 1)); // transposition = 1
  assert.ok(!editWithin("dune", "duel", 1)); // that's 2 edits
  assert.ok(!editWithin("abc", "abcdef", 1)); // length gap beats budget
});
