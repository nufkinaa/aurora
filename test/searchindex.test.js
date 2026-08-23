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

// ---------- the always-recommend fill (elia: 4–10 when we can) ----------
const { _setEntries } = si._internals;
const mk = (title, year, type, genres, rating, inLibrary = false) =>
  entryForFull({ title, year, type, genres, rating, poster: "/p.jpg", cover: "/c.jpg", imdbId: "tt0" + title.length }, inLibrary);
const entryForFull = si._internals.entryFor;

test("a half-typed year no longer zeroes the query: 'arrival 2'", () => {
  assert.ok(score("arrival 2", "Arrival") >= 80, "year rides along as a word");
});

test("most-of-the-words tier: one dud word doesn't kill the rest", () => {
  _setEntries([mk("Arrival", 2016, "movie", ["Sci-Fi"], 7.9)]);
  const out = si.suggest("arrival zzzz");
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "Arrival");
});

test("related fill: <4 real matches tops up with same-genre picks, labeled", () => {
  _setEntries([
    mk("Arrival", 2016, "movie", ["Sci-Fi", "Drama"], 7.9, true),
    mk("Interstellar", 2014, "movie", ["Sci-Fi"], 8.7),
    mk("Dune", 2021, "movie", ["Sci-Fi"], 8.0),
    mk("Moon", 2009, "movie", ["Sci-Fi"], 7.8),
    mk("Superbad", 2007, "movie", ["Comedy"], 7.6), // shares nothing — stays out
    mk("Severance", 2022, "show", ["Sci-Fi"], 8.7), // wrong type for the anchor
  ]);
  const out = si.suggest("arrival");
  assert.equal(out[0].title, "Arrival");
  assert.ok(!out[0].relatedTo, "the real match is not labeled related");
  const related = out.slice(1);
  assert.ok(related.length >= 3, "filled to at least 4 total");
  assert.ok(related.every((s) => s.relatedTo === "Arrival"), "fill rows carry the label");
  assert.ok(related.every((s) => s.type === "movie"), "fill stays the anchor's kind");
  assert.equal(related[0].title, "Interstellar", "best-rated shared-genre first");
  assert.ok(!out.some((s) => s.title === "Superbad"), "no shared genre → no fill");
});

test("suggest type filter: the Shows page never suggests a movie", () => {
  _setEntries([
    mk("Arrival", 2016, "movie", ["Sci-Fi"], 7.9),
    mk("Dark", 2017, "show", ["Sci-Fi"], 8.7),
  ]);
  assert.deepEqual(si.suggest("ar", { type: "show" }).map((s) => s.title), ["Dark"]);
});

test("suggest caps at 10 even when asked for more", () => {
  _setEntries(Array.from({ length: 30 }, (_, i) => mk("Star Movie " + i, 2000 + i, "movie", ["Action"], 5)));
  assert.ok(si.suggest("star", { limit: 99 }).length <= 10);
});

test("a bare digit prefix never matches the catalog through years", () => {
  // the year token joins word matching ONLY alongside a real word — "20"
  // alone must not score every 20xx title at tier 80
  assert.equal(score("20", "Arrival"), 0);
  _setEntries([
    mk("Arrival", 2016, "movie", ["Sci-Fi"], 7.9),
    mk("Dune", 2021, "movie", ["Sci-Fi"], 8.0),
    mk("2012", 2009, "movie", ["Action"], 5.8), // digit TITLE still findable
  ]);
  assert.deepEqual(si.suggest("20").map((s) => s.title), ["2012"]);
});

test("limit truncation of plentiful matches never triggers the related fill", () => {
  _setEntries(Array.from({ length: 12 }, (_, i) => mk("Star Movie " + i, 2000 + i, "movie", ["Action"], 5)));
  const out = si.suggest("star", { limit: 2 });
  assert.equal(out.length, 2, "exactly the asked-for count");
  assert.ok(out.every((s) => !s.relatedTo), "no fabricated related rows");
});

test("the related fill respects a small limit", () => {
  _setEntries([
    mk("Arrival", 2016, "movie", ["Sci-Fi"], 7.9),
    mk("Interstellar", 2014, "movie", ["Sci-Fi"], 8.7),
    mk("Dune", 2021, "movie", ["Sci-Fi"], 8.0),
    mk("Moon", 2009, "movie", ["Sci-Fi"], 7.8),
  ]);
  assert.ok(si.suggest("arrival", { limit: 2 }).length <= 2);
});

test("garbage still returns nothing — no anchor, no fill", () => {
  _setEntries([mk("Arrival", 2016, "movie", ["Sci-Fi"], 7.9)]);
  assert.equal(si.suggest("zzqqxxy").length, 0);
});
