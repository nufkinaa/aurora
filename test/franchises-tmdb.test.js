// TMDB collections as franchises (src/media/franchises/tmdb.js), with TMDB
// made up: the collection's parts in release order with IMDb ids, films not
// out yet left out, "… Collection" off the name, the title → collection
// answer cached (an empty one too), an old answer kept when TMDB fails, and
// nothing asked at all without a key.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.TMDB_API_KEY = "made-up";
const calls = [];
let failing = false;
const fakeSimilar = {
  tmdb: async (p) => {
    calls.push(p);
    if (failing) throw new Error("tmdb 503");
    if (p === "collection/10") {
      return { name: "Test Saga Collection", parts: [
        { id: 2, title: "Two", release_date: "2003-01-01", poster_path: "/2.jpg" },
        { id: 1, title: "One", release_date: "2001-01-01", poster_path: "/1.jpg" },
        { id: 3, title: "Three", release_date: "2999-01-01", poster_path: "/3.jpg" },
        { id: 4, title: "No date" },
      ] };
    }
    if (p === "movie/77") return { belongs_to_collection: null };
    throw Object.assign(new Error("not found"), { status: 404 });
  },
  addImdbIds: async (items) => items.map((it) => ({ ...it, imdbId: `tt000000${it.tmdbId}` })),
  collection: async (type, imdbId) => (imdbId === "tt0000001" || imdbId === "tt0000002" ? { collection: { id: 10, name: "Test Saga Collection", items: [] } } : { collection: null }),
  _internals: { tmdbIdFor: async (imdbId) => (imdbId === "tt0000077" ? 77 : null) },
};
const simPath = require.resolve("../src/media/similar");
require.cache[simPath] = { id: simPath, filename: simPath, loaded: true, exports: fakeSimilar };

const tmdb = require("../src/media/franchises/tmdb");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-fr-tmdb-"));
tmdb._internals.useFile(path.join(dir, "franchise-tmdb.json"));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("a film's TMDB collection is a franchise: released parts in release order, named without 'Collection'", async () => {
  const fr = await tmdb.forTitle("tt0000002");
  assert.equal(fr.id, "tmdb-10");
  assert.equal(fr.name, "Test Saga");
  assert.equal(fr.the, false);
  assert.equal(fr.source, "tmdb");
  assert.deepEqual(fr.orders.release.map((e) => e.imdbId), ["tt0000001", "tt0000002"], "the unreleased and the undated are left out");
  assert.equal(fr.orders.release[0].poster, "https://image.tmdb.org/t/p/w342/1.jpg");
  assert.equal(fr.orders.release[0].date, "2001-01-01");
});

test("cached: the next ask, and the sync read Home uses, cost no TMDB call", async () => {
  calls.length = 0;
  assert.equal((await tmdb.forTitle("tt0000001")).id, "tmdb-10");
  assert.equal(tmdb.cachedFor("tt0000002").id, "tmdb-10");
  assert.deepEqual(calls, []);
  assert.equal((await tmdb.collection(10)).name, "Test Saga");
});

test("a film in no collection is remembered as such; one TMDB cannot place is not", async () => {
  calls.length = 0;
  assert.equal(await tmdb.forTitle("tt0000077"), null);
  assert.deepEqual(calls, ["movie/77"]);
  calls.length = 0;
  assert.equal(await tmdb.forTitle("tt0000077"), null);
  assert.deepEqual(calls, [], "the empty answer is kept a day");
  assert.equal(tmdb.cachedFor("tt0000077"), null);
});

test("TMDB failing: an old collection is still the answer", async () => {
  const hit = tmdb._internals.db().data.colls[10];
  hit.at = 0; // a month old
  failing = true;
  try {
    assert.equal((await tmdb.collection(10)).id, "tmdb-10");
  } finally {
    failing = false;
  }
  assert.equal(await tmdb.collection("nonsense"), null);
});

test("the names", () => {
  assert.equal(tmdb.cleanName("The Matrix Collection"), "The Matrix");
  assert.equal(tmdb.cleanName("Paddington Collection"), "Paddington");
  assert.equal(tmdb.cleanName("Toy Story"), "Toy Story");
});
