// Moving titles between drives (src/lib/drives/mover.js), for real on temp
// folders — the copies, checks and renames are the real child-process ops:
//   - cold titles leave the fast drive when it runs low (oldest first; never
//     one on a My List, part-way watched, playing or played lately);
//   - a restart in the middle of a copy: the move goes on from where it was;
//   - a title that starts playing mid-copy: the move stops, the original is
//     untouched, the temp copy goes;
//   - someone watching from the drive: the move waits, then goes on;
//   - "Stop using this drive": an empty one, one with titles (they move, then
//     it is removed), one that does not answer (removed as it is).
// The library is the folders themselves (deps.libraryTitles), as the
// scanner would list them: a title keeps its id when it moves.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const base = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-drives-mover-"));
const A = path.join(base, "fast");
const B = path.join(base, "slow");
const C = path.join(base, "empty");
const D = path.join(base, "gone");
for (const d of [A, B, C, D]) for (const k of ["Movies", "Shows"]) fs.mkdirSync(path.join(d, "Aurora", k), { recursive: true });
process.env.AURORA_DRIVES_EXTRA = JSON.stringify([{ path: A }, { path: B }, { path: C }, { path: D, network: true }]);

const config = require("../src/config");
const drives = require("../src/lib/drives");
const rules = require("../src/lib/drives/rules");
const { _internals: I } = drives;

const DAY = 86400e3;
const GB = 1e9;
const CONFIG = path.join(base, "config.json");
const lib = (d, k) => path.join(d, "Aurora", k);
const saved = { movies: config.LIBRARIES.movies.slice(), shows: config.LIBRARIES.shows.slice() };
const setLibraries = (list) => {
  config.LIBRARIES.movies.splice(0, config.LIBRARIES.movies.length, ...list.map((d) => lib(d, "Movies")));
  config.LIBRARIES.shows.splice(0, config.LIBRARIES.shows.length, ...list.map((d) => lib(d, "Shows")));
  fs.writeFileSync(CONFIG, JSON.stringify({ adminName: "Test", libraries: { movies: config.LIBRARIES.movies.slice(), shows: config.LIBRARIES.shows.slice() } }, null, 2));
};
after(() => {
  drives.stop();
  config.LIBRARIES.movies.splice(0, config.LIBRARIES.movies.length, ...saved.movies);
  config.LIBRARIES.shows.splice(0, config.LIBRARIES.shows.length, ...saved.shows);
  delete process.env.AURORA_DRIVES_FAKE_SLOW_MS_PER_MB;
  delete process.env.AURORA_DRIVES_FAKE_HANG;
  fs.rmSync(base, { recursive: true, force: true });
});

// ---- the made-up library: what people did with each title, by folder name ----
let meta = {};
let playing = [];
const kindOf = (root) => (/Shows$/.test(root) ? "show" : "movie");
const libraryTitles = () => {
  const out = [];
  for (const root of [...config.LIBRARIES.movies, ...config.LIBRARIES.shows]) {
    let names = [];
    try { names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name); } catch {}
    for (const name of names) {
      const dir = path.join(root, name);
      const kind = kindOf(root);
      const id = `${kind}:${name}`;
      const files = [];
      const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
      walk(dir);
      const m = meta[name] || {};
      out.push({ id, ids: [id], kind, title: name, root, dir, sizeBytes: files.reduce((n, f) => n + fs.statSync(f).size, 0),
        lastPlayed: m.lastPlayed || 0, addedAt: m.addedAt || Date.now() - 400 * DAY, onList: !!m.onList, midway: !!m.midway, downloading: !!m.downloading });
    }
  }
  return out;
};
const titlesUnder = (dirs) => libraryTitles().filter((t) => dirs.some((d) => path.resolve(t.root) === path.resolve(d))).length;

const room = {}; // drive folder -> { total, free } (what statfs says)
const lowFast = () => { room[A] = { total: 1000 * GB, free: 150 * GB }; room[B] = { total: 4000 * GB, free: 3000 * GB }; }; // the fast drive: 10% room
Object.assign(drives.deps, {
  windowsDisks: async () => "[]",
  readMountinfo: () => "",
  announce: () => {},
  watchingNow: () => 1, // no speed checks here
  configFile: () => CONFIG,
  rescan: async () => {},
  titlesUnder,
  libraryTitles,
  playingNow: () => playing,
  downloadsTo: () => false,
  carryProbes: () => {},
  statfsLocal: async (p) => {
    const r = room[path.resolve(p)];
    if (!r) throw Object.assign(new Error("no such drive"), { code: "ENOENT" });
    return { total: r.total, free: r.free, used: r.total - r.free };
  },
});
drives.limits.checkTimeoutMs = 1500;
Object.assign(drives.limits.mover, { chunkMs: 400, stepTimeoutMs: 20000, pauseRetryMs: 0, idleEveryMs: 0 });

const film = (drive, name, mb = 3) => {
  const dir = path.join(lib(drive, "Movies"), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.mkv`), crypto.randomBytes(mb * 1024 * 1024));
  fs.writeFileSync(path.join(dir, "poster.jpg"), crypto.randomBytes(2000));
  return dir;
};
const show = (drive, name) => {
  const dir = path.join(lib(drive, "Shows"), name, "Season 01");
  fs.mkdirSync(dir, { recursive: true });
  for (const e of [1, 2]) fs.writeFileSync(path.join(dir, `${name} S01E0${e}.mkv`), crypto.randomBytes(1024 * 1024));
  return path.dirname(dir);
};
const hashOf = (f) => crypto.createHash("sha1").update(fs.readFileSync(f)).digest("hex");
const fresh = async (list, { scores = {} } = {}) => {
  I.reset();
  setLibraries(list);
  await I.round({ all: true });
  for (const [d, v] of Object.entries(scores)) I.data().scores[path.resolve(d)] = { value: v, word: "x", at: Date.now() };
};
const mover = () => drives.mover();

test("rules: the fast drive, what belongs on it, when cold titles move and which", () => {
  assert.equal(rules.fastDrive([{ id: "/", score: 92 }, { id: "/mnt", score: 72 }]), "/");
  assert.equal(rules.fastDrive([{ id: "/", score: 92 }, { id: "/mnt", score: 85 }]), null, "about as fast: no fast drive");
  assert.equal(rules.fastDrive([{ id: "/", score: 92 }]), null, "one drive: nothing to keep");
  assert.equal(rules.fastDrive([{ id: "/", score: 92 }, { id: "/mnt", score: 40, answering: false }]), null, "the other is not answering");
  assert.equal(rules.fastDrive([{ id: "/", score: null }, { id: "/mnt", score: 30 }]), null, "the best is not tested yet");

  assert.equal(rules.wantsFast({ type: "movie", quality: "2160p", release: "Film.2019.2160p.BluRay.REMUX", sizeBytes: 60e9 }, 2).why, "top-quality 4K");
  assert.equal(rules.wantsFast({ type: "movie", quality: "2160p", sizeBytes: 25e9 }, 3).fast, true, "a big 4K copy is above ~25 Mbit/s");
  assert.equal(rules.wantsFast({ type: "movie", quality: "2160p", sizeBytes: 8e9 }, 3).fast, false, "a small 4K web copy is not top quality");
  assert.equal(rules.wantsFast({ type: "show", quality: "2160p", sizeBytes: 9e9 }, 2).fast, true);
  assert.equal(rules.wantsFast({ type: "show", quality: "1080p", sizeBytes: 1e9 }, 0).why, "someone is about to watch it");
  assert.equal(rules.wantsFast({ type: "movie", quality: "1080p", sizeBytes: 3e9 }, 1).why, "asked for by a person");
  assert.equal(rules.wantsFast({ type: "show", quality: "1080p", sizeBytes: 1e9 }, 2).fast, false, "an automatic next episode: where there is room");
  assert.equal(rules.wantsFast({ type: "show", quality: "720p", sizeBytes: 1e9 }, 3).fast, false);

  // 502 GB NVMe: reserve 50 GB; 116 GB free → room 66 GB = 13% < 15% → move until 20%
  const nvme = { total: 502 * GB, free: 116 * GB };
  assert.ok(Math.abs(rules.coldNeed(nvme) - 0.07 * 502 * GB) < 2e9);
  assert.equal(rules.coldNeed({ total: 502 * GB, free: 140 * GB }), 0, "18% room: nothing starts");
  assert.ok(rules.coldNeed({ total: 502 * GB, free: 140 * GB }, true) > 0, "…but a round that started goes on to 20%");
  assert.equal(rules.coldNeed({ total: 502 * GB, free: 160 * GB }, true), 0);

  const now = Date.now();
  const t = (id, o) => ({ id, sizeBytes: 10, lastPlayed: now - 100 * DAY, ...o });
  const picked = rules.coldTitles([
    t("old"), t("older", { lastPlayed: now - 300 * DAY }), t("recent", { lastPlayed: now - 10 * DAY }), t("playing", { playing: true }),
    t("listed", { onList: true }), t("midway", { midway: true }), t("downloading", { downloading: true }), t("skipped", { skipUntil: now + DAY }),
    t("never-new", { lastPlayed: 0, addedAt: now - 5 * DAY }), t("never-old", { lastPlayed: 0, addedAt: now - 90 * DAY }),
  ], { now });
  assert.deepEqual(picked.map((x) => x.id), ["older", "old", "never-old"]);
  assert.deepEqual(rules.coldTitles([t("a"), t("b", { lastPlayed: now - 200 * DAY })], { now, needBytes: 5 }).map((x) => x.id), ["b"]);
});

test("pick: new and 4K titles go to the fast drive while it has room; a show stays with its episodes", () => {
  const fast = { root: "/opt/aurora/media/Movies", drive: "/", free: 120 * GB, total: 502 * GB, committed: 0, score: 92, accepts: true, answering: true };
  const slow = { root: "/mnt/nas/Aurora/Movies", drive: "/mnt/nas", free: 900 * GB, total: 1000 * GB, committed: 0, score: 66, accepts: true, answering: true };
  assert.equal(rules.pick([fast, slow], { kind: "movie", sizeBytes: 60e9, preferFast: "top-quality 4K" }).drive, "/");
  assert.match(rules.pick([fast, slow], { kind: "movie", sizeBytes: 60e9, preferFast: "top-quality 4K" }).why, /fast drive/);
  assert.equal(rules.pick([fast, slow], { kind: "movie", sizeBytes: 2e9 }).drive, "/mnt/nas", "an HD background copy: the most room");
  assert.equal(rules.pick([{ ...fast, free: 60 * GB }, slow], { kind: "movie", sizeBytes: 20e9, preferFast: "asked for by a person" }).drive, "/mnt/nas", "no room above the reserve: elsewhere");
  const showHome = rules.pick([{ ...slow, root: "/mnt/nas/Aurora/Shows", hasShow: true }, { ...fast, root: "/opt/aurora/media/Shows" }], { kind: "show", sizeBytes: 1e9, preferFast: "someone is about to watch it" });
  assert.equal(showHome.drive, "/mnt/nas", "a show's new episode stays with the show");
  assert.equal(rules.pick([{ ...fast, score: 70 }, slow], { kind: "movie", sizeBytes: 2e9, preferFast: "asked for by a person" }).drive, "/mnt/nas", "no clearly faster drive: as before");
});

test("cold titles leave the fast drive when it runs low — oldest first, never a listed, part-watched or recent one", { timeout: 60000 }, async () => {
  for (const d of [A, B, C, D]) for (const k of ["Movies", "Shows"]) fs.rmSync(lib(d, k), { recursive: true, force: true }), fs.mkdirSync(lib(d, k), { recursive: true });
  lowFast(); // room above the reserve: 100 GB = 10%
  const old = film(A, "Old Film (2001)");
  const oldHash = hashOf(path.join(old, "Old Film (2001).mkv"));
  film(A, "Recent Film (2020)");
  film(A, "Listed Film (2010)");
  film(A, "Midway Film (2011)");
  show(A, "Old Show");
  meta = {
    "Old Film (2001)": { lastPlayed: Date.now() - 200 * DAY },
    "Old Show": { lastPlayed: Date.now() - 100 * DAY },
    "Recent Film (2020)": { lastPlayed: Date.now() - 5 * DAY },
    "Listed Film (2010)": { lastPlayed: Date.now() - 300 * DAY, onList: true },
    "Midway Film (2011)": { lastPlayed: Date.now() - 300 * DAY, midway: true },
  };
  playing = [];
  await fresh([A, B], { scores: { [A]: 92, [B]: 66 } });
  const lines = [];
  const log = console.log;
  console.log = (...a) => { lines.push(a.join(" ")); };
  try { await mover().drain(); } finally { console.log = log; }
  assert.equal(fs.existsSync(old), false, "the original is gone");
  const moved = path.join(lib(B, "Movies"), "Old Film (2001)");
  assert.equal(hashOf(path.join(moved, "Old Film (2001).mkv")), oldHash, "the same bytes on the slow drive");
  assert.ok(fs.existsSync(path.join(moved, "poster.jpg")));
  assert.ok(fs.existsSync(path.join(lib(B, "Shows"), "Old Show", "Season 01", "Old Show S01E02.mkv")), "the show's folder, whole");
  for (const keep of ["Recent Film (2020)", "Listed Film (2010)", "Midway Film (2011)"]) assert.ok(fs.existsSync(path.join(lib(A, "Movies"), keep)), `${keep} stays`);
  assert.deepEqual(fs.readdirSync(lib(B, "Movies")).filter((n) => n.startsWith(".")), [], "no temp folder left");
  const v = drives.moverView();
  assert.equal(v.current, null);
  assert.deepEqual(v.recent.map((r) => [r.title, r.result]), [["Old Show", "moved"], ["Old Film (2001)", "moved"]]);
  assert.ok(lines.some((l) => /\[drives\] moved "Old Film \(2001\)" \(3 MB\) from .*fast.* to .*slow/.test(l)), lines.join("\n"));
  // the setting off: nothing more moves
  drives.setKeepFast(false);
  film(A, "Another Old (1999)");
  meta["Another Old (1999)"] = { lastPlayed: Date.now() - 400 * DAY };
  await mover().drain();
  assert.ok(fs.existsSync(path.join(lib(A, "Movies"), "Another Old (1999)")));
  I.data().keepFast = true; // (not setKeepFast: that starts the mover, and the next test starts afresh)
});

test("a restart in the middle of a copy: the move goes on from where it stopped", { timeout: 60000 }, async (t) => {
  for (const d of [A, B]) for (const k of ["Movies", "Shows"]) fs.rmSync(lib(d, k), { recursive: true, force: true }), fs.mkdirSync(lib(d, k), { recursive: true });
  const dir = film(A, "Big Old Film (1990)", 40);
  const want = hashOf(path.join(dir, "Big Old Film (1990).mkv"));
  meta = { "Big Old Film (1990)": { lastPlayed: Date.now() - 500 * DAY } };
  lowFast();
  playing = [];
  await fresh([A, B], { scores: { [A]: 92, [B]: 66 } });
  process.env.AURORA_DRIVES_FAKE_SLOW_MS_PER_MB = "40"; // ~25 MB/s
  t.after(() => { delete process.env.AURORA_DRIVES_FAKE_SLOW_MS_PER_MB; });
  const run = mover().kick({ force: true });
  // let it copy part of the film, then "restart"
  let cur = null;
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 50));
    cur = I.data().moves.current;
    if (cur && cur.phase === "copying" && cur.copied > 0) break;
  }
  mover().stop();
  await run;
  cur = JSON.parse(JSON.stringify(I.data().moves));
  assert.equal(cur.current.phase, "copying");
  assert.ok(cur.current.copied > 0 && cur.current.copied < 40 * 1024 * 1024, `part of it was copied (${cur.current.copied})`);
  const tempFile = path.join(cur.current.temp, "Big Old Film (1990).mkv");
  assert.ok(fs.statSync(tempFile).size > 0, "a part copy waits on the slow drive");
  assert.ok(fs.existsSync(path.join(dir, "Big Old Film (1990).mkv")), "the original is untouched");
  // the server starts again: drives.json as it was on disk
  I.reset();
  setLibraries([A, B]);
  await I.round({ all: true });
  Object.assign(I.data(), { scores: { [path.resolve(A)]: { value: 92 }, [path.resolve(B)]: { value: 66 } }, moves: cur });
  const lines = [];
  const log = console.log;
  console.log = (...a) => { lines.push(a.join(" ")); };
  try { await mover().drain(); } finally { console.log = log; }
  assert.ok(!lines.some((l) => /moving "Big Old Film/.test(l)), "it did not start over: " + lines.join("\n"));
  assert.equal(hashOf(path.join(lib(B, "Movies"), "Big Old Film (1990)", "Big Old Film (1990).mkv")), want);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(I.data().moves.recent[0].result, "moved");
});

test("a title that starts playing mid-copy: the move stops, the original is untouched, the temp copy goes", { timeout: 60000 }, async (t) => {
  for (const d of [A, B]) for (const k of ["Movies", "Shows"]) fs.rmSync(lib(d, k), { recursive: true, force: true }), fs.mkdirSync(lib(d, k), { recursive: true });
  const dir = film(A, "Played Now (1995)", 20);
  const want = hashOf(path.join(dir, "Played Now (1995).mkv"));
  meta = { "Played Now (1995)": { lastPlayed: Date.now() - 500 * DAY } };
  lowFast();
  playing = [];
  await fresh([A, B], { scores: { [A]: 92, [B]: 66 } });
  process.env.AURORA_DRIVES_FAKE_SLOW_MS_PER_MB = "40";
  t.after(() => { delete process.env.AURORA_DRIVES_FAKE_SLOW_MS_PER_MB; });
  const ask = drives.deps.ask;
  let copies = 0;
  drives.deps.ask = async (op, ...rest) => { const r = await ask(op, ...rest); if (op === "copy" && ++copies === 1) playing = [{ id: "movie:Played Now (1995)", path: path.join(dir, "Played Now (1995).mkv") }]; return r; };
  t.after(() => { drives.deps.ask = ask; playing = []; });
  await mover().drain();
  assert.equal(hashOf(path.join(dir, "Played Now (1995).mkv")), want, "the original is untouched");
  assert.deepEqual(fs.readdirSync(lib(B, "Movies")), [], "the temp copy is gone, nothing landed");
  const m = I.data().moves;
  assert.equal(m.current, null);
  assert.match(m.recent[0].result, /^stopped: someone started playing it$/);
  assert.ok(m.skip["movie:Played Now (1995)"] > Date.now() + 6 * DAY, "left alone for a week");
});

test("someone watching from the drive: the move waits, then goes on", { timeout: 60000 }, async () => {
  for (const d of [A, B]) for (const k of ["Movies", "Shows"]) fs.rmSync(lib(d, k), { recursive: true, force: true }), fs.mkdirSync(lib(d, k), { recursive: true });
  film(A, "Waits (1980)");
  const other = film(A, "Being Watched (2022)");
  meta = { "Waits (1980)": { lastPlayed: Date.now() - 500 * DAY }, "Being Watched (2022)": { lastPlayed: Date.now() } };
  lowFast();
  playing = [{ id: "movie:Being Watched (2022)", path: path.join(other, "Being Watched (2022).mkv") }];
  await fresh([A, B], { scores: { [A]: 92, [B]: 66 } });
  const r = await mover().drain();
  assert.equal(r[r.length - 1], "paused");
  assert.equal(I.data().moves.current.paused, "someone is watching from that drive");
  assert.match(drives.moverView().current.paused, /watching/);
  assert.ok(fs.existsSync(path.join(lib(A, "Movies"), "Waits (1980)")));
  playing = [];
  await mover().drain();
  assert.ok(fs.existsSync(path.join(lib(B, "Movies"), "Waits (1980)", "Waits (1980).mkv")));
  assert.equal(fs.existsSync(path.join(lib(A, "Movies"), "Waits (1980)")), false);
});

test("Stop using this drive: an empty one is removed at once; config.json keeps the rest", async () => {
  for (const d of [A, B, C]) for (const k of ["Movies", "Shows"]) fs.rmSync(lib(d, k), { recursive: true, force: true }), fs.mkdirSync(lib(d, k), { recursive: true });
  room[C] = { total: 500 * GB, free: 400 * GB };
  film(A, "Stays (2000)");
  meta = {};
  await fresh([A, B, C]);
  const id = path.resolve(C);
  const r = await drives.stopUsing(id, "remove");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.removed, true);
  const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  assert.deepEqual(cfg.libraries.movies, [lib(A, "Movies"), lib(B, "Movies")]);
  assert.deepEqual(cfg.libraries.shows, [lib(A, "Shows"), lib(B, "Shows")]);
  assert.equal(cfg.adminName, "Test", "the rest is kept");
  assert.ok(fs.readdirSync(base).some((f) => f.startsWith("config.json.before-drive-")), "a copy of the old file");
  assert.deepEqual(config.LIBRARIES.movies, [lib(A, "Movies"), lib(B, "Movies")], "the running server too");
  const card = (await drives.list()).find((d) => d.id === id);
  assert.equal(card.inUse, false, "back to Not in use");
  assert.ok(fs.existsSync(lib(C, "Movies")), "nothing on the drive is deleted");
  // one with titles is not removed that way
  const refuse = await drives.stopUsing(path.resolve(A), "remove");
  assert.equal(refuse.needsMove, true);
  assert.equal(refuse.titles, 1);
});

test("Stop using this drive with titles on it: they move to the other drives, then it is removed", { timeout: 60000 }, async () => {
  for (const d of [A, B]) for (const k of ["Movies", "Shows"]) fs.rmSync(lib(d, k), { recursive: true, force: true }), fs.mkdirSync(lib(d, k), { recursive: true });
  room[A] = { total: 1000 * GB, free: 900 * GB };
  film(A, "Recent One (2024)");
  show(A, "A Show");
  meta = { "Recent One (2024)": { lastPlayed: Date.now() - DAY, onList: true } }; // an evacuation moves everything
  playing = [];
  await fresh([A, B]);
  const id = path.resolve(A);
  const r = await drives.stopUsing(id, "move");
  assert.equal(r.moving, true, JSON.stringify(r));
  assert.equal(r.titles, 2);
  assert.equal(drives.candidatesFor("movie").find((c) => c.drive === id).accepts, false, "no new downloads go there meanwhile");
  assert.ok((await drives.list()).find((d) => d.id === id).evacuating);
  await mover().drain();
  assert.ok(fs.existsSync(path.join(lib(B, "Movies"), "Recent One (2024)", "Recent One (2024).mkv")));
  assert.ok(fs.existsSync(path.join(lib(B, "Shows"), "A Show", "Season 01", "A Show S01E01.mkv")));
  const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  assert.deepEqual(cfg.libraries.movies, [lib(B, "Movies")], "removed once it was empty");
  const card = (await drives.list()).find((d) => d.id === id);
  assert.equal(card.inUse, false);
  assert.equal(card.evacuating, null);
  assert.equal(I.data().removed[id].moved, 2);
});

test("Stop using a drive that does not answer: refused without force, then removed as it is — no alerts after", { timeout: 60000 }, async (t) => {
  for (const d of [B, D]) for (const k of ["Movies", "Shows"]) fs.rmSync(lib(d, k), { recursive: true, force: true }), fs.mkdirSync(lib(d, k), { recursive: true });
  film(D, "On The Share (2015)");
  meta = {};
  const sent = [];
  const announce = drives.deps.announce;
  drives.deps.announce = (...a) => sent.push(a);
  t.after(() => { drives.deps.announce = announce; delete process.env.AURORA_DRIVES_FAKE_HANG; });
  await fresh([B, D]);
  process.env.AURORA_DRIVES_FAKE_HANG = D;
  const id = path.resolve(D);
  await I.check(I.live.drives.find((d) => d.id === id));
  assert.equal(drives.onPath(lib(D, "Movies")).answering, false);
  const move = await drives.stopUsing(id, "move");
  assert.equal(move.needsForce, true, "its titles can't be moved");
  const plain = await drives.stopUsing(id, "remove");
  assert.equal(plain.needsForce, true);
  assert.equal(plain.titles, 1);
  const r = await drives.stopUsing(id, "force");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.forced, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(CONFIG, "utf8")).libraries.movies, [lib(B, "Movies")]);
  assert.equal(I.data().alerts[id], undefined);
  // the rounds go on: a drive removed on purpose is never announced
  await new Promise((res) => setTimeout(res, 100));
  await I.round({ all: true });
  I.stepAlert(I.live.drives.find((d) => d.id === id));
  assert.deepEqual(sent, []);
  assert.deepEqual(drives.summaryFacts().map((f) => f.id), [path.resolve(B)], "no Needs you for it");
  assert.equal((await drives.list()).find((d) => d.id === id).inUse, false);
});
