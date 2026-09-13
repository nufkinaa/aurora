// Smart downloads: the rules that decide WHICH episode and WHICH source get
// queued, pinned on the pure halves.
const test = require("node:test");
const assert = require("node:assert");

const { nextEpisode, pickSource, THRESHOLD } = require("../src/media/smartdl")._internals;

const META = {
  seasons: [
    { number: 0, episodes: [{ season: 0, episode: 1, released: "2008-01-01" }] },
    { number: 1, episodes: [
      { season: 1, episode: 1, released: "2008-01-20" },
      { season: 1, episode: 2, released: "2008-01-27" },
    ] },
    { number: 2, episodes: [
      { season: 2, episode: 1, released: "2009-03-08" },
      { season: 2, episode: 2, released: "2999-01-01" }, // not aired yet
    ] },
  ],
};

test("threshold is two-thirds-ish", () => {
  assert.ok(THRESHOLD >= 0.6 && THRESHOLD <= 0.7);
});

test("next episode: same season first, then the next season's first, specials skipped", () => {
  assert.deepEqual(nextEpisode(META, 1, 1).episode, 2);
  assert.equal(nextEpisode(META, 1, 2).season, 2);
  assert.equal(nextEpisode(META, 1, 2).episode, 1);
});

test("next episode: an unaired one is not next, and the finale has none", () => {
  assert.equal(nextEpisode(META, 2, 1), null);
  assert.equal(nextEpisode(META, 2, 2), null);
  assert.equal(nextEpisode({ seasons: [] }, 1, 1), null);
});

const STREAMS = [
  { infoHash: "a", quality: "2160p", recommended: false },
  { infoHash: "b", quality: "1080p", recommended: true },
  { infoHash: "c", quality: "720p", cam: true },
  { infoHash: "d", quality: "720p", dubbed: true },
  { infoHash: "e", quality: "720p" },
];

test("source: same quality as what is playing when available", () => {
  assert.equal(pickSource(STREAMS, "720p").infoHash, "e"); // not the CAM, not the dub
  assert.equal(pickSource(STREAMS, "2160p").infoHash, "a");
});

test("source: otherwise the ★ BEST pick, never CAM/dubbed/pack", () => {
  assert.equal(pickSource(STREAMS, "480p").infoHash, "b");
  assert.equal(pickSource(STREAMS, null).infoHash, "b");
  assert.equal(pickSource([{ infoHash: "x", cam: true }], null), null);
  assert.equal(pickSource([], "1080p"), null);
});
