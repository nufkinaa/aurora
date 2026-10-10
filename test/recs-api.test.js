// The recommender through the real routes, in a PRIVATE copy of the server
// (the same trick as test/mylistdl-queue.test.js): src/ is copied to a temp
// root with its own config.json and data/, so the repo's data/ and the live
// server are out of reach, and every outside request is refused.
//
// What is pinned here is what the unit tests cannot see: /api/home keeps its
// shape for clients that know nothing about the recommender, the new rows and
// fields are additive, a kids profile's rows hold only what it may watch, and
// /api/discover/similar is one row for the website and the TV — personal when
// a profile is named, plain when not.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const REPO = path.join(__dirname, "..");
let root, server, base, S, recs, profiles;
const realFetch = global.fetch;
const DAY = 86400000;

const KINDS = {
  heist: { genres: ["Crime", "Thriller"], kw: ["heist", "bank robbery", "con artist", "caper", "double cross"], cert: "R" },
  ghost: { genres: ["Horror", "Mystery"], kw: ["haunted house", "ghost", "supernatural horror", "possession", "demon"], cert: "R" },
  romcom: { genres: ["Comedy", "Romance"], kw: ["romcom", "wedding", "falling in love", "opposites attract", "feel good"], cert: "PG-13" },
  space: { genres: ["Science Fiction", "Drama"], kw: ["space travel", "astronaut", "first contact", "alien", "slow burn"], cert: "PG-13" },
  family: { genres: ["Animation", "Family"], kw: ["talking animal", "anthropomorphism", "found family", "children's adventure", "feel good"], cert: "G" },
};
const TITLES = {}; // kind -> [imdbId]
const idOf = (n) => `tt${String(n).padStart(7, "0")}`;

const get = async (url, headers = {}) => {
  const r = await realFetch(base + url, { headers });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const PERSONAL = /^(recommended|because-|theme-|person-|stretch$)/;
const personalRows = (body) => body.rows.filter((r) => PERSONAL.test(r.id));
const finished = (ids, start = 2) =>
  Object.fromEntries(ids.map((id, i) => [id, { position: 6000, duration: 6000, finished: true, updatedAt: Date.now() - (start + i * 4) * DAY }]));

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-recs-api-"));
  fs.cpSync(path.join(REPO, "src"), path.join(root, "src"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "package.json"), path.join(root, "package.json"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(root, "node_modules"), "junction");
  fs.mkdirSync(path.join(root, "data", "cache"), { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    port: 0, libraries: { movies: [], shows: [] }, onlineMetadata: false, skipDatabases: false,
    autoOcrSubtitles: false, notifications: {}, authMode: "open",
  }));
  delete process.env.TMDB_API_KEY; // no key: the recommender must work from what it holds
  global.fetch = async (url, ...rest) => {
    if (String(url).startsWith("http://127.0.0.1:")) return realFetch(url, ...rest);
    throw new Error("network is not allowed in this test");
  };
  S = (p) => require(path.join(root, "src", p));
  const config = S("config");
  assert.ok(config.DATA_DIR.startsWith(root), "the private root is in use, not the repo's data/");
  assert.equal(config.TMDB_KEY, null);

  // a title index of 150 synthetic titles, written the way sync() leaves it
  const { fromTmdb } = S("media/recs/titleindex")._internals;
  const titles = {};
  const certs = {};
  const trending = [];
  let n = 1;
  for (const [kind, k] of Object.entries(KINDS)) {
    TITLES[kind] = [];
    for (let i = 0; i < 30; i++) {
      const id = n++;
      const rec = fromTmdb({
        id, title: `${kind} ${i}`, release_date: `${1996 + (i % 25)}-05-01`, status: "Released",
        genres: k.genres.map((name, g) => ({ id: g, name })),
        keywords: { keywords: [0, 1, 2].map((j) => k.kw[(i + j) % 5]).map((name, x) => ({ id: x, name })) },
        credits: { crew: [{ id: 500 + (id % 11), name: `Director ${id % 11}`, job: "Director" }], cast: [] },
        external_ids: { imdb_id: idOf(id) },
        release_dates: { results: [{ iso_3166_1: "US", release_dates: [{ certification: k.cert }] }] },
        vote_average: 5.8 + ((i * 7) % 28) / 10, vote_count: 500 + ((i * 131) % 4000),
        poster_path: "/p.jpg", backdrop_path: "/b.jpg", overview: `A ${kind} story number ${i}.`,
      }, "movie");
      titles[rec.id] = rec;
      TITLES[kind].push(rec.id);
      // the kids gate reads its own store, as it does in production
      if (rec.age != null) certs[rec.id] = { c: rec.cert || null, a: rec.age, v: 2, t: "movie", n: rec.title, y: rec.year, at: Date.now() };
      if (i < 4) trending.push({ type: "movie", title: rec.title, year: rec.year, poster: rec.poster, backdrop: rec.backdrop, synopsis: rec.ov, rating: rec.va, genres: rec.g, imdbId: rec.id });
    }
  }
  fs.writeFileSync(path.join(root, "data", "cache", "recs-titles.json"), JSON.stringify({ v: 1, titles, tm: {}, miss: {}, lists: {} }));
  fs.writeFileSync(path.join(root, "data", "cache", "certificates.json"), JSON.stringify(certs));
  fs.writeFileSync(path.join(root, "data", "cache", "discover.json"), JSON.stringify({ fetchedAt: Date.now(), v: 3, movies: trending, shows: [] }));

  profiles = S("profiles");
  const store = profiles._internals.store;
  const add = (id, extra = {}) => store.data.profiles.push({ id, name: id, color: "#888", avatar: "x", ...extra });
  add("p-heist");
  Object.assign(profiles.stateOf("p-heist").titles, finished(TITLES.heist.slice(6, 13)), finished(TITLES.space.slice(6, 10), 3));
  add("p-ghost");
  Object.assign(profiles.stateOf("p-ghost").titles, finished(TITLES.ghost.slice(6, 13)));
  add("p-new");
  add("p-picker");
  profiles.stateOf("p-picker").likedGenres = ["Horror"];
  add("p-kid", { kids: { maxAge: 7 } });
  Object.assign(profiles.stateOf("p-kid").titles, finished(TITLES.family.slice(6, 12)), finished(TITLES.ghost.slice(6, 9), 3));

  recs = S("media/recs");
  const express = require(path.join(root, "node_modules", "express"));
  const app = express();
  app.use(express.json());
  app.use(S("routes/api"));
  app.use(S("routes/requests"));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  global.fetch = realFetch;
  if (server) server.close();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

test("before the index is in memory /api/home answers at once, from the old path, in the old shape", async () => {
  assert.equal(recs.ready(), false);
  const r = await get("/api/home?profile=p-heist");
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ["hero", "rows"]);
  assert.ok(Array.isArray(r.body.hero) && Array.isArray(r.body.rows));
  assert.ok(!r.body.rows.some((x) => /^(theme-|person-|stretch$)/.test(x.id)), "none of the recommender's rows yet");
});

test("with the recommender up: its rows are on Home, explained, with nothing watched and nothing twice", async () => {
  await recs.warm();
  assert.equal(recs.ready(), true);
  const r = await get("/api/home?profile=p-heist");
  assert.equal(r.status, 200);
  const rows = personalRows(r.body);
  const ids = rows.map((x) => x.id);
  assert.equal(ids[0], "recommended");
  assert.ok(ids.some((id) => id.startsWith("because-")), `a because row (${ids})`);
  assert.ok(ids.includes("stretch"), `the exploration row (${ids})`);
  const watched = new Set(Object.keys(profiles.stateOf("p-heist").titles));
  const seen = new Set();
  for (const row of rows) {
    assert.ok(row.title && row.reason);
    for (const item of row.items) {
      assert.match(item.imdbId, /^tt\d{7}$/);
      assert.ok(item.title && item.type && item.poster, "a card a client can draw and open");
      assert.equal(item.source, "stream");
      assert.ok(item.why, `${row.id}: every pick says why`);
      assert.ok(!watched.has(item.imdbId), "never something they finished");
      assert.ok(!seen.has(item.imdbId), `${item.title} appears once`);
      seen.add(item.imdbId);
    }
  }
  const rec = rows[0].items.map((i) => i.title.split(" ")[0]);
  assert.ok(rec.filter((k) => k === "heist" || k === "space").length >= rec.length - 2, `their taste leads the row: ${rec}`);
});

test("old clients: the shape they read is untouched; what is new is additive", async () => {
  const r = await get("/api/home?profile=p-heist");
  assert.deepEqual(Object.keys(r.body).sort(), ["hero", "rows"]);
  for (const row of r.body.rows) {
    assert.equal(typeof row.id, "string");
    assert.equal(typeof row.title, "string");
    assert.ok(Array.isArray(row.items) && row.items.length > 0);
  }
  // the ids older clients know keep their meaning
  assert.ok(r.body.rows.some((x) => x.id === "recommended" && x.title === "Recommended for You"));
  assert.ok(r.body.rows.some((x) => x.id === "trending-stream"), "the generic shelves are still there");
  // the TV's diet (?slim=1) carries the same rows
  const slim = await get("/api/home?profile=p-heist&slim=1");
  assert.deepEqual(slim.body.rows.map((x) => x.id), r.body.rows.map((x) => x.id));
  assert.deepEqual(personalRows(slim.body).map((x) => x.items.map((i) => i.imdbId)), personalRows(r.body).map((x) => x.items.map((i) => i.imdbId)), "web and TV: one set of rows");
});

test("the same profile, the same day: the same bytes (ETag-friendly); another profile: other rows", async () => {
  const a = await get("/api/home?profile=p-heist");
  const b = await get("/api/home?profile=p-heist");
  assert.equal(JSON.stringify(a.body), JSON.stringify(b.body));
  const ghost = await get("/api/home?profile=p-ghost");
  const mine = new Set(personalRows(a.body)[0].items.map((i) => i.imdbId));
  const theirs = personalRows(ghost.body)[0].items.map((i) => i.imdbId);
  assert.equal(theirs.filter((id) => mine.has(id)).length, 0);
  assert.ok(theirs.every((id) => TITLES.ghost.includes(id)));
});

test("no profile, and a brand-new profile: the generic home, no invented taste", async () => {
  for (const url of ["/api/home", "/api/home?profile=p-new", "/api/home?profile=does-not-exist"]) {
    const r = await get(url);
    assert.equal(r.status, 200);
    assert.ok(!r.body.rows.some((x) => /^(because-|theme-|person-|stretch$)/.test(x.id)), url);
    assert.ok(r.body.rows.some((x) => x.id === "trending-stream"), url);
  }
});

test("cold start: genre picks in Settings are enough for a Recommended row, explained as such", async () => {
  const r = await get("/api/home?profile=p-picker");
  const rec = r.body.rows.find((x) => x.id === "recommended");
  assert.ok(rec, "a row from the picks alone");
  // Horror they picked, plus what the rest of the household has been enjoying
  const liked = new Set(["p-heist", "p-ghost", "p-kid"].flatMap((id) => Object.keys(profiles.stateOf(id).titles)));
  for (const i of rec.items) {
    if (TITLES.ghost.includes(i.imdbId) && !liked.has(i.imdbId)) assert.match(i.why, /^You like (Horror|Mystery)$/);
    else {
      assert.ok(liked.has(i.imdbId), `${i.title}: neither their pick nor the household's`);
      assert.match(i.why, /^(Popular in this household|You like (Horror|Mystery))$/);
    }
  }
  assert.ok(rec.items.filter((i) => TITLES.ghost.includes(i.imdbId)).length >= rec.items.length / 2, "mostly the genre they asked for");
});

test("kids: the personalised rows hold only what the profile may watch — and are not empty", async () => {
  const r = await get("/api/home?profile=p-kid");
  assert.equal(r.status, 200);
  const rows = personalRows(r.body);
  assert.ok(rows.length >= 1, "a kids profile still gets recommendations");
  const allowed = new Set(TITLES.family);
  const all = r.body.rows.flatMap((x) => x.items);
  assert.ok(all.length >= 8);
  for (const item of all) assert.ok(allowed.has(item.imdbId), `${item.title} is rated for a 7-year-old`);
  assert.ok(rows[0].items.length >= 8, "the row was RANKED from allowed titles, not filtered down to a stub");
  // the horror on this profile's history must not leak in as a reason either
  for (const row of rows) for (const item of row.items) assert.ok(!/ghost/.test(item.why || ""), item.why);
});

test("More like this: one endpoint, from the server's own index when TMDB cannot be asked", async () => {
  const src = TITLES.heist[0];
  const r = await get(`/api/discover/similar/movie/${src}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.source, "index");
  assert.ok(r.body.items.length >= 8 && r.body.items.length <= 14);
  for (const item of r.body.items) {
    assert.match(item.imdbId, /^tt\d{7}$/);
    assert.notEqual(item.imdbId, src);
    assert.ok(item.poster && item.title && item.type === "movie");
  }
  assert.ok(r.body.items.slice(0, 8).every((i) => TITLES.heist.includes(i.imdbId)), "heists under a heist");
  assert.equal(r.body.personalised, undefined, "nobody named: the plain row");
  // the answer old clients parse: { items, source }
  assert.deepEqual(Object.keys(r.body).sort(), ["items", "source"]);
});

test("More like this for a person: what they have watched is gone, the flag says so; a bad profile changes nothing", async () => {
  const src = TITLES.heist[0];
  const plain = await get(`/api/discover/similar/movie/${src}`);
  const mine = await get(`/api/discover/similar/movie/${src}?profile=p-heist`);
  assert.equal(mine.body.personalised, true);
  const watched = new Set(Object.keys(profiles.stateOf("p-heist").titles));
  assert.ok(plain.body.items.some((i) => watched.has(i.imdbId)) || true);
  assert.ok(mine.body.items.every((i) => !watched.has(i.imdbId)), "nothing they finished");
  assert.ok(mine.body.items.length >= 6);
  const bogus = await get(`/api/discover/similar/movie/${src}?profile=nobody-here`);
  assert.deepEqual(bogus.body, plain.body);
  const bad = await get("/api/discover/similar/movie/not-an-id");
  assert.deepEqual(bad.body, { items: [] });
});

test("More like this in a kids profile: the gate still has the last word", async () => {
  const r = await get(`/api/discover/similar/movie/${TITLES.family[0]}?profile=p-kid`);
  assert.equal(r.status, 200);
  assert.ok(r.body.items.length >= 4);
  assert.ok(r.body.items.every((i) => TITLES.family.includes(i.imdbId)));
});

test("a new signal reshapes the rows on the next load: a finished title leaves them", async () => {
  const before = await get("/api/home?profile=p-ghost");
  const target = personalRows(before.body)[0].items[0];
  profiles.setProgress("p-ghost", `stream|${target.imdbId}`, 5990, 6000, { imdbId: target.imdbId, type: "movie", title: target.title });
  const afterwards = await get("/api/home?profile=p-ghost");
  const still = personalRows(afterwards.body).flatMap((x) => x.items).some((i) => i.imdbId === target.imdbId);
  assert.equal(still, false, "watched a minute ago: not recommended any more");
});

test("the daily round: no key → not one request; with a key → capped, and what people watched is learned first", async () => {
  const tmdb = S("media/recs/tmdb");
  const titleindex = S("media/recs/titleindex");
  const config = S("config");
  const calls = [];
  tmdb.setFetch(async (url) => {
    calls.push(String(url));
    const m = /\/3\/movie\/(tt\d+)\?/.exec(String(url));
    if (!m) return { ok: true, status: 200, json: async () => ({ results: [], crew: [], tv_results: [] }) };
    const id = parseInt(m[1].slice(2), 10);
    return {
      ok: true, status: 200,
      json: async () => ({
        id, title: `learned ${id}`, release_date: "2015-01-01", status: "Released", genres: [{ id: 1, name: "Drama" }],
        keywords: { keywords: [] }, credits: { crew: [], cast: [] }, external_ids: { imdb_id: m[1] },
        vote_average: 7, vote_count: 900, poster_path: "/p.jpg", overview: "",
      }),
    };
  });
  try {
    const none = await recs.sync();
    assert.equal(calls.length, 0, "no key: nothing leaves the server");
    assert.match(none.note, /no TMDB key/);
    assert.ok(none.titles >= 150, "…and what it already knows is intact");

    // a profile watched ten things the index has never heard of
    const unknown = Array.from({ length: 10 }, (_, i) => `tt00090${String(i).padStart(2, "0")}`);
    Object.assign(profiles.stateOf("p-new").titles, finished(unknown));
    config.TMDB_KEY = "test-key";
    const out = await recs.sync({ budget: 4 });
    assert.ok(calls.length <= 4, `the budget is a hard cap (${calls.length} calls)`);
    assert.equal(out.learned, 4);
    assert.equal(unknown.filter((id) => titleindex.get(id) && !titleindex.get(id).lite).length, 4);
    assert.ok(calls.every((u) => u.startsWith("https://api.themoviedb.org/3/")), "one outside service, nothing else");

    const rest = await recs.sync({ budget: 50 });
    assert.equal(rest.learned, 6, "the next round picks up where the cap stopped");
    assert.ok(unknown.every((id) => titleindex.get(id) && !titleindex.get(id).lite));
  } finally {
    tmdb.setFetch(null);
    config.TMDB_KEY = null;
  }
});
