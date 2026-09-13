// A title watched as a torrent stream and downloaded afterwards: its history
// must move onto the library file, or Continue Watching keeps pointing at the
// torrent and "play my downloaded episode" goes hunting for peers. Pure over a
// profile state object with an injected resolver — profiles.json is untouched.
const test = require("node:test");
const assert = require("node:assert");

const profiles = require("../src/profiles");
const { adoptStreamProgress } = profiles._internals;

const EP = { id: "ep101", type: undefined, showId: "sh1", episode: 1 };
const MOVIE = { id: "mv1", type: "movie" };
const find = (meta) =>
  meta.imdbId === "tt1" && meta.season === 1 && meta.episode === 1
    ? EP
    : meta.imdbId === "tt2"
      ? MOVIE
      : null;

const mkState = () => ({
  progress: {
    "torrent|abc|0": { position: 600, duration: 1400, finished: false, updatedAt: 1000 },
    "torrent|def|3": { position: 5000, duration: 5400, finished: true, updatedAt: 900 },
    "torrent|zzz|0": { position: 100, duration: 1400, finished: false, updatedAt: 800 },
  },
  streamItems: {
    "torrent|abc|0": { imdbId: "tt1", season: 1, episode: 1, title: "Show · S1 E1" },
    "torrent|def|3": { imdbId: "tt2", title: "Film" },
    "torrent|zzz|0": { imdbId: "tt9", season: 1, episode: 1, title: "Not owned" },
  },
});

test("stream history lands on the library copy, unowned streams stay put", () => {
  const state = mkState();
  assert.equal(adoptStreamProgress(state, find), true);
  assert.deepEqual(state.progress.ep101, { position: 600, duration: 1400, finished: false, updatedAt: 1000 });
  assert.deepEqual(state.progress.mv1, { position: 5000, duration: 5400, finished: true, updatedAt: 900 });
  assert.equal(Object.keys(state.progress).length, 5); // nothing invented for tt9
  // the stream entries themselves survive (watched-flags by imdbId still read them)
  assert.ok(state.progress["torrent|abc|0"]);
});

test("idempotent: a second run changes nothing", () => {
  const state = mkState();
  adoptStreamProgress(state, find);
  const snap = JSON.stringify(state);
  assert.equal(adoptStreamProgress(state, find), false);
  assert.equal(JSON.stringify(state), snap);
});

test("a NEWER watch of the file is never overwritten by older stream history", () => {
  const state = mkState();
  state.progress.ep101 = { position: 900, duration: 1400, finished: false, updatedAt: 2000 };
  assert.equal(adoptStreamProgress(state, find), true); // mv1 still adopts
  assert.equal(state.progress.ep101.position, 900);
});

test("a resolver that throws is ignored", () => {
  const state = mkState();
  assert.equal(adoptStreamProgress(state, () => { throw new Error("boom"); }), false);
  assert.equal(Object.keys(state.progress).length, 3);
});

test("dismissing the library card does NOT bring it back on the next pass", () => {
  const state = mkState();
  adoptStreamProgress(state, find);
  delete state.progress.ep101; // what clearProgress(libId) does for the card's X
  assert.equal(adoptStreamProgress(state, find), false);
  assert.equal(state.progress.ep101, undefined);
});

test("…but a stream watched AGAIN after that is handed over afresh", () => {
  const state = mkState();
  adoptStreamProgress(state, find);
  delete state.progress.ep101;
  state.progress["torrent|abc|0"] = { position: 700, duration: 1400, finished: false, updatedAt: 3000 };
  assert.equal(adoptStreamProgress(state, find), true);
  assert.equal(state.progress.ep101.position, 700);
});
