// The library scan off the event loop (server round, 2026-10-18):
//   - media/scanwalk.js reads every listing and file date in one pass, the
//     scanner builds from that snapshot without a filesystem call;
//   - the ten-minute rescan walks in a worker thread (scanAsync);
//   - an unchanged rescan keeps the index arrays and index.version;
//   - folder dates: unchanged folders keep their files' dates without a stat;
//   - the walk is saved, and a restart builds from it (boot) before reading.
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const config = require("../src/config");
const scanner = require("../src/media/scanner");
const scanwalk = require("../src/media/scanwalk");
const statsnap = require("../src/lib/statsnap");

let root, movies, shows, savedLibraries;
const touch = (...p) => {
  const f = path.join(...p);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, "x");
  return f;
};
const EXTS = [...config.VIDEO_EXTENSIONS, ...config.EXTRA_EXTENSIONS, ...config.SUBTITLE_EXTENSIONS];

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-scanwalk-"));
  movies = path.join(root, "movies");
  shows = path.join(root, "shows");
  touch(movies, "Alpha (2001)", "Alpha (2001).mkv");
  touch(movies, "Alpha (2001)", "cover.jpg");
  touch(movies, "Alpha (2001)", "Alpha (2001).English.srt");
  touch(movies, "Beta (2002)", "Beta (2002).mp4");
  touch(movies, ".staging", "Hidden.mkv");
  for (const e of [1, 2, 3]) touch(shows, "Gamma", "Season 1", `Gamma S01E0${e}.mkv`);
  touch(shows, "Gamma", "Season 1", "Extras", "Gamma S01E99.mkv");
  savedLibraries = { movies: config.LIBRARIES.movies, shows: config.LIBRARIES.shows };
  config.LIBRARIES.movies = [movies];
  config.LIBRARIES.shows = [shows];
});

after(async () => {
  config.LIBRARIES.movies = savedLibraries.movies;
  config.LIBRARIES.shows = savedLibraries.shows;
  scanner.scan();
  await require("../src/media/scanworker").stop();
  fs.rmSync(root, { recursive: true, force: true });
});

test("the walk reads what the scanner reads: roots, film folders, every folder of a show; hidden film folders skipped", () => {
  const snap = scanwalk.walk({ movies: [movies], shows: [shows], statExts: EXTS });
  const dirs = Object.keys(snap.dirs).map((d) => path.relative(root, d)).sort();
  assert.deepEqual(dirs, [
    "movies", path.join("movies", "Alpha (2001)"), path.join("movies", "Beta (2002)"),
    "shows", path.join("shows", "Gamma"), path.join("shows", "Gamma", "Season 1"), path.join("shows", "Gamma", "Season 1", "Extras"),
  ].sort());
  // videos and subtitles are dated; a cover is not
  const files = Object.keys(snap.files).map((f) => path.basename(f)).sort();
  assert.ok(files.includes("Alpha (2001).mkv") && files.includes("Alpha (2001).English.srt"));
  assert.ok(!files.includes("cover.jpg"));
  const [size, mtime] = snap.files[path.join(movies, "Alpha (2001)", "Alpha (2001).mkv")];
  assert.equal(size, 1);
  assert.equal(mtime, fs.statSync(path.join(movies, "Alpha (2001)", "Alpha (2001).mkv")).mtimeMs);
  // the same disk, the same digest; a new file, another
  assert.equal(scanwalk.walk({ movies: [movies], shows: [shows], statExts: EXTS }).hash, snap.hash);
  const extra = touch(movies, "Beta (2002)", "Beta (2002).English.srt");
  try {
    assert.notEqual(scanwalk.walk({ movies: [movies], shows: [shows], statExts: EXTS }).hash, snap.hash);
  } finally { fs.rmSync(extra); }
});

test("folder dates: an unchanged folder keeps its files' dates without a stat; a changed one is read again", () => {
  const opts = { movies: [movies], shows: [shows], statExts: EXTS };
  const first = scanwalk.walk(opts);
  const again = scanwalk.walk({ ...opts, prev: first, skipUnchanged: true });
  assert.equal(again.hash, first.hash);
  // one stat per folder only: no file is dated again
  assert.equal(again.calls.stat, Object.keys(first.dirs).length);
  assert.equal(again.reused, Object.keys(first.dirs).length);
  // a new episode: its folder (and only it) is read and dated again
  const ep = touch(shows, "Gamma", "Season 1", "Gamma S01E04.mkv");
  try {
    const third = scanwalk.walk({ ...opts, prev: again, skipUnchanged: true });
    assert.ok(third.files[ep], "the new file is dated");
    assert.notEqual(third.hash, first.hash);
    assert.equal(third.reused, Object.keys(first.dirs).length - 1);
  } finally { fs.rmSync(ep); }
});

test("the scanner builds from the walk with no filesystem call of its own (statsnap answers the subtitle passes)", () => {
  const real = { readdirSync: fs.readdirSync, statSync: fs.statSync, existsSync: fs.existsSync };
  const snap = scanwalk.walk({ movies: [movies], shows: [shows], statExts: EXTS });
  let calls = 0;
  fs.readdirSync = (...a) => { calls++; return real.readdirSync(...a); };
  fs.statSync = (...a) => { calls++; return real.statSync(...a); };
  try {
    // the walk is done; only the build is watched
    const lookup = (p) => { const f = snap.files[p]; return f ? { size: f[0], mtimeMs: f[1] } : undefined; };
    statsnap.within(lookup, () => {
      assert.equal(statsnap.mtimeMs(path.join(movies, "Alpha (2001)", "Alpha (2001).English.srt")), snap.files[path.join(movies, "Alpha (2001)", "Alpha (2001).English.srt")][1]);
    });
    assert.equal(calls, 0);
  } finally { Object.assign(fs, real); }
  // outside within(): the disk, as always
  assert.equal(statsnap.mtimeMs(path.join(root, "nope.srt")), null);
});

test("an unchanged rescan keeps the index arrays and its version; a change moves both", async () => {
  scanner.scan();
  const v = scanner.index.version;
  const films = scanner.index.movies;
  const at = scanner.index.scannedAt;
  let info = null;
  scanner.events.once("scanned", (i) => { info = i; });
  await new Promise((r) => setTimeout(r, 5));
  scanner.scan();
  assert.equal(scanner.index.version, v, "nothing on disk moved");
  assert.equal(scanner.index.movies, films, "the same arrays: what is built from them stays valid");
  assert.ok(scanner.index.scannedAt >= at, "scannedAt still moves");
  assert.deepEqual(info, { changed: false, version: v });
  const f = touch(movies, "Delta (2004)", "Delta (2004).mkv");
  try {
    scanner.scan();
    assert.equal(scanner.index.version, v + 1);
    assert.notEqual(scanner.index.movies, films);
    assert.ok(scanner.index.movies.some((m) => m.title === "Delta"));
    assert.ok(scanner.index.changedAt >= at);
  } finally {
    fs.rmSync(path.dirname(f), { recursive: true, force: true });
    scanner.scan();
  }
});

test("scanAsync walks in a worker and gives the same index as scan(); calls that overlap share a run", async () => {
  scanner.scan();
  const syncIds = scanner.allItems().map((i) => i.id).sort();
  const f = touch(movies, "Epsilon (2005)", "Epsilon (2005).mkv");
  try {
    const a = scanner.scanAsync();
    const b = scanner.scanAsync();
    assert.equal(a, b, "one run for both");
    await a;
    const ids = scanner.allItems().map((i) => i.id).sort();
    assert.equal(ids.length, syncIds.length + 1);
    assert.ok(scanner.findById(scanner.idForPath(f)), "the new film is in the index and the registry");
    const stats = scanner.scanStats();
    assert.ok(stats.async >= 1);
    assert.ok(stats.worker && stats.worker.alive, "the walk ran in the worker");
    assert.equal(stats.worker.fallbacks, 0);
  } finally {
    fs.rmSync(path.dirname(f), { recursive: true, force: true });
    await scanner.scanAsync({ force: true });
  }
  assert.deepEqual(scanner.allItems().map((i) => i.id).sort(), syncIds);
});

test("the walk is saved and a restart builds from it (boot) without reading a folder", async () => {
  scanner.scan();
  const file = path.join(config.CACHE_DIR, "library-walk.json");
  // the save is asynchronous: wait for it
  const want = scanner.scanStats().last.hash;
  let saved = null;
  for (let i = 0; i < 200; i++) {
    try { saved = JSON.parse(fs.readFileSync(file, "utf8")); if (saved.hash === want) break; } catch {}
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(saved.hash, want);
  assert.equal(saved.roots.movies[0], movies);
  const ids = scanner.allItems().map((i) => i.id).sort();
  const real = fs.readdirSync;
  let reads = 0;
  fs.readdirSync = (...a) => { reads++; return real(...a); };
  try {
    assert.equal(scanner.boot(), true);
  } finally { fs.readdirSync = real; }
  assert.equal(reads, 0, "no folder was read");
  assert.deepEqual(scanner.allItems().map((i) => i.id).sort(), ids);
  // a walk saved for other library folders is not used
  config.LIBRARIES.movies = [path.join(root, "elsewhere")];
  try { assert.equal(scanner.boot(), false); } finally { config.LIBRARIES.movies = [movies]; }
});

test("libraryReady lets everything through once the library has been read", () => {
  let n = 0;
  scanner.libraryReady({ path: "/api/library" }, {}, () => n++);
  scanner.libraryReady({ path: "/healthz" }, {}, () => n++);
  assert.equal(n, 2);
});

test("a changed scan drops probe-cache entries of files the library no longer holds (inside its folders only)", () => {
  const metadata = require("../src/media/metadata");
  const gone = path.join(movies, "Gone (1999)", "Gone (1999).mkv");
  const outside = path.join(root, "elsewhere", "Other.mkv");
  metadata._store.data[gone] = { v: 1, mtime: 1 };
  metadata._store.data[outside] = { v: 1, mtime: 1 };
  const f = touch(movies, "Zeta (2006)", "Zeta (2006).mkv");
  try {
    scanner.scan(); // a change: Zeta appeared
    assert.equal(metadata._store.data[gone], undefined, "a film that left the library folder");
    assert.ok(metadata._store.data[outside], "outside the library folders: left alone");
  } finally {
    delete metadata._store.data[outside];
    fs.rmSync(path.dirname(f), { recursive: true, force: true });
    scanner.scan();
  }
});

test("relTo answers what path.relative answers (ids depend on it)", () => {
  const { relTo } = scanner._internals;
  const cases = [
    [movies, path.join(movies, "Alpha (2001)", "Alpha (2001).mkv")],
    [movies, path.join(movies, "Alpha (2001)")],
    [shows, path.join(shows, "Gamma", "Season 1", "Gamma S01E01.mkv")],
    [path.join(shows, "Gamma"), path.join(shows, "Gamma", "Season 1")],
    [path.join(shows, "Gamma"), path.join(shows, "Gamma")],
    [movies + path.sep, path.join(movies, "x.mkv")],
    [movies.split(path.sep).join("/"), path.join(movies, "x.mkv")],
    [config.ROOT, path.join(movies, "a.srt")],
    [movies, path.join(root, "elsewhere", "b.mkv")],
  ];
  for (const [from, to] of cases) assert.equal(relTo(from, to), path.relative(from, to), `${from} -> ${to}`);
});

test("a scan on the main thread reads no more than before: no folder dates, no subtitle dates", () => {
  const real = { statSync: fs.statSync, readdirSync: fs.readdirSync };
  let stats = 0, reads = 0;
  fs.statSync = (...a) => { stats++; return real.statSync(...a); };
  fs.readdirSync = (...a) => { reads++; return real.readdirSync(...a); };
  try { scanner.scan(); } finally { Object.assign(fs, real); }
  const videos = scanner.index.movies.length + scanner.index.shows.reduce((n, s) => n + s.episodeCount, 0);
  assert.ok(reads <= 8, `${reads} listings`);
  // every video once, plus the extra episode the show index does not count
  assert.ok(stats <= videos + 2, `${stats} stats for ${videos} videos`);
});
