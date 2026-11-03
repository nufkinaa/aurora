// Downloads v2, played out against a FAKE engine on a fake clock: stalled
// downloads stop holding a slot, a dead copy moves to the next-best one, a
// fake is caught, the disk filling up holds instead of failing, a quick next
// episode for someone watching pushes the others aside for a moment — and
// what survives a restart. (docs/downloads-v2.md)
//
// Nothing here touches the real server, its data/ or the network: src/ is
// copied into a temp folder with its own config.json and data/ and required
// from there (the same private root as test/dlrace-queue.test.js); the engine
// is an in-memory fake; fetch is refused.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.join(__dirname, "..");
let root;
let downloads, D, config, settings, badreleases, monoDefault;
let engine;
let T = Date.now();
let load = { watching: 0, streams: 0 };
let sources = {};
let lookups = 0;
let probes = {};             // file path → what "ffprobe" says
const realFetch = global.fetch;
const MIN = 60 * 1000;

const HASH = (c) => String(c).repeat(40).slice(0, 40);
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const until = async (fn, what, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) {
    if (fn()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

// ---------- the fake engine ----------
const makeEngine = (stagingRoot, fileProgress) => {
  const torrents = new Map();
  const byGid = new Map();
  const log = { added: [], removed: [], purged: [], deselected: [], selected: [], limits: [] };
  let seq = 0;
  const get = (h) => torrents.get(h);
  const eng = {
    log,
    // `reported`: the length the engine SAYS each file has (a big film
    // without writing gigabytes to the test's disk)
    define(infoHash, { files = 1, length = 100000, meta = true, ext = ".mkv", names = null, lengths = null, reported = null } = {}) {
      const dir = path.join(stagingRoot, infoHash);
      fs.mkdirSync(dir, { recursive: true });
      const list = [];
      const n = names ? names.length : files;
      for (let i = 1; i <= n; i++) {
        const p = path.join(dir, names ? names[i - 1] : `file${i}${ext}`);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const len = lengths ? lengths[i - 1] : length;
        fs.writeFileSync(p, Buffer.alloc(len, i));
        list.push({ index: i, path: p, length: reported || len, completed: 0, selected: false });
      }
      torrents.set(infoHash, { infoHash, gid: null, files: list, speed: 0, seeders: 0, connections: 0, state: "active", meta, waiters: [], error: null, errorCode: null });
    },
    set(infoHash, fileIndex, completed, { speed, seeders, connections, state, error, errorCode } = {}) {
      const t = get(infoHash);
      const f = t.files.find((x) => x.index === fileIndex);
      if (completed != null) f.completed = completed === "all" ? f.length : completed;
      if (speed != null) t.speed = speed;
      if (seeders != null) t.seeders = seeders;
      if (connections != null) t.connections = connections;
      if (state) t.state = state;
      if (error) t.error = error;
      if (errorCode != null) t.errorCode = errorCode;
    },
    meta(infoHash) { const t = get(infoHash); t.meta = true; for (const w of t.waiters.splice(0)) w.resolve(); },
    isLive: (infoHash) => { const t = get(infoHash); return !!(t && t.gid && byGid.has(t.gid)); },
    gidOf: (infoHash) => (get(infoHash) || {}).gid,
    selectedOf: (infoHash) => get(infoHash).files.filter((f) => f.selected).map((f) => f.index),
    reset() { torrents.clear(); byGid.clear(); for (const k of Object.keys(log)) log[k].length = 0; },
    // the wrapper's surface
    available: () => true,
    running: () => true,
    stagingDir: (h) => path.join(stagingRoot, h),
    fileProgress,
    add(magnet, infoHash, fileIndex) {
      const t = get(infoHash);
      if (!t) return Promise.reject(new Error(`unknown torrent ${infoHash}`));
      log.added.push(`${infoHash}#${fileIndex}`);
      const ready = () => {
        if (!t.gid || !byGid.has(t.gid)) { t.gid = `gid${++seq}`; byGid.set(t.gid, t); t.state = "active"; t.error = null; t.errorCode = null; }
        t.files.find((f) => f.index === fileIndex).selected = true;
        return t.gid;
      };
      if (t.meta) return Promise.resolve().then(ready);
      return new Promise((resolve, reject) => t.waiters.push({ resolve: () => resolve(ready()), reject }));
    },
    async status(gid) {
      const t = byGid.get(gid);
      if (!t) throw new Error(`aria2.tellStatus: GID ${gid} is not found`);
      return {
        state: t.state, error: t.error, errorCode: t.errorCode, downloadSpeed: t.speed, peers: t.seeders || t.connections,
        seeders: t.seeders, connections: t.connections, infoHash: t.infoHash,
        pieceLength: 16384, numPieces: 10, bitfield: "000",
        files: t.files.map((f) => ({ ...f })),
      };
    },
    async select(gid, fileIndex, wanted) {
      const t = byGid.get(gid);
      if (!t) throw new Error("gone");
      t.files.find((f) => f.index === fileIndex).selected = !!wanted;
      (wanted ? log.selected : log.deselected).push(`${t.infoHash}#${fileIndex}`);
      return true;
    },
    async limit(gid, bps) { log.limits.push(`${gid}:${bps}`); return "OK"; },
    async peers() { return []; },
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-dlv2-"));
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
  settings = S("lib/settings");
  badreleases = S("media/badreleases");
  D = downloads._internals;
  monoDefault = D.seams.clock;
  engine = makeEngine(path.join(root, "staging"), S("media/aria2").fileProgress);
  D.setEngine(engine);
  D.seams.auto = false;
  D.seams.clock = () => T;
  D.seams.wall = () => T;
  D.seams.load = () => load;
  D.seams.streaming = () => new Set();
  D.seams.probe = async (file) => probes[file] || null;
  D.seams.findSources = async (job) => { lookups++; const s = sources[job.imdbId]; if (!s) throw new Error("no such title"); return { imdbId: job.imdbId, streams: badreleases.apply(job.type === "show" ? `${job.imdbId}:${job.season}:${job.episode}` : job.imdbId, s) }; };
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

// ---------- helpers ----------
const reset = async () => {
  D.resetPreempt();
  for (const j of downloads.rawJobs()) downloads.remove(j.id);
  await flush();
  assert.equal(D.active.size, 0, "nothing is left running from the test before");
  engine.reset();
  D.line.total = 0; D.line.at = 0; D.line.peak = null;
  D.store.data.length = 0;
  load = { watching: 0, streams: 0 };
  sources = {};
  probes = {};
  lookups = 0;
  settings.data.maxActiveDownloads = 4;
  settings.data.aria2MaxDownload = "0";
  config.DOWNLOAD_RACE = false;           // the second-source race has its own tests (dlrace-queue)
  config.DOWNLOAD_MIN_FREE_PERCENT = 0;
  T += 24 * 3600e3;
};
const source = (hash, over = {}) => ({
  infoHash: hash, fileIdx: 0, quality: "1080p", sizeBytes: 100000, seeders: 50, provider: `prov-${hash.slice(0, 2)}`,
  release: `Release.${hash.slice(0, 4)}`, cam: false, dubbed: false, pack: false, ...over,
});
let titleN = 0;
const movie = (hash, over = {}) => {
  const n = ++titleN;
  return { infoHash: hash, fileIdx: 0, type: "movie", imdbId: `tt66${String(n).padStart(5, "0")}`, title: `V2 Film ${n}`, year: 2021, quality: "1080p", sizeBytes: 100000, seeders: 50, profile: "aaaaaaaaaaaa", ...over };
};
const jobOf = (id) => downloads.rawJobs().find((j) => j.id === id);
const run = async (seconds, step = 10, each = null) => {
  for (let s = 0; s < seconds; s += step) {
    T += step * 1000;
    if (each) each();
    await D.poll();
    await flush();
  }
};
const runUntil = async (fn, maxSeconds, step = 10, each = null) => {
  const t0 = T;
  for (let s = 0; s < maxSeconds && !fn(); s += step) {
    T += step * 1000;
    if (each) each();
    await D.poll();
    await flush();
  }
  return (T - t0) / 1000;
};
const healthy = (hash, file = 1) => engine.set(hash, file, null, { speed: 4e6, seeders: 10, connections: 12 });
const libraryFiles = (job) => {
  const dir = path.join(config.LIBRARIES.movies[0], `${job.title} (${job.year})`);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(mkv|mp4)$/.test(f)) : [];
};

// ====================================================================

test("the stall clock is monotonic: a wall-clock jump does not age a download", () => {
  const before = monoDefault();
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 3600e3;
    assert.ok(monoDefault() - before < 5000, "the clock every stall rule runs on did not jump with the wall clock");
  } finally {
    Date.now = realNow;
  }
});

test("a stalled download stops holding a slot: the next one starts beside it, the stalled one keeps looking", async () => {
  await reset();
  settings.data.maxActiveDownloads = 2;
  const [A, B, C] = ["a", "b", "c"].map(HASH);
  for (const h of [A, B, C]) engine.define(h);
  const ja = downloads.create(movie(A)).job;
  const jb = downloads.create(movie(B)).job;
  const jc = downloads.create(movie(C)).job;
  await flush();
  assert.equal(D.active.size, 2, "two at once");
  assert.equal(jobOf(jc.id).status, "approved", "the third waits");
  healthy(B);
  engine.set(B, 1, 100, {});
  // A: details in, nobody to connect to
  const waited = await runUntil(() => jobOf(jc.id).status === "downloading", 600, 10, () => {
    const f = engine.selectedOf(B); if (f.length) engine.set(B, 1, Math.min(99000, (jobOf(jb.id).progress || 0) * 100000 + 500), {});
  });
  assert.ok(waited <= 200, `the third started ${waited}s in — the stalled one gave its slot up within ~3 minutes`);
  const a = jobOf(ja.id);
  assert.equal(a.status, "downloading", "the stalled one is still in the engine, looking");
  assert.equal(a.health.state, "stalled");
  assert.equal(a.health.countsAsRunning, false);
  assert.equal(a.note, "No one is sharing this copy right now — still looking");
  assert.equal(downloads.publicJob(a).note, a.note, "every client gets the sentence");
  assert.equal(downloads.slots().counted, 2, "two count as running: B and C");
  assert.equal(downloads.slots().notCounted, 1);
  // A comes back to life: it counts again (and nothing is stopped)
  engine.set(A, 1, 60000, { speed: 3e6, seeders: 4, connections: 6 });
  await run(20);
  assert.equal(jobOf(ja.id).health.state, "ok");
  assert.equal(D.active.size, 3, "nothing is ever stopped because the count went back up");
});

test("a dead copy: the next-best copy, in place — same job, same place; filed as dead for a few days; said in plain words", async () => {
  await reset();
  const [A, B, C] = ["a", "b", "c"].map(HASH);
  engine.define(A);
  engine.define(B);
  engine.define(C);
  const req = movie(A);
  sources[req.imdbId] = [source(A), source(B, { quality: "720p", seeders: 900 }), source(C, { seeders: 30 })];
  const j = downloads.create(req).job;
  await flush();
  // A: details in, no one to connect to
  const t0 = T;
  const detect = await runUntil(() => jobOf(j.id).infoHash === C, 900);
  assert.equal(jobOf(j.id).infoHash, C, "the same resolution (1080p) before a better-seeded 720p");
  assert.ok(detect >= 8 * 60 && detect <= 8 * 60 + 20, `a copy nobody shares is given up on at 8 minutes (took ${detect}s)`);
  const job = jobOf(j.id);
  assert.equal(job.id, j.id, "the same job keeps its place");
  assert.equal(job.status, "downloading");
  assert.equal(job.tried.length, 1);
  assert.equal(job.tried[0].h, A.toLowerCase());
  assert.equal(job.tried[0].kind, "dead");
  assert.match(job.note, /^No one was sharing that copy — now trying another \(1080p/);
  assert.ok(engine.log.removed.includes(A), "the dead copy left the engine");
  assert.ok(engine.log.purged.includes(A), "…and its (empty) staging went");
  const mark = badreleases.forTitle(req.imdbId).find((e) => e.h === A.toLowerCase());
  assert.ok(mark && mark.why === "dead" && mark.auto && mark.exp > T, "filed as dead, by the server, for a few days");
  assert.equal(badreleases.reasonLabel("dead"), "No one was sharing it");
  assert.ok(!badreleases.REASONS.some((r) => r.id === "dead"), "never offered to a person as a reason");
  // C downloads and lands as the one file
  healthy(C);
  engine.set(C, 1, "all");
  await run(10);
  await until(() => jobOf(j.id).status === "done", "the copy into the library");
  assert.equal(libraryFiles(job).length, 1);
  assert.equal(jobOf(j.id).note, null, "a finished download has nothing more to say");
  console.log(`[dlv2] dead copy detected ${detect}s after the start, the next copy running at once (${(T - t0) / 1000}s in all)`);
});

test("no copy left: it waits and tries again (15, 30, 60, 120, 240 min), then says plainly no one is sharing it — never a loop", async () => {
  await reset();
  const A = HASH("a");
  engine.define(A);
  const req = movie(A);
  sources[req.imdbId] = [source(A)];
  const j = downloads.create(req).job;
  await flush();
  await runUntil(() => jobOf(j.id).status === "approved", 900);
  let job = jobOf(j.id);
  assert.equal(job.status, "approved", "out of the engine, waiting");
  assert.equal(D.active.size, 0, "it holds nothing while it waits");
  assert.match(job.note, /^No one is sharing any copy of this right now \(1 copy tried\) — trying again in about 15 min$/);
  assert.equal(downloads.publicJob(job).retryAt, job.retryAt);
  const waits = [];
  let last = T;
  for (let round = 0; round < 8 && jobOf(j.id).status !== "error"; round++) {
    job = jobOf(j.id);
    if (job.status === "approved" && job.retryAt) {
      waits.push(Math.round((Date.parse(job.retryAt) - T) / MIN));
      T = Date.parse(job.retryAt) + 1000;
      downloads.pumpNow();
      await flush();
    }
    await runUntil(() => jobOf(j.id).status !== "downloading", 900);
    last = T;
  }
  job = jobOf(j.id);
  assert.deepEqual(waits, [15, 30, 60, 120, 240]);
  assert.equal(job.status, "error");
  assert.match(job.error, /^No one is sharing this right now — tried 1 copy over \d/);
  assert.ok(lookups <= 7, `the source list was asked ${lookups} times, not in a loop`);
  assert.equal(engine.log.added.filter((x) => x.startsWith(A)).length, 6, "the copy was tried six times in ~8 hours, no more");
  void last;
});

test("an automatic download gives up sooner (3 rounds) than a person's (5)", async () => {
  await reset();
  const A = HASH("a");
  engine.define(A);
  const req = movie(A, { smart: true });
  sources[req.imdbId] = [source(A)];
  const j = downloads.create(req).job;
  await flush();
  for (let round = 0; round < 8 && jobOf(j.id).status !== "error"; round++) {
    const job = jobOf(j.id);
    if (job.status === "approved" && job.retryAt) { T = Date.parse(job.retryAt) + 1000; downloads.pumpNow(); await flush(); }
    await runUntil(() => jobOf(j.id).status !== "downloading", 900);
  }
  assert.equal(jobOf(j.id).status, "error");
  assert.equal(jobOf(j.id).retries, 4, "three waits, then the end");
});

test("bytes worth resuming are kept when a copy dies, and it is the one tried again when nothing else is left", async () => {
  await reset();
  const [A, B] = ["a", "b"].map(HASH);
  engine.define(A, { length: 1000000 });
  engine.define(B, { meta: false });
  const req = movie(A, { sizeBytes: 1000000 });
  sources[req.imdbId] = [source(A, { sizeBytes: 1000000 }), source(B, { sizeBytes: 1000000 })];
  const j = downloads.create(req).job;
  await flush();
  // A gets 30% and then nothing, with nobody holding the whole file
  engine.set(A, 1, 300000, { speed: 0, seeders: 0, connections: 2 });
  await runUntil(() => jobOf(j.id).infoHash === B, 1200);
  let job = jobOf(j.id);
  assert.equal(job.infoHash, B);
  assert.equal(job.shelved.length, 1, "A's 30% is set aside");
  assert.ok(!engine.log.purged.includes(A), "and its bytes stay on disk");
  assert.ok(downloads.liveInfoHashes().has(A.toLowerCase()), "the staging sweep leaves them alone");
  // B never gets its details either → nothing left → wait
  await runUntil(() => jobOf(j.id).status === "approved", 1200);
  job = jobOf(j.id);
  assert.equal(job.infoHash, A, "the copy with the most bytes is the one to try again");
  // A comes back
  T = Date.parse(job.retryAt) + 1000;
  downloads.pumpNow();
  await flush();
  engine.set(A, 1, "all", { speed: 2e6, seeders: 3, connections: 3 });
  await run(10);
  await until(() => jobOf(j.id).status === "done", "the resumed copy to land");
  assert.ok(engine.log.purged.includes(A), "once it is in the library, the staging goes");
  assert.equal(jobOf(j.id).shelved, undefined);
});

test("the disk fills up mid-download: the job waits for room (never failed, never another copy), then carries on", async () => {
  await reset();
  const [A, B] = ["a", "b"].map(HASH);
  engine.define(A);
  engine.define(B);
  const req = movie(A);
  sources[req.imdbId] = [source(A), source(B)];
  const j = downloads.create(req).job;
  await flush();
  engine.set(A, 1, 20000, { speed: 1e6, seeders: 3, connections: 3 });
  await run(20);
  engine.set(A, 1, null, { state: "error", error: "Not enough disk space", errorCode: 9 });
  await run(10);
  const job = jobOf(j.id);
  assert.equal(job.status, "pending");
  assert.equal(job.diskHold, true);
  assert.match(job.holdReason, /disk is full/);
  assert.equal(job.infoHash, A, "the same copy: another one would not fit either");
  assert.equal(lookups, 0);
  assert.ok(!engine.log.purged.includes(A), "what it had is kept");
  // room again (the gate is off in this test, so the next look finds room)
  T += 2 * MIN;
  D.healthTick();
  await flush();
  assert.equal(jobOf(j.id).status, "downloading", "it carried on by itself");
  assert.equal(jobOf(j.id).diskHold, undefined);
});

test("a fake: a program where the film should be is filed as fake (for good) and the next copy taken at once", async () => {
  await reset();
  const [A, B] = ["a", "b"].map(HASH);
  engine.define(A, { names: ["Film.2021.1080p.exe", "readme.txt"], lengths: [100000, 100] });
  engine.define(B);
  const req = movie(A);
  sources[req.imdbId] = [source(A), source(B)];
  const j = downloads.create(req).job;
  await flush();
  await run(10);
  const job = jobOf(j.id);
  assert.equal(job.infoHash, B, "the next copy, within seconds");
  assert.equal(job.tried[0].kind, "fake");
  assert.match(job.note, /^That copy was fake or broken — now trying another/);
  const mark = badreleases.forTitle(req.imdbId).find((e) => e.h === A.toLowerCase());
  assert.equal(mark.why, "fake");
  assert.equal(mark.exp, undefined, "a fake does not get better");
});

test("the listed file is a sample: the feature is fetched instead, from the same copy", async () => {
  await reset();
  const A = HASH("a");
  engine.define(A, { names: ["Sample/film-sample.mkv", "Film.2021.1080p.mkv"], lengths: [20000, 100000] });
  const req = movie(A, { fileIdx: 0 });
  const j = downloads.create(req).job;
  await flush();
  await run(10);
  assert.equal(jobOf(j.id).fileIdx, 1, "file #2 (fileIdx 1) is the film");
  assert.ok(engine.log.selected.includes(`${A}#2`));
  assert.ok(engine.log.deselected.includes(`${A}#1`));
  engine.set(A, 2, "all", { speed: 1e6, seeders: 3, connections: 3 });
  await run(10);
  await until(() => jobOf(j.id).status === "done", "the film to land");
  const files = libraryFiles(jobOf(j.id));
  assert.equal(files.length, 1);
  assert.equal(fs.statSync(path.join(config.LIBRARIES.movies[0], `${req.title} (${req.year})`, files[0])).size, 100000, "the feature, not the sample");
});

test("the bytes are all there and ffprobe says it is not a film: nothing lands, the next copy", async () => {
  await reset();
  const [A, B] = ["a", "b"].map(HASH);
  engine.define(A);
  engine.define(B);
  const req = movie(A);
  sources[req.imdbId] = [source(A), source(B)];
  probes[path.join(engine.stagingDir(A), "file1.mkv")] = { invalid: true, video: false, duration: 0 };
  const j = downloads.create(req).job;
  await flush();
  engine.set(A, 1, "all", { speed: 1e6, seeders: 3, connections: 3 });
  await run(10);
  await until(() => jobOf(j.id).infoHash === B, "the next copy");
  assert.equal(libraryFiles(jobOf(j.id)).length, 0, "nothing landed");
  assert.equal(jobOf(j.id).tried[0].kind, "fake");
  engine.set(B, 1, "all", { speed: 1e6, seeders: 3, connections: 3 });
  await run(10);
  await until(() => jobOf(j.id).status === "done", "the good copy");
  assert.equal(libraryFiles(jobOf(j.id)).length, 1);
});

test("watching now: the next episode jumps the queue past the cap and the hold, and a quick one holds the others back until it is in", async () => {
  await reset();
  settings.data.maxActiveDownloads = 2;
  load = { watching: 1, streams: 0 };       // somebody is watching: the hold is 2
  const [X, Y, Z, E] = ["1", "2", "3", "e"].map(HASH);
  for (const h of [X, Y, Z]) engine.define(h, { length: 50e6 / 100 });
  engine.define(E);
  const jx = downloads.create(movie(X)).job;
  const jy = downloads.create(movie(Y)).job;
  const jz = downloads.create(movie(Z)).job;
  await flush();
  engine.set(X, 1, 100, { speed: 5e6, seeders: 20, connections: 30 });
  engine.set(Y, 1, 100, { speed: 5e6, seeders: 20, connections: 30 });
  await run(60);                                     // the line's speed is measured
  assert.equal(jobOf(jz.id).status, "approved");
  // the next episode of the show on screen, queued by smart downloads
  const ep = downloads.create({ infoHash: E, fileIdx: 0, type: "show", imdbId: "tt6600999", title: "V2 Show", season: 1, episode: 3, quality: "1080p", sizeBytes: 100000, seeders: 120, smart: true, auto: "next", profile: "bbbbbbbbbbbb" }).job;
  await flush();
  assert.equal(jobOf(ep.id).status, "approved", "an automatic download waits like any other…");
  assert.equal(downloads.publicJob(jobOf(ep.id)).priority.cls, 2);
  const marked = downloads.urgentAfter({ imdbId: "tt6600999", season: 1, episode: 2 }, T + 60 * MIN);
  assert.deepEqual(marked, [ep.id], "…until the episode before it plays");
  await flush();
  const t0 = T;
  assert.equal(jobOf(ep.id).status, "downloading", "it starts at once, past the hold of 2");
  assert.equal(downloads.publicJob(jobOf(ep.id)).priority.label, "Watching now");
  assert.equal(jobOf(jz.id).status, "approved", "the person's third film still waits its turn");
  engine.set(E, 1, 1000, { speed: 1e6, seeders: 40, connections: 40 });
  await run(10);
  const limits = engine.log.limits.slice();
  assert.ok(limits.includes(`${engine.gidOf(X)}:24576`) && limits.includes(`${engine.gidOf(Y)}:24576`), `the others are held to a trickle (${limits})`);
  assert.equal(jobOf(jx.id).note, "Paused for a moment — an episode someone is watching goes first");
  assert.ok(jobOf(jx.id).heldBack);
  assert.equal(jobOf(ep.id).note, "Going first — someone is watching the episode before it");
  assert.equal(jobOf(jx.id).health.state, "ok", "a held-back download is not judged slow for it");
  engine.set(E, 1, "all", { speed: 20e6, seeders: 40, connections: 40 });
  await run(10);
  await until(() => jobOf(ep.id).status === "done", "the next episode to land");
  const arrival = (T - t0) / 1000;
  await run(10);
  assert.ok(engine.log.limits.includes(`${engine.gidOf(X)}:0`) && engine.log.limits.includes(`${engine.gidOf(Y)}:0`), "…and let go once it is in");
  assert.equal(jobOf(jx.id).heldBack, undefined);
  assert.equal(jobOf(jx.id).note, null);
  assert.equal(D.preempt(), null);
  console.log(`[dlv2] next episode in ${arrival}s (fake clock) while two films ran`);
});

test("pre-empting is fair: a 'quick' one that is not quick lets go after 90 s and does not try again; a big one never holds anyone", async () => {
  await reset();
  const [X, E, G] = ["1", "e", "g"].map(HASH);
  engine.define(X);
  engine.define(E, { length: 1e6 });
  engine.define(G, { reported: 8e9 });
  const jx = downloads.create(movie(X)).job;
  await flush();
  engine.set(X, 1, 100, { speed: 5e6, seeders: 20, connections: 30 });
  await run(60);
  const ep = downloads.create({ infoHash: E, fileIdx: 0, type: "show", imdbId: "tt6600998", title: "V2 Show 2", season: 2, episode: 1, quality: "1080p", sizeBytes: 1e6, seeders: 100, smart: true, auto: "next" }).job;
  downloads.markUrgent({ imdbId: "tt6600998", season: 2, episode: 1 }, T + 60 * MIN);
  await flush();
  engine.set(E, 1, 100, { speed: 300, seeders: 2, connections: 2 });  // a crawl
  await run(10);
  assert.ok(D.preempt(), "held the others back on the estimate…");
  await run(100);
  assert.equal(D.preempt(), null, "…and let go once its real speed showed it is not quick");
  assert.equal(jobOf(ep.id).preemptTried, true);
  await run(300);
  assert.equal(D.preempt(), null, "it does not try again");
  assert.equal(jobOf(jx.id).heldBack, undefined);
  // a big next episode starts first but holds nobody back
  const big = downloads.create({ infoHash: G, fileIdx: 0, type: "show", imdbId: "tt6600997", title: "V2 Show 3", season: 1, episode: 2, quality: "2160p", sizeBytes: 8e9, seeders: 300, smart: true, auto: "next" }).job;
  downloads.markUrgent({ imdbId: "tt6600997", season: 1, episode: 2 }, T + 60 * MIN);
  await flush();
  engine.set(G, 1, 100, { speed: 5e6, seeders: 30, connections: 30 });
  await run(30);
  assert.equal(jobOf(big.id).status, "downloading");
  assert.equal(D.preempt(), null, "8 GB is not quick: nobody is held back for it");
});

test("the same episode asked for twice (another copy, same quality) is one download; the second person hears too", async () => {
  await reset();
  const [A, B] = ["a", "b"].map(HASH);
  engine.define(A);
  engine.define(B);
  const base = { fileIdx: 0, type: "show", imdbId: "tt6600900", title: "Twice Show", season: 1, episode: 1, quality: "1080p", sizeBytes: 100000 };
  const one = downloads.create({ ...base, infoHash: A, profile: "aaaaaaaaaaaa", smart: true, auto: "next" });
  const two = downloads.create({ ...base, infoHash: B, profile: "cccccccccccc" });
  assert.equal(two.duplicate, true);
  assert.equal(two.job.id, one.job.id);
  const job = jobOf(one.job.id);
  assert.deepEqual(job.also, ["cccccccccccc"]);
  assert.equal(job.smart, false, "a person asked for it: it is theirs to keep, no tidy-up");
  // a different quality is a different copy, on purpose
  const four = downloads.create({ ...base, infoHash: HASH("c"), quality: "2160p", profile: "cccccccccccc" });
  assert.ok(!four.duplicate);
});

test("a restart after a switch: the copies tried, the bytes set aside and the wait all survive; nothing runs twice", async () => {
  await reset();
  const [A, B] = ["a", "b"].map(HASH);
  engine.define(A, { length: 1000000 });
  engine.define(B, { meta: false });
  const req = movie(A, { sizeBytes: 1000000 });
  sources[req.imdbId] = [source(A, { sizeBytes: 1000000 }), source(B, { sizeBytes: 1000000 })];
  const j = downloads.create(req).job;
  await flush();
  engine.set(A, 1, 300000, { speed: 0, seeders: 0, connections: 1 });
  await runUntil(() => jobOf(j.id).infoHash === B, 1200);
  // the server stops (the engine with it) and comes back
  const saved = JSON.parse(JSON.stringify(downloads.rawJobs()));
  D.active.clear();
  engine.reset();
  engine.define(A, { length: 1000000 });
  engine.define(B);
  D.store.data.length = 0;
  D.store.data.push(...saved);
  D.resume();
  downloads.pumpNow();
  await flush();
  const job = jobOf(j.id);
  assert.equal(job.status, "downloading");
  assert.equal(job.infoHash, B, "it carries on with the copy it had moved to");
  assert.equal(job.tried.length, 1, "the dead copy is still known as tried");
  assert.equal(job.shelved.length, 1, "and its bytes are still set aside");
  assert.equal(job.health.state, "starting", "a fresh grace after a restart");
  assert.equal(D.active.size, 1);
  assert.equal(engine.log.added.length, 1, "one download in the engine, not two");
});

test("aria2 reports a finished download as COMPLETE with 0 bytes per file (seed-time 0): it still lands", async () => {
  await reset();
  const A = HASH("a");
  engine.define(A);
  const j = downloads.create(movie(A)).job;
  await flush();
  engine.set(A, 1, 40000, { speed: 2e6, seeders: 3, connections: 3 });
  await run(10);
  assert.ok(jobOf(j.id).progress > 0.3);
  // between two polls it finished — and the engine now says 0 of the file
  engine.set(A, 1, 0, { state: "complete", speed: 0 });
  await run(10);
  await until(() => jobOf(j.id).status === "done", "the finished download to land");
  assert.equal(libraryFiles(jobOf(j.id)).length, 1);
});
