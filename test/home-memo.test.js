// /api/home and /api/library through the real routes, in a PRIVATE copy of
// the server (the trick of test/recs-api.test.js: src/ copied to a temp root
// with its own config.json and data/ — the repo's data/ and the live server
// are out of reach, every outside request is refused).
//
// What is pinned: an unchanged Home is served from memory with the same bytes
// and a strong validator, and is a 304 for a client that has it; and the
// INVALIDATION MATRIX — each kind of change ends exactly the kept answers it
// must (that profile's own writes: only that profile's; the library, the
// settings, who the profiles are: everybody's), a kids profile's answer is
// its own, and the TV's slim shape and the placeholder variant are their own.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const zlib = require("zlib");

const REPO = path.join(__dirname, "..");
let root, server, base, S, profiles, memo, scanner;
const realFetch = global.fetch;

// a raw request: the validator and the encoding are what is being tested
const get = (url, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = http.get(base + url, { headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        const enc = res.headers["content-encoding"];
        let text = "";
        try { text = (enc === "br" ? zlib.brotliDecompressSync(raw) : enc === "gzip" ? zlib.gunzipSync(raw) : raw).toString("utf8"); } catch {}
        let body = null;
        try { body = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, raw, text, body });
      });
    });
    req.on("error", reject);
  });

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-home-memo-"));
  fs.cpSync(path.join(REPO, "src"), path.join(root, "src"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "package.json"), path.join(root, "package.json"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(root, "node_modules"), "junction");
  fs.mkdirSync(path.join(root, "data", "cache"), { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    port: 0, libraries: { movies: [], shows: [] }, onlineMetadata: false, skipDatabases: false,
    autoOcrSubtitles: false, notifications: {}, authMode: "open",
  }));
  delete process.env.TMDB_API_KEY;
  global.fetch = async (url, ...rest) => {
    if (String(url).startsWith("http://127.0.0.1:")) return realFetch(url, ...rest);
    throw new Error("network is not allowed in this test");
  };
  S = (p) => require(path.join(root, "src", p));
  const config = S("config");
  assert.ok(config.DATA_DIR.startsWith(root), "the private root is in use, not the repo's data/");

  // a catalogue of 40 films, half of them rated for small children
  const movies = [];
  const certs = {};
  for (let i = 0; i < 40; i++) {
    const imdbId = `tt${String(9100000 + i)}`;
    const kidsOk = i % 2 === 0;
    movies.push({ type: "movie", title: `${kidsOk ? "Gentle" : "Grown"} Film ${i}`, year: 2010 + (i % 12), poster: `https://images.example/p${i}.jpg`, backdrop: `https://images.example/b${i}.jpg`, synopsis: `Story ${i}.`, rating: 6 + (i % 30) / 10, genres: kidsOk ? ["Family", "Animation"] : ["Thriller", "Crime"], imdbId });
    certs[imdbId] = { c: kidsOk ? "G" : "R", a: kidsOk ? 0 : 17, v: 2, t: "movie", n: movies[i].title, y: movies[i].year, at: Date.now() };
  }
  fs.writeFileSync(path.join(root, "data", "cache", "discover.json"), JSON.stringify({ fetchedAt: Date.now(), v: 3, movies, shows: [] }));
  fs.writeFileSync(path.join(root, "data", "cache", "certificates.json"), JSON.stringify(certs));

  profiles = S("profiles");
  const store = profiles._internals.store;
  for (const [id, extra] of [["ann", {}], ["bob", {}], ["kid", { kids: { maxAge: 7 } }]]) store.data.profiles.push({ id, name: id, color: "#888", avatar: "x", ...extra });
  memo = S("lib/answermemo");
  scanner = S("media/scanner");

  const express = require(path.join(root, "node_modules", "express"));
  const app = express();
  app.use(express.json());
  app.use(S("lib/blurup").middleware);
  app.use(S("routes/api"));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  global.fetch = realFetch;
  if (server) server.close();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

// Was this request answered from memory? (the module's own count)
const fromMemory = async (url, headers) => {
  const before = memo.stats.hits;
  const r = await get(url, headers);
  return { ...r, kept: memo.stats.hits === before + 1 };
};
const HOME = (p) => `/api/home?profile=${p}`;

test("an unchanged Home: composed once, then served from memory — the same bytes, a strong validator, private and revalidated", async () => {
  // (the very first Home after a start sets background fills going — release
  // verdicts, the billboard pool; when they land the answer is rebuilt once)
  await get(HOME("ann"));
  await new Promise((r) => setTimeout(r, 400));
  memo.clear();
  const first = await fromMemory(HOME("ann"));
  assert.equal(first.status, 200);
  assert.equal(first.kept, false);
  assert.ok(first.body.rows.length > 0 && Array.isArray(first.body.hero));
  assert.match(first.headers.etag, /^"[A-Za-z0-9_-]{22}"$/, "strong: no W/ prefix");
  assert.equal(first.headers["cache-control"], "private, no-cache");
  const second = await fromMemory(HOME("ann"));
  assert.equal(second.kept, true);
  assert.equal(second.text, first.text, "byte for byte");
  assert.equal(second.headers.etag, first.headers.etag);
  // fast: the repeat costs well under a millisecond of server work — here just "much less than composing"
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 50; i++) await get(HOME("ann"));
  const perRequestMs = Number(process.hrtime.bigint() - t0) / 1e6 / 50;
  assert.ok(perRequestMs < 15, `50 repeats over HTTP took ${perRequestMs.toFixed(2)} ms each`);
});

test("If-None-Match on Home: 304 with no body while nothing changed; 200 with the new answer after a change", async () => {
  const a = await get(HOME("ann"));
  const same = await get(HOME("ann"), { "If-None-Match": a.headers.etag });
  assert.equal(same.status, 304);
  assert.equal(same.raw.length, 0, "no body");
  assert.equal(same.headers.etag, a.headers.etag);
  // the profile changes something Home shows
  profiles.toggleWatchlist("ann", { stream: true, imdbId: "tt9100001", type: "movie", title: "Grown Film 1", poster: "https://images.example/p1.jpg", year: 2011 }, true);
  const changed = await get(HOME("ann"), { "If-None-Match": a.headers.etag });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.etag, a.headers.etag);
  assert.ok(changed.body.rows.some((r) => r.id === "mylist"), "My List is there now");
  // and the compressed form carries its own validator, which also earns a 304
  const br = await get(HOME("ann"), { "Accept-Encoding": "br" });
  assert.equal(br.headers["content-encoding"], "br");
  assert.match(br.headers.etag, /-br"$/);
  assert.deepEqual(br.body, changed.body);
  assert.equal((await get(HOME("ann"), { "Accept-Encoding": "br", "If-None-Match": br.headers.etag })).status, 304);
});

test("the invalidation matrix: each kind of change ends exactly the kept answers it must", async () => {
  const prime = async () => { memo.clear(); await get(HOME("ann")); await get(HOME("bob")); await get("/api/home"); await get("/api/library"); };
  const state = async () => ({
    ann: (await fromMemory(HOME("ann"))).kept,
    bob: (await fromMemory(HOME("bob"))).kept,
    nobody: (await fromMemory("/api/home")).kept,
    library: (await fromMemory("/api/library")).kept,
  });
  const ALL_KEPT = { ann: true, bob: true, nobody: true, library: true };
  const item = (n) => ({ stream: true, imdbId: `tt91000${n}`, type: "movie", title: `Film ${n}`, poster: "https://images.example/p.jpg", year: 2012 });

  await prime();
  assert.deepEqual(await state(), ALL_KEPT, "nothing changed: everything from memory");

  // ---- one profile's own writes end ONLY that profile's Home
  const personal = [
    ["progress", () => profiles.setProgress("ann", "tt9100003", 300, 6000, { title: "Grown Film 3", imdbId: "tt9100003", type: "movie" })],
    ["My List", () => profiles.toggleWatchlist("ann", item(11), true)],
    ["a rating", () => profiles.setRating("ann", "tt9100005", 5)],
    ["liked genres", () => profiles.setLikedGenres("ann", ["Thriller"])],
  ];
  for (const [what, change] of personal) {
    await prime();
    change();
    assert.deepEqual(await state(), { ann: false, bob: true, nobody: true, library: true }, `${what}: ann's Home only`);
  }

  // ---- what everybody's answer is built from ends everybody's
  await prime();
  scanner.events.emit("scanned");
  assert.deepEqual(await state(), { ann: false, bob: false, nobody: false, library: false }, "a library scan");

  await prime();
  const settings = S("lib/settings");
  settings.data.maxActiveDownloads = 3;
  settings.save();
  assert.deepEqual(await state(), { ann: false, bob: false, nobody: false, library: true }, "a setting (Home; the library list does not read settings)");

  await prime();
  profiles._internals.store.data.profiles.find((p) => p.id === "bob").rows = { hidden: ["trending-stream"], order: [] };
  profiles._internals.store.save();
  assert.deepEqual(await state(), { ann: false, bob: false, nobody: false, library: true }, "who the profiles are / their row preferences");
  assert.ok(!(await get(HOME("bob"))).body.rows.some((r) => r.id === "trending-stream"), "and the new preference is in the fresh answer");

  await prime();
  profiles.setKids("kid", { maxAge: 12 });
  assert.equal((await state()).ann, false, "a kids limit changed");
  profiles.setKids("kid", { maxAge: 7 });

  await prime();
  S("media/recs")._internals.state.gen++;
  assert.deepEqual(await state(), { ann: false, bob: false, nobody: false, library: true }, "the recommender rebuilt its index");

  await prime();
  S("media/discover").noteCertificate && S("media/discover")._internals.certStore.save();
  assert.deepEqual(await state(), { ann: false, bob: false, nobody: false, library: false }, "the catalogue / age-rating caches were written");

  // ---- somebody else watching moves nothing of mine (the common case, every 5 s)
  await prime();
  for (let i = 0; i < 5; i++) profiles.setProgress("bob", "tt9100007", 100 + i * 5, 6000, { title: "Grown Film 7", imdbId: "tt9100007", type: "movie" });
  assert.deepEqual(await state(), { ann: true, bob: false, nobody: true, library: true }, "bob watching: only bob's Home");

  // ---- and time: nothing is kept past the window
  await prime();
  for (const e of memo._internals.entries.values()) e.at = Date.now() - memo.MAX_AGE_MS - 1;
  assert.deepEqual(await state(), { ann: false, bob: false, nobody: false, library: false }, "thirty seconds");
});

test("a kids profile never gets another profile's kept answer — and its own is filtered every time it is served", async () => {
  memo.clear();
  const grown = await get(HOME("ann"));
  const allTitles = grown.body.rows.flatMap((r) => r.items.map((i) => i.title));
  assert.ok(allTitles.some((t) => /^Grown Film/.test(t)), "the grown-up Home has grown-up films");
  const kid = await fromMemory(HOME("kid"));
  assert.equal(kid.kept, false, "not ann's, not anybody's");
  const kidTitles = kid.body.rows.flatMap((r) => r.items.map((i) => i.title)).concat(kid.body.hero.map((i) => i.title));
  assert.ok(kidTitles.length > 0);
  assert.ok(kidTitles.every((t) => /^Gentle Film/.test(t)), `only what a 7-year-old may see: ${kidTitles.filter((t) => !/^Gentle/.test(t)).slice(0, 3)}`);
  const again = await fromMemory(HOME("kid"));
  assert.equal(again.kept, true);
  assert.equal(again.text, kid.text, "the kept kids answer is the filtered one");
  assert.notEqual(again.headers.etag, grown.headers.etag);
  // ann asking again still gets ann's
  const annAgain = await fromMemory(HOME("ann"));
  assert.equal(annAgain.kept, true);
  assert.equal(annAgain.text, grown.text);
  // the kids limit is part of the key: a stricter limit is a different answer at once
  profiles.setKids("kid", { maxAge: 12 });
  assert.equal((await fromMemory(HOME("kid"))).kept, false);
  profiles.setKids("kid", { maxAge: 7 });
  // the library list too
  const libKid = await get("/api/library?profile=kid");
  const libAll = await get("/api/library");
  assert.equal(libKid.status, 200);
  assert.equal(libAll.status, 200);
});

test("the TV's slim shape and the placeholder variant are answers of their own", async () => {
  memo.clear();
  const web = await get(HOME("ann"));
  const slim = await fromMemory(`${HOME("ann")}&slim=1`);
  assert.equal(slim.kept, false, "not the website's bytes");
  assert.deepEqual(slim.body.rows.map((r) => r.id), web.body.rows.map((r) => r.id), "the same rows");
  assert.equal((await fromMemory(`${HOME("ann")}&slim=1`)).kept, true);
  const blur = await fromMemory(HOME("ann"), { "X-Blur": "1" });
  assert.equal(blur.kept, false, "a client that asks for placeholders is keyed apart");
  assert.equal((await fromMemory(HOME("ann"))).kept, true, "and the plain one is still kept");
});

test("a burst of the same request: one composition, everyone answered", async () => {
  memo.clear();
  const before = { ...memo.stats };
  const answers = await Promise.all(Array.from({ length: 40 }, () => get(HOME("bob"))));
  assert.ok(answers.every((a) => a.status === 200));
  assert.equal(new Set(answers.map((a) => a.text)).size, 1);
  assert.equal(memo.stats.stored - before.stored, 1, "composed once");
  assert.equal(memo.stats.hits - before.hits, 39);
});
