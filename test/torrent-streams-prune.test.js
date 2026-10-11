// The cached source lists (cache/torrent-streams.json) are only ever answered
// from while they are under six hours old and of today's shape. The ones
// past that used to stay in the file for good — read at boot, held in
// memory, and written back whole on every new lookup. They are dropped now;
// what a lookup answers must not have changed.
const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert");

const torrent = require("../src/media/torrent");
const { STORE, liveStreams, pruneStreams, STREAMS_TTL, STREAMS_V } = torrent._internals;

const saved = { data: STORE.data, save: STORE.save, fetch: global.fetch };
let saves, fetched;
after(() => { STORE.data = saved.data; STORE.save = saved.save; global.fetch = saved.fetch; });

const HOUR = 3600 * 1000;
const list = (tag, n = 2) => Array.from({ length: n }, (_, i) => ({ infoHash: `${tag}${i}`.padEnd(40, "0"), filename: `${tag}.${i}.1080p.mkv`, quality: "1080p", seeders: 10 - i, sizeBytes: 2e9, tags: [], cam: false, dubbed: false, pack: false, languages: [] }));
// what Torrentio answers for a lookup that has to go out
const upstream = (n) => ({ streams: Array.from({ length: n }, (_, i) => ({ infoHash: `f${i}`.padEnd(40, "a"), name: "Torrentio\n1080p", title: `Some.Film.2020.1080p.WEB-DL.x264-GRP${i}\n👤 ${50 - i} 💾 2.${i} GB ⚙️ Prov`, fileIdx: 0, sources: ["tracker:udp://tracker.example:1337/announce"] })) });

beforeEach(() => {
  const now = Date.now();
  saves = 0;
  fetched = [];
  STORE.save = () => { saves++; };
  STORE.data = {
    ids: { "movie|some film|2020": "tt0000001" },
    streams: {
      "movie|tt1000001": { at: now - 1 * HOUR, v: STREAMS_V, streams: list("fresh") },
      "movie|tt1000002": { at: now - 5.9 * HOUR, v: STREAMS_V, streams: list("almost") },
      "movie|tt1000003": { at: now - 6.1 * HOUR, v: STREAMS_V, streams: list("stale") },
      "series|tt1000004:1:2": { at: now - 40 * 24 * HOUR, v: STREAMS_V, streams: list("ancient") },
      "movie|tt1000005": { at: now - 1 * HOUR, v: STREAMS_V - 1, streams: list("oldshape") },
      "movie|tt1000006": { at: now - 1 * HOUR, streams: list("noversion") },
      "movie|tt1000007": { at: now - 1 * HOUR, v: STREAMS_V, streams: [] }, // a title with no sources: fresh, never a hit
      "movie|tt1000008": null,
    },
  };
  global.fetch = async (url) => {
    fetched.push(String(url));
    return { ok: true, status: 200, json: async () => upstream(3) };
  };
});

test("live = under six hours old and of today's shape — the test getSources always applied", () => {
  const now = Date.now();
  assert.equal(liveStreams({ at: now - 1000, v: STREAMS_V, streams: [] }, now), true);
  assert.equal(liveStreams({ at: now - STREAMS_TTL + 1000, v: STREAMS_V, streams: [] }, now), true);
  assert.equal(liveStreams({ at: now - STREAMS_TTL, v: STREAMS_V, streams: [] }, now), false);
  assert.equal(liveStreams({ at: now - 1000, v: STREAMS_V - 1, streams: [] }, now), false);
  assert.equal(liveStreams({ at: now - 1000, streams: [] }, now), false);
  assert.equal(liveStreams({ v: STREAMS_V, streams: [] }, now), false, "no date: never served, so never kept");
  assert.equal(liveStreams(null, now), false);
  assert.equal(liveStreams(undefined, now), false);
});

test("prune drops exactly the lists that could never be answered from, and nothing else", () => {
  assert.equal(pruneStreams(), 5);
  assert.deepEqual(Object.keys(STORE.data.streams).sort(), ["movie|tt1000001", "movie|tt1000002", "movie|tt1000007"]);
  assert.deepEqual(STORE.data.ids, { "movie|some film|2020": "tt0000001" }, "the permanent title -> id table is untouched");
  assert.equal(pruneStreams(), 0, "nothing left to drop");
  assert.equal(saves, 0, "pruning by itself writes nothing: the file shrinks with the next real save");
});

test("a fresh list is answered from the cache, no request made — exactly as before", async () => {
  const before = STORE.data.streams["movie|tt1000001"].streams;
  const r = await torrent.getSources("movie", "tt1000001");
  assert.equal(r.imdbId, "tt1000001");
  assert.equal(r.streams, before, "the cached array itself");
  assert.deepEqual(fetched, []);
  assert.equal(saves, 0);
  const almost = await torrent.getSources("movie", "tt1000002");
  assert.equal(almost.streams.length, 2);
  assert.deepEqual(fetched, []);
});

test("a stale, old-shape, or empty list is asked for again — and the save that follows carries only live lists", async () => {
  for (const [id, why] of [["tt1000003", "over six hours old"], ["tt1000005", "older shape"], ["tt1000007", "empty list is never a hit"], ["tt1000009", "never asked"]]) {
    fetched.length = 0;
    const r = await torrent.getSources("movie", id);
    assert.equal(fetched.length, 1, why);
    assert.ok(fetched[0].includes(`/stream/movie/${id}.json`));
    assert.equal(r.streams.length, 3, why);
    const entry = STORE.data.streams[`movie|${id}`];
    assert.equal(entry.v, STREAMS_V);
    assert.ok(Date.now() - entry.at < 5000);
    // and from now on it is a cache hit
    fetched.length = 0;
    assert.equal((await torrent.getSources("movie", id)).streams.length, 3);
    assert.deepEqual(fetched, [], `${why}: cached after the lookup`);
  }
  assert.equal(saves, 4, "one save per lookup that went out");
  const now = Date.now();
  for (const [key, entry] of Object.entries(STORE.data.streams)) assert.ok(liveStreams(entry, now), `${key} is live`);
  assert.deepEqual(Object.keys(STORE.data.streams).sort(), ["movie|tt1000001", "movie|tt1000002", "movie|tt1000003", "movie|tt1000005", "movie|tt1000007", "movie|tt1000009"]);
  assert.equal(STORE.data.streams["series|tt1000004:1:2"], undefined, "the six-week-old episode list is gone from memory and from the next file");
});
