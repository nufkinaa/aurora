// TV trailers (src/media/trailers.js): Apple's HLS trailer when Wikidata knows
// the title's Apple id, else the YouTube keys, else none — with the cache
// rules (an Apple id for good, a miss for 30 days, an error for a day), the
// shape-change guard, and the TV's failure reports. No network: fetch, the
// metadata lookup and the store are all handed in.
const test = require("node:test");
const assert = require("node:assert");
const trailers = require("../src/media/trailers");
const signals = require("../src/lib/signals");
const X = trailers._internals;

const DAY = 24 * 3600 * 1000;
const NOW = new Date(2026, 9, 9, 12, 0, 0).getTime();
const DUNE = "tt15239678";
const APPLE_ID = "umc.cmc.363aycnv6vy9qgekvew6fveb9";
const HLS = "https://play-edge.itunes.apple.com/WebObjects/MZPlayLocal.woa/hls/playlist.m3u8?cc=US&a=1725365997&id=789866031&aec=HD&l=en";

const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => (body === undefined ? JSON.parse("<") : body) });
const wdSearch = (q) => answer(200, { query: { search: q ? [{ title: q }] : [] } });
const wdEntity = (q, prop, value) => answer(200, { entities: { [q]: { claims: value ? { [prop]: [{ mainsnak: { datavalue: { value } } }] } : {} } } });
const appleMovie = (clips) => answer(200, {
  data: {
    content: { id: APPLE_ID },
    playables: {
      "tvs.sbd.12962:x": { type: "Vod" },
      "tvs.sbd.9001:y": { itunesMediaApiData: { movieClips: clips } },
    },
  },
});

// fetch by URL: routes = [[regex, () => answer]]; every call is recorded
const rig = (routes, meta = async () => ({ trailers: ["Way9Dexny3w", "U2Qp5pL3ovA"] })) => {
  const calls = [];
  const store = { data: { ids: {}, clips: {} }, saves: 0, save() { this.saves++; } };
  X.reset();
  X.setStore(store);
  X.setMeta(meta);
  X.setFetch(async (url) => {
    calls.push(url);
    for (const [re, fn] of routes) if (re.test(url)) return fn(url);
    throw new Error(`unexpected fetch ${url}`);
  });
  signals._reset();
  return { calls, store };
};
const WD_SEARCH = /wikidata\.org.*list=search/;
const WD_ENT = /wikidata\.org.*wbgetentities/;
const APPLE = /uts-api\.itunes\.apple\.com\/uts\/v3\/movies\//;

test.afterEach(() => X.reset());

test("Wikidata knows the Apple id and Apple has the clip → the Apple trailer", async () => {
  const { calls, store } = rig([
    [WD_SEARCH, () => wdSearch("Q109228991")],
    [WD_ENT, () => wdEntity("Q109228991", "P9586", APPLE_ID)],
    [APPLE, () => appleMovie([{ title: "Clip 1", hlsUrl: HLS.replace("789866031", "1") }, { title: "Trailer", hlsUrl: HLS }])],
  ]);
  const r = await trailers.trailerFor({ imdbId: DUNE, type: "movie" }, NOW);
  assert.deepEqual(r, { source: "apple", hls: HLS, id: APPLE_ID, quality: 1080 });
  assert.equal(calls.length, 3);
  assert.match(calls[0], /haswbstatement%3AP345%3Dtt15239678/);
  assert.match(calls[2], new RegExp(`/movies/${APPLE_ID.replace(/\./g, "\\.")}\\?.*utsk=`));
  assert.equal(store.data.ids[DUNE].id, APPLE_ID);
  assert.equal(store.data.clips[APPLE_ID].hls, HLS);
  assert.ok(store.saves >= 2);
  // the provider counters see both services
  assert.equal(signals.byKey("provider", DAY).get("wikidata:ok"), 2);
  assert.equal(signals.byKey("provider", DAY).get("apple-tv:ok"), 1);
});

test("a show reads P9751 and Apple's Trailers shelf", async () => {
  const showId = "umc.cmc.1srk2goyh2q2zdxcx605w8vtx";
  const shelf = "https://play-edge.itunes.apple.com/WebObjects/MZPlayLocal.woa/hls/subscription/playlist.m3u8?cc=US&a=1596157388&id=1322550030";
  const { calls } = rig([
    [WD_SEARCH, () => wdSearch("Q101096725")],
    [WD_ENT, () => wdEntity("Q101096725", "P9751", showId)],
    [/\/uts\/v3\/shows\//, () => answer(200, { data: { content: {}, canvas: { shelves: [
      { id: "uts.col.Other" },
      { id: `uts.col.Trailers.${showId}`, items: [
        { title: "Welcome Back: Season 2", playables: [{ title: "Welcome Back: Season 2", assets: { hlsUrl: shelf.replace("1322550030", "9") } }] },
        { title: "Teaser Trailer: Season 1", playables: [{ title: "Teaser Trailer: Season 1", assets: { hlsUrl: shelf } }] },
      ] },
    ] } } })],
  ]);
  const r = await trailers.trailerFor({ imdbId: "tt11280740", type: "show" }, NOW);
  assert.equal(r.source, "apple");
  assert.equal(r.hls, shelf, "the one titled as a trailer wins");
  assert.match(calls[2], /\/shows\/umc\.cmc\.1srk2goyh2q2zdxcx605w8vtx\?/);
});

test("no Apple id on Wikidata → the YouTube keys; the miss is kept 30 days, then asked again", async () => {
  const { calls, store } = rig([
    [WD_SEARCH, () => wdSearch("Q1")],
    [WD_ENT, () => wdEntity("Q1", "P9586", null)],
  ]);
  const r = await trailers.trailerFor({ imdbId: "tt0000001", type: "movie" }, NOW);
  assert.deepEqual(r, { source: "youtube", ids: ["Way9Dexny3w", "U2Qp5pL3ovA"] });
  assert.equal(store.data.ids.tt0000001.id, null);
  assert.equal(store.data.ids.tt0000001.err, undefined);
  assert.equal(calls.length, 2);
  await trailers.trailerFor({ imdbId: "tt0000001", type: "movie" }, NOW + 29 * DAY);
  assert.equal(calls.length, 2, "a miss is not asked again within 30 days");
  await trailers.trailerFor({ imdbId: "tt0000001", type: "movie" }, NOW + 31 * DAY);
  assert.equal(calls.length, 4, "after 30 days it is");
});

test("a title Wikidata does not know at all → YouTube, and none when there are no keys either", async () => {
  rig([[WD_SEARCH, () => wdSearch(null)]], async () => ({ trailers: [] }));
  const r = await trailers.trailerFor({ imdbId: "tt0000002", type: "movie" }, NOW);
  assert.equal(r.source, "none");
  assert.match(r.why, /no trailer/);
  assert.deepEqual(await trailers.trailerFor({ imdbId: "not-an-id" }, NOW), { source: "none", why: "no IMDb id" });
});

test("an Apple id is kept for good: a year later Wikidata is not asked again", async () => {
  const { calls } = rig([
    [WD_SEARCH, () => wdSearch("Q109228991")],
    [WD_ENT, () => wdEntity("Q109228991", "P9586", APPLE_ID)],
    [APPLE, () => appleMovie([{ title: "Trailer", hlsUrl: HLS }])],
  ]);
  await trailers.trailerFor({ imdbId: DUNE }, NOW);
  assert.equal(calls.filter((u) => /wikidata/.test(u)).length, 2);
  await trailers.trailerFor({ imdbId: DUNE }, NOW + 6 * DAY);
  assert.equal(calls.length, 3, "the clip is kept a week too");
  await trailers.trailerFor({ imdbId: DUNE }, NOW + 365 * DAY);
  assert.equal(calls.filter((u) => /wikidata/.test(u)).length, 2, "the id is never looked up again");
  assert.equal(calls.filter((u) => APPLE.test(u)).length, 2, "the clip is asked again after its week");
});

test("Apple 4xx → YouTube keys, the error is counted and kept for a day", async () => {
  const { calls, store } = rig([
    [WD_SEARCH, () => wdSearch("Q109228991")],
    [WD_ENT, () => wdEntity("Q109228991", "P9586", APPLE_ID)],
    [APPLE, () => answer(403, {})],
  ]);
  const r = await trailers.trailerFor({ imdbId: DUNE, type: "movie" }, NOW);
  assert.equal(r.source, "youtube");
  assert.match(store.data.clips[APPLE_ID].err, /403/);
  assert.equal(signals.byKey("trailer-apple", DAY).get("apple:403"), 1);
  assert.equal(signals.byKey("provider", DAY).get("apple-tv:403"), 1);
  await trailers.trailerFor({ imdbId: DUNE }, NOW + 20 * 3600 * 1000);
  assert.equal(calls.filter((u) => APPLE.test(u)).length, 1, "within the day the error answers");
  await trailers.trailerFor({ imdbId: DUNE }, NOW + DAY + 1000);
  assert.equal(calls.filter((u) => APPLE.test(u)).length, 2, "after a day Apple is asked again");
});

test("Apple 404 is a plain 'no trailer' (30 days), not a fault", async () => {
  const { store } = rig([
    [WD_SEARCH, () => wdSearch("Q109228991")],
    [WD_ENT, () => wdEntity("Q109228991", "P9586", APPLE_ID)],
    [APPLE, () => answer(404, {})],
  ]);
  const r = await trailers.trailerFor({ imdbId: DUNE }, NOW);
  assert.equal(r.source, "youtube");
  assert.equal(store.data.clips[APPLE_ID].err, undefined);
  assert.equal(signals.count("trailer-apple", DAY), 0);
});

test("Apple's answer in a new shape → counted as 'shape', YouTube meanwhile", async () => {
  rig([
    [WD_SEARCH, () => wdSearch("Q109228991")],
    [WD_ENT, () => wdEntity("Q109228991", "P9586", APPLE_ID)],
    [APPLE, () => answer(200, { results: { something: "else" } })],
  ]);
  const r = await trailers.trailerFor({ imdbId: DUNE }, NOW);
  assert.equal(r.source, "youtube");
  assert.equal(signals.byKey("trailer-apple", DAY).get("apple:shape"), 1);
  // the shape guard itself
  assert.throws(() => X.pickAppleClip({}), /unexpected shape/);
  assert.throws(() => X.pickAppleClip({ data: null }), /unexpected shape/);
  assert.equal(X.pickAppleClip({ data: { content: {}, playables: {} } }), null, "the usual shape with no clip is 'no trailer'");
  // a clip that is not an Apple HLS playlist is never handed to a TV
  assert.equal(X.pickAppleClip({ data: { playables: { a: { itunesMediaApiData: { movieClips: [{ title: "Trailer", hlsUrl: "https://evil.example/x.m3u8" }] } } } } }), null);
});

test("Wikidata down → YouTube, counted, and retried after a day (not 30)", async () => {
  let wdUp = false;
  const { calls, store } = rig([
    [WD_SEARCH, () => (wdUp ? wdSearch("Q109228991") : answer(503, {}))],
    [WD_ENT, () => wdEntity("Q109228991", "P9586", APPLE_ID)],
    [APPLE, () => appleMovie([{ title: "Trailer", hlsUrl: HLS }])],
  ]);
  const r = await trailers.trailerFor({ imdbId: DUNE }, NOW);
  assert.equal(r.source, "youtube");
  assert.match(store.data.ids[DUNE].err, /503/);
  assert.equal(signals.byKey("trailer-apple", DAY).get("wikidata:503"), 1);
  wdUp = true;
  await trailers.trailerFor({ imdbId: DUNE }, NOW + 3600 * 1000);
  assert.equal(calls.length, 1, "within the day: the error answers");
  const later = await trailers.trailerFor({ imdbId: DUNE }, NOW + DAY + 1);
  assert.equal(later.source, "apple");
});

test("a timeout and garbage JSON are errors, never a crash", async () => {
  rig([
    [WD_SEARCH, () => { const e = new Error("The operation was aborted due to timeout"); e.name = "TimeoutError"; throw e; }],
  ]);
  const r = await trailers.trailerFor({ imdbId: DUNE }, NOW);
  assert.equal(r.source, "youtube");
  assert.equal(signals.byKey("trailer-apple", DAY).get("wikidata:timeout"), 1);
  rig([
    [WD_SEARCH, () => wdSearch("Q109228991")],
    [WD_ENT, () => wdEntity("Q109228991", "P9586", APPLE_ID)],
    [APPLE, () => answer(200, undefined)],
  ]);
  const r2 = await trailers.trailerFor({ imdbId: DUNE }, NOW);
  assert.equal(r2.source, "youtube");
  assert.equal(signals.byKey("trailer-apple", DAY).get("apple:json"), 1);
});

test("the YouTube keys are filtered and capped; a failing metadata lookup is just 'none'", async () => {
  rig([[WD_SEARCH, () => wdSearch(null)]], async () => ({ trailers: ["ok_key-123", "bad key!", 7, "a2", "k2k2k2k2", "k3k3k3k3", "k4k4k4k4"] }));
  assert.deepEqual(await trailers.trailerFor({ imdbId: DUNE }, NOW), { source: "youtube", ids: ["ok_key-123", "k2k2k2k2", "k3k3k3k3"] });
  rig([[WD_SEARCH, () => wdSearch(null)]], async () => { throw new Error("cinemeta down"); });
  assert.equal((await trailers.trailerFor({ imdbId: DUNE }, NOW)).source, "none");
});

test("two TVs asking at once share one lookup", async () => {
  const { calls } = rig([
    [WD_SEARCH, () => wdSearch("Q109228991")],
    [WD_ENT, () => wdEntity("Q109228991", "P9586", APPLE_ID)],
    [APPLE, () => appleMovie([{ title: "Trailer", hlsUrl: HLS }])],
  ]);
  const [a, b] = await Promise.all([trailers.trailerFor({ imdbId: DUNE }, NOW), trailers.trailerFor({ imdbId: DUNE }, NOW)]);
  assert.deepEqual(a, b);
  assert.equal(calls.length, 3);
});

test("a TV's failure report: one tidy log line and one count", () => {
  signals._reset();
  const lines = [];
  const orig = console.log;
  console.log = (s) => lines.push(s);
  try {
    trailers.report({ imdbId: DUNE, source: "youtube", stage: "resolve", id: "Way9Dexny3w", why: "blocked\nnext line" }, "10.0.0.3");
    trailers.report({ imdbId: "<script>", source: "weird", stage: "nope", why: "" });
    trailers.report(null);
  } finally {
    console.log = orig;
  }
  assert.equal(lines[0], "[trailer] youtube resolve failed on a TV: tt15239678 Way9Dexny3w — blockednext line (10.0.0.3)");
  assert.equal(lines[1], "[trailer] other play failed on a TV: - — unknown");
  assert.equal(signals.byKey("trailer-fail", DAY).get("youtube:resolve"), 1);
  assert.equal(signals.byKey("trailer-fail", DAY).get("other:play"), 2);
});

test("the cache rules are the ones promised", () => {
  assert.equal(X.TTL.idHit, Infinity);
  assert.equal(X.TTL.idMiss, 30 * DAY);
  assert.equal(X.TTL.error, DAY);
  assert.match(X.APPLE_QS, /sf=143441/);
});
