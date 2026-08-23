// The library ↔ stream identity matcher. STRICTNESS is the contract: a
// duplicate card beats a wrong merge, so every ambiguous case must refuse.
const test = require("node:test");
const assert = require("node:assert");

const identity = require("../src/media/identity");
const { titlesMatch } = identity._internals;

test("exact title, agreeing years, matches", () => {
  assert.ok(titlesMatch("Arrival", 2016, "Arrival", 2016));
  assert.ok(titlesMatch("Arrival", 2016, "arrival", 2017)); // ±1 tolerance
});

test("exact title with a missing year on either side still matches", () => {
  assert.ok(titlesMatch("Arrival", null, "Arrival", 2016));
  assert.ok(titlesMatch("Arrival", 2016, "Arrival", null));
});

test("same title, CONTRADICTING years, refuses — Dune 1984 is not Dune 2021", () => {
  assert.ok(!titlesMatch("Dune", 1984, "Dune", 2021));
});

test("punctuation and case are not load-bearing", () => {
  assert.ok(titlesMatch("Honey Don't!", 2025, "honey dont", 2025));
});

test("prefix match needs BOTH years, within one", () => {
  // folder junk words: "Avatar Movie" is Avatar when the year agrees
  assert.ok(titlesMatch("Avatar Movie", 2009, "Avatar", 2009));
  assert.ok(!titlesMatch("Avatar Movie", null, "Avatar", 2009)); // year missing → refuse
  assert.ok(!titlesMatch("Alien", 1979, "Alien Romulus", 2024)); // years disagree
});

test("prefix without year agreement never merges franchise siblings", () => {
  assert.ok(!titlesMatch("Alien", null, "Alien Resurrection", null));
});

test("empty titles never match anything", () => {
  assert.ok(!titlesMatch("", 2020, "Arrival", 2020));
  assert.ok(!titlesMatch("Arrival", 2020, "  !!  ", 2020));
});

// ---------- findLibraryFor over precomputed maps (the perf-fixed fast path
// must keep byte-identical MATCHING behavior to titlesMatch) ----------
const { libraryMaps } = identity._internals;
const FAKE_LIB = [
  { id: "m1", type: "movie", title: "Arrival", year: 2016 },
  { id: "m2", type: "movie", title: "Avatar Movie", year: 2009 },
  { id: "m3", type: "movie", title: "Dune", year: 1984 },
  { id: "s1", type: "show", title: "Arrival", year: 2016 },
];
const maps = libraryMaps(FAKE_LIB);
const find = (q) => identity.findLibraryFor(q, maps);

test("findLibraryFor: exact title, missing query year, right type", () => {
  assert.equal(find({ type: "movie", title: "arrival" })?.id, "m1");
  assert.equal(find({ type: "series", title: "Arrival" })?.id, "s1");
});

test("findLibraryFor: contradicting years refuse (Dune 1984 ≠ Dune 2021)", () => {
  assert.equal(find({ type: "movie", title: "Dune", year: 2021 }), null);
  assert.equal(find({ type: "movie", title: "Dune", year: 1985 })?.id, "m3");
});

test("findLibraryFor: prefix rule needs BOTH years within one", () => {
  assert.equal(find({ type: "movie", title: "Avatar", year: 2009 })?.id, "m2");
  assert.equal(find({ type: "movie", title: "Avatar" }), null); // no year → no prefix walk
  assert.equal(find({ type: "movie", title: "Avatar", year: 2022 }), null);
});

test("a Hebrew-titled library item never prefix-matches an English query", () => {
  // norm() here is ASCII-only, so a Hebrew title norms to "" — and an empty
  // string prefix-matches everything. The pool must exclude it.
  const heb = libraryMaps([{ id: "heb1", type: "movie", title: "מבצע סבתא", year: 2024 }]);
  assert.equal(identity.findLibraryFor({ type: "movie", title: "Wicked", year: 2024 }, heb), null);
});

test("findLibraryFor: imdbId hit is authoritative", () => {
  const withImdb = { ...maps, byImdb: new Map([["tt2543164", FAKE_LIB[0]]]) };
  assert.equal(
    identity.findLibraryFor({ imdbId: "tt2543164", type: "movie", title: "Wrong Title" }, withImdb)?.id,
    "m1",
  );
});
