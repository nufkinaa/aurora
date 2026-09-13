// One history per TITLE. Progress is keyed by what was played (library id,
// torrent file, hand-ticked stream key); the title rows fold them into the
// IMDb identity, and reads materialize library ids back out of that. Pure
// halves with an injected key resolver — profiles.json is never touched.
const test = require("node:test");
const assert = require("node:assert");

const profiles = require("../src/profiles");
const identity = require("../src/media/identity");
const { foldTitles, materializeProgress, clearTitle } = profiles._internals;

// A fake library: episode ep101 is S1E1 of tt1; movie mv1 is tt2.
const titleKeys = new Map([["ep101", "tt1:1:1"], ["ep102", "tt1:1:2"], ["mv1", "tt2"]]);
const keyFor = (itemId, meta) => {
  if (itemId.startsWith("torrent|") || itemId.startsWith("stream|")) return identity.titleKeyFor(itemId, meta);
  return titleKeys.get(itemId) || null;
};

const mkState = () => ({
  progress: {
    "torrent|abc|0": { position: 600, duration: 1400, finished: false, updatedAt: 1000 },
    "torrent|def|3": { position: 5000, duration: 5400, finished: true, updatedAt: 900 },
    "torrent|zzz|0": { position: 100, duration: 1400, finished: false, updatedAt: 800 },
    "stream|tt7|2|5": { position: 0, duration: 0, finished: true, updatedAt: 700 },
  },
  streamItems: {
    "torrent|abc|0": { imdbId: "tt1", season: 1, episode: 1, title: "Show · S1 E1" },
    "torrent|def|3": { imdbId: "tt2", title: "Film" },
    "torrent|zzz|0": { title: "no id known" },
  },
  titles: {},
});

test("titleKeyFor: torrent meta and stream keys name their title; specials keep season 0", () => {
  assert.equal(identity.titleKeyFor("torrent|x|0", { imdbId: "tt1", season: 1, episode: 4 }), "tt1:1:4");
  assert.equal(identity.titleKeyFor("torrent|x|0", { imdbId: "tt1", season: 0, episode: 2 }), "tt1:0:2");
  assert.equal(identity.titleKeyFor("torrent|x|0", { imdbId: "tt2" }), "tt2");
  assert.equal(identity.titleKeyFor("torrent|x|0", { title: "no id" }), null);
  assert.equal(identity.titleKeyFor("stream|tt7|2|5"), "tt7:2:5");
  assert.equal(identity.titleKeyFor("stream|tt7"), "tt7");
});

test("fold: every resolvable row lands under its title, newest wins, unknowns are left alone", () => {
  const state = mkState();
  assert.equal(foldTitles(state, keyFor), true);
  assert.deepEqual(Object.keys(state.titles).sort(), ["tt1:1:1", "tt2", "tt7:2:5"]);
  assert.equal(state.titles["tt1:1:1"].position, 600);
  assert.equal(state.titles["tt1:1:1"].itemId, "torrent|abc|0");
  // a second fold is a no-op
  assert.equal(foldTitles(state, keyFor), false);
});

test("fold: an older alias never overwrites a fresher title row", () => {
  const state = mkState();
  state.titles["tt1:1:1"] = { position: 900, duration: 1400, finished: false, updatedAt: 2000, itemId: "ep101" };
  foldTitles(state, keyFor);
  assert.equal(state.titles["tt1:1:1"].position, 900);
});

test("materialize: the library copy of a streamed title shows the stream's position", () => {
  const state = mkState();
  foldTitles(state, keyFor);
  const view = materializeProgress(state, titleKeys);
  assert.deepEqual(view.ep101, { position: 600, duration: 1400, finished: false, updatedAt: 1000 });
  assert.deepEqual(view.mv1, { position: 5000, duration: 5400, finished: true, updatedAt: 900 });
  assert.equal(view.ep102, undefined); // never watched anywhere
  assert.ok(view["torrent|abc|0"]);    // raw rows survive
  assert.deepEqual(state.progress.ep101, undefined); // read-only: nothing written back
});

test("materialize: a fresher watch of the file itself wins over the title row", () => {
  const state = mkState();
  foldTitles(state, keyFor);
  state.progress.ep101 = { position: 900, duration: 1400, finished: false, updatedAt: 3000 };
  const view = materializeProgress(state, titleKeys);
  assert.equal(view.ep101.position, 900);
});

test("clear: dismissing the library card clears the title and every alias — nothing comes back", () => {
  const state = mkState();
  foldTitles(state, keyFor);
  clearTitle(state, "ep101", keyFor);
  assert.equal(state.titles["tt1:1:1"], undefined);
  assert.equal(state.progress["torrent|abc|0"], undefined);
  assert.equal(state.streamItems["torrent|abc|0"], undefined);
  assert.equal(materializeProgress(state, titleKeys).ep101, undefined);
  // unrelated rows untouched
  assert.ok(state.progress["torrent|def|3"]);
  assert.ok(state.titles["tt2"]);
});

test("clear: a row with no known identity clears just itself", () => {
  const state = mkState();
  foldTitles(state, keyFor);
  clearTitle(state, "torrent|zzz|0", keyFor);
  assert.equal(state.progress["torrent|zzz|0"], undefined);
  assert.equal(Object.keys(state.titles).length, 3);
});
