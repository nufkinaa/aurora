// "Free up space" through the REAL routes (src/routes/admin.js):
// GET /api/admin/library/freeup lists what is safe to remove (with the disk
// forecast), POST /api/admin/library/freeup/delete removes ONLY the keys the
// admin confirmed, each checked again — still safe, nobody playing it — and
// through the existing deletes (a film's folder, an episode's file, one copy).
//
// A private copy of the server with real files in a temp library (the trick
// of test/admin-free-pick.test.js): nothing here touches the repo's data/.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const REPO = path.join(__dirname, "..");
const ADMIN = "private-test-admin";
const DAY = 86400e3;
let root, server, base;
let S, scanner, inuse, profiles;
const realFetch = global.fetch;
const admin = { "X-Admin-Password": ADMIN };

const call = async (method, url, { body, headers = admin } = {}) => {
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
const play = async (id) => {
  const r = await realFetch(`${base}/stream/video/${id}`, { headers: { Range: "bytes=0-1023" } });
  await r.arrayBuffer();
  assert.ok(r.status === 206 || r.status === 200, `the stream route served ${id}: ${r.status}`);
};
const stopPlaying = (id) => inuse.touch(id, Date.now() - inuse.WINDOW_MS - 1000);
const writeVideo = (p, fill, size, daysOld) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(size, fill));
  const t = (Date.now() - daysOld * DAY) / 1000;
  fs.utimesSync(p, t, t);
  return p;
};
const pstate = (pid) => {
  const st = profiles._internals.store.data;
  st.state = st.state || {};
  st.state[pid] = st.state[pid] || {};
  st.state[pid].progress = st.state[pid].progress || {};
  st.state[pid].watchlist = st.state[pid].watchlist || [];
  return st.state[pid];
};
const finished = (pid, id) => { pstate(pid).progress[id] = { position: 2650, duration: 2700, finished: true, updatedAt: Date.now() - 5 * DAY }; };
const partway = (pid, id) => { pstate(pid).progress[id] = { position: 600, duration: 2700, finished: false, updatedAt: Date.now() }; };
const onList = (pid, id) => { pstate(pid).watchlist.push(id); };

const paths = {};
const ids = {};
let movies, shows;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-freespace-"));
  fs.cpSync(path.join(REPO, "src"), path.join(root, "src"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "package.json"), path.join(root, "package.json"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(root, "node_modules"), "junction");
  movies = path.join(root, "media", "movies");
  shows = path.join(root, "media", "shows");
  fs.mkdirSync(movies, { recursive: true });
  fs.mkdirSync(shows, { recursive: true });
  fs.mkdirSync(path.join(root, "data", "cache"), { recursive: true });
  // 3 days of download history: two finished downloads
  const iso = (d) => new Date(Date.now() - d * DAY).toISOString();
  fs.writeFileSync(path.join(root, "data", "downloads.json"), JSON.stringify([
    { id: "dlaaaaaaaaa1", title: "Older Pull", type: "movie", status: "done", at: iso(3), doneAt: iso(2.5), sizeBytes: 6 * 1024 ** 3 },
    { id: "dlaaaaaaaaa2", title: "Newer Pull", type: "movie", status: "done", at: iso(1), doneAt: iso(0.5), sizeBytes: 3 * 1024 ** 3 },
  ]));
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

  const express = require(path.join(root, "node_modules", "express"));
  const app = express();
  app.use(express.json());
  app.use(S("routes/stream"));
  app.use(S("routes/admin"));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;

  paths.safe = writeVideo(path.join(movies, "Safe Film (2001)", "Safe Film (2001).mkv"), 1, 50000, 94);
  paths.midway = writeVideo(path.join(movies, "Midway Film (2002)", "Midway Film (2002).mkv"), 2, 40000, 94);
  paths.listed = writeVideo(path.join(movies, "Listed Film (2003)", "Listed Film (2003).mkv"), 3, 30000, 94);
  paths.fresh = writeVideo(path.join(movies, "Fresh Film (2004)", "Fresh Film (2004).mkv"), 4, 20000, 5);
  paths.later = writeVideo(path.join(movies, "Later Film (2005)", "Later Film (2005).mkv"), 5, 25000, 94);
  // one film held twice in its folder: the bigger 1080p is the one indexed
  paths.twiceA = writeVideo(path.join(movies, "Twice Film (2010)", "A Twice Film 1080p.mkv"), 6, 60000, 94);
  paths.twiceB = writeVideo(path.join(movies, "Twice Film (2010)", "B Twice Film 720p.mkv"), 7, 20000, 94);
  for (let e = 1; e <= 3; e++) paths[`e${e}`] = writeVideo(path.join(shows, "Free Show", "Season 01", `Free Show S01E0${e}.mkv`), 10 + e, 10000 + e * 1000, 120);
  scanner.scan();
  for (const k of Object.keys(paths)) if (k !== "twiceB") ids[k] = scanner.idForPath(paths[k]);
  for (const [k, v] of Object.entries(ids)) assert.ok(v, `${k} is in the library`);

  const pstore = profiles._internals.store;
  pstore.data.profiles.push({ id: "p-ann", name: "Ann", prefs: {} });
  pstore.data.profiles.push({ id: "p-ben", name: "Ben", prefs: {} });
  for (const k of ["safe", "midway", "listed", "fresh", "later", "e1", "e2", "e3"]) finished("p-ann", ids[k]);
  finished("p-ben", ids.safe);
  partway("p-ben", ids.midway);
  onList("p-ben", ids.listed);
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

test("admin only", async () => {
  assert.equal((await call("GET", "/api/admin/library/freeup", { headers: {} })).status, 403);
  assert.equal((await call("POST", "/api/admin/library/freeup/delete", { body: { keys: ["m:x"] }, headers: {} })).status, 403);
});

test("the list: finished by everyone who started it, on nobody's My List, old enough — plus the extra copy; with the forecast", async () => {
  const r = await call("GET", "/api/admin/library/freeup?days=60");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body;
  assert.equal(d.days, 60);
  const keys = d.safe.map((x) => x.key).sort();
  assert.deepEqual(keys, [`m:${ids.later}`, `m:${ids.safe}`, `s:${scanner.index.shows[0].id}`].sort(), "midway (Ben is part-way), listed (Ben's My List), fresh (5 days) and the unwatched Twice Film are not offered");
  const safe = d.safe.find((x) => x.key === `m:${ids.safe}`);
  assert.equal(safe.why, "watched by Ann and Ben, nobody's My List, 94 days old");
  const show = d.safe.find((x) => x.kind === "show");
  assert.match(show.why, /^3 episodes \(S01E01–S01E03\) watched by Ann, nobody's My List, 120\+ days old$/);
  assert.equal(d.duplicates.length, 1);
  assert.equal(d.duplicates[0].fileName, "B Twice Film 720p.mkv");
  assert.match(d.duplicates[0].why, /^an extra 720p copy — the 1080p copy \(.+\) stays and is the one the app plays$/);
  assert.equal(d.totals.all.count, 4);
  // the forecast: 9 GB in the 3 days recorded so far
  assert.equal(d.forecast.state, "filling");
  assert.match(d.forecast.line, /until full at the pace of the 3 days recorded so far$/);
  assert.ok(d.disk.free > 0);
  // fewer days lets the fresh one in
  const zero = await call("GET", "/api/admin/library/freeup?days=0");
  assert.ok(zero.body.safe.some((x) => x.key === `m:${ids.fresh}`));
  // the Downloads screen's disk answer carries the same forecast
  const disk = await call("GET", "/api/admin/disk");
  assert.equal(disk.body.forecast.state, "filling");
  assert.equal(disk.body.forecast.line, d.forecast.line);
});

test("remove: only the confirmed keys, each checked again; a key no longer safe and a made-up key are kept", async () => {
  // between the list and the yes, Ben puts Later Film on his My List
  onList("p-ben", ids.later);
  const dup = (await call("GET", "/api/admin/library/freeup?days=60")).body.duplicates[0];
  const r = await call("POST", "/api/admin/library/freeup/delete", { body: { keys: [`m:${ids.safe}`, dup.key, `m:${ids.later}`, `m:${ids.midway}`, "m:nope"], days: 60 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.deleted.map((x) => x.key).sort(), [`m:${ids.safe}`, dup.key].sort());
  assert.deepEqual(r.body.skipped.map((x) => [x.key, x.reason]).sort(), [[`m:${ids.later}`, "not-safe"], [`m:${ids.midway}`, "not-safe"], ["m:nope", "not-safe"]].sort());
  assert.ok(r.body.freedBytes >= 50000 + 20000);
  assert.ok(!fs.existsSync(paths.safe), "the safe film's file is gone");
  assert.ok(!fs.existsSync(path.dirname(paths.safe)), "with its folder (the On disk delete)");
  assert.ok(!fs.existsSync(paths.twiceB), "the extra copy is gone");
  assert.ok(fs.existsSync(paths.twiceA), "the copy that stays, stays");
  for (const k of ["midway", "listed", "fresh", "later"]) assert.ok(fs.existsSync(paths[k]), `${k} is untouched`);
  // the list no longer offers them
  const after = (await call("GET", "/api/admin/library/freeup?days=60")).body;
  assert.ok(!after.safe.some((x) => x.key === `m:${ids.safe}`));
  assert.equal(after.duplicates.length, 0);
});

test("a show's episode being played is kept; the others go", async () => {
  await play(ids.e2);
  const d = (await call("GET", "/api/admin/library/freeup?days=60")).body;
  const show = d.safe.find((x) => x.kind === "show");
  assert.deepEqual(show.ids.sort(), [ids.e1, ids.e3].sort(), "the one being played is not among what it removes");
  assert.equal(show.episodes.find((e) => e.id === ids.e2).inUse, true);
  const r = await call("POST", "/api/admin/library/freeup/delete", { body: { keys: [show.key], days: 60 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.deleted.length, 1);
  assert.ok(!fs.existsSync(paths.e1) && !fs.existsSync(paths.e3));
  assert.ok(fs.existsSync(paths.e2), "the one being played stays");
  stopPlaying(ids.e2);
});

test("bad bodies are refused", async () => {
  assert.equal((await call("POST", "/api/admin/library/freeup/delete", { body: {} })).status, 400);
  assert.equal((await call("POST", "/api/admin/library/freeup/delete", { body: { keys: [] } })).status, 400);
  assert.equal((await call("POST", "/api/admin/library/freeup/delete", { body: { keys: "m:x" } })).status, 400);
});
