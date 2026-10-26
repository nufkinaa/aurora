// "Problem with this copy? → Get another version" (media/replace.js): a
// person replaces a bad copy in the library with another source of the same
// title — no admin, no delete.
//
// Played out like test/dlrace-queue.test.js: src/ is copied into a temp root
// with its own config.json, data/ and library and required from THERE; the
// download engine is an in-memory fake (downloads._internals.setEngine), the
// source lookups and "is somebody playing it" are seams, and fetch is
// refused. Nothing here touches the real server, its data/ or the network.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.join(__dirname, "..");
let root, S;
let downloads, D, replace, R, badreleases, idpins, scanner, profiles, imdb, smartdl, config, reports;
let engine;
let T = Date.now();
let sources = {};       // "<imdbId>[:s:e]" → streams
let playing = new Set(); // paths somebody is "playing"
const realFetch = global.fetch;

const HASH = (c) => String(c).repeat(40).slice(0, 40);
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const until = async (fn, what, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) {
    if (fn()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
};

// ---------- a fake engine (the subset of test/dlrace-queue.test.js's) ----------
const makeEngine = (stagingRoot, fileProgress) => {
  const torrents = new Map();
  const byGid = new Map();
  let seq = 0;
  return {
    define(infoHash, { length = 4096, ext = ".mkv" } = {}) {
      const dir = path.join(stagingRoot, infoHash);
      fs.mkdirSync(dir, { recursive: true });
      const p = path.join(dir, `release${ext}`);
      fs.writeFileSync(p, Buffer.alloc(length, 7));
      torrents.set(infoHash, { infoHash, gid: null, files: [{ index: 1, path: p, length, completed: 0, selected: false }], speed: 0, state: "active", error: null });
    },
    finish(infoHash) { const t = torrents.get(infoHash); t.files[0].completed = t.files[0].length; t.speed = 1000; },
    fail(infoHash, error) { const t = torrents.get(infoHash); t.state = "error"; t.error = error; },
    reset() { torrents.clear(); byGid.clear(); },
    available: () => true,
    running: () => true,
    stagingDir: (h) => path.join(stagingRoot, h),
    fileProgress,
    add(magnet, infoHash, fileIndex) {
      const t = torrents.get(infoHash);
      if (!t) return Promise.reject(new Error(`unknown torrent ${infoHash}`));
      return Promise.resolve().then(() => {
        if (!t.gid || !byGid.has(t.gid)) { t.gid = `gid${++seq}`; byGid.set(t.gid, t); }
        t.files[fileIndex - 1].selected = true;
        return t.gid;
      });
    },
    async status(gid) {
      const t = byGid.get(gid);
      if (!t) throw new Error(`GID ${gid} is not found`);
      return { state: t.state, error: t.error, downloadSpeed: t.speed, peers: 3, seeders: 3, connections: 3, infoHash: t.infoHash, files: t.files.map((f) => ({ ...f })) };
    },
    async select() { return true; },
    async remove(gid) { byGid.delete(gid); },
    async removeByInfoHash() { return 1; },
    async purge(infoHash) { fs.rmSync(path.join(stagingRoot, infoHash), { recursive: true, force: true }); },
    applyEnginePlan: async () => ({ applied: true }),
  };
};

// ---------- the private root ----------
const PROFILES = {
  profiles: [
    { id: "aaaaaaaaaaa1", name: "Grown Up", color: "#e05f2c", avatar: "🍿" },
    { id: "bbbbbbbbbbb2", name: "Other One", color: "#2ce05f", avatar: "🎬" },
    { id: "ccccccccccc3", name: "Little One", color: "#5f2ce0", avatar: "🧸", kids: { maxAge: 7 } },
  ],
  state: {},
  pending: [],
};
const GROWN = { id: "aaaaaaaaaaa1", name: "Grown Up" };
const OTHER = { id: "bbbbbbbbbbb2", name: "Other One" };
const KID = { id: "ccccccccccc3", name: "Little One" };
const FILM_ID = "tt8800001";
const SHOW_ID = "tt8800002";
let moviesRoot, showsRoot;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-replace-"));
  fs.cpSync(path.join(REPO, "src"), path.join(root, "src"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "package.json"), path.join(root, "package.json"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(root, "node_modules"), "junction");
  moviesRoot = path.join(root, "media", "movies");
  showsRoot = path.join(root, "media", "shows");
  fs.mkdirSync(moviesRoot, { recursive: true });
  fs.mkdirSync(showsRoot, { recursive: true });
  fs.mkdirSync(path.join(root, "data", "cache"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "profiles.json"), JSON.stringify(PROFILES));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    port: 0, libraries: { movies: [moviesRoot], shows: [showsRoot] },
    onlineMetadata: false, skipDatabases: false, prewarmStreams: false, autoOcrSubtitles: false,
    preconvert: false, notifications: {}, downloadMinFreePercent: 0, authMode: "open",
  }));
  global.fetch = async () => { throw new Error("network is not allowed in this test"); };

  S = (p) => require(path.join(root, "src", p));
  config = S("config");
  assert.ok(config.DATA_DIR.startsWith(root), "the private root is in use, not the repo's data/");
  downloads = S("media/downloads");
  replace = S("media/replace");
  badreleases = S("media/badreleases");
  idpins = S("media/idpins");
  scanner = S("media/scanner");
  profiles = S("profiles");
  imdb = S("media/imdb");
  smartdl = S("media/smartdl");
  reports = S("routes/reports");
  D = downloads._internals;
  R = replace._internals;
  engine = makeEngine(path.join(root, "staging"), S("media/aria2").fileProgress);
  D.setEngine(engine);
  D.seams.auto = false;
  D.seams.clock = () => T;
  D.seams.load = () => ({ watching: 0, streams: 0 });
  R.seams.sources = async (s) => {
    const key = s.type === "show" ? `${s.imdbId}:${s.season}:${s.episode}` : s.imdbId;
    const list = sources[key];
    if (!list) throw new Error("no such title");
    return { imdbId: s.imdbId, streams: badreleases.apply(key, list) };
  };
  R.seams.inUse = (p) => playing.has(path.resolve(p));
  R.seams.waitMs = 20;
  R.seams.busyMs = 5;
});

after(async () => {
  global.fetch = realFetch;
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

// ---------- a library to replace things in ----------
const A = HASH("a"), B = HASH("b"), C = HASH("c"), X = HASH("e");
const src = (hash, over = {}) => ({
  infoHash: hash, fileIdx: 0, quality: "1080p", sizeBytes: 4096, seeders: 40, provider: `prov-${hash.slice(0, 2)}`,
  release: `Rep.Release.${hash.slice(0, 4)}.1080p`, cam: false, dubbed: false, pack: false, ...over,
});
let n = 0;
// A film on disk, written by a download of source A (so its release is known).
const seedFilm = ({ ext = ".mp4" } = {}) => {
  const title = `Rep Film ${++n}`;
  const dir = path.join(moviesRoot, `${title} (2020)`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${title} (2020)${ext}`);
  fs.writeFileSync(file, Buffer.alloc(2048, 1));
  fs.writeFileSync(path.join(dir, `${title} (2020).Hebrew.srt`), "1\n00:00:01,000 --> 00:00:02,000\nold\n");
  const imdbId = `tt88${String(n).padStart(5, "0")}`;
  imdb.remember(title, "movie", 2020, imdbId);
  D.store.data.push({
    id: `old${String(n).padStart(9, "0")}`, infoHash: A, fileIdx: 0, type: "movie", imdbId, title, year: 2020,
    status: "done", destPath: file, release: "Rep.Film.2020.1080p.HC.WEB", quality: "1080p", sizeBytes: 2048,
    doneAt: new Date(T).toISOString(), at: new Date(T).toISOString(), profile: OTHER.id,
  });
  scanner.scan();
  const id = scanner.idForPath(file);
  assert.ok(id, "the film is in the library");
  sources[imdbId] = [src(A, { release: "Rep.Film.2020.1080p.HC.WEB", recommended: true }), src(B), src(C, { quality: "720p" })];
  return { id, file, dir, title, imdbId };
};
const seedEpisode = () => {
  const show = `Rep Show ${++n}`;
  const dir = path.join(showsRoot, show, "Season 01");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${show} S01E02.mkv`);
  fs.writeFileSync(file, Buffer.alloc(2048, 2));
  fs.writeFileSync(path.join(dir, `${show} S01E02.English.srt`), "1\n00:00:01,000 --> 00:00:02,000\nold\n");
  fs.writeFileSync(path.join(dir, `${show} S01E03.mkv`), Buffer.alloc(1024, 3));
  const imdbId = `tt89${String(n).padStart(5, "0")}`;
  imdb.remember(show, "show", null, imdbId);
  scanner.scan();
  const id = scanner.idForPath(file);
  assert.ok(id, "the episode is in the library");
  sources[`${imdbId}:1:2`] = [src(B, { release: `Rep.Show.S01E02.${n}` }), src(C, { release: `Rep.Show.S01E02.other.${n}` })];
  return { id, file, dir, show, imdbId };
};
const reset = async () => {
  for (const j of downloads.rawJobs()) if (["pending", "approved", "downloading"].includes(j.status)) downloads.cancel(j.id);
  await flush();
  engine.reset();
  playing = new Set();
  T += 3600e3;
};
const jobOf = (id) => downloads.rawJobs().find((j) => j.id === id);
const entryOf = (rid) => R.entries().find((e) => e.id === rid);
const videosIn = (dir) => fs.readdirSync(dir).filter((f) => /\.(mkv|mp4)$/i.test(f));
const ask = (id, viewer, hash, reason = "burned", extra = {}) => replace.request(id, viewer, { reason, source: { infoHash: hash, fileIdx: 0 }, ...extra });
const land = async (jobId, hash) => {
  await flush(); // (the engine is handed the torrent on the next tick)
  engine.finish(hash);
  await D.poll();
  await until(() => { const j = jobOf(jobId); return j && j.status === "done"; }, "the replacement to land");
};

// ====================================================================

test("a film: the replacement lands under the same library id; progress, My List and ratings carry over; the old file goes", async () => {
  await reset();
  const f = seedFilm({ ext: ".mp4" });
  profiles.setProgress(GROWN.id, f.id, 1200, 6000);
  profiles.toggleWatchlist(GROWN.id, f.id, true);
  profiles.setRating(GROWN.id, f.id, 4);

  const v = replace.view(f.id, GROWN);
  assert.equal(v.status, 200);
  assert.equal(v.body.can, true, JSON.stringify(v.body));
  assert.equal(v.body.current.infoHash, A, "the copy's own source is known from the download that wrote it");
  assert.deepEqual(v.body.reasons.map((r) => r.label), ["Burned-in subtitles", "Bad picture", "Bad sound", "Wrong language", "Other"]);

  const list = await replace.sources(f.id, GROWN);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.streams.map((s) => s.infoHash), [B, C], "the copy being replaced is not offered");
  assert.ok(list.body.streams[0].recommended, "the ★ pick moves to the next good source");

  engine.define(B, { ext: ".mkv" });
  const r = await ask(f.id, GROWN, B, "burned", { note: "subs in the picture" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const jobId = r.body.job.id;
  const rid = r.body.replacement.id;
  await flush();
  assert.equal(jobOf(jobId).status, "downloading");
  assert.ok(fs.existsSync(f.file), "until it lands, the old copy stays where it is");
  assert.equal(scanner.findById(f.id).container, "mp4");
  assert.equal(replace.view(f.id, GROWN).body.active.reasonLabel, "Burned-in subtitles");

  await land(jobId, B);
  assert.ok(!fs.existsSync(f.file), "the old file is gone");
  assert.ok(!fs.existsSync(path.join(f.dir, `${f.title} (2020).Hebrew.srt`)), "…with its sidecar subtitles");
  assert.deepEqual(videosIn(f.dir), [`${f.title} (2020).mkv`], "the new one sits under the old file's name");
  assert.ok(!fs.readdirSync(f.dir).some((x) => x.startsWith(".aurora-dl-")), "no temp file is left behind");
  const job = jobOf(jobId);
  assert.equal(scanner.idForPath(job.destPath), f.id, "the new file is indexed under the OLD library id");
  const item = scanner.findById(f.id);
  assert.equal(item.container, "mkv", "…and the id now points at the new file");
  assert.equal(downloads.publicJob(job).libraryId, f.id, "Play on the downloads page opens the same title");
  // carry-over
  assert.equal(profiles.getProgressView(GROWN.id)[f.id].position, 1200, "watch progress carries over");
  assert.ok(profiles.watchlistItems(GROWN.id).some((x) => x.id === f.id), "My List carries over");
  assert.equal(profiles.getRatings(GROWN.id)[f.id], 4, "the rating carries over");
  // the record
  const e = entryOf(rid);
  assert.equal(e.status, "done");
  assert.equal(e.byName, "Grown Up");
  assert.equal(e.reason, "burned");
  assert.equal(e.old.release, "Rep.Film.2020.1080p.HC.WEB");
  assert.equal(e.new.infoHash, B);
  assert.ok(replace.forProfile(GROWN.id).some((x) => x.id === rid), "the admin's person sheet sees it");
  assert.ok(!downloads.rawJobs().some((j) => j.destPath === f.file), "the old copy's download record went with its file");
  assert.equal(replace.statusById().get(rid).status, "done", "the report's line says how it ended");
  // a rescan later still keeps the id (the pin is on disk)
  scanner.scan();
  assert.equal(scanner.idForPath(job.destPath), f.id);
  assert.ok(Object.values(idpins.list()).some((p) => p.id === f.id), "the pin is stored");
});

test("the report lands in Problem reports with the reason", async () => {
  await reset();
  const f = seedFilm();
  engine.define(B);
  const r = await ask(f.id, GROWN, B, "language", { note: "it's dubbed" });
  assert.equal(r.status, 200);
  const e = entryOf(r.body.replacement.id);
  assert.ok(e.reportId, "a report was filed");
  // what the admin's "Problem reports" route serves (its store is the route's own)
  const router = S("routes/reports");
  const layer = router.stack.find((l) => l.route && l.route.path === "/api/admin/reports" && l.route.methods.get);
  const realtime = S("realtime");
  const was = realtime.isAdmin;
  let served = null;
  realtime.isAdmin = () => true;
  try {
    const handlers = layer.route.stack.map((x) => x.handle);
    handlers[handlers.length - 1]({ headers: {}, query: {} }, { status() { return this; }, json(b) { served = b; } }, () => {});
  } finally { realtime.isAdmin = was; }
  const list = served.reports;
  const rep = list.find((x) => x.id === e.reportId);
  assert.ok(rep, "the report is in the admin's list");
  assert.match(rep.text, /^Problem with this copy: Wrong language — it's dubbed/);
  assert.equal(rep.profile, "Grown Up");
  assert.equal(rep.kind, "replace");
  assert.equal(rep.replace.reason, "language");
  assert.ok(["queued", "downloading", "pending"].includes(rep.replace.status), `the report says where it stands (${rep.replace.status})`);
  downloads.cancel(r.body.job.id);
});

test("an episode: same container, same name, same id — the old sidecar goes, its neighbour is untouched", async () => {
  await reset();
  const ep = seedEpisode();
  const neighbour = path.join(ep.dir, `${ep.show} S01E03.mkv`);
  profiles.setProgress(GROWN.id, ep.id, 300, 2400);
  engine.define(B, { ext: ".mkv" });
  const r = await ask(ep.id, GROWN, B, "sound");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(jobOf(r.body.job.id).label, /S1 E2 — another version/);
  await land(r.body.job.id, B);
  const job = jobOf(r.body.job.id);
  assert.equal(job.destPath, ep.file, "the same path");
  assert.equal(fs.readFileSync(ep.file)[0], 7, "…holding the new bytes");
  assert.ok(!fs.existsSync(path.join(ep.dir, `${ep.show} S01E02.English.srt`)), "the old release's subtitles went with it");
  assert.ok(fs.existsSync(neighbour), "the next episode is untouched");
  assert.equal(scanner.idForPath(ep.file), ep.id, "the same library id");
  assert.equal(scanner.findById(ep.id).showId != null, true, "still an episode of its show");
  assert.equal(profiles.getProgressView(GROWN.id)[ep.id].position, 300);
});

test("who may: kids profiles, no profile, an unmatched title, a second request, a foreign source, the copy itself", async () => {
  await reset();
  const f = seedFilm();
  const kid = await ask(f.id, KID, B);
  assert.equal(kid.status, 403);
  assert.equal(kid.body.code, "kids");
  assert.equal(replace.view(f.id, KID).body.can, false);
  const kidLock = await replace.request(f.id, GROWN, { reason: "burned", source: { infoHash: B }, kids: { profile: KID.id, maxAge: 7 } });
  assert.equal(kidLock.body.code, "kids", "a kids lock on the device refuses too");
  assert.equal((await ask(f.id, { id: null, name: null }, B)).body.code, "profile");
  assert.equal((await ask(f.id, { id: "ffffffffffff", name: "Nobody" }, B)).body.code, "profile");
  assert.equal((await ask(f.id, GROWN, B, "nonsense")).body.code, "reason");
  assert.equal((await ask(f.id, GROWN, X)).body.code, "source", "a source this title does not offer is refused");
  assert.equal((await ask(f.id, GROWN, A)).body.code, "same", "the copy being replaced is refused");
  assert.equal((await ask("000000000000", GROWN, B)).status, 404);

  // a film the catalogue has never matched
  const dir = path.join(moviesRoot, "Unmatched Film (2019)");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "Unmatched Film (2019).mp4"), Buffer.alloc(100));
  scanner.scan();
  const um = scanner.idForPath(path.join(dir, "Unmatched Film (2019).mp4"));
  assert.equal(replace.view(um, GROWN).body.code, "unmatched");

  engine.define(B);
  const ok = await ask(f.id, GROWN, B);
  assert.equal(ok.status, 200);
  const again = await ask(f.id, OTHER, C);
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "busy", "one replacement at a time per title");
  assert.equal(replace.view(f.id, OTHER).body.active.mine, false);
  assert.equal(replace.view(f.id, GROWN).body.active.mine, true);
  // only the one who asked (or the admin) cancels
  assert.equal(replace.cancel(f.id, OTHER).status, 403);
  assert.equal(replace.cancel(f.id, GROWN).status, 200);

  // torrents off: nothing new
  const gate = S("lib/torrentgate");
  const was = config.TORRENTS;
  const wasEnabled = gate.enabled;
  gate.enabled = () => false;
  try { assert.equal((await ask(f.id, GROWN, B)).body.code, "torrents-off"); } finally { gate.enabled = wasEnabled; config.TORRENTS = was; }
});

test("cancel while it downloads: everything is as it was — the file, the bad-release mark, nothing left behind", async () => {
  await reset();
  const f = seedFilm();
  engine.define(B);
  const r = await ask(f.id, GROWN, B, "picture");
  const key = f.imdbId;
  assert.ok(badreleases.match(key, { infoHash: A }), "while it runs, the old release is marked bad");
  assert.equal(replace.cancel(f.id, GROWN).status, 200);
  await flush();
  assert.equal(jobOf(r.body.job.id).status, "canceled");
  assert.ok(fs.existsSync(f.file), "the old copy is untouched");
  assert.equal(scanner.findById(f.id).container, "mp4");
  assert.equal(badreleases.match(key, { infoHash: A }), null, "the mark is taken back");
  assert.equal(entryOf(r.body.replacement.id).status, "canceled");
  assert.ok(!fs.readdirSync(f.dir).some((x) => x.startsWith(".aurora-dl-")));
});

test("somebody is playing the old copy: the finished file waits hidden, frees its slot, and swaps in once they stop", async () => {
  await reset();
  const f = seedFilm();
  playing.add(path.resolve(f.file));
  engine.define(B, { ext: ".mkv" });
  const r = await ask(f.id, GROWN, B);
  const jobId = r.body.job.id;
  await flush();
  engine.finish(B);
  await D.poll();
  await until(() => jobOf(jobId).replaceWait, "the replacement to wait");
  assert.ok(fs.existsSync(f.file), "the old copy plays on");
  assert.equal(D.active.has(jobId), false, "the download slot is handed back while it waits");
  assert.equal(downloads.publicJob(jobOf(jobId)).replaceWait, true, "the apps can say it is waiting");
  assert.equal(replace.view(f.id, GROWN).body.active.waiting, true);
  assert.equal(entryOf(r.body.replacement.id).status, "waiting");
  assert.ok(fs.readdirSync(f.dir).some((x) => x.startsWith(".aurora-dl-")), "the new file waits under a hidden name");
  playing.clear();
  await until(() => jobOf(jobId).status === "done", "the swap once nobody plays it");
  assert.ok(!fs.existsSync(f.file));
  assert.equal(scanner.idForPath(jobOf(jobId).destPath), f.id);
});

test("cancel while it waits for the old copy: the hidden new file is removed, the old copy stays", async () => {
  await reset();
  const f = seedFilm();
  playing.add(path.resolve(f.file));
  engine.define(B, { ext: ".mkv" });
  const r = await ask(f.id, GROWN, B);
  await flush();
  engine.finish(B);
  await D.poll();
  await until(() => jobOf(r.body.job.id).replaceWait, "the replacement to wait");
  assert.equal(replace.cancel(f.id, GROWN).status, 200);
  await until(() => !fs.readdirSync(f.dir).some((x) => x.startsWith(".aurora-dl-")), "the hidden file to go");
  assert.ok(fs.existsSync(f.file), "the old copy is untouched");
  assert.deepEqual(videosIn(f.dir), [path.basename(f.file)]);
  assert.equal(scanner.findById(f.id).container, "mp4");
});

test("a failed replacement keeps the old copy (and the bad-release mark)", async () => {
  await reset();
  const f = seedFilm();
  engine.define(B);
  const r = await ask(f.id, GROWN, B, "burned");
  await flush();
  engine.fail(B, "no peers at all");
  await D.poll();
  await flush();
  const job = jobOf(r.body.job.id);
  assert.equal(job.status, "error");
  assert.ok(fs.existsSync(f.file), "the old copy is where it was");
  assert.equal(scanner.findById(f.id).container, "mp4");
  const e = entryOf(r.body.replacement.id);
  assert.equal(e.status, "failed");
  assert.match(e.error, /no peers/);
  assert.ok(badreleases.match(f.imdbId, { infoHash: A }), "the copy was still bad: its release stays marked");
  // …and a new replacement may be asked for at once
  engine.define(C);
  assert.equal((await ask(f.id, GROWN, C)).status, 200);
});

test("bad-release memory: marked, sunk below the rest, never ★, never picked by smart downloads", async () => {
  await reset();
  const key = "tt8899999";
  const list = [src(A, { release: "Same.Release.1080p", recommended: true }), src(B), src(C, { cam: true })];
  assert.equal(badreleases.apply(key, list), list, "a title with no reports is handed back as it was");
  badreleases.record(key, { infoHash: A, release: "Same.Release.1080p", reason: "burned", by: GROWN.id, byName: "Grown Up", rid: "r1" });
  const out = badreleases.apply(key, list);
  assert.deepEqual(out.map((s) => s.infoHash), [B, A, C], "the bad one goes below the good ones, CAM still last");
  assert.equal(out[1].badHere.label, "Burned-in subtitles");
  assert.ok(out[0].recommended && !out[1].recommended, "★ moves to the first good source");
  assert.equal(smartdl._internals.pickSource(out, "1080p").infoHash, B, "smart downloads skip it even at the wanted quality");
  // the same release under another hash is the same release
  const other = badreleases.apply(key, [src(X, { release: "same release 1080p" }), src(B)]);
  assert.ok(other.find((s) => s.infoHash === X).badHere, "matched by its release name too");
  assert.equal(smartdl._internals.pickSource([src(X, { badHere: { reason: "burned" } })], null), null, "nothing at all rather than a bad one");
  assert.equal(badreleases.unrecord(key, "r1"), true);
  assert.equal(badreleases.apply(key, list), list);
});

test("with the release markers (releasekind.js): bad below burned-in, pre-release last; the ★ never on a pre-release or a bad copy", async () => {
  await reset();
  const key = "tt8899998";
  const H = src(HASH("h"), { hardsub: true, release: "Mark.2020.KORSUB.1080p" });
  const P = src(HASH("p"), { cam: true, prerelease: "telesync", release: "Mark.2020.HDTS", seeders: 900 });
  const list = [src(A, { release: "Mark.Release.1080p", recommended: true }), src(B), H, P];
  badreleases.record(key, { infoHash: B, reason: "picture", by: GROWN.id, rid: "rk1" });
  badreleases.record(key, { infoHash: A, reason: "sound", by: GROWN.id, rid: "rk2" });
  const out = badreleases.apply(key, list);
  assert.deepEqual(out.map((s) => s.infoHash), [H.infoHash, A, B, P.infoHash], "burned-in, then the bad ones, the pre-release copy last of all");
  assert.equal(out.filter((s) => s.recommended).map((s) => s.infoHash).join(), H.infoHash, "no clean copy left that is not bad: the ★ goes to the burned-in one, never the TS");
  // only bad and pre-release copies: no ★ at all
  const none = badreleases.apply(key, [src(A), src(B), P]);
  assert.equal(none.filter((s) => s.recommended).length, 0);
  badreleases.unrecord(key, "rk1");
  badreleases.unrecord(key, "rk2");
});

test("Get another version's list: the ★ moves off the copy being replaced — never onto a pre-release copy", async () => {
  await reset();
  const f = seedFilm();
  const P = src(HASH("q"), { cam: true, prerelease: "cam", badge: "CAM", warning: "CAM — filmed in a cinema", seeders: 999 });
  const H = src(HASH("r"), { hardsub: true, badge: "BURNED-IN SUBS", warning: "Subtitles burned into the picture" });
  // the copy on disk was the ★; what is left: a CAM (best seeded) and a burned-in copy
  sources[f.imdbId] = [src(A, { release: "Rep.Film.2020.1080p.HC.WEB", recommended: true }), H, P];
  const r = await replace.sources(f.id, GROWN);
  assert.equal(r.status, 200);
  const best = r.body.streams.filter((s) => s.recommended);
  assert.deepEqual(best.map((s) => s.infoHash), [H.infoHash], "the ★ is the burned-in copy, not the cinema recording");
  const cam = r.body.streams.find((s) => s.infoHash === P.infoHash);
  assert.equal(cam.badge, "CAM", "the marks reach the sheet as they are");
  assert.equal(cam.warning, "CAM — filmed in a cinema");
  // nothing but a cinema recording left: no ★
  sources[f.imdbId] = [src(A, { release: "Rep.Film.2020.1080p.HC.WEB", recommended: true }), P];
  const r2 = await replace.sources(f.id, GROWN);
  assert.equal(r2.body.streams.filter((s) => s.recommended).length, 0);
  // a person may still pick it (the sheet asks first): it is one of the title's sources
  const asked = await ask(f.id, GROWN, P.infoHash, "picture");
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  replace.cancel(f.id, GROWN);
  await flush();
});

test("the copy's old name is free again; a title replaced twice keeps one pin and its id", async () => {
  await reset();
  const f = seedFilm({ ext: ".mp4" });
  engine.define(B, { ext: ".mkv" });
  const r1 = await ask(f.id, GROWN, B);
  await land(r1.body.job.id, B);
  engine.define(C, { ext: ".mp4" });
  sources[f.imdbId] = [src(A, { release: "Rep.Film.2020.1080p.HC.WEB" }), src(B), src(C, { quality: "720p" })];
  const cur = replace.view(f.id, GROWN).body.current;
  assert.equal(cur.infoHash, B, "the copy is now the replacement's source");
  const r2 = await ask(f.id, GROWN, C, "picture");
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  await land(r2.body.job.id, C);
  assert.deepEqual(videosIn(f.dir), [`${f.title} (2020).mp4`]);
  assert.equal(scanner.idForPath(path.join(f.dir, `${f.title} (2020).mp4`)), f.id, "back in its first container: its own id again");
  assert.equal(Object.values(idpins.list()).filter((p) => p.id === f.id).length, 0, "no pin is needed (or kept) for its natural path");
  const marks = badreleases.forTitle(f.imdbId);
  assert.ok(marks.some((m) => m.h === A) && marks.some((m) => m.h === B), "both replaced releases are remembered");
});

test("it is a person's download like any other: the per-account limit (3 at once) still applies", async () => {
  await reset();
  const f = seedFilm();
  const mine = [];
  for (const c of "pqr") {
    const h = HASH(c);
    engine.define(h);
    const r = downloads.create({ infoHash: h, fileIdx: 0, type: "movie", imdbId: `tt77${c.charCodeAt(0)}001`, title: `Busy Film ${c}`, year: 2021, quality: "1080p", sizeBytes: 4096, profile: GROWN.id, profileName: GROWN.name });
    assert.ok(r.job, JSON.stringify(r));
    mine.push(r.job.id);
  }
  await flush();
  assert.equal(mine.filter((id) => D.active.has(id)).length, 3);
  engine.define(B);
  const r = await ask(f.id, GROWN, B);
  assert.equal(r.status, 200);
  await flush();
  const job = jobOf(r.body.job.id);
  assert.equal(job.status, "approved", "it waits its turn");
  assert.equal(D.active.has(job.id), false);
  assert.equal(downloads.publicJob(job).accountLimit, 3, "…and says why");
  for (const id of mine) downloads.cancel(id);
  await flush();
  assert.equal(D.active.has(job.id), true, "it starts once one of the three is done");
});
