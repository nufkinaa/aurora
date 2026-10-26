// My List — the add, and what the removed auto-download left behind — end to
// end, through the real routes, the real queue and the real deletion path — in a PRIVATE copy of the server (the same trick as
// test/dlrace-queue.test.js): src/ is copied to a temp root with its own
// config.json, data/ and library and required from there, so the repo's
// data/, the live server and its files are out of reach.
//
//   * the download engine is a stub that accepts a job and never moves it —
//     no aria2 process, no torrent, not one byte fetched
//   * every network call is refused, and the queue's source lookup counts
//     how often it is asked (it must never be, for an add)
//   * no notification channel is configured, so notify/push reach nobody
//
// What is pinned here is the WIRING the unit tests (test/mylistdl.test.js)
// cannot see: an add to My List starts nothing (elia 2026-10-26), "by hand"
// taking a leftover job over, the admin's routes, the library tree's stale
// mark, and a real file leaving a real (temp) library.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const REPO = path.join(__dirname, "..");
const ADMIN = "private-test-admin";
let root, server, base;
let S, config, downloads, D, profiles, mylist, scanner, settings;
let T = Date.UTC(2026, 9, 1, 12);
let lookups = [];
const realFetch = global.fetch;
const DAY = 24 * 3600 * 1000;

const HASH = (c) => String(c).repeat(40).slice(0, 40);
const FILM = (n) => ({ imdbId: `tt88000${n}`, type: "movie", title: `List Film ${n}`, year: 2021, poster: null, genres: ["Drama"], rating: 7.1 });
const SHOW = { imdbId: "tt8900001", type: "show", title: "List Show", year: 2020, poster: null };

const call = async (method, url, body, headers = {}) => {
  const r = await realFetch(base + url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const post = (url, body, headers) => call("POST", url, body, headers);
const get = (url, headers) => call("GET", url, undefined, headers);
const admin = { "X-Admin-Password": ADMIN };
const jobs = () => downloads.rawJobs();

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-mylq-"));
  fs.cpSync(path.join(REPO, "src"), path.join(root, "src"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "package.json"), path.join(root, "package.json"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(root, "node_modules"), "junction");
  const movies = path.join(root, "media", "movies");
  const shows = path.join(root, "media", "shows");
  fs.mkdirSync(movies, { recursive: true });
  fs.mkdirSync(shows, { recursive: true });
  fs.mkdirSync(path.join(root, "data", "cache"), { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    port: 0, libraries: { movies: [movies], shows: [shows] }, adminPassword: ADMIN,
    onlineMetadata: false, skipDatabases: false, prewarmStreams: false, autoOcrSubtitles: false,
    preconvert: false, notifications: {}, downloadMinFreePercent: 0, authMode: "open",
  }));
  // nothing leaves this machine: only the private instance itself may be called
  global.fetch = async (url, ...rest) => {
    if (String(url).startsWith("http://127.0.0.1:")) return realFetch(url, ...rest);
    throw new Error("network is not allowed in this test");
  };

  S = (p) => require(path.join(root, "src", p));
  config = S("config");
  assert.ok(config.DATA_DIR.startsWith(root), "the private root is in use, not the repo's data/");
  assert.deepEqual(require(path.join(root, "src", "lib", "notify")).channels?.() || [], [], "no alert channel: nobody's phone rings");
  downloads = S("media/downloads");
  D = downloads._internals;
  profiles = S("profiles");
  scanner = S("media/scanner");
  settings = S("lib/settings");
  mylist = S("media/mylistdl");
  // An engine that takes a job and sits on it.
  D.setEngine({
    available: () => true,
    running: () => true,
    stagingDir: (h) => path.join(root, "staging", h),
    fileProgress: S("media/aria2").fileProgress,
    add: () => new Promise(() => {}),
    status: async () => { throw new Error("no such download"); },
    select: async () => true,
    remove: async () => {},
    removeByInfoHash: async () => 0,
    purge: async () => {},
    applyEnginePlan: async () => ({ applied: true }),
  });
  D.seams.auto = false;
  D.seams.load = () => ({ watching: 0, streams: 0 });
  D.seams.findSources = async (...a) => { lookups.push(a); return { streams: [] }; };
  mylist._internals.use({ now: () => T });

  // three people, straight into the private profiles.json
  const store = profiles._internals.store;
  store.data.profiles.push(
    { id: "aaaaaaaaaaa1", name: "Ann", color: "#112233", avatar: "A" },
    { id: "aaaaaaaaaaa2", name: "Ben", color: "#112233", avatar: "B" },
    { id: "aaaaaaaaaaa3", name: "Kiddo", color: "#112233", avatar: "K", kids: { maxAge: 7 } },
  );

  const express = require(path.join(root, "node_modules", "express"));
  const app = express();
  app.use(express.json());
  app.use(S("routes/profiles"));
  app.use(S("routes/downloads"));
  app.use(S("routes/admin"));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
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
  // (the copied modules hold timers of their own — the scanner, the stores)
  setTimeout(() => process.exit(process.exitCode || 0), 50).unref();
});

const reset = async () => {
  for (const j of jobs()) downloads.remove(j.id);
  D.store.data.length = 0;
  const recs = mylist._internals.records();
  for (const k of Object.keys(recs)) delete recs[k];
  for (const p of profiles.list()) profiles.getWatchlist(p.id).length = 0;
  for (const k of Object.keys(settings.data)) if (k.startsWith("myList")) delete settings.data[k];
  lookups = [];
  config.DOWNLOAD_MIN_FREE_PERCENT = 0;
  T += 3 * DAY;
};
const ANN = "aaaaaaaaaaa1", BEN = "aaaaaaaaaaa2", KID = "aaaaaaaaaaa3";

// What the removed feature left behind: its job in the queue (`auto:
// "mylist"`, quiet like smart downloads) and its record in data/mylistdl.json.
const leftover = (film, c, by = ANN) => {
  const r = downloads.create({ infoHash: HASH(c), fileIdx: 0, type: "movie", imdbId: film.imdbId, title: film.title, year: film.year, quality: "1080p", sizeBytes: 100000, smart: true, profile: by });
  const job = D.store.data.find((j) => j.id === r.job.id);
  job.auto = "mylist";
  mylist._internals.records()[film.imdbId] = {
    key: film.imdbId, imdbId: film.imdbId, type: "movie", title: film.title, year: film.year, poster: null,
    season: null, episode: null, by, profiles: [by], at: T, addedAt: T, state: "queued", attempts: 0, jobId: job.id, queuedAt: T,
  };
  return job;
};

test("the watchlist route: adding a film or a show only adds it — nothing queued, no source asked, nothing recorded", async () => {
  await reset();
  const film = FILM(1);
  const r = await post(`/api/profiles/${ANN}/watchlist`, { stream: film, add: true });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body), ["watchlist"], "the answer is the list, as before the feature — no `download`");
  assert.equal(r.body.watchlist.length, 1);
  const show = await post(`/api/profiles/${BEN}/watchlist`, { stream: SHOW, add: true });
  assert.deepEqual(Object.keys(show.body), ["watchlist"]);
  // a kids profile, a second profile on the same film: the same
  await post(`/api/profiles/${KID}/watchlist`, { stream: film, add: true });
  await post(`/api/profiles/${BEN}/watchlist`, { stream: film, add: true });
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(jobs().length, 0, "no download, not even a row waiting for approval");
  assert.equal(lookups.length, 0, "no source lookup");
  assert.deepEqual(Object.keys(mylist._internals.records()), [], "nothing enters the leftovers' record");
  // the old switch does nothing either
  settings.data.myListDownloads = true;
  await post(`/api/profiles/${ANN}/watchlist`, { stream: FILM(2), add: true });
  assert.equal(jobs().length, 0);
  // and a remove answers as it always did
  const off = await post(`/api/profiles/${ANN}/watchlist`, { stream: film, add: false });
  assert.deepEqual(Object.keys(off.body), ["watchlist"]);
  assert.equal(off.body.watchlist.length, 1);
  assert.equal((await get(`/api/profiles/${ANN}/watchlist`)).body.items.length, 1);
});

test("a leftover job is left alone by an add or a remove of its title, and clients see an ordinary automatic download", async () => {
  await reset();
  const film = FILM(3);
  const job = leftover(film, "3");
  await post(`/api/profiles/${ANN}/watchlist`, { stream: film, add: true });
  await post(`/api/profiles/${ANN}/watchlist`, { stream: film, add: false });
  assert.ok(["approved", "downloading"].includes(D.store.data.find((j) => j.id === job.id).status), "existing downloads are left alone");
  const mine = (await get(`/api/downloads?profile=${ANN}`)).body;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].smart, true);
  assert.equal(mine[0].auto, undefined, "no My List tag is sent any more");
  assert.equal(mine[0].held, undefined, "and no 'on hold'");
  assert.equal(mine[0].profile, undefined);
});


test("pressing Download by hand on the source being fetched takes the job over: it is nobody's to clean up", async () => {
  await reset();
  const film = FILM(6);
  const id = leftover(film, "1").id;
  const r = await post("/api/downloads", { infoHash: HASH("1"), fileIdx: 0, type: "movie", imdbId: film.imdbId, title: film.title, year: 2021, quality: "1080p", sizeBytes: 100000, profile: BEN });
  assert.equal(r.body.duplicate, true);
  assert.equal(r.body.job.id, id, "one job, not two");
  const job = jobs()[0];
  assert.equal(job.auto, null);
  assert.equal(job.smart, false);
  assert.equal(job.profile, BEN, "it is Ben's request now");
  const st = (await get("/api/admin/mylist", admin)).body;
  assert.equal(st.records.find((x) => x.imdbId === film.imdbId).state, "claimed");
  // a smart / automatic request for the same source does NOT take it over
  await reset();
  leftover(film, "1");
  downloads.create({ infoHash: HASH("1"), fileIdx: 0, type: "movie", imdbId: film.imdbId, title: film.title, smart: true, profile: BEN });
  assert.equal(jobs()[0].auto, "mylist");
});

test("the admin routes: behind the admin password, settings validated, defaults reported", async () => {
  await reset();
  assert.equal((await get("/api/admin/mylist")).status, 403);
  assert.equal((await post("/api/admin/mylist/settings", { myListStaleDays: 3 })).status, 403);
  const st = (await get("/api/admin/mylist", admin)).body;
  assert.deepEqual(st.settings, { myListAutoDelete: true, myListStaleDays: 14, myListDeleteDays: 21 });
  assert.deepEqual(st.records, []);
  assert.equal(st.open, 0);
  const bad = await post("/api/admin/mylist/settings", { myListStaleDays: "30" }, admin);
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Delete after must not be sooner than Stale after/);
  assert.equal(settings.data.myListStaleDays, undefined, "a refused change stores nothing");
  const good = await post("/api/admin/mylist/settings", { myListStaleDays: "10", myListDeleteDays: "12", myListAutoDelete: false }, admin);
  assert.equal(good.status, 200);
  assert.equal(good.body.settings.myListDeleteDays, 12);
  assert.equal((await get("/api/admin/mylist", admin)).body.settings.myListAutoDelete, false);
  assert.equal((await post("/api/admin/mylist/keep", { key: "tt0" }, admin)).status, 404);
  // the removed feature's own switches are not settings any more
  const old = await post("/api/admin/mylist/settings", { myListDownloads: true, myListYield: "slots", myListDailyCap: 3 }, admin);
  assert.equal(old.status, 200);
  assert.deepEqual(Object.keys(old.body.settings).sort(), ["myListAutoDelete", "myListDeleteDays", "myListStaleDays"]);
  // "Start now" (it only ever served My List downloads on hold) is gone
  assert.equal((await post("/api/admin/downloads/000000000000/start", {}, admin)).status, 404);
});

test("a landed copy, for real: marked stale in the library tree at 14 days, the file gone at 21, the title still on the list", async () => {
  await reset();
  const film = FILM(7);
  const job = leftover(film, "7");
  await post(`/api/profiles/${ANN}/watchlist`, { stream: film, add: true });

  // The queue's finish(), by hand (the engine here never delivers): the file
  // is in the library, the job says so, the feature is told.
  const dir = path.join(config.LIBRARIES.movies[0], `${film.title} (${film.year})`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${film.title} (${film.year}).mkv`);
  fs.writeFileSync(file, Buffer.alloc(50000, 7));
  fs.writeFileSync(path.join(dir, `${film.title} (${film.year}).English.srt`), "1\n00:00:01,000 --> 00:00:02,000\nhi\n");
  // a film someone put there themselves, next to it
  const ownDir = path.join(config.LIBRARIES.movies[0], "Own Film (2019)");
  fs.mkdirSync(ownDir, { recursive: true });
  const own = path.join(ownDir, "Own Film (2019).mkv");
  fs.writeFileSync(own, Buffer.alloc(30000, 3));
  D.active.delete(job.id);
  job.status = "done";
  job.progress = 1;
  job.destPath = file;
  job.doneAt = new Date(T).toISOString();
  S("media/imdb").remember(film.title, "movie", film.year, film.imdbId);
  scanner.scan();
  mylist.onJob(job);
  const libId = scanner.idForPath(file);
  assert.ok(libId, "the scanner indexed the landed file");

  const treeMovie = async (id) => (await get("/api/admin/library/tree", admin)).body.movies.find((m) => m.id === id);
  let m = await treeMovie(libId);
  assert.equal(m.mylist.state, "fresh");
  assert.equal(m.mylist.by, "Ann");
  assert.equal((await treeMovie(scanner.idForPath(own))).mylist, null, "a film nobody's list fetched carries no mark");

  T += 13 * DAY;
  assert.equal((await treeMovie(libId)).mylist.state, "fresh");
  T += DAY;
  m = await treeMovie(libId);
  assert.equal(m.mylist.state, "stale", "the delete suggestions may take it from here");
  assert.match(m.mylist.why, /^added to My List on \d{4}-\d\d-\d\d, never watched$/);
  assert.equal(m.watched, 0);
  await mylist.daily();
  assert.equal(fs.existsSync(file), true, "stale is not deleted");

  T += 7 * DAY;
  const summary = await mylist.daily();
  assert.match(summary, /1 deleted/);
  assert.equal(fs.existsSync(file), false, "the file is gone");
  assert.equal(fs.existsSync(dir), false, "with its subtitles and its folder");
  assert.equal(fs.existsSync(own), true, "the film beside it is untouched");
  assert.equal(scanner.idForPath(file), null, "and the library entry with it");
  assert.equal(jobs().some((j) => j.id === job.id), false, "its finished row left the downloads pages");
  const list = (await get(`/api/profiles/${ANN}/watchlist`)).body.items;
  assert.equal(list.length, 1, "still on Ann's list");
  assert.equal(list[0].imdbId, film.imdbId);
  const rec = (await get("/api/admin/mylist", admin)).body.records.find((x) => x.imdbId === film.imdbId);
  assert.equal(rec.state, "deleted");
});

test("watching the landed copy — real progress through the profile route — keeps it for good", async () => {
  await reset();
  const film = FILM(8);
  const job = leftover(film, "8", BEN);
  const dir = path.join(config.LIBRARIES.movies[0], `${film.title} (${film.year})`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${film.title} (${film.year}).mkv`);
  fs.writeFileSync(file, Buffer.alloc(20000, 8));
  D.active.delete(job.id);
  job.status = "done"; job.progress = 1; job.destPath = file; job.doneAt = new Date(T).toISOString();
  S("media/imdb").remember(film.title, "movie", film.year, film.imdbId);
  scanner.scan();
  mylist.onJob(job);
  const libId = scanner.idForPath(file);

  // Ann — not even the one who added it — watches five minutes of it.
  // (profiles stamp progress with the wall clock: move the feature's clock there)
  T = Date.now() - 1000;
  mylist._internals.records()[film.imdbId].at = T;
  mylist._internals.records()[film.imdbId].addedAt = T;
  mylist._internals.records()[film.imdbId].doneAt = T;
  const p = await post(`/api/profiles/${ANN}/progress`, { itemId: libId, position: 300, duration: 6000 });
  assert.equal(p.status, 200);
  T += 30 * DAY;
  await mylist.daily();
  assert.equal(fs.existsSync(file), true, "watched: never deleted by this feature");
  const rec = (await get("/api/admin/mylist", admin)).body.records.find((x) => x.imdbId === film.imdbId);
  assert.equal(rec.state, "watched");
  assert.match(rec.why, /watched by Ann/);
  const tree = (await get("/api/admin/library/tree", admin)).body;
  assert.equal(tree.movies.find((m) => m.id === libId).mylist, null, "an ordinary library title now");
});
