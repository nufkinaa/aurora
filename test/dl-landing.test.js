// Where a finished download lands — with real files in a temp library:
// never over another file (two downloads of one title used to write the same
// name, the second truncating the first even while it was being played), and
// never half a file under a library name (the bytes go to a hidden temp file
// first, and only a complete one is put in place).
//
// The same private-root trick as test/dlrace-queue.test.js: src/ is copied to
// a temp folder with its own config.json, data/ and library and required from
// there; the engine (media/aria2.js) is an in-memory fake; fetch is refused.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");

const REPO = path.join(__dirname, "..");
let root, stagingRoot;
let downloads, D, config, scanner, inuse;
let engine;
let T = Date.now();
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
const sha = (p) => crypto.createHash("sha1").update(fs.readFileSync(p)).digest("hex");

// ---------- a fake engine: one "torrent" per hash, its file real bytes on disk ----------
const makeEngine = (fileProgress) => {
  const torrents = new Map();
  const byGid = new Map();
  let seq = 0;
  return {
    define(infoHash, { length = 200000, ext = ".mkv", fill = 1 } = {}) {
      const dir = path.join(stagingRoot, infoHash);
      fs.mkdirSync(dir, { recursive: true });
      const p = path.join(dir, `release${ext}`);
      fs.writeFileSync(p, Buffer.alloc(length, fill));
      torrents.set(infoHash, { infoHash, gid: null, state: "active", files: [{ index: 1, path: p, length, completed: 0, selected: false }] });
      return p;
    },
    finish(infoHash) { const t = torrents.get(infoHash); t.files[0].completed = t.files[0].length; },
    reset() { torrents.clear(); byGid.clear(); },
    available: () => true,
    running: () => true,
    stagingDir: (h) => path.join(stagingRoot, h),
    fileProgress,
    add(magnet, infoHash, fileIndex) {
      const t = torrents.get(infoHash);
      if (!t) return Promise.reject(new Error(`unknown torrent ${infoHash}`));
      if (!t.gid) { t.gid = `gid${++seq}`; byGid.set(t.gid, t); }
      t.files.find((f) => f.index === fileIndex).selected = true;
      return Promise.resolve(t.gid);
    },
    async status(gid) {
      const t = byGid.get(gid);
      if (!t) throw new Error(`aria2.tellStatus: GID ${gid} is not found`);
      return { state: t.state, error: null, downloadSpeed: 1000, peers: 3, seeders: 3, connections: 3, infoHash: t.infoHash, files: t.files.map((f) => ({ ...f })) };
    },
    async select() { return true; },
    async remove(gid) { byGid.delete(gid); },
    async removeByInfoHash(h) { const t = torrents.get(h); if (t && t.gid) byGid.delete(t.gid); return 1; },
    async purge() {}, // the staging bytes stay: some tests read them back
    applyEnginePlan: async () => ({ applied: true }),
  };
};

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-dlland-"));
  stagingRoot = path.join(root, "staging");
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
  scanner = S("media/scanner");
  inuse = S("lib/inuse");
  D = downloads._internals;
  engine = makeEngine(S("media/aria2").fileProgress);
  D.setEngine(engine);
  D.seams.auto = false;
  D.seams.clock = () => T;
  D.seams.load = () => ({ watching: 0, streams: 0 });
  D.seams.findSources = async () => { throw new Error("no second sources in this test"); };
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

const reset = async () => {
  for (const j of downloads.rawJobs()) downloads.remove(j.id);
  await flush();
  engine.reset();
  D.store.data.length = 0;
  T += 3600e3;
};
const jobOf = (id) => downloads.rawJobs().find((j) => j.id === id);
let n = 0;
const film = (hash, over = {}) => ({ infoHash: hash, fileIdx: 0, type: "movie", imdbId: `tt66${String(++n).padStart(5, "0")}`, title: `Landing Film ${n}`, year: 2020, quality: "1080p", sizeBytes: 200000, ...over });
const episode = (hash, over = {}) => ({ infoHash: hash, fileIdx: 0, type: "show", imdbId: "tt6600999", title: "Landing Show", year: 2019, season: 1, episode: 2, quality: "1080p", sizeBytes: 200000, ...over });
const start = async (fields) => {
  const r = downloads.create(fields);
  assert.ok(r.job && !r.error && !r.alreadyAvailable, JSON.stringify(r));
  await flush();
  assert.ok(D.active.has(r.job.id), "the job is running");
  return r.job.id;
};
// The engine says the file is complete; the queue copies it in.
const land = async (hash, id) => {
  engine.finish(hash);
  T += 1000;
  await D.poll();
  await until(() => ["done", "error"].includes(jobOf(id).status), "the copy into the library");
  await flush();
  const job = jobOf(id);
  assert.equal(job.status, "done", job.error || "");
  return job;
};
const videosIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(mkv|mp4)$/.test(f)).sort() : []);
const everything = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

// ---------- the rules, on their own ----------

test("landingName: the usual name when free; '(2)', '(3)' when a video of that name exists in any container", () => {
  const dir = fs.mkdtempSync(path.join(root, "names-"));
  const { landingName } = D;
  assert.deepEqual(landingName(dir, "Show S01E02", ".mkv"), { path: path.join(dir, "Show S01E02.mkv"), copyOf: null });
  fs.writeFileSync(path.join(dir, "Show S01E02.mp4"), "x");
  assert.equal(path.basename(landingName(dir, "Show S01E02", ".mkv").path), "Show S01E02 (2).mkv", "an .mp4 of the same name is the same episode");
  fs.writeFileSync(path.join(dir, "Show S01E02 (2).mkv"), "x");
  const third = landingName(dir, "Show S01E02", ".mkv");
  assert.equal(path.basename(third.path), "Show S01E02 (3).mkv");
  assert.equal(third.copyOf, "Show S01E02");
  // a subtitle or a temp file of that name is not a video
  fs.writeFileSync(path.join(dir, "Other S01E01.en.srt"), "x");
  fs.writeFileSync(path.join(dir, D.tempNameFor("abcdefabcdef")), "x");
  assert.equal(path.basename(landingName(dir, "Other S01E01", ".mkv").path), "Other S01E01.mkv");
  // a film's folder holds one film: any video already there makes this a copy
  const filmDir = fs.mkdtempSync(path.join(root, "film-"));
  fs.writeFileSync(path.join(filmDir, "Some.Film.2019.1080p.BluRay.mkv"), "x");
  assert.equal(path.basename(landingName(filmDir, "Some Film (2019)", ".mkv", { movie: true }).path), "Some Film (2019) (2).mkv");
});

test("placeNoClobber puts a file in place only where nothing is, and never touches what is there", () => {
  const dir = fs.mkdtempSync(path.join(root, "place-"));
  const tmp = path.join(dir, D.tempNameFor("aaaaaaaaaaaa"));
  const dest = path.join(dir, "Film.mkv");
  fs.writeFileSync(dest, "the original");
  fs.writeFileSync(tmp, "the newcomer");
  assert.equal(D.placeNoClobber(tmp, dest), false, "the name is taken");
  assert.equal(fs.readFileSync(dest, "utf8"), "the original", "…and the file there is untouched");
  assert.equal(fs.existsSync(tmp), true, "the newcomer is still in its temp file, for the next name");
  const free = path.join(dir, "Film (2).mkv");
  assert.equal(D.placeNoClobber(tmp, free), true);
  assert.equal(fs.readFileSync(free, "utf8"), "the newcomer");
  assert.equal(fs.existsSync(tmp), false, "the temp name is gone once the file is in place");
});

test("the scanner keeps the original as the film, and lists the original episode first", () => {
  const { isCopyName, copyLastCompare } = scanner._internals;
  assert.equal(isCopyName("Film (2020) (2).mkv"), true);
  assert.equal(isCopyName("Show S01E02 (13).mp4"), true);
  assert.equal(isCopyName("Film (2020).mkv"), false, "a year is not a copy mark");
  assert.equal(isCopyName("Part (1).mkv"), false, "(1) is not a copy");
  // plain natural order would put "Film (2020) (2).mkv" FIRST (a space sorts before a dot)
  assert.deepEqual(["Film (2020) (2).mkv", "Film (2020).mkv"].sort(copyLastCompare), ["Film (2020).mkv", "Film (2020) (2).mkv"]);
  assert.deepEqual(["B.mkv", "A (2).mkv", "A.mkv", "A (3).mkv"].sort(copyLastCompare), ["A.mkv", "B.mkv", "A (2).mkv", "A (3).mkv"]);
});

// ---------- the queue, end to end, with real files ----------

test("two downloads of one film: the first lands under the usual name, the second beside it as '(2)'; the film stays the first", async () => {
  await reset();
  const A = HASH("a"), B = HASH("b");
  engine.define(A, { fill: 0xa1 });
  engine.define(B, { fill: 0xb2, length: 210000 });
  const req = film(A);
  const idA = await start(req);
  const idB = await start({ ...req, infoHash: B, quality: "720p" }); // the same title from another source, before the first landed
  const jobA = await land(A, idA);
  const dir = path.dirname(jobA.destPath);
  assert.equal(path.basename(jobA.destPath), `${req.title} (${req.year}).mkv`);
  const firstHash = sha(jobA.destPath);
  const filmId = scanner.idForPath(jobA.destPath);
  assert.ok(filmId, "indexed");
  inuse.touch(filmId); // …and somebody is playing it while the second one lands

  const jobB = await land(B, idB);
  assert.equal(path.basename(jobB.destPath), `${req.title} (${req.year}) (2).mkv`, "the second never takes the first one's name");
  assert.equal(jobB.copyOf, `${req.title} (${req.year})`);
  assert.deepEqual(videosIn(dir), [`${req.title} (${req.year}) (2).mkv`, `${req.title} (${req.year}).mkv`]);
  assert.equal(sha(jobA.destPath), firstHash, "the file being played was not touched");
  assert.equal(fs.statSync(jobA.destPath).size, 200000);
  assert.equal(fs.statSync(jobB.destPath).size, 210000, "and the second is whole, with its own bytes");
  assert.equal(fs.readFileSync(jobB.destPath)[0], 0xb2);
  assert.deepEqual(everything(dir).filter((f) => f.endsWith(".part")), [], "no temp file is left");
  scanner.scan();
  const m = scanner.index.movies.find((x) => x.title === req.title);
  assert.equal(m.id, filmId, "the film's library id (everyone's progress) is still the original file's");
  // the admin's "More than one copy" (media/copies.js, fix-web-batch) lists the
  // " (2)" as a real second copy, with the download that wrote it on its row
  const copies = require(path.join(root, "src", "media", "copies"));
  const { files, jobs } = copies.collect();
  const grp = copies.group(files, jobs).find((x) => x.title === req.title);
  assert.ok(grp, "the film is listed as having more than one copy");
  assert.deepEqual(grp.copies.map((c) => c.fileName).sort(), [`${req.title} (${req.year}) (2).mkv`, `${req.title} (${req.year}).mkv`]);
  assert.equal(grp.copies[0].fileName, `${req.title} (${req.year}).mkv`, "the indexed original first");
  assert.ok(grp.copies[0].streaming, "the original is the one being played");
  const second = grp.copies.find((c) => c.fileName.endsWith(" (2).mkv"));
  assert.equal(second.indexed, false);
  assert.deepEqual(second.jobs.map((j) => j.id), [idB]);
  assert.deepEqual(copies.deletable(grp, second), { ok: true });
});

test("an episode already on disk — by hand, in another container, being played — gets a copy beside it, never over it", async () => {
  await reset();
  const showDir = path.join(config.LIBRARIES.shows[0], "Landing Show (2019)", "Season 01");
  fs.mkdirSync(showDir, { recursive: true });
  const original = path.join(showDir, "Landing Show S01E02.mp4");
  fs.writeFileSync(original, Buffer.alloc(150000, 0x0e));
  fs.writeFileSync(path.join(showDir, "Landing Show S01E02.en.srt"), "1\n00:00:01,000 --> 00:00:02,000\nhi\n");
  const before = { hash: sha(original), mtime: fs.statSync(original).mtimeMs };
  scanner.scan();
  const epId = scanner.idForPath(original);
  assert.ok(epId);
  inuse.touch(epId);

  const H = HASH("c");
  engine.define(H, { fill: 0xc3 });
  const id = await start(episode(H));
  const job = await land(H, id);
  assert.equal(job.destPath, path.join(showDir, "Landing Show S01E02 (2).mkv"));
  assert.equal(sha(original), before.hash, "the episode being played is byte for byte what it was");
  assert.equal(fs.statSync(original).mtimeMs, before.mtime);
  assert.equal(fs.readFileSync(path.join(showDir, "Landing Show S01E02.en.srt"), "utf8").includes("hi"), true, "its subtitles too");
  scanner.scan();
  const show = scanner.index.shows.find((s) => /Landing Show/.test(s.title));
  const eps = show.seasons[0].episodes.filter((e) => e.episode === 2);
  assert.equal(eps.length, 2, "both copies are in the library");
  assert.equal(eps[0].id, epId, "the original is listed first");
  {
    const copies = require(path.join(root, "src", "media", "copies"));
    const { files, jobs } = copies.collect();
    const grp = copies.group(files, jobs).find((x) => x.kind === "episode" && x.season === 1 && x.episode === 2);
    assert.ok(grp, "the episode twice is listed");
    assert.deepEqual(grp.copies.map((c) => c.fileName).sort(), ["Landing Show S01E02 (2).mkv", "Landing Show S01E02.mp4"]);
    assert.deepEqual(grp.copies.find((c) => c.fileName.endsWith("(2).mkv")).jobs.map((j) => j.id), [id]);
  }

  // and a third download of it: "(3)"
  const H2 = HASH("d");
  engine.define(H2, { fill: 0xd4 });
  const id2 = await start(episode(H2));
  assert.equal(path.basename((await land(H2, id2)).destPath), "Landing Show S01E02 (3).mkv");
  assert.equal(sha(original), before.hash);
});

test("a reader never sees half a file: the bytes go to a hidden temp file, the library name appears only when it is whole", async () => {
  await reset();
  const H = HASH("e");
  const staged = engine.define(H, { fill: 0xe5, length: 300000 });
  const req = film(H);
  const id = await start(req);

  // Hold the copy half-way: the staging file is read in two parts, the
  // second only when the test says so.
  const realCRS = fs.createReadStream;
  let release;
  const gate = new Promise((r) => { release = r; });
  fs.createReadStream = (p, ...rest) => {
    if (path.resolve(String(p)) !== path.resolve(staged)) return realCRS(p, ...rest);
    const data = fs.readFileSync(p);
    let sent = false;
    return new Readable({
      read() {
        if (sent) return;
        sent = true;
        this.push(data.subarray(0, 100000));
        gate.then(() => { this.push(data.subarray(100000)); this.push(null); });
      },
    });
  };
  try {
    engine.finish(H);
    T += 1000;
    await D.poll();
    const dir = path.join(config.LIBRARIES.movies[0], `${req.title} (${req.year})`);
    const tmp = path.join(dir, D.tempNameFor(id));
    await until(() => fs.existsSync(tmp) && fs.statSync(tmp).size >= 100000, "the first half in the temp file");
    assert.equal(jobOf(id).phase, "copying");
    assert.deepEqual(videosIn(dir), [], "half-way: no video under any library name");
    scanner.scan();
    assert.equal(scanner.index.movies.some((m) => m.title === req.title), false, "…so the scanner indexes nothing");
    release();
    await until(() => jobOf(id).status === "done", "the copy to finish");
    await flush();
  } finally {
    fs.createReadStream = realCRS;
    release();
  }
  const job = jobOf(id);
  const dir = path.dirname(job.destPath);
  assert.deepEqual(everything(dir).filter((f) => /\.(mkv|part)$/.test(f)), [`${req.title} (${req.year}).mkv`], "whole, under its name, and the temp file is gone");
  assert.equal(fs.statSync(job.destPath).size, 300000);
});

test("canceled while copying: nothing lands, the temp file goes; a temp left by a crash is swept on the next landing", async () => {
  await reset();
  const H = HASH("f");
  const staged = engine.define(H, { fill: 0xf6, length: 300000 });
  const req = film(H);
  const id = await start(req);
  const realCRS = fs.createReadStream;
  let release;
  const gate = new Promise((r) => { release = r; });
  fs.createReadStream = (p, ...rest) => {
    if (path.resolve(String(p)) !== path.resolve(staged)) return realCRS(p, ...rest);
    const data = fs.readFileSync(p);
    let sent = false;
    return new Readable({ read() { if (sent) return; sent = true; this.push(data.subarray(0, 1000)); gate.then(() => { this.push(data.subarray(1000)); this.push(null); }); } });
  };
  const dir = path.join(config.LIBRARIES.movies[0], `${req.title} (${req.year})`);
  try {
    engine.finish(H);
    T += 1000;
    await D.poll();
    await until(() => fs.existsSync(path.join(dir, D.tempNameFor(id))), "the copy to start");
    downloads.cancel(id);
    release();
    await until(() => !fs.existsSync(path.join(dir, D.tempNameFor(id))), "the temp file to go");
    await flush();
  } finally {
    fs.createReadStream = realCRS;
    release();
  }
  assert.equal(jobOf(id).status, "canceled", "it stays canceled — the late copy did not mark it done");
  assert.deepEqual(videosIn(dir), [], "and nothing was put in the library");

  // a crash's leftover in the folder of the next download
  const H2 = HASH("9");
  engine.define(H2);
  const id2 = await start({ ...req, infoHash: H2 });
  const stale = path.join(dir, D.tempNameFor("0123456789ab"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stale, Buffer.alloc(5000, 1));
  await land(H2, id2);
  assert.equal(fs.existsSync(stale), false, "the leftover partial copy was removed");
  assert.deepEqual(videosIn(dir), [`${req.title} (${req.year}).mkv`]);
});

// 2026-10-28: an episode asked for as type "series" (the word the sources API
// and the website's episode flow use) was stored as a MOVIE — create() took
// anything but "show" for a film — and 15 episodes were filed in the Movies
// folder. Every word for a show is a show now; an unknown one is refused.
test("typeOf: every word for a show is a show, for a film a movie; no type is a movie unless an episode is named; anything else is unknown", () => {
  for (const t of ["show", "series", "Series", "episode", "tv", " SHOW "]) assert.equal(D.typeOf(t), "show", t);
  for (const t of ["movie", "film", "Movie"]) assert.equal(D.typeOf(t), "movie", t);
  assert.equal(D.typeOf(undefined), "movie");
  assert.equal(D.typeOf(""), "movie");
  assert.equal(D.typeOf(null, { season: 1, episode: 2 }), "show");
  for (const t of ["anime", "music", "1", "movies?"]) assert.equal(D.typeOf(t), null, t);
});

test("an episode asked for as type \"series\" (or \"episode\", \"tv\") lands in the shows library as an episode; an unknown type is refused", async () => {
  await reset();
  const showDir = path.join(config.LIBRARIES.shows[0], "Landing Show (2019)", "Season 01");
  for (const [i, word] of ["series", "episode", "tv"].entries()) {
    const H = HASH(["e", "f", "a"][i]);
    engine.define(H, { fill: 0x30 + i });
    const id = await start(episode(H, { type: word, episode: 10 + i }));
    assert.equal(jobOf(id).type, "show", `"${word}" is stored as a show`);
    const job = await land(H, id);
    assert.equal(path.dirname(job.destPath), showDir, `"${word}": filed with the show, not in Movies`);
    assert.equal(path.basename(job.destPath), `Landing Show S01E${10 + i}.mkv`);
  }
  assert.deepEqual(videosIn(config.LIBRARIES.movies[0]), [], "nothing in the Movies folder");
  const bad = downloads.create(episode(HASH("b"), { type: "anime" }));
  assert.match(bad.error || "", /Unknown download type "anime"/);
  assert.equal(downloads.rawJobs().length, 3, "no job for the unknown type");
});
