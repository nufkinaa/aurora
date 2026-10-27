// "Suggest what to delete" as a list to choose from (admin → Downloads → On
// disk): GET /api/admin/library/suggest lists the suggestions, and
// POST /api/admin/library/suggest/delete deletes ONLY the ids the admin kept
// ticked — each one again checked to be still a suggestion and not being
// played (src/media/freeup.js, src/routes/admin.js).
//
// Through the REAL routes, in a private copy of the server with real files in
// a temp library (the same trick as test/delete-inuse.test.js): nothing here
// touches the repo's data/ or the live server.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const REPO = path.join(__dirname, "..");
const ADMIN = "private-test-admin";
let root, server, base;
let S, scanner, inuse, profiles, freeup;
const realFetch = global.fetch;
const admin = { "X-Admin-Password": ADMIN };
const GB = 1024 ** 3;

const call = async (method, url, { body, headers = {} } = {}) => {
  const r = await realFetch(base + url, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, body: json };
};
// What a player does: ask for some of the file's bytes (the stream route stamps it in use).
const play = async (id) => {
  const r = await realFetch(`${base}/stream/video/${id}`, { headers: { Range: "bytes=0-1023" } });
  await r.arrayBuffer();
  assert.ok(r.status === 206 || r.status === 200, `the stream route served ${id}: ${r.status}`);
};
const stopPlaying = (id) => inuse.touch(id, Date.now() - inuse.WINDOW_MS - 1000);

let movies, shows;
const writeVideo = (p, fill, size = 40000) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.alloc(size, fill)); return p; };

// Watch state, straight into the private profiles store.
const setProgress = (pid, itemId, row) => {
  const pstore = profiles._internals.store;
  pstore.data.state = pstore.data.state || {};
  pstore.data.state[pid] = pstore.data.state[pid] || { progress: {} };
  pstore.data.state[pid].progress = pstore.data.state[pid].progress || {};
  pstore.data.state[pid].progress[itemId] = row;
};
const finished = (pid, itemId, daysAgo) => setProgress(pid, itemId, { position: 2650, duration: 2700, finished: true, updatedAt: Date.now() - daysAgo * 86400e3 });
const partway = (pid, itemId) => setProgress(pid, itemId, { position: 600, duration: 2700, finished: false, updatedAt: Date.now() });

let ids = {};
let paths = {};

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-freepick-"));
  fs.cpSync(path.join(REPO, "src"), path.join(root, "src"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "package.json"), path.join(root, "package.json"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(root, "node_modules"), "junction");
  movies = path.join(root, "media", "movies");
  shows = path.join(root, "media", "shows");
  fs.mkdirSync(movies, { recursive: true });
  fs.mkdirSync(shows, { recursive: true });
  fs.mkdirSync(path.join(root, "data", "cache"), { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    port: 0, libraries: { movies: [movies], shows: [shows] }, adminPassword: ADMIN,
    onlineMetadata: false, skipDatabases: false, prewarmStreams: false, autoOcrSubtitles: false,
    preconvert: false, notifications: {}, downloadMinFreePercent: 0, authMode: "open",
  }));
  global.fetch = async (url, ...rest) => {
    if (String(url).startsWith("http://127.0.0.1:")) return realFetch(url, ...rest);
    throw new Error("network is not allowed in this test");
  };

  S = (p) => require(path.join(root, "src", p));
  const config = S("config");
  assert.ok(config.DATA_DIR.startsWith(root), "the private root is in use, not the repo's data/");
  scanner = S("media/scanner");
  inuse = S("lib/inuse");
  profiles = S("profiles");
  freeup = S("media/freeup");

  const express = require(path.join(root, "node_modules", "express"));
  const app = express();
  app.use(express.json());
  app.use(S("routes/stream"));
  app.use(S("routes/admin"));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;

  // The library: two films and a show of four episodes.
  paths.filmA = writeVideo(path.join(movies, "Old Film (2001)", "Old Film (2001).mkv"), 1, 50000);
  paths.filmB = writeVideo(path.join(movies, "Kept Film (2002)", "Kept Film (2002).mkv"), 2, 30000);
  paths.filmC = writeVideo(path.join(movies, "Unwatched Film (2003)", "Unwatched Film (2003).mkv"), 3, 20000);
  for (let e = 1; e <= 4; e++) paths[`e${e}`] = writeVideo(path.join(shows, "Pick Show", "Season 01", `Pick Show S01E0${e}.mkv`), 10 + e, 10000 + e * 1000);
  scanner.scan();
  for (const k of Object.keys(paths)) ids[k] = scanner.idForPath(paths[k]);
  for (const [k, v] of Object.entries(ids)) assert.ok(v, `${k} is in the library`);

  const pstore = profiles._internals.store;
  pstore.data.profiles.push({ id: "p-ann", name: "Ann", prefs: {} });
  pstore.data.profiles.push({ id: "p-kid", name: "Kiddo", prefs: {}, kids: { maxAge: 7 } });
  // Ann finished film A (long ago), film B and E1..E3; the kid is part-way through E3.
  finished("p-ann", ids.filmA, 300);
  finished("p-ann", ids.filmB, 10);
  finished("p-ann", ids.e1, 100);
  finished("p-ann", ids.e2, 90);
  finished("p-ann", ids.e3, 80);
  partway("p-kid", ids.e3);
});

after(async () => {
  global.fetch = realFetch;
  await new Promise((r) => server.close(r));
  await new Promise((r) => setTimeout(r, 200));
  try { fs.rmdirSync(path.join(root, "node_modules")); } catch { try { fs.unlinkSync(path.join(root, "node_modules")); } catch {} }
  if (!fs.existsSync(path.join(root, "node_modules"))) {
    for (let i = 0; i < 20 && fs.existsSync(root); i++) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
      if (fs.existsSync(root)) await new Promise((r) => setTimeout(r, 150));
    }
  }
  setTimeout(() => process.exit(process.exitCode || 0), 50).unref();
});

test("the suggestions: what was finished with nobody part-way (a kid counts), the longest-ago watched first, each with why", async () => {
  const r = await call("GET", "/api/admin/library/suggest?gb=100", { headers: admin });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const order = r.body.items.map((i) => i.id);
  assert.deepEqual(order, [ids.filmA, ids.e1, ids.e2, ids.filmB], "oldest-watched first; E3 (a kid is part-way) and the unwatched film never");
  const a = r.body.items[0];
  assert.equal(a.kind, "movie");
  assert.equal(a.name, "Old Film (2001)");
  assert.equal(a.reason, "finished");
  assert.match(a.why, /^Finished by 1 person, last watched \d+ months ago · nobody is part-way through$/);
  assert.equal(a.inUse, false);
  const e1 = r.body.items[1];
  assert.equal(e1.kind, "episode");
  assert.equal(e1.name, "Pick Show S01E01");
  assert.equal(e1.show.title, "Pick Show");
  assert.equal(e1.season, 1);
  assert.equal(e1.episode, 1);
  assert.equal(r.body.short, true, "less than 100 GB is on offer");
  assert.equal(r.body.totalBytes, r.body.items.reduce((n, i) => n + i.sizeBytes, 0));

  // a small target: just enough, in order
  const small = await call("GET", "/api/admin/library/suggest?gb=0.00001", { headers: admin });
  assert.deepEqual(small.body.items.map((i) => i.id), [ids.filmA], "50 KB is enough for ~10 KB");
  assert.equal(small.body.short, false);
});

test("the order puts stale My List downloads first, oldest add first; fresh ones never (pure)", () => {
  const now = Date.now();
  const t = {
    movies: [
      { id: "w", title: "Watched", year: 2019, watched: 2, midway: 0, lastWatched: now - 5 * 86400e3, sizeBytes: 5 },
      { id: "s2", title: "Stale Two", watched: 0, midway: 0, sizeBytes: 3, mylist: { state: "stale", why: "added to My List on 2026-09-20, never watched", addedAt: 20 } },
      { id: "s1", title: "Stale One", watched: 0, midway: 0, sizeBytes: 4, mylist: { state: "stale", why: "added on day 10", addedAt: 10 } },
      { id: "f", title: "Fresh", watched: 0, midway: 0, sizeBytes: 9, mylist: { state: "fresh", why: "x", addedAt: 1 } },
      { id: "busy", title: "Busy", watched: 1, midway: 0, streaming: true, lastWatched: 1, sizeBytes: 7 },
    ],
    shows: [],
  };
  const c = freeup.candidates(t, now);
  assert.deepEqual(c.map((x) => x.id), ["s1", "s2", "busy", "w"]);
  assert.equal(c[1].why, "My List download — added to My List on 2026-09-20, never watched");
  assert.equal(c[3].why, "Finished by 2 people, last watched 5 days ago · nobody is part-way through");
  // the one being played is listed where it falls, but never counted
  const s = freeup.suggest(t, 100, now);
  assert.equal(s.items.find((x) => x.id === "busy").inUse, true);
  assert.equal(s.totalBytes, 4 + 3 + 5);
  assert.equal(s.availableBytes, 12);
});

test("the guards: admin only; nothing chosen, a bad list or a bad target is refused", async () => {
  const noPw = await call("POST", "/api/admin/library/suggest/delete", { body: { ids: [ids.filmA] } });
  assert.equal(noPw.status, 403);
  assert.equal((await call("GET", "/api/admin/library/suggest?gb=5")).status, 403);
  const none = await call("POST", "/api/admin/library/suggest/delete", { body: { ids: [] }, headers: admin });
  assert.equal(none.status, 400);
  assert.equal(none.body.error, "Nothing was chosen.");
  assert.equal((await call("POST", "/api/admin/library/suggest/delete", { body: { ids: "x" }, headers: admin })).status, 400);
  assert.equal((await call("POST", "/api/admin/library/suggest/delete", { body: {}, headers: admin })).status, 400);
  assert.equal((await call("POST", "/api/admin/library/suggest/delete", { body: { ids: [5, null, {}] }, headers: admin })).status, 400);
  assert.equal((await call("GET", "/api/admin/library/suggest?gb=0", { headers: admin })).status, 400);
  assert.equal((await call("GET", "/api/admin/library/suggest?gb=abc", { headers: admin })).status, 400);
  assert.equal(fs.existsSync(paths.filmA), true, "nothing was deleted");
});

test("an unknown id and a library item that is not a suggestion (a kid is part-way, never watched) are skipped, with why", async () => {
  const r = await call("POST", "/api/admin/library/suggest/delete", { body: { ids: ["nope00000000", ids.e3, ids.filmC] }, headers: admin });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.deleted, []);
  assert.equal(r.body.freedBytes, 0);
  const why = Object.fromEntries(r.body.skipped.map((x) => [x.id, x]));
  assert.equal(why.nope00000000.reason, "unknown");
  assert.equal(why[ids.e3].reason, "not-suggested");
  assert.equal(why[ids.e3].name, "Pick Show S01E03");
  assert.equal(why[ids.filmC].reason, "not-suggested");
  assert.equal(fs.existsSync(paths.e3), true, "the kid's episode stays");
  assert.equal(fs.existsSync(paths.filmC), true);
});

test("one being played right now: listed as in use, not counted, and skipped by the delete — then deletable once they stopped", async () => {
  await play(ids.e2);
  const s = await call("GET", "/api/admin/library/suggest?gb=100", { headers: admin });
  const row = s.body.items.find((i) => i.id === ids.e2);
  assert.equal(row.inUse, true);
  assert.equal(s.body.totalBytes, s.body.items.filter((i) => i.id !== ids.e2).reduce((n, i) => n + i.sizeBytes, 0), "not counted");
  const r = await call("POST", "/api/admin/library/suggest/delete", { body: { ids: [ids.e2] }, headers: admin });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.deleted, []);
  assert.equal(r.body.skipped[0].reason, "in-use");
  assert.match(r.body.skipped[0].why, /^Being watched right now/);
  assert.equal(fs.existsSync(paths.e2), true, "not from under a viewer");
  stopPlaying(ids.e2);
});

test("a subset: only the ticked ids are deleted (a film's folder, an episode's file), the rest stay suggested", async () => {
  const r = await call("POST", "/api/admin/library/suggest/delete", { body: { ids: [ids.filmA, ids.e1, ids.filmA] }, headers: admin });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.deleted.map((x) => x.id).sort(), [ids.filmA, ids.e1].sort(), "each once");
  assert.deepEqual(r.body.skipped, []);
  assert.equal(r.body.freedBytes, 50000 + 11000);
  assert.equal(fs.existsSync(path.dirname(paths.filmA)), false, "the film's folder is gone");
  assert.equal(fs.existsSync(paths.e1), false);
  for (const k of ["filmB", "e2", "e3", "e4", "filmC"]) assert.equal(fs.existsSync(paths[k]), true, `${k} was not chosen and stays`);
  // the list refreshes: what is left
  const s = await call("GET", "/api/admin/library/suggest?gb=100", { headers: admin });
  assert.deepEqual(s.body.items.map((i) => i.id), [ids.e2, ids.filmB]);
  // the same id again: it is gone now
  const again = await call("POST", "/api/admin/library/suggest/delete", { body: { ids: [ids.e1] }, headers: admin });
  assert.equal(again.body.skipped[0].reason, "unknown");
});

test("somebody started a suggested film since the list was shown: it is no longer a suggestion and stays", async () => {
  partway("p-kid", ids.filmB);
  const r = await call("POST", "/api/admin/library/suggest/delete", { body: { ids: [ids.filmB, ids.e2] }, headers: admin });
  assert.deepEqual(r.body.deleted.map((x) => x.id), [ids.e2]);
  assert.equal(r.body.skipped[0].id, ids.filmB);
  assert.equal(r.body.skipped[0].reason, "not-suggested");
  assert.equal(fs.existsSync(paths.filmB), true);
  assert.equal(fs.existsSync(paths.e2), false);
});
