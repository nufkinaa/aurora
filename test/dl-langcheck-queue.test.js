// The language check before a download lands (media/langcheck.js, Niso's
// report 2026-10-31), played out against the same FAKE engine and fake clock
// as test/dlv2-queue.test.js: a "Wrong language" replacement that arrives in
// the wrong language is not swapped in — it is filed in badreleases and the
// next copy is fetched; one that says nothing about its language is swapped in
// with a plain line for the person; any other download is checked against the
// person's audio language when its tracks say theirs. Nothing here touches the
// real server, its data/ or the network.
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
let personLang = {};         // profile id → prefs.audioLang
let originals = {};          // imdbId → original language
let R;                       // media/replace.js
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
  D.seams.personLang = (who) => personLang[who] || null;
  D.seams.originalLanguage = async (job) => originals[job.imdbId] || null;
  R = S("media/replace");
  R._internals.seams.inUse = () => false;
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
  personLang = {};
  originals = {};
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

const PERSON = "aaaaaaaaaaaa";
const keyOf = (req) => req.imdbId;
// The copy in the library that a "Wrong language" request replaces.
const oldCopy = (req) => {
  const dir = path.join(config.LIBRARIES.movies[0], `${req.title} (${req.year})`);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${req.title} (${req.year}).mkv`);
  fs.writeFileSync(p, Buffer.alloc(5000, 9));
  return p;
};
const languageReplace = (req, oldPath, lang) => ({
  ...req,
  label: `${req.title} — another version`,
  replaces: {
    id: `r${req.imdbId.slice(-5)}`, libraryId: `lib${req.imdbId.slice(-5)}`, path: oldPath, reason: "language", reasonLabel: "Wrong language",
    by: PERSON, byName: "Tester", oldRelease: "Old.Release.1080p", oldInfoHash: null, titleKey: req.imdbId, lang,
  },
});
const finish = async (hash, jobId, what) => {
  engine.set(hash, 1, "all", { speed: 1e6, seeders: 3, connections: 3 });
  await run(10);
  await until(what, `the download of ${hash.slice(0, 4)} to be judged`);
};
const audio = (...tags) => ({ video: true, duration: 7200, invalid: false, audio: tags.map((t) => (typeof t === "string" || t == null ? { language: t, title: null } : t)) });

test("a 'Wrong language' replacement that arrives in the wrong language is not swapped in: filed, and the copy that names the language is next", async () => {
  await reset();
  const [A, B, C] = ["a", "b", "c"].map(HASH);
  for (const h of [A, B, C]) engine.define(h);
  const req = movie(A, { release: "Film.2021.1080p.WEB" });
  const oldPath = oldCopy(req);
  sources[req.imdbId] = [source(A, { release: "Film.2021.1080p.WEB" }), source(C, { release: "Film.2021.1080p.BluRay", seeders: 900 }), source(B, { release: "Film.2021.1080p.HEBREW.WEB-DL", seeders: 5 })];
  probes[path.join(engine.stagingDir(A), "file1.mkv")] = audio("eng");
  probes[path.join(engine.stagingDir(B), "file1.mkv")] = audio("heb", "eng");
  const j = downloads.create(languageReplace(req, oldPath, { want: ["he"], wrong: ["en"] })).job;
  await flush();
  await finish(A, j.id, () => jobOf(j.id).infoHash !== A);
  const job = jobOf(j.id);
  assert.equal(job.infoHash, B, "the copy that names Hebrew goes before the better-seeded one that names nothing");
  assert.equal(job.tried[0].kind, "language");
  assert.match(job.note, /^That copy was in English, not Hebrew — now trying another/);
  assert.ok(fs.existsSync(oldPath), "the old copy is untouched");
  const mark = badreleases.match(keyOf(req), { infoHash: A });
  assert.ok(mark && mark.why === "language" && mark.auto === true && !mark.exp, "the wrong copy is filed for good, as the server's own mark");
  await finish(B, j.id, () => jobOf(j.id).status === "done");
  assert.ok(!fs.existsSync(oldPath) || fs.statSync(oldPath).size !== 5000, "the right copy took the old one's place");
  const pj = downloads.publicJob(jobOf(j.id));
  assert.equal(pj.langLine, null, "nothing to warn about");
  assert.equal(pj.readyLine, `The new version of “${req.title}” is in — ready to watch`);
});

test("a 'Wrong language' replacement whose audio says nothing is swapped in, and the person is told plainly", async () => {
  await reset();
  const [A, B] = ["a", "b"].map(HASH);
  for (const h of [A, B]) engine.define(h);
  const req = movie(A);
  const oldPath = oldCopy(req);
  sources[req.imdbId] = [source(A), source(B)];
  probes[path.join(engine.stagingDir(A), "file1.mkv")] = audio("und", null);
  const j = downloads.create(languageReplace(req, oldPath, { want: ["he"], wrong: ["en"] })).job;
  await flush();
  await finish(A, j.id, () => jobOf(j.id).status === "done");
  assert.equal(jobOf(j.id).infoHash, A, "no other copy was fetched");
  assert.equal(downloads.publicJob(jobOf(j.id)).langLine, "This copy doesn't say its language — report it again if it's wrong.");
  assert.equal(badreleases.match(keyOf(req), { infoHash: A }), null, "nothing filed against it");
});

test("a 'Wrong language' replacement that never finds the language: every copy tried, then a plain failure — the old copy stays", async () => {
  await reset();
  const [A, B] = ["a", "b"].map(HASH);
  for (const h of [A, B]) engine.define(h);
  const req = movie(A);
  const oldPath = oldCopy(req);
  sources[req.imdbId] = [source(A), source(B)];
  probes[path.join(engine.stagingDir(A), "file1.mkv")] = audio("eng");
  probes[path.join(engine.stagingDir(B), "file1.mkv")] = audio({ language: "eng", title: "English 5.1" });
  const j = downloads.create(languageReplace(req, oldPath, { want: ["he"], wrong: ["en"] })).job;
  await flush();
  await finish(A, j.id, () => jobOf(j.id).infoHash === B);
  await finish(B, j.id, () => jobOf(j.id).status === "error");
  const job = jobOf(j.id);
  assert.equal(job.error, "No copy in Hebrew could be found — the 2 copies tried were in another language. Try again later.");
  assert.ok(fs.existsSync(oldPath) && fs.statSync(oldPath).size === 5000, "the old copy stays as it was");
  assert.equal(engine.log.added.filter((x) => x.startsWith(A)).length, 1, "the wrong copy is never fetched again");
});

test("any download: tracks that say another language than the person's and the title's → the next copy", async () => {
  await reset();
  const [A, B] = ["a", "b"].map(HASH);
  for (const h of [A, B]) engine.define(h);
  const req = movie(A);
  personLang[PERSON] = "he";
  originals[req.imdbId] = "en";
  sources[req.imdbId] = [source(A), source(B)];
  probes[path.join(engine.stagingDir(A), "file1.mkv")] = audio({ language: "eng", title: "Russian Dub" });
  probes[path.join(engine.stagingDir(B), "file1.mkv")] = audio("eng");
  const j = downloads.create(req).job;
  await flush();
  await finish(A, j.id, () => jobOf(j.id).infoHash === B);
  assert.match(jobOf(j.id).note, /^That copy was in Russian, not Hebrew or English — now trying another/, "a track's title beats its tag");
  await finish(B, j.id, () => jobOf(j.id).status === "done");
  assert.equal(libraryFiles(jobOf(j.id)).length, 1);
  assert.equal(downloads.publicJob(jobOf(j.id)).langLine, null);
});

test("any download in the title's own language is right for a person who speaks another (no false 'wrong')", async () => {
  await reset();
  const [A] = ["a"].map(HASH);
  engine.define(A);
  const req = movie(A);
  personLang[PERSON] = "heb";
  originals[req.imdbId] = "en";
  sources[req.imdbId] = [source(A)];
  probes[path.join(engine.stagingDir(A), "file1.mkv")] = audio("eng");
  const j = downloads.create(req).job;
  await flush();
  await finish(A, j.id, () => jobOf(j.id).status === "done");
  assert.equal(jobOf(j.id).langCheck.verdict, "right");
});

test("any download: wrong language with no other copy to try lands as it is, and says so", async () => {
  await reset();
  const [A] = ["a"].map(HASH);
  engine.define(A);
  const req = movie(A);
  personLang[PERSON] = "en";
  originals[req.imdbId] = "en";
  sources[req.imdbId] = [source(A)];
  probes[path.join(engine.stagingDir(A), "file1.mkv")] = audio("rus", "ukr");
  const j = downloads.create(req).job;
  await flush();
  await finish(A, j.id, () => jobOf(j.id).status === "done");
  assert.equal(libraryFiles(jobOf(j.id)).length, 1, "it is in the library");
  assert.equal(downloads.publicJob(jobOf(j.id)).langLine, "This copy is in Russian and Ukrainian — no copy in English was found.");
  assert.equal(badreleases.match(keyOf(req), { infoHash: A }), null, "nothing filed: it is the copy the person has");
});

test("any download: no check without tagged tracks, without the person's language, or without the title's", async () => {
  for (const [what, setup, facts] of [
    ["untagged", () => { personLang[PERSON] = "en"; }, audio(null, "und")],
    ["no person language", () => {}, audio("rus")],
    ["no original language", () => { personLang[PERSON] = "en"; }, audio("rus")],
  ]) {
    await reset();
    const [A, B] = ["a", "b"].map(HASH);
    for (const h of [A, B]) engine.define(h);
    const req = movie(A);
    setup();
    if (what !== "no original language") originals[req.imdbId] = "en";
    sources[req.imdbId] = [source(A), source(B)];
    probes[path.join(engine.stagingDir(A), "file1.mkv")] = facts;
    const j = downloads.create(req).job;
    await flush();
    await finish(A, j.id, () => jobOf(j.id).status === "done");
    assert.equal(jobOf(j.id).infoHash, A, `${what}: it lands`);
    assert.equal(lookups, 0, `${what}: no source lookup`);
    assert.equal(downloads.publicJob(jobOf(j.id)).langLine, null, `${what}: nothing to say`);
  }
});

test("tell me when it's ready: Web Push for the person who asked, not when they said no, never for a smart download nobody asked for", async () => {
  const push = require(path.join(root, "src", "lib", "push"));
  const realSend = push.send;
  const sent = [];
  push.send = (who, msg) => { sent.push({ who, ...msg }); return Promise.resolve(); };
  const realReady = D.seams.readyNotice;
  const off = new Set();
  D.seams.readyNotice = (who) => !off.has(who);
  try {
    for (const [what, over] of [
      ["asked for", {}],
      ["said no", {}],
      ["smart", { smart: true, auto: "next" }],
    ]) {
      await reset();
      sent.length = 0;
      off.clear();
      if (what === "said no") off.add(PERSON);
      const A = HASH("a");
      engine.define(A);
      const req = movie(A, over);
      sources[req.imdbId] = [source(A)];
      const j = downloads.create(req).job;
      await flush();
      await finish(A, j.id, () => jobOf(j.id).status === "done");
      await flush();
      const mine = sent.filter((x) => x.who === PERSON);
      if (what === "asked for") {
        assert.equal(mine.length, 1, "one push");
        assert.equal(mine[0].body, "Downloaded and ready to watch.");
        assert.equal(downloads.publicJob(jobOf(j.id)).readyLine, `“${req.title}” is ready to watch`);
      } else assert.equal(mine.length, 0, `${what}: no push`);
    }
  } finally {
    push.send = realSend;
    D.seams.readyNotice = realReady;
  }
});
