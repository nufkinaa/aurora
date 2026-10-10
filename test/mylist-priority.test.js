// My List downloads come LAST, and give way while they run (the owner,
// 2026-10-10: "a list add download should have lower priority than all other
// download types and should be on hold if and when something else needs to be
// downloaded").
//
// Two halves:
//   * the rule itself — media/dlslots.js plan() — as plain data in, plain
//     data out;
//   * the queue carrying it out against a FAKE engine, the same way
//     test/dlrace-queue.test.js plays the queue: src/ is copied into a temp
//     folder with its own config.json, data/ and library and required from
//     there; the engine is an in-memory stand-in (no aria2 process, no
//     torrent, no network — fetch is refused outright); the clock, the timers
//     and "who is watching" are the queue's test seams.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.join(__dirname, "..");
const dlslots = require("../src/media/dlslots");

// ====================================================================
// Part 1 — the rule (pure)
// ====================================================================

const W = (id, kind, over = {}) => ({
  id,
  tier: kind === "mylist" ? dlslots.TIER_MYLIST : kind === "auto" ? dlslots.TIER_AUTO : dlslots.TIER_PERSON,
  yields: kind === "mylist", held: false, progress: 0, ...over,
});
const R = (id, kind, over = {}) => ({ id, yields: kind === "mylist", locked: false, stalled: false, progress: 0, startedAt: 0, ...over });

test("the tiers: a person's request, then the other automatic kinds, then My List — and 'Start now' lifts a job out", () => {
  assert.equal(dlslots.tierOf({ smart: false, auto: null }), dlslots.TIER_PERSON);
  assert.equal(dlslots.tierOf({ smart: true, auto: null }), dlslots.TIER_AUTO, "the next episode, a followed show");
  assert.equal(dlslots.tierOf({ smart: true, auto: "mylist" }), dlslots.TIER_MYLIST);
  assert.equal(dlslots.tierOf({ smart: true, auto: "mylist", startNow: true }), dlslots.TIER_PERSON);
  assert.equal(dlslots.yields({ auto: "mylist" }), true);
  assert.equal(dlslots.yields({ auto: "mylist", startNow: true }), false);
  assert.equal(dlslots.yields({ smart: true }), false, "smart downloads never give way");
  assert.equal(dlslots.yieldMode(undefined), "always", "a settings file from before the key existed");
  assert.equal(dlslots.yieldMode("slots"), "slots");
  assert.equal(dlslots.yieldMode("sometimes"), "always");
});

test("the order: several of each kind waiting — people first, then automatic, My List last; the queue's own order inside a kind", () => {
  const waiting = [W("ml2", "mylist"), W("a2", "auto"), W("p2", "person"), W("ml1", "mylist"), W("a1", "auto"), W("p1", "person")];
  for (const mode of ["always", "slots"]) {
    const p = dlslots.plan({ cap: 6, mode, waiting });
    assert.deepEqual(p.start.slice(0, 4), ["p2", "p1", "a2", "a1"], `${mode}: everything else first, in tier order`);
    // six slots for six jobs: "slots" lets My List use the two nobody else wants; "always" does not
    assert.deepEqual(p.start.slice(4), mode === "slots" ? ["ml2", "ml1"] : []);
    assert.equal(dlslots.plan({ cap: 3, mode, waiting }).blocked, true);
    assert.deepEqual(dlslots.plan({ cap: 3, mode, waiting }).start, ["p2", "p1", "a2"]);
  }
  // nothing else in the queue: My List runs, the one that was on hold first
  const mine = [W("fresh", "mylist"), W("heldLittle", "mylist", { held: true, progress: 0.1 }), W("heldMost", "mylist", { held: true, progress: 0.7 })];
  assert.deepEqual(dlslots.plan({ cap: 2, waiting: mine }).start, ["heldMost", "heldLittle"]);
  assert.deepEqual(dlslots.plan({ cap: 4, waiting: mine }).start, ["heldMost", "heldLittle", "fresh"]);
  assert.deepEqual(dlslots.plan({ cap: 4, waiting: mine, quiet: false }).start, [], "inside the quiet minute nothing of My List starts");
  // an admin's "Start now" (tier -1 in the queue's view) goes before everyone
  assert.deepEqual(dlslots.plan({ cap: 1, waiting: [W("p", "person"), W("now", "person", { tier: -1 })] }).start, ["now"]);
});

test("a waiting My List job never takes a slot another waiting job could use", () => {
  const p = dlslots.plan({ cap: 2, mode: "slots", running: [R("x", "person")], waiting: [W("ml", "mylist"), W("a", "auto")] });
  assert.deepEqual(p.start, ["a"]);
  // "slots": with the others all running and a slot still free, it runs beside them
  assert.deepEqual(dlslots.plan({ cap: 3, mode: "slots", running: [R("x", "person"), R("a", "auto")], waiting: [W("ml", "mylist")] }).start, ["ml"]);
  // "always": not while anything else is live
  const q = dlslots.plan({ cap: 3, mode: "always", running: [R("x", "person")], waiting: [W("ml", "mylist")] });
  assert.deepEqual([q.start, q.blocked], [[], true]);
});

test("'slots': a running My List job is held when another job needs its slot — one at a time, the one with least of its file first", () => {
  const running = [R("p", "person"), R("mlBig", "mylist", { progress: 0.8 }), R("mlSmall", "mylist", { progress: 0.1 })];
  let p = dlslots.plan({ cap: 3, mode: "slots", running, waiting: [W("new", "person")] });
  assert.deepEqual(p.hold, [{ id: "mlSmall", why: "downloads" }]);
  assert.deepEqual(p.start, ["new"]);
  assert.equal(p.blocked, false, "the newcomer has its slot: nothing is waiting any more");
  p = dlslots.plan({ cap: 3, mode: "slots", running, waiting: [W("n1", "person"), W("n2", "auto"), W("n3", "auto")] });
  assert.deepEqual(p.hold.map((h) => h.id), ["mlSmall", "mlBig"]);
  assert.deepEqual(p.start, ["n1", "n2"]);
  assert.equal(p.blocked, true, "n3 still waits — behind real downloads now, which are never stopped");
  // free slots: nothing is held
  p = dlslots.plan({ cap: 4, mode: "slots", running, waiting: [W("new", "person")] });
  assert.deepEqual([p.hold, p.start], [[], ["new"]]);
  // a job being copied into the library is finished: it is not put on hold
  p = dlslots.plan({ cap: 1, mode: "slots", running: [R("ml", "mylist", { locked: true })], waiting: [W("new", "person")] });
  assert.deepEqual([p.hold, p.start], [[], []]);
});

test("'always': held whenever anything else is waiting or running, free slots or not", () => {
  let p = dlslots.plan({ cap: 4, mode: "always", running: [R("ml", "mylist", { progress: 0.5 })], waiting: [W("new", "person")] });
  assert.deepEqual(p.start, ["new"]);
  assert.deepEqual(p.hold, [{ id: "ml", why: "downloads" }]);
  assert.equal(p.blocked, true);
  p = dlslots.plan({ cap: 4, mode: "always", running: [R("ml1", "mylist"), R("ml2", "mylist"), R("a", "auto")] });
  assert.deepEqual(p.hold.map((h) => h.id).sort(), ["ml1", "ml2"], "a smart download running is 'something else' too");
  p = dlslots.plan({ cap: 4, mode: "always", running: [R("ml1", "mylist"), R("ml2", "mylist")], waiting: [W("ml3", "mylist")] });
  assert.deepEqual([p.hold, p.start, p.blocked], [[], ["ml3"], false], "My List jobs do not give way to each other");
  // a download the healer restarted and that has not moved since holds its
  // slot but does not keep My List waiting
  p = dlslots.plan({ cap: 4, mode: "always", running: [R("dead", "person", { stalled: true }), R("ml", "mylist")] });
  assert.deepEqual([p.hold, p.blocked], [[], false]);
});

test("while people watch: My List jobs are the first — and the only — downloads stopped to get down to the viewing cap", () => {
  const running = [R("p1", "person"), R("p2", "person"), R("ml1", "mylist", { progress: 0.3 }), R("ml2", "mylist", { progress: 0.6 })];
  let p = dlslots.plan({ cap: 2, holding: true, mode: "slots", running });
  assert.deepEqual(p.hold, [{ id: "ml1", why: "watching" }, { id: "ml2", why: "watching" }]);
  p = dlslots.plan({ cap: 2, holding: true, mode: "slots", running: [R("p1", "person"), R("p2", "person"), R("p3", "person"), R("ml", "mylist")] });
  assert.deepEqual(p.hold, [{ id: "ml", why: "watching" }], "three people's downloads keep running: only My List is stopped");
  p = dlslots.plan({ cap: 2, holding: true, mode: "slots", running: [R("p1", "person"), R("ml", "mylist")] });
  assert.deepEqual(p.hold, [], "at the cap already: it stays");
  // a waiting job that cannot start because of the viewing cap takes a My List job's place
  p = dlslots.plan({ cap: 2, holding: true, mode: "slots", running: [R("p1", "person"), R("ml", "mylist")], waiting: [W("p2", "person")] });
  assert.deepEqual([p.hold, p.start], [[{ id: "ml", why: "downloads" }], ["p2"]]);
});

// ====================================================================
// Part 2 — the queue, against a fake engine
// ====================================================================

let root;
let downloads, D, config, memory, settings, mylist, healer, notify, push;
let engine;
let T = Date.now() + 5 * 3600e3;
let load = { watching: 0, streams: 0 };
let lookups = 0;
let said = [];               // every admin notification and every push
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

// One "torrent" per infoHash, one file of real bytes on disk. What a file has
// (`completed`) belongs to the TORRENT, not to the engine's download of it —
// so removing the download and adding it again carries on from the same
// bytes, which is what aria2 does with its staging folder.
const makeEngine = (stagingRoot, fileProgress) => {
  const torrents = new Map();
  const byGid = new Map();
  const log = { added: [], removed: [], purged: [] };
  let seq = 0;
  const get = (h) => torrents.get(h);
  return {
    log,
    define(infoHash, { length = 100000 } = {}) {
      const dir = path.join(stagingRoot, infoHash);
      fs.mkdirSync(dir, { recursive: true });
      const p = path.join(dir, "file1.mkv");
      fs.writeFileSync(p, Buffer.alloc(length, 1));
      torrents.set(infoHash, { infoHash, gid: null, files: [{ index: 1, path: p, length, completed: 0, selected: false }], speed: 0, seeders: 0, connections: 0, state: "active", error: null });
    },
    set(infoHash, completed, { speed, seeders, connections } = {}) {
      const t = get(infoHash);
      if (completed != null) t.files[0].completed = completed === "all" ? t.files[0].length : completed;
      if (speed != null) t.speed = speed;
      if (seeders != null) t.seeders = seeders;
      if (connections != null) t.connections = connections;
    },
    isLive: (infoHash) => { const t = get(infoHash); return !!(t && t.gid && byGid.has(t.gid)); },
    adds: (infoHash) => log.added.filter((h) => h === infoHash).length,
    staged: (infoHash) => fs.existsSync(path.join(stagingRoot, infoHash, "file1.mkv")),
    reset() { torrents.clear(); byGid.clear(); for (const k of Object.keys(log)) log[k].length = 0; },
    available: () => true,
    running: () => true,
    stagingDir: (h) => path.join(stagingRoot, h),
    fileProgress,
    add(magnet, infoHash) {
      const t = get(infoHash);
      if (!t) return Promise.reject(new Error(`unknown torrent ${infoHash}`));
      log.added.push(infoHash);
      return Promise.resolve().then(() => {
        if (!t.gid || !byGid.has(t.gid)) { t.gid = `gid${++seq}`; byGid.set(t.gid, t); t.state = "active"; }
        t.files[0].selected = true;
        return t.gid;
      });
    },
    async status(gid) {
      const t = byGid.get(gid);
      if (!t) throw new Error(`aria2.tellStatus: GID ${gid} is not found`);
      return {
        state: t.state, error: t.error, downloadSpeed: t.speed, peers: t.seeders || t.connections,
        seeders: t.seeders, connections: t.connections, infoHash: t.infoHash, files: t.files.map((f) => ({ ...f })),
      };
    },
    async select() { return true; },
    async remove(gid) {
      const t = byGid.get(gid);
      if (!t) return;
      byGid.delete(gid);
      log.removed.push(t.infoHash);
    },
    async removeByInfoHash(infoHash) {
      const t = get(infoHash);
      if (t && t.gid && byGid.has(t.gid)) { byGid.delete(t.gid); log.removed.push(infoHash); }
      return 1;
    },
    async purge(infoHash) {
      log.purged.push(infoHash);
      fs.rmSync(path.join(stagingRoot, infoHash), { recursive: true, force: true });
    },
    applyEnginePlan: async () => ({ applied: true }),
  };
};

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-mlp-"));
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
  memory = S("media/sourcememory");
  settings = S("lib/settings");
  mylist = S("media/mylistdl");
  healer = S("lib/healer");
  notify = S("lib/notify");
  push = S("lib/push");
  // Nothing is ever sent from here: both are replaced by a list.
  notify.send = (title, message) => { said.push(`${title} | ${message}`); };
  push.send = (profile, msg) => { said.push(`push ${profile} | ${msg && msg.title}`); };
  D = downloads._internals;
  engine = makeEngine(path.join(root, "staging"), S("media/aria2").fileProgress);
  D.setEngine(engine);
  D.seams.auto = false;
  D.seams.clock = () => T;
  D.seams.load = () => load;
  D.seams.findSources = async () => { lookups++; return { streams: [] }; };
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
  setTimeout(() => process.exit(process.exitCode || 0), 50).unref();
});

// ---------- helpers ----------
const reset = async (mode) => {
  for (const j of downloads.rawJobs()) downloads.remove(j.id);
  await flush();
  assert.equal(D.active.size, 0, "nothing is left running from the test before");
  engine.reset();
  D.line.total = 0; D.line.at = 0; D.line.peak = null;
  D.store.data.length = 0;
  D.quietState.blocked = false; D.quietState.clearedAt = 0;
  load = { watching: 0, streams: 0 };
  lookups = 0;
  said = [];
  settings.data.maxActiveDownloads = 4;
  delete settings.data.myListYield;
  if (mode) settings.data.myListYield = mode;
  const recs = mylist._internals.records();
  for (const k of Object.keys(recs)) delete recs[k];
  T += 3600e3;
};
let titleN = 0;
// One download of a given kind: "person" (pressed Download), "auto" (smart /
// followed show), "mylist". Returns its job id; `hashOf` finds its torrent.
const hashes = new Map();
const add = (kind, letter) => {
  const n = ++titleN;
  const hash = HASH(letter);
  engine.define(hash);
  const r = downloads.create({
    infoHash: hash, fileIdx: 0, type: "movie", imdbId: `tt66${String(n).padStart(5, "0")}`, title: `Queue Film ${n}`, year: 2021,
    quality: "1080p", sizeBytes: 100000, profile: "p-test", profileName: "Tester",
    ...(kind === "auto" ? { smart: true } : kind === "mylist" ? { smart: true, auto: "mylist" } : {}),
  });
  assert.ok(r.job && !r.error, JSON.stringify(r));
  hashes.set(r.job.id, hash);
  return r.job.id;
};
const hashOf = (id) => hashes.get(id);
const jobOf = (id) => downloads.rawJobs().find((j) => j.id === id);
const pub = (id) => downloads.publicJob(jobOf(id));
const runningIds = () => [...D.active.keys()];
const isRunning = (id) => D.active.has(id);
// One poll = one "second" of the server's life, however far the clock jumped.
const tick = async (seconds = 1) => { T += seconds * 1000; await D.poll(); await flush(); };
// Give a running job bytes and a healthy speed, and let the queue see them.
const progress = async (id, bytes, speed = 5e6) => {
  engine.set(hashOf(id), bytes, { speed, seeders: 5, connections: 6 });
  await flush();
  await tick();
};
const pumpAfter = async (seconds) => { T += seconds * 1000; downloads.pumpNow(); await flush(); };
const QUIET_S = dlslots.RESUME_QUIET_MS / 1000;

// ---------- ordering ----------

test("queue: My List jobs start last — behind every person's and every automatic download — and only once the queue has been quiet", async () => {
  await reset();
  settings.data.maxActiveDownloads = 1;
  const first = add("person", "a");
  await flush();
  assert.deepEqual(runningIds(), [first]);
  const ml1 = add("mylist", "b"), s1 = add("auto", "c"), p1 = add("person", "d");
  const ml2 = add("mylist", "e"), s2 = add("auto", "f"), p2 = add("person", "g");
  await flush();
  assert.deepEqual(runningIds(), [first], "one slot: everything else waits");

  const order = [];
  for (let i = 0; i < 4; i++) {
    downloads.cancel(runningIds()[0]);
    await flush();
    assert.equal(D.active.size, 1);
    order.push(runningIds()[0]);
  }
  assert.deepEqual(order, [p2, p1, s2, s1], "people's requests, then the automatic ones; inside a kind the queue's own order (newest first)");

  downloads.cancel(s1);
  await flush();
  assert.equal(D.active.size, 0, "the last of the others just ended: My List does not jump in at once");
  assert.equal(pub(ml1).held, false, "waiting, never started: plain 'queued', not 'on hold'");
  await pumpAfter(QUIET_S - 5);
  assert.equal(D.active.size, 0, "still inside the quiet minute");
  await pumpAfter(6);
  assert.deepEqual(runningIds(), [ml2], "now it starts");
  downloads.cancel(ml2);
  await flush();
  assert.deepEqual(runningIds(), [ml1], "between My List jobs there is no waiting");
});

// ---------- on hold: "slots" ----------

test("queue ('slots'): every slot busy, a person's download arrives → the running My List job is put on hold with its bytes, the newcomer starts; it carries on after", async () => {
  await reset("slots");
  settings.data.maxActiveDownloads = 2;
  const ml = add("mylist", "a");
  const p1 = add("person", "b");
  await flush();
  assert.deepEqual(runningIds().sort(), [ml, p1].sort(), "'slots': with a slot free for everything else, a My List download runs beside the others");
  await progress(ml, 40000);
  assert.equal(jobOf(ml).progress, 0.4);
  said = [];

  const p2 = add("person", "c");
  await flush();
  assert.deepEqual(runningIds().sort(), [p1, p2].sort(), "the newcomer has the slot");
  let job = jobOf(ml);
  assert.equal(job.status, "approved", "on hold is a queued job…");
  assert.deepEqual(Object.keys(job.held).sort(), ["at", "why"]);
  assert.equal(job.held.why, "downloads");
  assert.equal(job.progress, 0.4, "…that keeps the progress it stopped at");
  assert.equal(job.downloadSpeed, 0);
  assert.ok(engine.log.removed.includes(hashOf(ml)), "its download was released in the engine");
  assert.ok(!engine.isLive(hashOf(ml)));
  assert.ok(!engine.log.purged.includes(hashOf(ml)), "its staging bytes were NOT purged");
  assert.ok(engine.staged(hashOf(ml)));
  assert.ok(downloads.liveInfoHashes().has(hashOf(ml)), "the staging sweep still sees them as wanted");
  assert.deepEqual(said.filter((s) => s.includes(job.title)), [], "nobody is notified about a hold");

  // the others finish (cancelled here): not resumed at once
  downloads.cancel(p2);
  await flush();
  assert.ok(!isRunning(ml), "a slot is free, but the quiet minute has only begun");
  await pumpAfter(QUIET_S - 2);
  assert.ok(!isRunning(ml));
  assert.equal(pub(ml).held, true);
  // …and a download arriving inside that minute starts the wait again
  const p3 = add("person", "d");
  await flush();
  assert.ok(isRunning(p3));
  await pumpAfter(5);
  assert.ok(!isRunning(ml), "p3 took the free slot; with both slots busy and nobody waiting the My List job simply waits");
  downloads.cancel(p3);
  await flush();
  said = [];
  await pumpAfter(QUIET_S + 1);
  assert.ok(isRunning(ml), "quiet for a minute: it carries on");
  job = jobOf(ml);
  assert.equal(job.status, "downloading");
  assert.equal(job.held, undefined);
  assert.equal(job.progress, 0.4, "from where it was, not from zero");
  assert.equal(engine.adds(hashOf(ml)), 2, "added to the engine again — once");
  assert.deepEqual(said, [], "nobody is notified about a resume");
  await progress(ml, 60000);
  assert.equal(jobOf(ml).progress, 0.6, "the engine continued from the bytes on disk");
  assert.equal(jobOf(ml).raceCount, undefined);
});

test("queue ('slots'): two My List jobs and one person's download — only as many are held as the newcomer needs", async () => {
  await reset("slots");
  settings.data.maxActiveDownloads = 2;
  const big = add("mylist", "a");
  const small = add("mylist", "b");
  await flush();
  await progress(big, 70000);
  await progress(small, 10000);
  const p = add("person", "c");
  await flush();
  assert.deepEqual(runningIds().sort(), [big, p].sort(), "the one with less of its file gave way; the other keeps running");
  assert.equal(pub(small).held, true);
  assert.equal(pub(big).held, false);
  downloads.cancel(p);
  await flush();
  await pumpAfter(QUIET_S + 1);
  assert.deepEqual(runningIds().sort(), [big, small].sort());
});

// ---------- on hold: "always" (the default) ----------

test("queue ('always', the default): a My List job is held whenever another download is active, even with free slots — and a waiting one does not start", async () => {
  await reset();
  assert.equal(downloads.slots().myListYield, "always");
  const ml = add("mylist", "a");
  await flush();
  assert.deepEqual(runningIds(), [ml], "an idle queue: it starts at once");
  await progress(ml, 30000);

  const p = add("person", "b");
  await flush();
  assert.equal(downloads.slots().cap, 4);
  assert.deepEqual(runningIds(), [p], "three slots are free, and it is on hold all the same");
  assert.equal(pub(ml).held, true);
  assert.equal(downloads.slots().held, 1);
  const ml2 = add("mylist", "c");
  await flush();
  assert.deepEqual(runningIds(), [p], "a new My List job waits too");
  assert.equal(pub(ml2).held, false);
  await pumpAfter(10 * QUIET_S);
  assert.deepEqual(runningIds(), [p], "for as long as the other download runs");

  // a smart download counts as "something else" as well
  downloads.cancel(p);
  await flush();
  const s = add("auto", "d");
  await flush();
  await pumpAfter(QUIET_S + 1);
  assert.deepEqual(runningIds(), [s]);

  downloads.cancel(s);
  await flush();
  await pumpAfter(QUIET_S + 1);
  assert.deepEqual(runningIds(), [ml, ml2], "the queue is quiet: the held one first, then the other");
  assert.equal(jobOf(ml).progress, 0.3);
});

test("queue ('always'): a dead download the healer keeps restarting does not keep My List on hold — until it moves again", async () => {
  await reset();
  const p = add("person", "a");
  await flush();
  engine.set(hashOf(p), 500, { speed: 0, seeders: 0, connections: 0 });
  await tick();
  const ml = add("mylist", "b");
  await flush();
  assert.deepEqual(runningIds(), [p]);
  assert.equal(downloads.restartJob(p, "stuck (test)"), true);
  downloads.pumpNow();
  await flush();
  assert.deepEqual(runningIds(), [p], "restarted, running again — with nothing new");
  await pumpAfter(1);
  await pumpAfter(QUIET_S + 1);
  assert.deepEqual(runningIds().sort(), [p, ml].sort(), "it holds its slot, but it is not 'something that needs to be downloaded'");
  await tick();
  assert.ok(isRunning(ml), "the same bytes as before the restart are not progress");
  engine.set(hashOf(p), 4000, { speed: 2e6, seeders: 3, connections: 3 });
  await tick();
  assert.deepEqual(runningIds(), [p], "it moved: My List gives way again");
  assert.equal(pub(ml).held, true);
});

// ---------- people watching ----------

test("queue: someone presses Play — My List jobs are held down to the viewing cap, nobody else's download is stopped; they carry on when viewing stops", async () => {
  await reset("slots");
  const p1 = add("person", "a"), p2 = add("person", "b"), p3 = add("person", "c");
  const ml = add("mylist", "d");
  await flush();
  assert.equal(D.active.size, 4);
  await progress(ml, 20000);
  load = { watching: 1, streams: 0 };
  downloads.pumpNow();
  await flush();
  assert.deepEqual(runningIds().sort(), [p1, p2, p3].sort(), "three people's downloads run on (over the cap of two, as always); only My List stopped");
  assert.deepEqual([pub(ml).held, pub(ml).heldReason], [true, "watching"]);

  downloads.cancel(p1);
  downloads.cancel(p2);
  await flush();
  await pumpAfter(QUIET_S + 1);
  await pumpAfter(QUIET_S + 1);
  assert.deepEqual(runningIds().sort(), [p3, ml].sort(), "one running while someone watches: the viewing cap (two) has room, so it carries on");
  load = { watching: 0, streams: 0 };

  // the default rule: on hold beside any other download anyway — and the
  // waiting job that cannot start because of the viewing cap takes its place
  await reset();
  const a = add("mylist", "e"), b = add("mylist", "f");
  await flush();
  assert.deepEqual(runningIds().sort(), [a, b].sort());
  load = { watching: 2, streams: 0 };
  const p = add("person", "g");
  await flush();
  assert.deepEqual(runningIds(), [p]);
  assert.deepEqual([pub(a).heldReason, pub(b).heldReason], ["downloads", "downloads"]);
});

// ---------- a restart ----------

test("queue: a hold survives a server restart — not lost, not started from zero, not started twice", async () => {
  await reset();
  const ml = add("mylist", "a");
  await flush();
  await progress(ml, 40000);
  const p = add("person", "b");
  await flush();
  assert.equal(pub(ml).held, true);
  D.store.flush?.();
  const onDisk = JSON.parse(fs.readFileSync(path.join(config.DATA_DIR, "downloads.json"), "utf8")).find((j) => j.id === ml);
  assert.equal(onDisk.held.why, "downloads", "the hold is in downloads.json");
  assert.equal(onDisk.progress, 0.4);

  // the process dies: the live records and the clocks are gone, the file is what it was
  D.active.clear();
  D.quietState.blocked = false; D.quietState.clearedAt = 0;
  engine.log.purged.length = 0;
  downloads.resume();
  await flush();
  let job = jobOf(ml);
  assert.deepEqual([job.status, job.held.why, job.progress], ["approved", "downloads", 0.4], "still on hold, still 40%");
  assert.equal(jobOf(p).status, "approved");
  assert.deepEqual(engine.log.purged, [], "nothing of it was purged at boot");
  downloads.pumpNow();
  await flush();
  assert.deepEqual(runningIds(), [p], "at boot the other download starts; the held one stays on hold");
  assert.equal(engine.adds(hashOf(ml)), 1, "it was not handed to the engine again");
  assert.equal(pub(ml).held, true);

  downloads.cancel(p);
  await flush();
  await pumpAfter(QUIET_S + 1);
  assert.deepEqual(runningIds(), [ml]);
  assert.equal(engine.adds(hashOf(ml)), 2);
  await tick();
  assert.equal(jobOf(ml).progress, 0.4, "the engine found its bytes: it carries on from them");

  // a restart with nothing else in the queue: the held job simply carries on
  const p2 = add("person", "c");
  await flush();
  assert.equal(pub(ml).held, true);
  downloads.cancel(p2);
  await flush();
  D.active.clear();
  D.quietState.blocked = false; D.quietState.clearedAt = 0;
  downloads.resume();
  downloads.pumpNow();
  await flush();
  assert.deepEqual(runningIds(), [ml]);
  assert.equal(jobOf(ml).held, undefined);
});

// ---------- what a held job is left out of ----------

test("a held job is not slow, not stalled, not stuck: no second source, no healer restart, no 'queue stuck', nothing remembered against its source", async () => {
  await reset();
  const ml = add("mylist", "a");
  await flush();
  // a trickle — exactly what the second-source race and the stall clock look for
  await progress(ml, 30000, 2);
  const p = add("person", "b");
  await flush();
  assert.equal(pub(ml).held, true);
  // My List's own record of this job, as media/mylistdl.js keeps it
  const rec = { key: jobOf(ml).imdbId, imdbId: jobOf(ml).imdbId, type: "movie", title: jobOf(ml).title, by: "p-test", profiles: ["p-test"], at: T, addedAt: T, acceptedAt: T, queuedAt: T, state: "queued", jobId: ml, attempts: 0 };
  mylist._internals.records()[rec.key] = rec;
  const recBefore = JSON.stringify(rec);

  // forty minutes pass: far past the race's grace (5 min), the healer's
  // "no bytes" (12 min) and "stuck" (15 min) lines
  engine.set(hashOf(p), 1000, { speed: 5e6, seeders: 5, connections: 5 });
  for (let i = 0; i < 240; i++) { await tick(10); engine.set(hashOf(p), 1000 + i * 10); }
  let job = jobOf(ml);
  assert.equal(job.status, "approved");
  assert.equal(pub(ml).held, true);
  assert.equal(job.race || null, null, "no second source was tried for it");
  assert.equal(job.raceCount, undefined);
  assert.equal(job.raceNote || null, null);
  assert.equal(job.stalledRestarts, undefined);
  assert.equal(lookups, 0, "no source list was even fetched");
  assert.equal(memory.forTitle(job.imdbId), null, "nothing is filed against its source");
  assert.equal(engine.adds(hashOf(ml)), 1);

  const q = downloads.queueHealth();
  assert.deepEqual(q.active.map((a) => a.job.id), [p], "the healer's stall check never sees it: it has no live record");
  assert.deepEqual([q.approvedWaiting, q.yielding, q.held, q.oldestApprovedAgeMs], [0, 1, 1, 0], "waiting on purpose is counted apart from 'approved with a free slot'");
  assert.equal(healer._internals.stallReason(job, D.active.get(ml)), null);
  // an hour on hold with three free slots is not a stuck queue
  job.approvedAt = new Date(Date.now() - 3600e3).toISOString();
  const pumpsBefore = engine.log.added.length;
  const check = await healer._internals.checkDownloads();
  // (this test drives the poll by hand, so the one thing the healer does find
  // is "no progress poller" — nothing about the held job, no pump, no restart)
  assert.equal(check.healed, "restarted the progress poller", JSON.stringify(check));
  assert.equal(check.detail, null);
  assert.match(check.summary, /1 from My List waiting for the others \(1 on hold\)/);
  assert.equal(engine.log.added.length, pumpsBefore, "the healer started nothing");
  assert.equal(pub(ml).held, true);

  // the daily cap and the retry counter: its record did not change
  assert.equal(JSON.stringify(mylist._internals.records()[rec.key]), recBefore);

  // the same holds for a My List job that is waiting its turn and never ran
  const ml2 = add("mylist", "c");
  await flush();
  jobOf(ml2).approvedAt = new Date(Date.now() - 3600e3).toISOString();
  assert.equal((await healer._internals.checkDownloads()).healed, "restarted the progress poller");
  // …but once the queue is quiet and its turn has come, a My List job that
  // still sits there IS a stuck queue, and the healer may pump it
  downloads.cancel(p);
  await flush();
  T += dlslots.RESUME_QUIET_MS + 1000;
  const q2 = downloads.queueHealth();
  assert.deepEqual([q2.approvedWaiting, q2.yielding], [2, 0]);
});

// ---------- the clocks ----------

test("the lifecycle clocks start when a held job LANDS: its My List record waits as 'queued' and gets the landing time", async () => {
  await reset();
  const ml = add("mylist", "a");
  await flush();
  await progress(ml, 50000);
  const j0 = jobOf(ml);
  const rec = { key: j0.imdbId, imdbId: j0.imdbId, type: "movie", title: j0.title, year: 2021, by: "p-test", profiles: ["p-test"], at: T, addedAt: T, acceptedAt: T, queuedAt: T, state: "queued", jobId: ml, attempts: 0 };
  mylist._internals.records()[rec.key] = rec;

  const p = add("person", "b");
  await flush();
  assert.equal(pub(ml).held, true);
  assert.deepEqual([rec.state, rec.doneAt, rec.attempts, rec.acceptedAt], ["queued", undefined, 0, rec.at], "on hold: no clock has started, nothing counted");
  downloads.cancel(p);
  await flush();
  await pumpAfter(QUIET_S + 1);
  assert.ok(isRunning(ml));
  assert.equal(rec.state, "queued");

  engine.set(hashOf(ml), "all");
  await tick();
  await until(() => jobOf(ml).status === "done", "the copy into the library");
  await flush();
  assert.equal(rec.state, "done", "landed");
  assert.equal(rec.doneAt, Date.parse(jobOf(ml).doneAt), "the 14 / 21 days count from the landing");
  assert.equal(rec.attempts, 0);
  assert.ok(said.some((s) => s.startsWith("Aurora: download ready")), "the usual 'ready' still goes out — once it has really landed");
});

// ---------- cancel, and the admin's "Start now" ----------

test("cancel works on a held job (the requester's own, and the admin's), and its staging bytes go", async () => {
  await reset();
  const ml = add("mylist", "a");
  await flush();
  await progress(ml, 40000);
  const p = add("person", "b");
  await flush();
  assert.equal(pub(ml).held, true);
  assert.equal(downloads.cancelOwn(ml, { id: "someone-else" }).error, "not your download");
  const r = downloads.cancelOwn(ml, { id: "p-test" });
  assert.equal(r.job.status, "canceled");
  assert.equal(r.job.held, false);
  assert.equal(jobOf(ml).held, undefined);
  await flush();
  assert.ok(engine.log.purged.includes(hashOf(ml)), "nothing wants those bytes any more");
  assert.deepEqual(runningIds(), [p], "the other download is untouched");

  const ml2 = add("mylist", "c");
  await flush();
  assert.ok(!isRunning(ml2));
  assert.equal(downloads.cancel(ml2).job.status, "canceled", "the admin's cancel, on one that is waiting its turn");
  await pumpAfter(QUIET_S + 1);
  assert.deepEqual(runningIds(), [p], "a cancelled job never comes back");
});

test("the admin's 'Start now': a held job goes to the front, takes a slot like any other, and never gives way again", async () => {
  await reset();
  const ml = add("mylist", "a");
  await flush();
  await progress(ml, 40000);
  const p = add("person", "b");
  await flush();
  assert.equal(pub(ml).held, true);
  assert.equal(downloads.startNow("nope").error, "not found");

  const r = downloads.startNow(ml);
  await flush();
  assert.equal(r.job.status, "downloading");
  assert.deepEqual(runningIds().sort(), [ml, p].sort(), "a slot was free: it runs beside the other download");
  assert.equal(jobOf(ml).progress, 0.4);
  const p2 = add("person", "c");
  await flush();
  await pumpAfter(5);
  assert.ok(isRunning(ml), "another download arriving does not put it on hold again");
  assert.equal(pub(ml).auto, "mylist", "it is still a My List download (its copy still follows the 14 / 21 day rule)");
  assert.equal(downloads.startNow(ml).job.status, "downloading", "pressing it on a running job changes nothing");

  // every slot busy: it is simply next, ahead of everything else that waits
  await reset();
  settings.data.maxActiveDownloads = 1;
  const busy = add("person", "d");
  const waitingPerson = add("person", "e");
  const ml2 = add("mylist", "f");
  await flush();
  downloads.startNow(ml2);
  await flush();
  assert.deepEqual(runningIds(), [busy], "no running download is stopped for it");
  downloads.cancel(busy);
  await flush();
  assert.deepEqual(runningIds(), [ml2], "next in line — before the person's request, and with no quiet minute");
  assert.equal(jobOf(waitingPerson).status, "approved");
  void p2;
});

test("a person pressing Download on a held My List job's own source takes it over: it stops waiting", async () => {
  await reset();
  const ml = add("mylist", "a");
  await flush();
  await progress(ml, 40000);
  const p = add("person", "b");
  await flush();
  assert.equal(pub(ml).held, true);
  const j = jobOf(ml);
  const r = downloads.create({ infoHash: j.infoHash, fileIdx: 0, type: "movie", imdbId: j.imdbId, title: j.title, year: 2021, quality: "1080p", sizeBytes: 100000, profile: "p-other", profileName: "Other" });
  await flush();
  assert.equal(r.duplicate, true);
  assert.deepEqual([jobOf(ml).auto, jobOf(ml).smart, jobOf(ml).held], [null, false, undefined]);
  assert.deepEqual(runningIds().sort(), [ml, p].sort(), "a person's download now: it runs beside the other one");
  assert.equal(jobOf(ml).progress, 0.4);
});

// ---------- what clients are sent ----------

test("the API: a held job keeps a status every client knows ('approved') and adds held / heldReason / heldAt — nothing an old client reads changes", async () => {
  await reset();
  const ml = add("mylist", "a");
  await flush();
  await progress(ml, 40000);
  const running = pub(ml);
  assert.deepEqual([running.held, running.heldReason, running.heldAt], [false, null, null]);
  add("person", "b");
  await flush();
  const held = pub(ml);
  assert.equal(held.status, "approved", "the released TV app and older website tabs file this under 'queued'; an unknown status would drop the row");
  assert.ok(["pending", "approved", "downloading", "done", "declined", "canceled", "error"].includes(held.status));
  assert.equal(held.held, true);
  assert.equal(held.heldReason, "downloads");
  assert.ok(Date.parse(held.heldAt) > 0);
  assert.equal(held.progress, 0.4, "its progress so far is what `progress` says");
  assert.equal(held.holdReason, null, "holdReason means 'an admin has to approve it' — it is not used for this");
  assert.equal(held.downloadSpeed, 0);
  assert.equal(held.phase, null);
  assert.equal(held.race, null);
  assert.deepEqual([held.auto, held.smart], ["mylist", true]);
  assert.deepEqual(Object.keys(held).sort(), Object.keys(running).sort(), "the same fields whether held or not");
  for (const k of ["id", "infoHash", "fileIdx", "imdbId", "title", "label", "type", "season", "episode", "quality", "sizeBytes", "poster", "provider", "status", "phase", "copyProgress", "progress", "downloadSpeed", "peers", "error", "at", "approvedAt", "doneAt", "holdReason", "autoApproved", "seenAt", "smart", "resolvedAt", "auto", "libraryId", "race", "raceNote"]) {
    assert.ok(k in held, `${k} is still sent`);
  }
  const mine = downloads.listFor({ id: "p-test" }).find((j) => j.id === ml);
  assert.deepEqual([mine.mine, mine.held, mine.status], [true, true, "approved"], "the same on GET /api/downloads");
});

// ---------- the setting ----------

test("the setting: myListYield is 'always' unless set, only the two known words are accepted, and a change takes effect at once", async () => {
  await reset();
  const { readSettings, parseSettings } = mylist._internals;
  assert.equal(readSettings({}).myListYield, "always");
  assert.equal(readSettings({ myListYield: "slots" }).myListYield, "slots");
  assert.equal(readSettings({ myListYield: "never" }).myListYield, "always");
  assert.match(parseSettings({ myListYield: "never" }, {}).error, /Gives way must be one of: always, slots/);
  assert.equal(parseSettings({ myListYield: "slots" }, {}).value.myListYield, "slots");
  assert.equal(parseSettings({ myListDailyCap: 3 }, { myListYield: "slots" }).value.myListYield, "slots", "a save that does not mention it leaves it alone");

  const ml = add("mylist", "a");
  await flush();
  const p = add("person", "b");
  await flush();
  assert.deepEqual(runningIds(), [p]);
  assert.equal(mylist.setSettings({ myListYield: "slots" }).ok, true);
  assert.equal(settings.data.myListYield, "slots");
  await flush();
  await pumpAfter(1);
  await pumpAfter(QUIET_S + 1);
  assert.deepEqual(runningIds().sort(), [ml, p].sort(), "'slots': there is a free slot, so it runs beside the other download");
  assert.equal(mylist.setSettings({ myListYield: "always" }).ok, true);
  await flush();
  assert.deepEqual(runningIds(), [p], "back to 'always': on hold at once");
});
