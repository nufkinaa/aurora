// The 45-day rule through the REAL routes, on a private copy of the server
// with throwaway files in a temp library (nothing here touches the repo's
// data/ or any real library):
//   GET  /api/admin/library/freeup           the groups: Nobody watched for N
//        days, Never played, Kept for people who are away, Kept by you, …
//   POST /api/admin/library/freeup/delete    removes ONLY the keys the admin
//        confirmed, each checked again; an away person's title only with the
//        stronger confirmation; every removal in "Removed recently"
//   POST /api/admin/library/keep             the Keep pin
//   POST /api/admin/library/freeup/settings  days, uploads, My List
// and the proof that listing — any number of times — never removes a file.
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
let S, scanner, profiles, untouched, busyfiles;
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
const writeVideo = (p, fill, size, daysOld) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(size, fill));
  const t = (Date.now() - daysOld * DAY) / 1000;
  fs.utimesSync(p, t, t);
  return p;
};
const list = async () => {
  const r = await call("GET", "/api/admin/library/freeup?days=60");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const keysOf = (rows) => rows.map((r) => r.key).sort();

const paths = {};
const ids = {};
let movies, shows;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-untouched-"));
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
  profiles = S("profiles");
  untouched = S("media/untouched");
  busyfiles = S("lib/busyfiles");

  const express = require(path.join(root, "node_modules", "express"));
  const app = express();
  app.use(express.json());
  app.use(S("routes/stream"));
  app.use(S("routes/admin"));
  app.use(S("routes/profiles"));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;

  paths.played = writeVideo(path.join(movies, "Played Long Ago (2001)", "Played Long Ago (2001).mkv"), 1, 50000, 120);
  paths.never = writeVideo(path.join(movies, "Never Played (2002)", "Never Played (2002).mkv"), 2, 40000, 90);
  paths.fresh = writeVideo(path.join(movies, "Fresh Arrival (2003)", "Fresh Arrival (2003).mkv"), 3, 30000, 10);
  paths.awayLast = writeVideo(path.join(movies, "Her Last Film (2004)", "Her Last Film (2004).mkv"), 4, 35000, 120);
  paths.pinned = writeVideo(path.join(movies, "Keep This (2005)", "Keep This (2005).mkv"), 5, 25000, 200);
  paths.busy = writeVideo(path.join(movies, "Being Moved (2006)", "Being Moved (2006).mkv"), 6, 20000, 200);
  paths.watchNow = writeVideo(path.join(movies, "Watched Today (2007)", "Watched Today (2007).mkv"), 7, 20000, 200);
  for (let e = 1; e <= 3; e++) paths[`e${e}`] = writeVideo(path.join(shows, "Old Show", "Season 01", `Old Show S01E0${e}.mkv`), 10 + e, 10000 + e * 1000, 150);
  scanner.scan();
  for (const k of Object.keys(paths)) ids[k] = scanner.idForPath(paths[k]);
  for (const [k, v] of Object.entries(ids)) assert.ok(v, `${k} is in the library`);

  const pstore = profiles._internals.store;
  pstore.data.profiles.push({ id: "p-ann", name: "Ann", prefs: {} });
  pstore.data.profiles.push({ id: "p-maya", name: "Maya", prefs: {} });
  // what the module remembers: Ann played the old film 100 days ago and has
  // been on Aurora since; Maya's last play was her film, 80 days ago, and she
  // has not been connected at all since
  const d = untouched._internals.data();
  d.since = Date.now() - 200 * DAY;
  d.plays[ids.played] = { at: Date.now() - 100 * DAY, by: "p-ann" };
  d.plays[ids.awayLast] = { at: Date.now() - 80 * DAY, by: "p-maya" };
  d.lastPlay["p-ann"] = { itemId: ids.played, key: null, at: Date.now() - 100 * DAY };
  d.returns["p-ann"] = { watchAt: Date.now() - 100 * DAY, at: Date.now() - 99 * DAY };
  d.lastPlay["p-maya"] = { itemId: ids.awayLast, key: null, at: Date.now() - 80 * DAY };
  d.lastSeen["p-maya"] = Date.now() - 80 * DAY;
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
  assert.equal((await call("POST", "/api/admin/library/keep", { body: { id: "x", on: true }, headers: {} })).status, 403);
  assert.equal((await call("POST", "/api/admin/library/freeup/settings", { body: { untouchedDays: 10 }, headers: {} })).status, 403);
});

test("a real play through the progress route moves the clock; opening a film does not", async () => {
  const id = ids.watchNow;
  const save = (position) => call("POST", "/api/profiles/p-ann/progress", { body: { itemId: id, position, duration: 6000 }, headers: {} });
  assert.equal((await save(0)).status, 200);
  assert.ok(!untouched._internals.data().plays[id], "opened at the start: not a play");
  assert.equal((await save(6)).status, 200);
  const p = untouched._internals.data().plays[id];
  assert.ok(p && Date.now() - p.at < 60e3 && p.by === "p-ann", "six seconds played: a play, by Ann, now");
});

test("the groups, with why — and listing never removes a file", async () => {
  const before = Object.fromEntries(Object.entries(paths).map(([k, p]) => [k, fs.statSync(p).size]));
  let d;
  for (let i = 0; i < 5; i++) d = await list();
  for (const [k, p] of Object.entries(paths)) assert.equal(fs.existsSync(p) && fs.statSync(p).size, before[k], `${k} is still there after five listings`);
  assert.deepEqual(keysOf(d.idle), [`x:${ids.played}`]);
  assert.equal(d.idle[0].why.replace(/on \w+ \d+(, \d{4})?/, "on <day>"), "Nobody watched for 100 days · last played by Ann on <day>");
  assert.deepEqual(keysOf(d.never), [`x:${ids.never}`, `x:${ids.e1}`, `x:${ids.e2}`, `x:${ids.e3}`, `x:${ids.pinned}`, `x:${ids.busy}`].sort());
  assert.match(d.never.find((r) => r.id === ids.never).why, /^Never played · arrived \w+ \d+(, \d{4})?$/);
  assert.ok(!d.never.some((r) => r.id === ids.fresh), "ten days old: not suggested");
  assert.ok(![...d.idle, ...d.never].some((r) => r.id === ids.watchNow), "played a moment ago: not suggested");
  assert.deepEqual(keysOf(d.away), [`a:${ids.awayLast}`]);
  assert.match(d.away[0].why, /^Kept for Maya — away since \w+ \d+(, \d{4})? · the last thing they watched$/);
  assert.ok(d.never[0].drive, "each row names its drive");
  assert.equal(d.untouched.days, 45);
  assert.deepEqual(d.untouched.settings, { untouchedDays: 45, untouchedUploads: false, untouchedKeepMyList: false });
  assert.equal(d.totals.all.count, d.idle.length + d.never.length + d.safe.length + d.duplicates.length);
  // "Suggest what to delete" (On disk) offers them too
  const s = await call("GET", "/api/admin/library/suggest?gb=1000");
  assert.equal(s.status, 200);
  assert.ok(s.body.items.some((x) => x.id === ids.never && x.reason === "never"));
  assert.ok(s.body.items.some((x) => x.id === ids.played && x.reason === "untouched"));
  assert.ok(!s.body.items.some((x) => x.id === ids.awayLast), "never the away person's last title");
});

test("Keep pin: pinned is never suggested, listed as Kept by you; a mover's busy file is held and its delete refused", async () => {
  assert.equal((await call("POST", "/api/admin/library/keep", { body: { id: ids.pinned, on: true } })).status, 200);
  assert.equal((await call("POST", "/api/admin/library/keep", { body: { id: "nope", on: true } })).status, 404);
  assert.equal((await call("POST", "/api/admin/library/keep", { body: { id: ids.pinned } })).status, 400);
  const done = busyfiles.mark(path.dirname(paths.busy), "being moved to another drive");
  try {
    const d = await list();
    assert.ok(!d.never.some((r) => r.id === ids.pinned));
    assert.deepEqual(d.pinned.map((p) => [p.id, p.name]), [[ids.pinned, "Keep This (2005)"]]);
    assert.match(d.pinned[0].why, /^Kept by you on \w+ \d+ — never suggested$/);
    assert.ok(!d.never.some((r) => r.id === ids.busy));
    assert.deepEqual(d.held.map((h) => [h.id, h.why]), [[ids.busy, "being moved to another drive"]]);
    const del = await call("POST", "/api/admin/library/freeup/delete", { body: { keys: [`x:${ids.pinned}`, `x:${ids.busy}`], days: 60 } });
    assert.equal(del.body.deleted.length, 0);
    assert.ok(fs.existsSync(paths.pinned) && fs.existsSync(paths.busy));
    const file = await call("DELETE", `/api/admin/library/file/${ids.busy}`);
    assert.equal(file.status, 503, "the On disk delete refuses a file being moved");
    assert.equal(file.body.code, "busy");
    assert.ok(fs.existsSync(paths.busy));
  } finally { done(); }
  assert.ok((await list()).never.some((r) => r.id === ids.busy), "released: suggested again");
});

test("remove: only the confirmed keys; the away person's title only with the stronger yes; Removed recently", async () => {
  const r = await call("POST", "/api/admin/library/freeup/delete", { body: { keys: [`x:${ids.never}`, `x:${ids.e2}`, `a:${ids.awayLast}`, `x:${ids.fresh}`, "x:nope"], days: 60 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.deleted.map((x) => x.key).sort(), [`x:${ids.never}`, `x:${ids.e2}`].sort());
  assert.deepEqual(r.body.skipped.map((x) => [x.key, x.reason]).sort(), [[`a:${ids.awayLast}`, "away"], [`x:${ids.fresh}`, "not-safe"], ["x:nope", "not-safe"]].sort());
  assert.ok(!fs.existsSync(paths.never) && !fs.existsSync(path.dirname(paths.never)), "the film and its folder are gone");
  assert.ok(!fs.existsSync(paths.e2), "the episode file is gone");
  for (const k of ["e1", "e3", "awayLast", "fresh", "played", "pinned"]) assert.ok(fs.existsSync(paths[k]), `${k} stays`);
  // the stronger yes for Maya's film
  const away = await call("POST", "/api/admin/library/freeup/delete", { body: { keys: [`a:${ids.awayLast}`], days: 60, confirmAway: true } });
  assert.deepEqual(away.body.deleted.map((x) => x.key), [`a:${ids.awayLast}`]);
  assert.ok(!fs.existsSync(paths.awayLast));
  // Removed recently, newest first, with why and size; the library index no longer has them
  const d = await list();
  assert.equal(d.removed[0].name, "Her Last Film (2004)", "the latest removal first");
  assert.deepEqual(d.removed.slice(1, 3).map((x) => x.name).sort(), ["Never Played (2002)", "Old Show S01E02"]);
  assert.match(d.removed[0].why, /^Kept for Maya — away since .+ — removed anyway$/);
  assert.ok(d.removed.every((x) => x.sizeBytes > 0 && x.at > 0));
  assert.ok(!scanner.index.movies.some((m) => m.id === ids.never), "gone from the library index");
  // watch history is kept: Maya's history and the module's memory of her play are untouched
  assert.ok(untouched._internals.data().plays[ids.awayLast]);
});

test("settings: days, uploads, My List — only the keys sent; a bad value changes nothing", async () => {
  let r = await call("POST", "/api/admin/library/freeup/settings", { body: { untouchedDays: 200 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.settings.untouchedDays, 200);
  let d = await list();
  assert.equal(d.untouched.days, 200);
  assert.deepEqual(keysOf(d.idle), [], "200 days: the film Ann played 100 days ago is not suggested");
  r = await call("POST", "/api/admin/library/freeup/settings", { body: { untouchedDays: "lots" } });
  assert.equal(r.status, 400);
  r = await call("POST", "/api/admin/library/freeup/settings", { body: { untouchedDays: 45, untouchedKeepMyList: true } });
  assert.equal(r.status, 200);
  d = await list();
  assert.equal(d.untouched.settings.untouchedKeepMyList, true);
  assert.equal(d.untouched.days, 45);
});
