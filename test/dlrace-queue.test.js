// The download queue played out against a FAKE engine: "Downloads at once",
// the hold while people watch, and the second-source race from the first slow
// minute to the one file in the library.
//
// Nothing here touches the real server, its data/ or the network. Like the
// browser tests' private instance (scripts/ui-test-server.js), the code is
// given a different root: src/ is copied into a temp folder with its own
// config.json, data/ and library, and required from THERE — src/config.js
// resolves everything from where the code sits. On top of that:
//
//   * the engine (media/aria2.js) is replaced by an in-memory fake through
//     downloads._internals.setEngine — no aria2 process, no torrent
//   * the clock, the timers, the "who is watching" reading and the source
//     lookup are the queue's test seams (downloads._internals.seams)
//   * fetch is refused outright
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.join(__dirname, "..");
let root;
let downloads, D, config, memory, dlrace, settings;
let engine;
let T = Date.now();          // the fake clock (ms)
let load = { watching: 0, streams: 0 };
let sources = {};            // imdbId → streams list for the seam
let lookups = 0;
const realFetch = global.fetch;

const HASH = (c) => String(c).repeat(40).slice(0, 40);
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const until = async (fn, what, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) {
    if (fn()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

// ---------- the fake engine ----------
// One "torrent" per infoHash with files of real bytes on disk (the queue
// copies the finished one into the library), and numbers the test sets.
const makeEngine = (stagingRoot, fileProgress) => {
  const torrents = new Map();
  const byGid = new Map();
  const log = { added: [], removed: [], purged: [], deselected: [], hunts: [] };
  let seq = 0;
  const get = (h) => torrents.get(h);
  const eng = {
    log,
    // test controls ---------------------------------------------------
    define(infoHash, { files = 1, length = 100000, meta = true, ext = ".mkv" } = {}) {
      const dir = path.join(stagingRoot, infoHash);
      fs.mkdirSync(dir, { recursive: true });
      const list = [];
      for (let i = 1; i <= files; i++) {
        const p = path.join(dir, `file${i}${ext}`);
        fs.writeFileSync(p, Buffer.alloc(length, i));
        list.push({ index: i, path: p, length, completed: 0, selected: false });
      }
      torrents.set(infoHash, { infoHash, gid: null, files: list, speed: 0, seeders: 0, connections: 0, state: "active", meta, waiters: [], error: null });
    },
    set(infoHash, fileIndex, completed, { speed, seeders, connections, state, error } = {}) {
      const t = get(infoHash);
      const f = t.files.find((x) => x.index === fileIndex);
      if (completed != null) f.completed = completed === "all" ? f.length : completed;
      if (speed != null) t.speed = speed;
      if (seeders != null) t.seeders = seeders;
      if (connections != null) t.connections = connections;
      if (state) t.state = state;
      if (error) t.error = error;
    },
    gidOf: (infoHash) => (get(infoHash) || {}).gid,
    isLive: (infoHash) => { const t = get(infoHash); return !!(t && t.gid && byGid.has(t.gid)); },
    selected: (infoHash) => get(infoHash).files.filter((f) => f.selected).map((f) => f.index),
    reset() { torrents.clear(); byGid.clear(); for (const k of Object.keys(log)) log[k].length = 0; },
    // the wrapper's surface -------------------------------------------
    available: () => true,
    running: () => true,
    stagingDir: (h) => path.join(stagingRoot, h),
    fileProgress,
    add(magnet, infoHash, fileIndex) {
      const t = get(infoHash);
      if (!t) return Promise.reject(new Error(`unknown torrent ${infoHash}`));
      log.added.push(`${infoHash}#${fileIndex}`);
      const ready = () => {
        if (!t.gid || !byGid.has(t.gid)) { t.gid = `gid${++seq}`; byGid.set(t.gid, t); t.state = "active"; }
        t.files.find((f) => f.index === fileIndex).selected = true;
        return t.gid;
      };
      if (t.meta) return Promise.resolve().then(ready);
      log.hunts.push(infoHash);
      return new Promise((resolve, reject) => t.waiters.push({ resolve: () => resolve(ready()), reject }));
    },
    async status(gid) {
      const t = byGid.get(gid);
      if (!t) throw new Error(`aria2.tellStatus: GID ${gid} is not found`);
      return {
        state: t.state, error: t.error, downloadSpeed: t.speed, peers: t.seeders || t.connections,
        seeders: t.seeders, connections: t.connections, infoHash: t.infoHash,
        files: t.files.map((f) => ({ ...f })),
      };
    },
    async select(gid, fileIndex, wanted) {
      const t = byGid.get(gid);
      if (!t) throw new Error("gone");
      t.files.find((f) => f.index === fileIndex).selected = !!wanted;
      if (!wanted) log.deselected.push(`${t.infoHash}#${fileIndex}`);
      return true;
    },
    async remove(gid) {
      const t = byGid.get(gid);
      if (!t) return;
      byGid.delete(gid);
      log.removed.push(t.infoHash);
    },
    async removeByInfoHash(infoHash) {
      const t = get(infoHash);
      if (!t) return 0;
      for (const w of t.waiters.splice(0)) w.reject(new Error("the download was removed before its details arrived"));
      if (t.gid && byGid.has(t.gid)) { byGid.delete(t.gid); log.removed.push(infoHash); }
      return 1;
    },
    async purge(infoHash) {
      log.purged.push(infoHash);
      fs.rmSync(path.join(stagingRoot, infoHash), { recursive: true, force: true });
    },
    applyEnginePlan: async () => ({ applied: true }),
  };
  return eng;
};

// ---------- the private root ----------
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-dlq-"));
  fs.cpSync(path.join(REPO, "src"), path.join(root, "src"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "package.json"), path.join(root, "package.json"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(root, "node_modules"), "junction");
  const movies = path.join(root, "media", "movies");
  const shows = path.join(root, "media", "shows");
  fs.mkdirSync(movies, { recursive: true });
  fs.mkdirSync(shows, { recursive: true });
  fs.mkdirSync(path.join(root, "data", "cache"), { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    port: 0, libraries: { movies: [movies], shows: [shows] },
    onlineMetadata: false, skipDatabases: false, prewarmStreams: false, autoOcrSubtitles: false,
    preconvert: false, notifications: {}, downloadMinFreePercent: 0, authMode: "open",
  }));
  global.fetch = async () => { throw new Error("network is not allowed in this test"); };

  const S = (p) => require(path.join(root, "src", p));
  config = S("config");
  assert.ok(config.DATA_DIR.startsWith(root), "the private root is in use, not the repo's data/");
  downloads = S("media/downloads");
  dlrace = S("media/dlrace");
  memory = S("media/sourcememory");
  settings = S("lib/settings");
  D = downloads._internals;
  engine = makeEngine(path.join(root, "staging"), S("media/aria2").fileProgress);
  D.setEngine(engine);
  D.seams.auto = false;
  D.seams.clock = () => T;
  D.seams.load = () => load;
  D.seams.findSources = async (job) => { lookups++; const s = sources[job.imdbId]; if (!s) throw new Error("no such title"); return { imdbId: job.imdbId, streams: s }; };
});

after(async () => {
  global.fetch = realFetch;
  await new Promise((r) => setTimeout(r, 200)); // (a late ffprobe on a library file)
  try { fs.rmdirSync(path.join(root, "node_modules")); } catch { try { fs.unlinkSync(path.join(root, "node_modules")); } catch {} }
  if (!fs.existsSync(path.join(root, "node_modules"))) {
    for (let i = 0; i < 20 && fs.existsSync(root); i++) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
      if (fs.existsSync(root)) await new Promise((r) => setTimeout(r, 150));
    }
  }
  // (the copied modules hold timers of their own — the scanner, the stores)
  setTimeout(() => process.exit(process.exitCode || 0), 50).unref();
});

// ---------- helpers ----------
const reset = async () => {
  for (const j of downloads.rawJobs()) downloads.remove(j.id);
  await flush();
  assert.equal(D.active.size, 0, "nothing is left running from the test before");
  engine.reset();
  D.line.total = 0; D.line.at = 0; D.line.peak = null;
  D.store.data.length = 0;
  load = { watching: 0, streams: 0 };
  sources = {};
  lookups = 0;
  settings.data.maxActiveDownloads = 4;
  settings.data.aria2MaxDownload = "0";
  config.DOWNLOAD_RACE = undefined;
  config.DOWNLOAD_MIN_FREE_PERCENT = 0;
  T += 3600e3;
};
const source = (hash, over = {}) => ({
  infoHash: hash, fileIdx: 0, quality: "1080p", sizeBytes: 100000, seeders: 50, provider: `prov-${hash.slice(0, 2)}`,
  release: `Release.${hash.slice(0, 4)}`, cam: false, dubbed: false, pack: false, ...over,
});
let titleN = 0;
const movie = (hash, over = {}) => {
  const n = ++titleN;
  return { infoHash: hash, fileIdx: 0, type: "movie", imdbId: `tt77${String(n).padStart(5, "0")}`, title: `Race Film ${n}`, year: 2020, quality: "1080p", sizeBytes: 100000, ...over };
};
const jobOf = (id) => downloads.rawJobs().find((j) => j.id === id);
// Advance the fake clock in steps, polling at each (a poll is one "second" of
// the real server's life, however far the clock jumped).
const run = async (seconds, step = 10) => {
  for (let s = 0; s < seconds; s += step) { T += step * 1000; await D.poll(); await flush(); }
};
const libraryFiles = (job) => {
  const dir = path.join(config.LIBRARIES.movies[0], `${job.title} (${job.year})`);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(mkv|mp4)$/.test(f)) : [];
};
// A slow original (connected, a trickle) with a healthy challenger on offer,
// taken to the point where both run. Returns everything a test needs.
const intoRace = async ({ chExt = ".mkv" } = {}) => {
  const A = HASH("a"), B = HASH("b");
  engine.define(A);
  engine.define(B, { ext: chExt });
  const req = movie(A);
  sources[req.imdbId] = [source(A), source(B), source(HASH("c"), { quality: "720p" })];
  const r = downloads.create(req);
  assert.ok(r.job && !r.error, JSON.stringify(r));
  await flush();
  engine.set(A, 1, 500, { speed: 2, seeders: 1, connections: 1 });
  await run(290);
  assert.equal(jobOf(r.job.id).race || null, null, "inside the grace period nothing is raced");
  assert.equal(lookups, 0);
  await run(30);
  const job = jobOf(r.job.id);
  assert.ok(job.race, "past the grace, a download projected far beyond its budget gets a second source");
  assert.equal(job.race.state, "probing");
  assert.equal(job.attempts.length, 2);
  assert.equal(job.attempts[1].infoHash, B, "the next best source of the same resolution");
  assert.equal(job.infoHash, A, "the job still carries its original");
  engine.set(B, 1, 1000, { speed: 5000, seeders: 8, connections: 9 });
  await run(20);
  assert.equal(jobOf(job.id).race.state, "racing", "the challenger connected inside its probe window");
  return { A, B, id: job.id, req };
};

// ====================================================================
// Part 1 — downloads at once
// ====================================================================

test("downloads at once: the setting is the cap, a raise pumps, a lower number kills nothing", async () => {
  await reset();
  const hashes = "123456789".split("").map(HASH);
  for (const h of hashes) { engine.define(h); downloads.create(movie(h)); }
  await flush();
  assert.equal(D.active.size, 4, "the default is four at once");
  assert.equal(downloads.slots().queued, 5);

  assert.ok((await downloads.setMaxActive(7)).error, "7 is refused");
  assert.ok((await downloads.setMaxActive(0)).error, "0 is refused");
  assert.ok((await downloads.setMaxActive("many")).error);
  assert.equal(settings.data.maxActiveDownloads, 4, "a refused value changes nothing");

  assert.equal((await downloads.setMaxActive(6)).maxActive, 6);
  await flush();
  assert.equal(D.active.size, 6, "raising it starts the next ones at once — no restart");

  await downloads.setMaxActive(1);
  await flush();
  assert.equal(D.active.size, 6, "lowering it never stops a running download");
  assert.equal(engine.log.removed.length, 0);
  const first = downloads.rawJobs().find((j) => j.status === "downloading");
  downloads.cancel(first.id);
  await flush();
  assert.equal(D.active.size, 5, "…and nothing new starts until the count is under the new number");
});

test("hold while people watch: no more than two are STARTED, running ones stay, the queue moves again after", async () => {
  await reset();
  const hashes = "12345".split("").map(HASH);
  for (const h of hashes.slice(0, 3)) { engine.define(h); downloads.create(movie(h)); }
  await flush();
  assert.equal(D.active.size, 3);

  load = { watching: 1, streams: 0 };
  for (const h of hashes.slice(3)) { engine.define(h); downloads.create(movie(h)); }
  await flush();
  assert.equal(D.active.size, 3, "three were already running: none is stopped, none is added");
  assert.deepEqual([downloads.slots().cap, downloads.slots().holding], [2, true]);
  const q = downloads.queueHealth();
  assert.deepEqual([q.maxActive, q.maxActiveSetting, q.holding], [2, 4, true]);

  for (const j of downloads.rawJobs().filter((x) => x.status === "downloading").slice(0, 2)) downloads.cancel(j.id);
  await flush();
  assert.equal(D.active.size, 2, "one left running + one started = two, and it stops there");

  load = { watching: 0, streams: 0 };
  downloads.pumpNow();
  await flush();
  assert.equal(D.active.size, 3, "viewing stopped: the last queued one starts");
});

// ====================================================================
// Part 2 — the race
// ====================================================================

test("race: slow original → challenger probes OK → challenger finishes first → one file, the winner's source", async () => {
  await reset();
  const { A, B, id } = await intoRace();
  const pub = downloads.publicJob(jobOf(id));
  assert.equal(pub.race.state, "racing");
  assert.equal(pub.race.attempts.length, 2);
  assert.match(pub.race.why, /projected to take/);
  assert.equal(pub.infoHash, A, "fields the TV app reads are still there and still the original's");
  assert.equal(downloads.slots().active, 1, "the challenger took no download slot");

  engine.set(B, 1, "all");
  T += 1000; await D.poll();
  await until(() => jobOf(id).status === "done", "the copy into the library");
  await flush();
  const job = jobOf(id);
  assert.deepEqual(libraryFiles(job), [`${job.title} (${job.year}).mkv`], "exactly one file in the library");
  assert.equal(job.infoHash, B, "the job carries the WINNER's source from here on");
  assert.equal(job.fileIdx, 0);
  assert.equal(job.race, null);
  assert.equal(job.attempts, undefined);
  assert.ok(engine.log.removed.includes(A), "the loser was cancelled");
  assert.ok(engine.log.purged.includes(A), "the loser's staging was purged");
  assert.equal(D.active.size, 0);
  const hist = memory.forTitle(dlrace.titleKey(job));
  assert.equal(hist[A].o, "lost");
  assert.equal(hist[B].o, "won");
  assert.equal(downloads.publicJob(job).race, null);
});

test("race: the mirror — the original finishes first and keeps its place", async () => {
  await reset();
  const { A, B, id } = await intoRace({ chExt: ".mp4" });
  engine.set(A, 1, "all");
  T += 1000; await D.poll();
  await until(() => jobOf(id).status === "done", "the copy into the library");
  await flush();
  const job = jobOf(id);
  assert.deepEqual(libraryFiles(job), [`${job.title} (${job.year}).mkv`], "one file — the original's");
  assert.equal(job.infoHash, A);
  assert.ok(engine.log.removed.includes(B), "the challenger was cancelled");
  assert.ok(engine.log.purged.includes(B), "…and its staging purged");
  const hist = memory.forTitle(dlrace.titleKey(job));
  assert.equal(hist[A].o, "won", "winning replaces the 'stalled' the race began with");
  assert.equal(hist[B].o, "lost");
});

test("race: both attempts finish in the same poll tick — still one winner, one file", async () => {
  await reset();
  const { A, B, id } = await intoRace({ chExt: ".mp4" });
  engine.set(A, 1, "all");
  engine.set(B, 1, "all");
  T += 1000; await D.poll();
  await until(() => jobOf(id).status === "done", "the copy into the library");
  await flush();
  const job = jobOf(id);
  const files = libraryFiles(job);
  assert.equal(files.length, 1, `one library file, not two (${files.join(", ")})`);
  assert.equal(job.infoHash, A, "the first to be seen complete won");
  assert.ok(engine.log.removed.includes(B) && engine.log.purged.includes(B), "the other was cancelled and purged");
  // and nothing arrives late: more polls change nothing
  T += 1000; await D.poll(); await flush();
  assert.equal(libraryFiles(job).length, 1);
});

test("race: a viewer cancelling mid-race cancels every attempt", async () => {
  await reset();
  const { A, B, id } = await intoRace();
  const r = downloads.cancel(id);
  assert.equal(r.job.status, "canceled");
  await flush();
  assert.equal(D.active.size, 0);
  assert.ok(engine.log.removed.includes(A) && engine.log.removed.includes(B), "both downloads were stopped");
  assert.ok(engine.log.purged.includes(A) && engine.log.purged.includes(B), "both staging folders were purged");
  const job = jobOf(id);
  assert.equal(job.race, null);
  assert.equal(job.attempts, undefined);
  assert.equal(libraryFiles(job).length, 0);
  T += 1000; await D.poll(); await flush();
  assert.equal(jobOf(id).status, "canceled");
});

test("race: a server restart mid-race keeps the attempt with more bytes and drops the other", async () => {
  await reset();
  const { A, B, id } = await intoRace();
  engine.set(B, 1, 40000);
  await run(10);
  assert.ok(jobOf(id).attempts[1].bytes > jobOf(id).attempts[0].bytes, "the challenger is ahead on disk, and that is persisted");

  // the process dies: the live records are gone, downloads.json is what it was
  D.active.clear();
  engine.log.purged.length = 0;
  downloads.resume();
  await flush();
  let job = jobOf(id);
  assert.equal(job.status, "approved");
  assert.equal(job.infoHash, B, "it carries on with the attempt that had more bytes");
  assert.equal(job.attempts, undefined);
  assert.equal(job.race, null);
  assert.deepEqual(engine.log.purged, [A], "the other attempt's staging is dropped, the survivor's kept");
  downloads.pumpNow();
  await flush();
  assert.equal(D.active.get(id).main.infoHash, B);

  // the other way round: the original is ahead → the original stays
  await reset();
  const second = await intoRace();
  engine.set(second.A, 1, 60000);
  engine.set(second.B, 1, 2000);
  await run(10);
  D.active.clear();
  engine.log.purged.length = 0;
  downloads.resume();
  await flush();
  job = jobOf(second.id);
  assert.equal(job.infoHash, second.A);
  assert.deepEqual(engine.log.purged, [second.B]);
});

test("race: a challenger that does not connect is cancelled, remembered, and the next is tried once — then no more", async () => {
  await reset();
  const A = HASH("a"), B = HASH("b"), C = HASH("c"), E = HASH("e");
  engine.define(A);
  engine.define(B, { meta: false });   // never finds its details
  engine.define(C);                    // finds them, never a seeder
  engine.define(E);
  const req = movie(A);
  sources[req.imdbId] = [source(A), source(B), source(C), source(E)];
  const { job: made } = downloads.create(req);
  await flush();
  engine.set(A, 1, 500, { speed: 2, seeders: 1, connections: 1 });
  await run(320);
  assert.equal(jobOf(made.id).attempts[1].infoHash, B);
  await run(80);
  let job = jobOf(made.id);
  const key = dlrace.titleKey(job);
  assert.equal(memory.forTitle(key)[B].o, "probe", "the source that failed its probe is marked bad for this title");
  assert.ok(engine.log.hunts.includes(B) && engine.log.purged.includes(B), "its hunt was stopped and its staging purged");
  assert.equal(job.attempts[1].infoHash, C, "the next candidate is tried — B is not offered again");
  assert.equal(job.raceCount, 2);
  await run(90);
  job = jobOf(made.id);
  assert.equal(memory.forTitle(key)[C].o, "probe");
  assert.equal(job.race, null);
  await run(60);
  job = jobOf(made.id);
  assert.equal(job.race, null, "two challengers in a job's lifetime, never a third");
  assert.equal(job.raceCount, 2);
  assert.ok(!engine.log.added.some((a) => a.startsWith(E)));
  assert.match(job.raceNote, /2 other sources were tried at 1080p/);
  assert.equal(job.infoHash, A, "it keeps trying its original");
  assert.equal(job.quality, "1080p");
  // …and the healer's stall sentence now says so
  const healer = require(path.join(root, "src", "lib", "healer"))._internals;
  const rec = D.active.get(made.id);
  const stalled = healer.stallReason({ ...job, progress: 0.005, downloadSpeed: 0 }, { startedAt: rec.startedAt, lastProgressAt: T - healer.PROGRESS_STALL_MS - 1000 }, T);
  assert.match(stalled, /stuck at .*2 other sources were tried/);
});

test("race: nothing healthy at that resolution → no race, an honest note, and never another resolution", async () => {
  await reset();
  const A = HASH("a"), B = HASH("b"), C = HASH("c");
  engine.define(A); engine.define(B); engine.define(C);
  const req = movie(A);
  // B is the right resolution but ten times the size; C is healthy but 720p
  sources[req.imdbId] = [source(A), source(B, { sizeBytes: 1000000 }), source(C, { quality: "720p" })];
  const { job: made } = downloads.create(req);
  await flush();
  engine.set(A, 1, 500, { speed: 2, seeders: 1, connections: 1 });
  await run(330);
  const job = jobOf(made.id);
  assert.equal(job.race || null, null);
  assert.equal(job.raceNote, "No healthy source was found at 1080p — still trying the original.");
  assert.equal(downloads.publicJob(job).raceNote, job.raceNote);
  assert.deepEqual(engine.log.added, [`${A}#1`], "no other torrent was started");
  assert.equal(lookups, 1);
  await run(120);
  assert.equal(lookups, 1, "…and it is not looked up again every second");
});

test("race: never while someone is watching, a torrent stream plays, the line is busy, or at the speed cap", async () => {
  const slowJob = async () => {
    await reset();
    const A = HASH("a"), B = HASH("b");
    engine.define(A); engine.define(B);
    const req = movie(A);
    sources[req.imdbId] = [source(A), source(B)];
    const { job } = downloads.create(req);
    await flush();
    engine.set(A, 1, 500, { speed: 2, seeders: 1, connections: 1 });
    return job.id;
  };

  let id = await slowJob();
  load = { watching: 1, streams: 0 };
  await run(400);
  assert.equal(jobOf(id).race || null, null, "someone is watching");
  assert.equal(downloads.queueHealth().active[0].whyNot, "someone is watching");
  load = { watching: 0, streams: 0 };
  await run(20);
  assert.ok(jobOf(id).race, "…and it starts once they stop");

  id = await slowJob();
  load = { watching: 0, streams: 1 };
  await run(400);
  assert.equal(jobOf(id).race || null, null, "a torrent stream is active");

  id = await slowJob();
  settings.data.aria2MaxDownload = "2";   // 2 bytes/s: the trickle IS the cap
  await run(400);
  assert.equal(jobOf(id).race || null, null, "running at the admin's cap");
  assert.match(downloads.queueHealth().active[0].whyNot, /speed cap/);

  // the line: a second download is using all of it
  id = await slowJob();
  const F = HASH("f");
  engine.define(F, { length: 100000 });
  downloads.create(movie(F, { sizeBytes: 100000 }));
  await flush();
  engine.set(F, 1, 100, { speed: 5e6, seeders: 30, connections: 40 });
  await run(400);
  assert.equal(jobOf(id).race || null, null, "the other download is using the whole line");
  assert.match(downloads.queueHealth().active.find((a) => a.job.id === id).whyNot, /whole line/);

  // the disk: not enough room for two copies
  id = await slowJob();
  config.DOWNLOAD_MIN_FREE_PERCENT = 99.99;
  await run(400);
  assert.equal(jobOf(id).race || null, null);
  assert.match(jobOf(id).raceNote, /not enough free disk space/);

  // switched off in config.json
  id = await slowJob();
  config.DOWNLOAD_RACE = false;
  await run(400);
  assert.equal(jobOf(id).race || null, null, '"downloadRace": false');
  assert.equal(lookups, 0);
});

test("race: an original that dies mid-race hands the job to the challenger instead of failing it", async () => {
  await reset();
  const { A, B, id } = await intoRace();
  engine.set(A, 1, null, { state: "error", error: "tracker said no" });
  await run(10);
  const job = jobOf(id);
  assert.equal(job.status, "downloading", "the job did not fail");
  assert.equal(job.infoHash, B);
  assert.equal(job.race, null);
  assert.equal(memory.forTitle(dlrace.titleKey(job))[A].o, "failed");
  assert.equal(D.active.get(id).main.infoHash, B);
  assert.ok(engine.log.purged.includes(A));
});

test("race: early knockout — a challenger far ahead on time remaining takes over; a hopeless one is dropped", async () => {
  await reset();
  let r = await intoRace();
  // the challenger: 5000 B/s for 99 KB ≈ 20 s; the original: thousands of seconds
  await run(100);
  assert.ok(jobOf(r.id).race, "not before the lead has held for two minutes");
  await run(60);
  let job = jobOf(r.id);
  assert.equal(job.race, null);
  assert.equal(job.infoHash, r.B, "the original was cancelled early; the job is on the second source");
  assert.ok(engine.log.removed.includes(r.A));
  assert.equal(memory.forTitle(dlrace.titleKey(job))[r.A].o, "lost");

  await reset();
  r = await intoRace();
  // now the original wakes up and the challenger dies down
  engine.set(r.A, 1, 60000, { speed: 4000, seeders: 5 });
  engine.set(r.B, 1, 1000, { speed: 1, seeders: 1 });
  await run(600);
  job = jobOf(r.id);
  assert.equal(job.race, null);
  assert.equal(job.infoHash, r.A, "the original stays; the challenger was dropped");
  assert.ok(engine.log.removed.includes(r.B) && engine.log.purged.includes(r.B));
});

test("race: a pack a sibling episode is already downloading is preferred, and its bytes survive losing", async () => {
  await reset();
  const A = HASH("a"), B = HASH("b"), P = HASH("d");
  engine.define(A); engine.define(B); engine.define(P, { files: 6 });
  const show = { type: "show", imdbId: "tt7799999", title: "Race Show", year: 2021, quality: "1080p", sizeBytes: 100000 };
  // the sibling: episode 2 from the pack (file #4)
  const sib = downloads.create({ ...show, infoHash: P, fileIdx: 3, season: 1, episode: 2 }).job;
  const made = downloads.create({ ...show, infoHash: A, fileIdx: 0, season: 1, episode: 1 }).job;
  sources[show.imdbId] = [source(A), source(B), source(P, { fileIdx: 2, pack: true })];
  await flush();
  engine.set(P, 4, 2000, { speed: 3000, seeders: 9, connections: 9 });
  engine.set(A, 1, 500, { speed: 2, seeders: 1, connections: 1 });
  await run(330);
  let job = jobOf(made.id);
  assert.ok(job.race, "episode 1 is slow and gets a second source");
  assert.equal(job.attempts[1].infoHash, P, "the pack already running for episode 2, ahead of the better-ranked single release");
  assert.equal(job.attempts[1].fileIdx, 2);
  assert.deepEqual(engine.selected(P), [3, 4], "only the wanted episode's file was added to the pack's selection");
  assert.equal(engine.log.added.filter((a) => a.startsWith(B)).length, 0);

  // the original wins after all
  engine.set(A, 1, "all");
  T += 1000; await D.poll();
  await until(() => jobOf(made.id).status === "done", "episode 1 landing");
  await flush();
  assert.ok(!engine.log.purged.includes(P), "the pack is still wanted by episode 2: its bytes stay");
  assert.ok(engine.isLive(P), "…and its download was not removed");
  assert.deepEqual(engine.selected(P), [4], "only episode 1's file was dropped from it");
  assert.equal(jobOf(sib.id).status, "downloading");
});

test("the ranking: a title with no history is returned untouched; a source that stalled here is demoted", async () => {
  const torrent = require(path.join(root, "src", "media", "torrent"))._internals;
  const list = [
    { infoHash: HASH("1"), quality: "1080p", seeders: 900, sizeBytes: 2e9, recommended: true },
    { infoHash: HASH("2"), quality: "1080p", seeders: 500, sizeBytes: 2e9 },
    { infoHash: HASH("3"), quality: "720p", seeders: 1000, sizeBytes: 1e9 },
  ];
  assert.equal(torrent.withHistory("tt7700000", list, "movie"), list, "no history: the very same list");
  memory.record("tt7700001", HASH("9"), "stalled");
  assert.equal(torrent.withHistory("tt7700001", list, "movie"), list, "history about some OTHER source changes nothing");
  memory.record("tt7700001", HASH("1"), "stalled");
  const out = torrent.withHistory("tt7700001", list, "movie");
  assert.deepEqual(out.map((s) => s.infoHash), [HASH("2"), HASH("1"), HASH("3")], "demoted below its near-equal, still above a lower resolution");
  assert.equal(out[0].recommended, true);
  assert.ok(!out[1].recommended);
  assert.equal(list[0].recommended, true, "the cached list itself is not modified");
});
