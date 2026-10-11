// identity.libraryMaps() for the whole library is built once and kept until
// the library or the IMDb-id cache changes (media/identity.js). What it
// answers — and what findLibraryFor / markLibrary answer through it — must be
// what a fresh build answers, at every moment.
const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert");

const scanner = require("../src/media/scanner");
const imdb = require("../src/media/imdb");
const identity = require("../src/media/identity");
const { libraryMaps } = identity._internals;

const saved = { movies: scanner.index.movies, shows: scanner.index.shows, cachedIdFor: imdb.cachedIdFor, version: imdb.version };
// The IMDb-id cache, stood in for (the real one is a file under data/): ids
// by "type|title|year", and the version that moves on every write.
const ids = new Map();
let idsVersion = 1000;
imdb.cachedIdFor = (title, type, year) => ids.get(`${type}|${title}|${year || ""}`) || null;
imdb.version = () => idsVersion;
const learn = (title, type, year, id) => { ids.set(`${type}|${title}|${year || ""}`, id); idsVersion++; };
after(() => {
  scanner.index.movies = saved.movies;
  scanner.index.shows = saved.shows;
  imdb.cachedIdFor = saved.cachedIdFor;
  imdb.version = saved.version;
});

const film = (id, title, year) => ({ id, type: "movie", title, year });
const show = (id, title, year) => ({ id, type: "show", title, year, seasons: [] });
// maps -> something comparable (Maps of library ids)
const shape = (m) => ({
  byImdb: [...m.byImdb].map(([k, v]) => [k, v.id]),
  byTitle: [...m.byTitle].map(([k, v]) => [k, v.map((x) => x.id)]),
  pools: { movie: m.pools.movie.map((x) => [x.nt, x.item.id]), show: m.pools.show.map((x) => [x.nt, x.item.id]) },
});

beforeEach(() => {
  scanner.index.movies = [film("m1", "Arrival", 2016), film("m2", "Dune", 1984), film("m3", "Avatar Movie", 2009)];
  scanner.index.shows = [show("s1", "Arrival", 2016)];
});

test("asked twice, built once — and it is what a fresh build of the same library gives", () => {
  const a = libraryMaps();
  assert.equal(libraryMaps(), a, "the same maps while nothing changed");
  assert.equal(libraryMaps(undefined), a, "an explicit undefined is the whole library too, as before");
  assert.deepEqual(shape(a), shape(libraryMaps(scanner.allItems())));
  assert.deepEqual(shape(a).byTitle, [["arrival", ["m1", "s1"]], ["dune", ["m2"]], ["avatar movie", ["m3"]]]);
});

test("a list handed in is never the kept one, and never becomes it", () => {
  const whole = libraryMaps();
  const own = libraryMaps([film("x1", "Only This", 2001)]);
  assert.notEqual(own, whole);
  assert.deepEqual(shape(own).byTitle, [["only this", ["x1"]]]);
  assert.equal(libraryMaps(), whole);
  assert.notEqual(libraryMaps(scanner.allItems()), whole, "even the same items, handed in, are built afresh");
});

test("a new library index is new maps", () => {
  const before = libraryMaps();
  scanner.index.movies = [...scanner.index.movies, film("m4", "Sicario", 2015)];
  const after1 = libraryMaps();
  assert.notEqual(after1, before);
  assert.equal(identity.findLibraryFor({ type: "movie", title: "Sicario", year: 2015 }).id, "m4");
  scanner.index.shows = [];
  assert.equal(identity.findLibraryFor({ type: "series", title: "Arrival" }), null, "the show left with its index");
  assert.equal(identity.findLibraryFor({ type: "movie", title: "Arrival" }).id, "m1");
  // added in place (tests do this): seen as well
  scanner.index.shows.push(show("s2", "Severance", 2022));
  assert.equal(identity.findLibraryFor({ type: "series", title: "Severance" }).id, "s2");
});

test("an IMDb id learnt later is in the maps from then on", () => {
  assert.equal(identity.findLibraryFor({ imdbId: "tt2543164", type: "movie" }), null);
  const before = libraryMaps();
  learn("Arrival", "movie", 2016, "tt2543164");
  const now = libraryMaps();
  assert.notEqual(now, before, "the id cache moved: rebuilt");
  assert.equal(identity.findLibraryFor({ imdbId: "tt2543164", type: "movie" }).id, "m1");
  assert.equal(libraryMaps(), now);
});

test("findLibraryFor and markLibrary answer the same with the kept maps as with fresh ones", () => {
  const queries = [
    { type: "movie", title: "arrival" }, { type: "series", title: "Arrival", year: 2016 }, { type: "movie", title: "Dune", year: 2021 },
    { type: "movie", title: "Dune", year: 1984 }, { type: "movie", title: "Avatar", year: 2009 }, { type: "movie", title: "Avatar" },
    { type: "movie", title: "Nope", year: 2022 }, { type: "movie", title: "" }, {},
  ];
  for (let round = 0; round < 2; round++) {
    for (const q of queries) {
      const kept = identity.findLibraryFor(q);
      const fresh = identity.findLibraryFor(q, libraryMaps(scanner.allItems()));
      assert.equal(kept, fresh, JSON.stringify(q));
    }
  }
  const cards = queries.map((q) => ({ ...q }));
  identity.markLibrary(cards);
  assert.deepEqual(cards.map((c) => c.inLibrary), ["m1", "s1", null, "m2", "m3", null, null, null, null]);
});
