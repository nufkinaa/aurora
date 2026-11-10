// GET /api/profiles/:id/state kept between changes (perf-server 2026-11-10),
// through the real route, in a PRIVATE copy of the server (as
// test/home-memo.test.js: src/ copied to a temp root with its own config.json
// and data/, every outside request refused).
//
// Pinned: the answer is byte for byte what the route composes; asked again
// with nothing changed it is served from memory; EVERY kind of write that
// changes it — a playback save, a mark, a rating, liked genres, a forgotten
// title, the library, the IMDb ids — ends the kept answer at once; somebody
// else watching does not; and it is its own pool (Home's kept answers are
// never pushed out by it).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const zlib = require("zlib");

const REPO = path.join(__dirname, "..");
let root, server, base, S, profiles, memo, pool, scanner;
const realFetch = global.fetch;

const get = (url, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = http.get(base + url, { headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        const enc = res.headers["content-encoding"];
        const text = (enc === "br" ? zlib.brotliDecompressSync(raw) : enc === "gzip" ? zlib.gunzipSync(raw) : raw).toString("utf8");
        resolve({ status: res.statusCode, headers: res.headers, text });
      });
    });
    req.on("error", reject);
  });

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-state-kept-"));
  fs.cpSync(path.join(REPO, "src"), path.join(root, "src"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "package.json"), path.join(root, "package.json"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(root, "node_modules"), "junction");
  fs.mkdirSync(path.join(root, "data", "cache"), { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    port: 0, libraries: { movies: [], shows: [] }, onlineMetadata: false, skipDatabases: false,
    autoOcrSubtitles: false, notifications: {}, authMode: "open",
  }));
  global.fetch = async (url, ...rest) => {
    if (String(url).startsWith("http://127.0.0.1:")) return realFetch(url, ...rest);
    throw new Error("network is not allowed in this test");
  };
  S = (p) => require(path.join(root, "src", p));
  const config = S("config");
  assert.ok(config.DATA_DIR.startsWith(root), "the private root is in use, not the repo's data/");
  profiles = S("profiles");
  const store = profiles._internals.store;
  for (const id of ["ann", "bob"]) store.data.profiles.push({ id, name: id, color: "#888", avatar: "x" });
  memo = S("lib/answermemo");
  scanner = S("media/scanner");
  // a history worth keeping: films and episodes, streamed and not
  for (let i = 0; i < 300; i++) profiles.setProgress("ann", `torrent|${String(i).padStart(40, "a")}|0`, 600 + i, 6000, { title: `Film ${i}`, imdbId: `tt${9200000 + i}`, type: "movie" });
  profiles.setRating("ann", "tt9200001", 4);

  const express = require(path.join(root, "node_modules", "express"));
  const app = express();
  app.use(express.json());
  app.use(S("lib/blurup").middleware);
  app.use(S("routes/profiles"));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  pool = [...memo.pools].find((p) => p.name === "profile state");
});

after(() => {
  global.fetch = realFetch;
  if (server) server.close();
  try { fs.rmdirSync(path.join(root, "node_modules")); } catch { try { fs.unlinkSync(path.join(root, "node_modules")); } catch {} } // the link first, by itself
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

const STATE = (p) => `/api/profiles/${p}/state`;
// what the route composes, as Express's res.json writes it
const composed = (p) => JSON.stringify({
  progress: profiles.getProgressView(p),
  ratings: profiles.getRatings(p),
  likedGenres: profiles.getLikedGenres(p),
  episodeProgress: profiles.streamEpisodeProgress(p),
  streamProgress: profiles.streamTitleProgress(p),
});
const ask = async (p, headers) => {
  const before = pool.stats.hits;
  const r = await get(STATE(p), headers);
  return { ...r, kept: pool.stats.hits === before + 1 };
};

test("the answer is what the route composes, and is kept while nothing changes", async () => {
  pool.clear();
  const first = await ask("ann", { "X-Blur": "1" });
  assert.equal(first.status, 200);
  assert.equal(first.kept, false);
  assert.equal(first.text, composed("ann"), "byte for byte");
  const second = await ask("ann", { "X-Blur": "1", "Accept-Encoding": "gzip, deflate, br" });
  assert.equal(second.kept, true);
  assert.equal(second.headers["content-encoding"], "br");
  assert.equal(second.text, first.text);
  const plain = await ask("ann", { "X-Blur": "1" });
  assert.equal(plain.kept, true);
  assert.equal(plain.text, first.text);
  // a client that has it: 304
  const again = await get(STATE("ann"), { "X-Blur": "1", "If-None-Match": plain.headers.etag });
  assert.equal(again.status, 304);
  // without placeholders asked: its own entry, the same bytes (state names no picture)
  const noBlur = await ask("ann", {});
  assert.equal(noBlur.kept, false);
  assert.equal(noBlur.text, first.text);
  // not a profile: refused before anything is kept
  assert.equal((await get(STATE("nobody"))).status, 404);
  assert.ok(![...pool._internals.entries.keys()].some((k) => k.includes("nobody")));
});

test("every write that changes the answer ends the kept one at once", async () => {
  const fresh = async (why, change) => {
    await ask("ann", {});
    assert.equal((await ask("ann", {})).kept, true, `primed (${why})`);
    change();
    const r = await ask("ann", {});
    assert.equal(r.kept, false, why);
    assert.equal(r.text, composed("ann"), `${why}: the new answer`);
  };
  await fresh("a playback save (the watch journal, not a full write)", () => profiles.setProgress("ann", `torrent|${"a".repeat(40)}|0`, 700, 6000));
  await fresh("a playback tick a few seconds on", () => profiles.setProgress("ann", `torrent|${"a".repeat(40)}|0`, 705, 6000));
  await fresh("a new title played", () => profiles.setProgress("ann", `torrent|${"b".repeat(40)}|0`, 30, 6000, { title: "New", imdbId: "tt9299999", type: "movie" }));
  await fresh("a rating", () => profiles.setRating("ann", "tt9200002", 5));
  await fresh("liked genres", () => profiles.setLikedGenres("ann", ["Drama"]));
  await fresh("marked watched", () => profiles.markProgress("ann", [{ itemId: `torrent|${"a".repeat(40)}|0`, watched: true, duration: 6000 }]));
  await fresh("marked unwatched", () => profiles.markProgress("ann", [{ itemId: `torrent|${"a".repeat(40)}|0`, watched: false }]));
  await fresh("a title forgotten", () => profiles.clearProgress("ann", `torrent|${"b".repeat(40)}|0`));
  await fresh("any write of profiles.json", () => profiles._internals.store.save());
  await fresh("the library changed", () => { scanner.index.version = (scanner.index.version || 0) + 1; });
});

test("somebody else watching leaves my kept answer alone; nothing is kept past two minutes", async () => {
  await ask("ann", {});
  for (let i = 0; i < 5; i++) profiles.setProgress("bob", `torrent|${"d".repeat(40)}|0`, 100 + i * 5, 6000, { title: "Bob's", imdbId: "tt9288888", type: "movie" });
  assert.equal((await ask("ann", {})).kept, true, "bob watching: ann's answer stays");
  const bob = await ask("bob", {});
  assert.equal(bob.text, composed("bob"));
  for (const e of pool._internals.entries.values()) e.at = Date.now() - pool.MAX_AGE_MS - 1;
  assert.equal((await ask("ann", {})).kept, false);
});

test("its own pool: Home's kept answers are not pushed out, and the pool is bounded", async () => {
  memo.clear();
  pool.clear();
  await ask("ann", {});
  await ask("bob", {});
  assert.equal(memo._internals.entries.size, 0, "nothing in Home's pool");
  assert.equal(pool._internals.entries.size, 2);
  assert.ok(pool.MAX_ENTRIES <= 64);
});
