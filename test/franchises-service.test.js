// Franchise order for one person (src/media/franchises/service.js) and its
// routes (src/routes/franchises.js), with the person, the library and TMDB
// made up: the title page's line in the person's order, the franchise page
// (what is on the server, what this person watched), the end card's next
// title with gaps (not on the server: still offered, no copy named; optional
// skipped), Continue the franchise, and the order switch.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const express = require("express");
const franchises = require("../src/media/franchises");
const service = require("../src/media/franchises/service");

const e = (n, date, extra = {}) => ({ imdbId: `tt000000${n}`, tmdbId: n, type: "movie", title: `F${n}`, year: Number(date.slice(0, 4)), date, ...extra });
const SAGA = {
  id: "saga", name: "Saga", the: true, priority: 100, sources: ["https://example.org/saga"],
  entries: [e(1, "2001-05-01"), e(2, "2002-05-01", { type: "series", optional: true }), e(3, "2003-05-01"), e(4, "2004-05-01")],
  story: ["tt0000004", "tt0000002", "tt0000001", "tt0000003"],
};
const SIDE = {
  id: "side", name: "Side Story", the: false, priority: 10, sources: ["https://example.org/side"],
  entries: [e(3, "2003-05-01"), e(7, "2007-05-01"), e(8, "2008-05-01")],
};
const TMDB_COLL = {
  id: "tmdb-555", name: "Other Films", the: false, priority: 0, source: "tmdb",
  orders: { release: [e(5, "2005-01-01"), e(6, "2006-01-01")] },
  entries: [e(5, "2005-01-01"), e(6, "2006-01-01")],
  sources: ["https://www.themoviedb.org/collection/555"],
};

// the made-up world
const world = () => {
  const w = {
    films: {}, // imdbId -> {position, finished, updatedAt}
    eps: {}, // "tt:s:e" -> row
    orders: {}, // `${profile}|${fr}` -> order
    library: { tt0000003: { id: "lib3", type: "movie", title: "F3", cover: "/img/lib3.jpg" } },
    titleMatches: {}, // imdbId -> library item found by title (its own id may differ)
    meta: {},
  };
  service._internals.use({
    catalogue: () => franchises.build([SAGA, SIDE]),
    profiles: () => ({
      streamTitleProgress: () => w.films,
      streamEpisodeProgress: () => w.eps,
      franchiseOrderOf: (p, fr) => w.orders[`${p}|${fr}`] || null,
      setFranchiseOrder: (p, fr, o) => { w.orders[`${p}|${fr}`] = o; return o; },
    }),
    identity: () => ({
      ensureStamped: () => {},
      findLibraryFor: ({ imdbId }) => w.library[imdbId] || w.titleMatches[imdbId] || null,
      imdbIdFor: (item) => item.imdbId || null,
    }),
    discover: () => ({ metaCached: (type, id) => w.meta[id] || null }),
    tmdb: () => ({
      forTitle: async (id) => (id === "tt0000005" || id === "tt0000006" ? TMDB_COLL : null),
      cachedFor: (id) => (id === "tt0000005" || id === "tt0000006" ? TMDB_COLL : null),
      collection: async (cid) => (String(cid) === "555" ? TMDB_COLL : null),
    }),
  });
  return w;
};
test.afterEach(() => service._internals.restore());

test("the title page's line is the best franchise, in the person's order", async () => {
  const w = world();
  let r = await service.forTitle("tt0000003", "p1");
  assert.equal(r.franchise.id, "saga", "the higher priority wins");
  assert.equal(r.franchise.line, "Part of the Saga · 2 of 3");
  assert.equal(r.franchise.action, "Watch in order");
  assert.deepEqual(r.others.map((x) => x.id), ["side"]);
  w.orders["p1|saga"] = "story";
  r = await service.forTitle("tt0000003", "p1");
  assert.equal(r.franchise.line, "Part of the Saga · 3 of 3");
  assert.equal(r.franchise.order, "story");
  // somebody else's order is theirs
  assert.equal((await service.forTitle("tt0000003", "p2")).franchise.line, "Part of the Saga · 2 of 3");
});

test("a film the curated list lacks gets its TMDB collection; nothing else gets anything", async () => {
  world();
  const r = await service.forTitle("tt0000005", null);
  assert.equal(r.franchise.id, "tmdb-555");
  assert.equal(r.franchise.line, "Part of Other Films · 1 of 2");
  assert.equal((await service.forTitle("tt0000009", null)).franchise, null);
  assert.equal((await service.forTitle("tt0000009", null, { type: "series" })).franchise, null);
});

test("the franchise page: every entry in the order, what is on the server, what this person watched", async () => {
  const w = world();
  w.films.tt0000001 = { position: 7000, finished: true, updatedAt: 5 };
  w.films.tt0000004 = { position: 600, finished: false, updatedAt: 6 };
  w.eps["tt0000002:1:1"] = { position: 0, finished: true, updatedAt: 3 };
  const pg = await service.page("saga", "p1");
  assert.equal(pg.order, "release");
  assert.deepEqual(pg.orders.map((o) => o.label), ["Release order", "Story order"]);
  assert.deepEqual(pg.entries.map((x) => x.imdbId), ["tt0000001", "tt0000002", "tt0000003", "tt0000004"]);
  assert.deepEqual(pg.entries.map((x) => x.position), [1, null, 2, 3]);
  assert.deepEqual(pg.entries.map((x) => x.state), ["watched", "started", null, "started"]);
  assert.deepEqual(pg.entries.map((x) => x.onServer && x.onServer.id), [null, null, "lib3", null]);
  assert.equal(pg.entries[2].cover, "/img/lib3.jpg", "the server's own picture for its copy");
  assert.match(pg.entries[0].poster, /metahub\.space\/poster\/small\/tt0000001\//, "a catalogue poster by IMDb id");
  assert.equal(pg.entries[1].type, "show");
  assert.equal(pg.summary, "3 films · 1 optional · 1 on the server · 1 watched");
  // the order asked for wins over the saved one; an unknown franchise is null
  assert.deepEqual((await service.page("saga", "p1", "story")).entries.map((x) => x.imdbId), ["tt0000004", "tt0000002", "tt0000001", "tt0000003"]);
  assert.equal(await service.page("nope", "p1"), null);
  assert.equal((await service.page("tmdb-555", null)).entries.length, 2);
});

test("a series counts as watched once every aired episode is finished", async () => {
  const w = world();
  w.meta.tt0000002 = { seasons: [{ number: 1, episodes: [{ released: "2002-05-01" }, { released: "2002-05-08" }, { released: "2999-01-01" }] }] };
  w.eps["tt0000002:1:1"] = { finished: true };
  assert.equal((await service.page("saga", "p1")).entries[1].state, "started");
  w.eps["tt0000002:1:2"] = { finished: true };
  assert.equal((await service.page("saga", "p1")).entries[1].state, "watched", "the unaired third is not waited for");
});

test("a library copy found only by title, whose own IMDb id is another film, is not this entry", async () => {
  const w = world();
  w.titleMatches.tt0000004 = { id: "libX", type: "movie", title: "F4", imdbId: "tt7777777" };
  w.titleMatches.tt0000001 = { id: "lib1", type: "movie", title: "F1" }; // no id of its own: trusted
  const pg = await service.page("saga", null);
  assert.equal(pg.entries.find((x) => x.imdbId === "tt0000004").onServer, null);
  assert.equal(pg.entries.find((x) => x.imdbId === "tt0000001").onServer.id, "lib1");
});

test("next in order: on the server it names the copy; missing it is still offered, with no copy", async () => {
  world();
  let n = (await service.nextFor("tt0000001", "p1")).next;
  assert.equal(n.kicker, "Next in the Saga");
  assert.equal(n.entry.imdbId, "tt0000003", "the optional series is skipped");
  assert.equal(n.entry.onServer.id, "lib3");
  assert.equal(n.position, 2);
  assert.equal(n.total, 3);
  n = (await service.nextFor("tt0000003", "p1")).next;
  assert.equal(n.entry.imdbId, "tt0000004");
  assert.equal(n.entry.onServer, null, "not on the server: offered without a countdown");
});

test("next in order: the person's order, the end of a franchise, and the second franchise when the first has none", async () => {
  const w = world();
  w.orders["p1|saga"] = "story";
  assert.equal((await service.nextFor("tt0000004", "p1")).next.entry.imdbId, "tt0000001");
  // F3 is last in Saga's story order → Side Story carries on after it
  const n = (await service.nextFor("tt0000003", "p1")).next;
  assert.equal(n.franchise.id, "side");
  assert.equal(n.kicker, "Next in Side Story");
  assert.equal(n.entry.imdbId, "tt0000007");
  assert.equal((await service.nextFor("tt0000008", "p1")).next, null);
  assert.equal((await service.nextFor("tt0000009", "p1")).next, null);
});

test("continue the franchise: the next film for each franchise mid-way, most recent first", async () => {
  const w = world();
  assert.deepEqual(service.homeRow("p1"), [], "nothing watched, no row");
  assert.deepEqual(service.homeRow(null), []);
  w.films.tt0000001 = { finished: true, updatedAt: 100 };
  w.films.tt0000005 = { finished: true, updatedAt: 200 };
  const row = service.homeRow("p1");
  assert.deepEqual(row.map((x) => x.imdbId || x.id), ["tt0000006", "lib3"]);
  // on the server: the library item itself (it plays from its card)
  assert.equal(row[1].id, "lib3");
  assert.equal(row[1].franchise.line, "Next in the Saga · 2 of 3");
  // not on the server: the catalogue title, a stream card
  assert.equal(row[0].source, "stream");
  assert.equal(row[0].onServer, null);
  assert.equal(row[0].franchise.name, "Other Films");
  // already on the page (Continue Watching) → left out
  assert.deepEqual(service.homeRow("p1", { used: new Set(["tt0000006"]) }).map((x) => x.id || x.imdbId), ["lib3"]);
  // F3 started → it is in Continue Watching, the Saga waits
  w.films.tt0000003 = { position: 300, finished: false, updatedAt: 300 };
  assert.deepEqual(service.homeRow("p1").map((x) => x.imdbId), ["tt0000006"]);
});

test("continue the franchise: one card per title even when two franchises point at it", async () => {
  const w = world();
  w.films.tt0000001 = { finished: true, updatedAt: 1 };
  w.films.tt0000003 = { finished: true, updatedAt: 2 };
  // Saga → F4; Side Story → F7: two different cards
  assert.deepEqual(service.homeRow("p1").map((x) => x.imdbId).sort(), ["tt0000004", "tt0000007"]);
});

test("the order switch keeps only orders the franchise has", async () => {
  const w = world();
  assert.deepEqual(await service.setOrder("saga", "p1", "story"), { ok: true, order: "story" });
  assert.equal(w.orders["p1|saga"], "story");
  assert.equal((await service.setOrder("side", "p1", "story")).status, 400);
  assert.equal((await service.setOrder("nope", "p1", "release")).status, 404);
});

test("the routes answer nothing rather than an error, and the order switch needs a person", async () => {
  world();
  const app = express();
  app.use(express.json());
  app.use(require("../src/routes/franchises"));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await (await fetch(`${base}/api/franchises/for/not-an-id`)).json(), { franchise: null, others: [] });
    const line = await (await fetch(`${base}/api/franchises/for/tt0000003`)).json();
    assert.equal(line.franchise.line, "Part of the Saga · 2 of 3");
    assert.deepEqual(await (await fetch(`${base}/api/franchises/next/bad`)).json(), { next: null });
    assert.equal((await (await fetch(`${base}/api/franchises/next/tt0000001`)).json()).next.entry.imdbId, "tt0000003");
    assert.equal((await fetch(`${base}/api/franchises/nope`)).status, 404);
    const pg = await (await fetch(`${base}/api/franchises/saga?order=story`)).json();
    assert.equal(pg.order, "story");
    const post = await fetch(`${base}/api/franchises/saga/order`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profile: "ghost", order: "story" }) });
    assert.equal(post.status, 401);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
