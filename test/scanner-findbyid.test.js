// scanner.findById answers from a map built once per library index instead
// of walking the whole library per id (media/scanner.js, lookupMap). It must
// answer exactly what the walk answered — pinned here against the walk
// itself, copied from 1.6.92.
const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert");

const scanner = require("../src/media/scanner");

// the old implementation, word for word
const walk = (index, id) => {
  for (const m of index.movies) if (m.id === id) return m;
  for (const s of index.shows) {
    if (s.id === id) return s;
    for (const season of s.seasons) {
      for (const ep of season.episodes) {
        if (ep.id === id)
          return { ...ep, showId: s.id, showTitle: s.title, cover: s.cover };
      }
    }
  }
  return null;
};

const saved = { movies: scanner.index.movies, shows: scanner.index.shows };
after(() => { scanner.index.movies = saved.movies; scanner.index.shows = saved.shows; });

const film = (id, title) => ({ id, type: "movie", title, cover: `/img/${id}` });
const ep = (id, season, episode) => ({ id, season, episode, title: `Episode ${episode}`, videoUrl: `/stream/video/${id}` });
const show = (id, title, seasons) => ({ id, type: "show", title, cover: `/img/c-${id}`, seasons: seasons.map(([number, episodes]) => ({ number, episodes })) });

beforeEach(() => {
  scanner.index.movies = [film("m1", "Alpha"), film("m2", "Beta"), film("dup", "A film whose id an episode shares")];
  scanner.index.shows = [
    show("s1", "Gamma", [[1, [ep("e1", 1, 1), ep("e2", 1, 2)]], [2, [ep("e3", 2, 1)]]]),
    show("s2", "Delta", [[1, [ep("e4", 1, 1), ep("dup", 1, 2), ep("s1", 1, 3)]]]),
    show("e1", "A show whose id an earlier episode has", [[1, [ep("e5", 1, 1)]]]),
  ];
});

test("every id answers what the walk answered — films, shows, episodes, and what is not there", () => {
  const ids = ["m1", "m2", "s1", "s2", "e1", "e2", "e3", "e4", "e5", "dup", "nope", "", "torrent|abc|0", undefined, null, 7];
  for (const id of ids) assert.deepEqual(scanner.findById(id), walk(scanner.index, id), `id ${String(id)}`);
});

test("a film and a show are the index's own objects; an episode is a fresh copy carrying its show", () => {
  assert.equal(scanner.findById("m1"), scanner.index.movies[0], "the same object, not a copy");
  assert.equal(scanner.findById("s2"), scanner.index.shows[1]);
  const a = scanner.findById("e3");
  const b = scanner.findById("e3");
  assert.deepEqual(a, { ...scanner.index.shows[0].seasons[1].episodes[0], showId: "s1", showTitle: "Gamma", cover: "/img/c-s1" });
  assert.notEqual(a, b, "callers add fields to what they get: never the shared episode object");
  assert.notEqual(a, scanner.index.shows[0].seasons[1].episodes[0]);
  a.progress = { position: 5 };
  assert.equal(scanner.findById("e3").progress, undefined);
});

test("when one id names two things, the first in library order wins, as before", () => {
  assert.equal(scanner.findById("dup"), scanner.index.movies[2], "a film comes before any episode");
  assert.equal(scanner.findById("s1"), scanner.index.shows[0], "a show comes before a later show's episode");
  assert.equal(scanner.findById("e1").showId, "s1", "an earlier show's episode comes before a later show");
});

test("a new index is a new answer", () => {
  assert.equal(scanner.findById("m9"), null);
  scanner.index.movies = [...scanner.index.movies, film("m9", "Late arrival")];
  assert.equal(scanner.findById("m9").title, "Late arrival");
  scanner.index.shows = [];
  assert.equal(scanner.findById("e1"), null);
  assert.equal(scanner.findById("m1").title, "Alpha");
  // (a test, or anyone, adding to the arrays in place is seen too)
  scanner.index.shows.push(show("s9", "Pushed", [[1, [ep("e9", 1, 1)]]]));
  assert.equal(scanner.findById("e9").showTitle, "Pushed");
  scanner.index.movies.push(film("m10", "Pushed film"));
  assert.equal(scanner.findById("m10").title, "Pushed film");
});

test("a real scan replaces the map with it", () => {
  // (no library folders are configured in the test config: an empty library)
  scanner.scan();
  assert.equal(scanner.findById("m1"), null);
  assert.equal(scanner.findById("e1"), null);
  for (const m of scanner.index.movies) assert.equal(scanner.findById(m.id), m);
});

test("a half-built show (no seasons yet) never breaks a lookup", () => {
  scanner.index.shows = [{ id: "bare", type: "show", title: "Bare" }, ...scanner.index.shows];
  assert.equal(scanner.findById("bare").title, "Bare");
  assert.equal(scanner.findById("m2").title, "Beta");
  assert.equal(scanner.findById("e4").showId, "s2");
});
