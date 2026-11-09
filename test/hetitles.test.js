// media/hetitles.js: the official Hebrew names from TMDB — what is asked,
// what is kept, what is asked again. TMDB is a stub; the store is in memory.
const test = require("node:test");
const assert = require("node:assert/strict");

const he = require("../src/media/hetitles");
const { useMemory, pick, MISS_TTL, HIT_TTL } = he._internals;

const FIND = {
  tt0241527: { movie_results: [{ title: "הארי פוטר ואבן החכמים", original_title: "Harry Potter and the Philosopher's Stone" }] },
  tt0903747: { movie_results: [], tv_results: [{ name: "שובר שורות", original_name: "Breaking Bad" }] },
  tt11808942: { tv_results: [{ name: "Schmigadoon!", original_name: "Schmigadoon!" }] }, // no Hebrew name: TMDB's English
};
const stubGet = (calls, fail = new Set()) => async (pathname, params) => {
  calls.push({ pathname, params });
  const id = pathname.replace("find/", "");
  if (fail.has(id)) throw new Error("tmdb 503");
  return FIND[id] || { movie_results: [], tv_results: [] };
};

test("pick: the Hebrew name for the kind asked; TMDB's English fallback is not one", () => {
  assert.equal(pick(FIND.tt0241527, "movie"), "הארי פוטר ואבן החכמים");
  assert.equal(pick(FIND.tt0903747, "show"), "שובר שורות");
  assert.equal(pick(FIND.tt0903747, "movie"), "שובר שורות"); // (a film asked, a series found)
  assert.equal(pick(FIND.tt11808942, "show"), null);
  assert.equal(pick({}, "movie"), null);
});

test("ensure: one /find a title in Hebrew; names kept, misses remembered, nothing asked twice", async () => {
  useMemory();
  const calls = [];
  const wants = [{ imdbId: "tt0241527", type: "movie" }, { imdbId: "tt0903747", type: "show" }, { imdbId: "tt11808942", type: "show" }, { imdbId: "tt0241527", type: "movie" }, { imdbId: "bad" }];
  const s0 = he.stamp();
  const r = await he.ensure(wants, { get: stubGet(calls) });
  assert.deepEqual(r, { asked: 3, got: 2, missed: 1, failed: 0 });
  assert.deepEqual(calls.map((c) => c.pathname), ["find/tt0241527", "find/tt0903747", "find/tt11808942"]);
  assert.ok(calls.every((c) => c.params.includes("language=he-IL") && c.params.includes("external_source=imdb_id")));
  assert.equal(he.get("tt0241527"), "הארי פוטר ואבן החכמים");
  assert.equal(he.get("tt0903747"), "שובר שורות");
  assert.equal(he.get("tt11808942"), null);
  assert.notEqual(he.stamp(), s0, "the stamp moves once the round has names (the search rebuilds on it)");
  const again = [];
  const r2 = await he.ensure(wants, { get: stubGet(again) });
  assert.equal(r2.asked, 0);
  assert.equal(again.length, 0);
});

test("a miss is asked again after a month, a name after half a year; a budget caps a round", async () => {
  const store = useMemory();
  const now = Date.now();
  store.data.miss.tt11808942 = now - MISS_TTL - 1000;
  store.data.titles.tt0241527 = { he: "ישן", at: now - HIT_TTL - 1000 };
  store.data.titles.tt0903747 = { he: "שובר שורות", at: now };
  const calls = [];
  await he.ensure([{ imdbId: "tt11808942", type: "show" }, { imdbId: "tt0241527", type: "movie" }, { imdbId: "tt0903747", type: "show" }], { get: stubGet(calls) });
  assert.deepEqual(calls.map((c) => c.pathname).sort(), ["find/tt0241527", "find/tt11808942"]);
  assert.equal(he.get("tt0241527"), "הארי פוטר ואבן החכמים");
  useMemory();
  const capped = [];
  const many = Array.from({ length: 30 }, (_, i) => ({ imdbId: `tt${1000000 + i}`, type: "movie" }));
  const r = await he.ensure(many, { budget: 7, get: stubGet(capped) });
  assert.equal(r.asked, 7);
});

test("TMDB failing: a few failures in a row end the round; nothing is remembered as a miss", async () => {
  useMemory();
  const calls = [];
  const many = Array.from({ length: 20 }, (_, i) => ({ imdbId: `tt${2000000 + i}`, type: "movie" }));
  const r = await he.ensure(many, { get: stubGet(calls, new Set(many.map((w) => w.imdbId))) });
  assert.equal(r.failed, 5);
  assert.equal(calls.length, 5);
  assert.equal(Object.keys(he._internals.open().data.miss).length, 0, "a failure is asked again next round");
});

test("no TMDB key: nothing is asked", async () => {
  useMemory();
  const config = require("../src/config");
  const had = config.TMDB_KEY;
  config.TMDB_KEY = null;
  try {
    const r = await he.ensure([{ imdbId: "tt0241527", type: "movie" }]);
    assert.equal(r.noKey, true);
    assert.equal(r.asked, 0);
  } finally {
    config.TMDB_KEY = had;
  }
});
