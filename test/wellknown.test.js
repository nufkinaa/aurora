// The well-known titles (src/media/wellknown.js): the catalogue's popularity
// list kept on disk for the search. The fetching is stubbed; nothing here
// touches the network or the real file.
const test = require("node:test");
const assert = require("node:assert/strict");
const wk = require("../src/media/wellknown");
const { fromMeta, useStore } = wk._internals;

const meta = (i, type) => ({ id: `tt${String(1000000 + i)}`, name: `${type} ${i}`, poster: "https://p/x.jpg", releaseInfo: "2001–2005", imdbRating: "7.5", genres: ["Drama", "Crime"], cast: ["A One", "B Two", "C Three", "D Four", "E Five"], director: ["Dee Rector"] });
const memory = (data = { v: 1, at: 0, tried: 0, titles: [] }) => {
  const s = { data, saves: 0, save() { this.saves++; } };
  useStore(s);
  return s;
};
const pages = (perType) => async (type, skip) => {
  const n = perType[type] || 0;
  return Array.from({ length: Math.max(0, Math.min(50, n - skip)) }, (_, i) => meta((type === "movie" ? 0 : 500000) + skip + i, type));
};

test("a catalogue entry becomes a compact card with its place in the list", () => {
  assert.deepEqual(fromMeta(meta(7, "movie"), "movie", 42), {
    imdbId: "tt1000007", type: "movie", title: "movie 7", year: 2001, poster: "https://p/x.jpg", rating: 7.5,
    genres: ["Drama", "Crime"], cast: ["A One", "B Two", "C Three", "D Four"], director: ["Dee Rector"], k: 42,
  });
  assert.equal(fromMeta(meta(7, "series"), "series", 0).type, "show");
  assert.equal(fromMeta({ id: "kitsu:1", name: "x", poster: "p" }, "movie", 0), null, "no IMDb id: nothing the app can open");
  assert.equal(fromMeta({ id: "tt1", name: "x" }, "movie", 0), null, "no poster");
});

test("refresh keeps both lists in the catalogue's order, and the stamp changes when they do", async () => {
  const s = memory();
  assert.equal(wk.due(), true);
  const before = wk.stamp();
  const n = await wk.refresh({ pause: 0, depth: { movie: 300, series: 200 }, fetchPage: pages({ movie: 260, series: 500 }) });
  assert.equal(n, 460, "260 films (the list ended), then the first 200 series");
  const all = wk.all();
  assert.deepEqual([all[0].title, all[0].k, all[259].k, all[260].type, all[260].k, all[459].k], ["movie 0", 0, 259, "show", 0, 199]);
  assert.notEqual(wk.stamp(), before);
  assert.equal(wk.due(), false, "fresh for a week");
  assert.ok(s.saves >= 1);
});

test("a round that comes back thin (offline, the catalogue down) never replaces a good file, and is not retried at once", async () => {
  const s = memory();
  await wk.refresh({ pause: 0, depth: { movie: 300, series: 200 }, fetchPage: pages({ movie: 300, series: 200 }) });
  const at = s.data.at;
  s.data.at = Date.now() - 8 * 24 * 3600 * 1000; // a week old: due again
  s.data.tried = 0;
  assert.equal(wk.due(), true);
  const n = await wk.refresh({ pause: 0, depth: { movie: 300, series: 200 }, fetchPage: async () => { throw new Error("offline"); } });
  assert.equal(n, 500, "the old list stands");
  assert.ok(s.data.at < at);
  assert.equal(wk.due(), false, "tried just now: not again for a few hours");
  // an empty store offline: nothing, and no crash
  memory();
  assert.equal(await wk.refresh({ pause: 0, fetchPage: async () => [] }), 0);
  assert.deepEqual(wk.all(), []);
});
