// Continue Watching's history writes (cw-fix, 2026-11-19), through the real
// profiles.js in a PRIVATE copy of the server (as test/state-kept.test.js:
// src/ copied to a temp root with its own config.json and data/):
//   - a late save (an offline copy's queued minutes) carries `at`: older than
//     the title's history it is dropped, newer it keeps its own time — it
//     used to be stamped "now" and take the row back to the plane's episode;
//   - the Undo of a ✕ (`undo`) brings the series back (the ✕ stamped it off
//     the row) in its old place (`at`);
//   - the route says `stale` for a dropped save;
//   - a library episode whose file is gone is known again by its title row.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const REPO = path.join(__dirname, "..");
let root, server, base, S, profiles;
const realFetch = global.fetch;

const post = (url, body) =>
  new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(base + url, { method: "POST", agent: false, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") }));
    });
    req.on("error", reject);
    req.end(data);
  });

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-cw-history-"));
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
  assert.ok(S("config").DATA_DIR.startsWith(root), "the private root is in use, not the repo's data/");
  profiles = S("profiles");
  const store = profiles._internals.store;
  for (const id of ["ann", "bob"]) store.data.profiles.push({ id, name: id, color: "#888", avatar: "x" });
  const express = require(path.join(root, "node_modules", "express"));
  const app = express();
  app.use(express.json());
  app.use(S("routes/profiles"));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  global.fetch = realFetch;
  if (server) server.close();
  try { fs.rmdirSync(path.join(root, "node_modules")); } catch { try { fs.unlinkSync(path.join(root, "node_modules")); } catch {} } // the link first, by itself
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

const SILO = (hash, season, episode) => ({ id: `torrent|${hash.padEnd(40, "0")}|0`, type: "movie", title: `Silo · S${season} E${episode}`, imdbId: "tt14688458", season, episode });
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); // (each save its own millisecond)
const ids = (p) => profiles.continueWatching(p).map((i) => i.id);

test("a late save older than the title's history is dropped; a newer one keeps its own time", () => {
  const e3 = SILO("a3", 1, 3);
  const e5 = SILO("a5", 1, 5);
  const t0 = Date.now() - 60 * 60 * 1000;
  // on the plane (an hour ago): E3 to 20 minutes — queued on the phone
  // meanwhile, on the TV: E5, now
  profiles.setProgress("ann", e5.id, 900, 3000, e5);
  pause();
  assert.deepEqual(ids("ann"), [e5.id]);
  // the phone lands and sends its queue: E3 is older than the row the series' newest?
  // E3 has no row: written, with its own time — so it is not the newest
  assert.equal(profiles.setProgress("ann", e3.id, 1200, 3000, e3, { at: t0 }), true);
  assert.equal(profiles.getProgress("ann")[e3.id].updatedAt, t0);
  assert.deepEqual(ids("ann"), [e5.id], "red before: the replay was stamped now and E3 took the series' card");
  // the same episode watched further on the TV than the queued spot: the queued one is dropped
  profiles.setProgress("ann", e5.id, 1500, 3000, e5);
  assert.equal(profiles.setProgress("ann", e5.id, 600, 3000, e5, { at: t0 + 1000 }), false);
  assert.equal(profiles.getProgress("ann")[e5.id].position, 1500);
  // a stamp from the future is never later than now
  const before = Date.now();
  profiles.setProgress("ann", e5.id, 1600, 3000, e5, { at: Date.now() + 10 * 60 * 1000 });
  assert.ok(profiles.getProgress("ann")[e5.id].updatedAt <= Date.now() && profiles.getProgress("ann")[e5.id].updatedAt >= before);
});

test("the route: a dropped late save answers stale; an ordinary save is as before", async () => {
  const e = SILO("b1", 2, 1);
  let r = await post("/api/profiles/bob/progress", { itemId: e.id, position: 900, duration: 3000, item: e });
  assert.deepEqual(r.body, { ok: true });
  r = await post("/api/profiles/bob/progress", { itemId: e.id, position: 300, duration: 3000, item: e, at: Date.now() - 3600 * 1000 });
  assert.deepEqual(r.body, { ok: true, stale: true });
  assert.equal(profiles.getProgress("bob")[e.id].position, 900);
  r = await post("/api/profiles/bob/progress", { itemId: e.id, position: 950, duration: 3000, item: e, at: "soon" });
  assert.deepEqual(r.body, { ok: true }, "a malformed `at` is ignored: an ordinary save");
  assert.equal(profiles.getProgress("bob")[e.id].position, 950);
});

test("Undo of a ✕: the series comes back, in its old place", () => {
  const film = { id: `torrent|${"f1".padEnd(40, "0")}|0`, type: "movie", title: "Arrival", imdbId: "tt2543164" };
  const ep = SILO("c2", 1, 2);
  profiles.setProgress("bob", ep.id, 800, 3000, ep);
  const was = { ...profiles.getProgress("bob")[ep.id] };
  pause();
  profiles.setProgress("bob", film.id, 1200, 6900, film);
  assert.deepEqual(ids("bob").slice(0, 2), [film.id, ep.id]);
  profiles.clearProgress("bob", ep.id);
  assert.ok(!ids("bob").includes(ep.id), "the ✕ took the series off");
  // what the website's Undo sends: the row back, `at` its old stamp, `undo`
  profiles.setProgress("bob", ep.id, was.position, was.duration, ep, { at: was.updatedAt, undo: true });
  assert.deepEqual(ids("bob").slice(0, 2), [film.id, ep.id], "red before: hidden (the ✕'s stamp is newer than the old row), or first");
  assert.equal(profiles.stateOf("bob").cwHidden.tt14688458, undefined);
});

test("a library episode whose file is gone is known by the title row it wrote", () => {
  const state = { progress: { gone1: { position: 3000, duration: 3000, finished: true, updatedAt: 5 } }, streamItems: {}, titles: { "tt14688458:1:2": { position: 3000, duration: 3000, finished: true, updatedAt: 5, itemId: "gone1" }, "tt2543164": { itemId: "film9", updatedAt: 1 } } };
  const d = profiles._internals.continueDeps(state);
  assert.deepEqual(d.goneEpisode("gone1"), { imdbId: "tt14688458", season: 1, episode: 2 });
  assert.equal(d.goneEpisode("film9"), null, "a film's row is no episode");
  assert.equal(d.goneEpisode("nope"), null);
});

test("a late save from a device whose clock is behind: how long ago is read from its own clock (sentAt)", () => {
  const e = SILO("d7", 3, 1);
  const behind = 10 * 60 * 1000; // the phone's clock runs ten minutes slow
  // another device saved this episode just now (server clock)
  profiles.setProgress("ann", e.id, 600, 3000, e);
  pause();
  // the phone, with no server, watched on to 20:00 a moment later; on its own
  // clock that moment reads ten minutes ago, and it sends right away
  const phoneNow = Date.now() - behind;
  assert.equal(profiles.setProgress("ann", e.id, 1200, 3000, e, { at: phoneNow }), false,
    "(as before, `at` alone: ten minutes \"old\" on the server's clock — dropped)");
  const ok = profiles.setProgress("ann", e.id, 1200, 3000, e, { at: phoneNow, sentAt: phoneNow });
  assert.equal(ok, true, "with sentAt the phone's clock being slow does not matter");
  assert.equal(profiles.getProgress("ann")[e.id].position, 1200);
  assert.ok(Math.abs(profiles.getProgress("ann")[e.id].updatedAt - Date.now()) < 2000, "stamped on the server's clock");
  const at = phoneNow - 60 * 60 * 1000;
  // and one really older than the server's history is still dropped
  profiles.setProgress("ann", e.id, 1500, 3000, e);
  assert.equal(profiles.setProgress("ann", e.id, 900, 3000, e, { at, sentAt: phoneNow + 5 * 60 * 1000 }), false);
});

test("the Undo of a ✕ is written to profiles.json (the journal does not carry the lifted hide)", () => {
  const ep = SILO("u5", 4, 2);
  profiles.setProgress("bob", ep.id, 800, 3000, ep);
  const was = { ...profiles.getProgress("bob")[ep.id] };
  profiles.clearProgress("bob", ep.id);
  const store = profiles._internals.store;
  store.flush();
  assert.equal(store.dirty, false);
  profiles.setProgress("bob", ep.id, was.position, was.duration, ep, { at: was.updatedAt, undo: true });
  assert.equal(store.dirty, true, "red before: only the journal heard of it");
  store.flush();
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, "data", "profiles.json"), "utf-8"));
  assert.equal((onDisk.state.bob.cwHidden || {}).tt14688458, undefined, "the hide is gone on disk too");
});
