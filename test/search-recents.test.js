// Recent searches, kept per profile on the server (src/profiles.js): the pure
// halves over one profile's state.
const test = require("node:test");
const assert = require("node:assert/strict");
const { noteSearch, dropSearch } = require("../src/profiles")._internals;

const qs = (s) => s.searches.map((x) => x.q);

test("newest first, one entry per query whatever its capitals, twelve at most", () => {
  const s = {};
  let now = 1_000_000;
  for (const q of ["Dune", "arrival", "DUNE", "  the   office "]) noteSearch(s, q, (now += 120000));
  assert.deepEqual(qs(s), ["the office", "DUNE", "arrival"]);
  for (let i = 0; i < 20; i++) noteSearch(s, `title ${i}`, (now += 120000));
  assert.equal(s.searches.length, 12);
  assert.equal(qs(s)[0], "title 19");
});

test("what was typed on the way to a query is replaced by it; an old shorter query is kept", () => {
  const s = {};
  noteSearch(s, "dun", 1000);
  noteSearch(s, "dune", 2000);
  assert.deepEqual(qs(s), ["dune"]);
  noteSearch(s, "dune part two", 2000 + 5 * 60000); // minutes later: a search of its own
  assert.deepEqual(qs(s), ["dune part two", "dune"]);
});

test("too short, empty or not a string: not remembered; long ones are cut", () => {
  const s = {};
  for (const q of ["", " ", "a", null, undefined]) assert.equal(noteSearch(s, q, 1), false);
  assert.deepEqual(s.searches || [], []);
  noteSearch(s, "x".repeat(300), 1);
  assert.equal(s.searches[0].q.length, 80);
});

test("remove one (any capitals), or clear them all", () => {
  const s = {};
  let now = 0;
  for (const q of ["Dune", "Arrival", "Troy"]) noteSearch(s, q, (now += 120000));
  dropSearch(s, "arrival");
  assert.deepEqual(qs(s), ["Troy", "Dune"]);
  dropSearch(s, "nothing like it");
  assert.deepEqual(qs(s), ["Troy", "Dune"]);
  dropSearch(s, null);
  assert.deepEqual(qs(s), []);
});
