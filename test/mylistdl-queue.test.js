// My List downloads end to end, through the real routes, the real queue and
// the real deletion path — in a PRIVATE copy of the server (the same trick as
// test/dlrace-queue.test.js): src/ is copied to a temp root with its own
// config.json, data/ and library and required from there, so the repo's
// data/, the live server and its files are out of reach.
//
//   * the download engine is a stub that accepts a job and never moves it —
//     no aria2 process, no torrent, not one byte fetched
//   * the source lookup and the episode list are the feature's own seams
//     (mylistdl._internals.use); every other network call is refused
//   * no notification channel is configured, so notify/push reach nobody
//
// What is pinned here is the WIRING the unit tests (test/mylistdl.test.js)
// cannot see: the watchlist route's answer, the job's tag in the queue and in
// what clients are sent, "by hand" taking a job over, the admin's routes, the
// library tree's stale mark, and a real file leaving a real (temp) library.
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
let sources = {};
let metas = {};
let lookups = [];
const realFetch = global.fetch;
const DAY = 24 * 3600 * 1000;

const HASH = (c) => String(c).repeat(40).slice(0, 40);
const source = (c, over = {}) => ({ infoHash: HASH(c), fileIdx: 0, quality: "1080p", sizeBytes: 100000, seeders: 50, provider: "prov", cam: false, dubbed: false, pack: false, ...over });
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
const idle = () => mylist._internals.idle();
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
  D.seams.findSources = async () => ({ streams: [] });
  mylist._internals.use({
    now: () => T,
    sources: async (type, imdbId, year, season, episode) => { lookups.push({ type, imdbId, season, episode }); return { imdbId, streams: sources[imdbId] || [] }; },
    meta: async (type, imdbId) => { if (!metas[imdbId]) throw new Error("no such title"); return metas[imdbId]; },
    metaCached: (type, imdbId) => metas[imdbId] || null,
  });

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
  await idle();
  for (const j of jobs()) downloads.remove(j.id);
  D.store.data.length = 0;
  const recs = mylist._internals.records();
  for (const k of Object.keys(recs)) delete recs[k];
  for (const p of profiles.list()) profiles.getWatchlist(p.id).length = 0;
  for (const k of Object.keys(settings.data)) if (k.startsWith("myList")) delete settings.data[k];
  sources = {}; metas = {}; lookups = [];
  config.DOWNLOAD_MIN_FREE_PERCENT = 0;
  T += 3 * DAY;
};
const ANN = "aaaaaaaaaaa1", BEN = "aaaaaaaaaaa2", KID = "aaaaaaaaaaa3";

test("the watchlist route: an add answers with what it started, and the queue holds one tagged job", async () => {
  await reset();
  const film = FILM(1);
  sources[film.imdbId] = [source("a")];
  const r = await post(`/api/profiles/${ANN}/watchlist`, { stream: film, add: true });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.watchlist), "what older clients read is still there, unchanged");
  assert.equal(r.body.watchlist.length, 1);
  assert.deepEqual(r.body.download, { queued: true, what: "film" });
  await idle();

  assert.equal(jobs().length, 1);
  const job = jobs()[0];
  assert.equal(job.auto, "mylist");
  assert.equal(job.smart, true);
  assert.equal(job.profile, ANN);
  assert.equal(job.imdbId, film.imdbId);
  assert.equal(job.infoHash, HASH("a"));
  assert.ok(["approved", "downloading"].includes(job.status), "in the same queue as every other download");
  // what clients are sent: tagged, "mine" for the adder only, and never who asked
  const mine = (await get(`/api/downloads?profile=${ANN}`)).body;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].auto, "mylist");
  assert.equal(mine[0].smart, true);
  assert.equal(mine[0].mine, true);
  assert.equal(mine[0].profile, undefined);
  assert.equal((await get(`/api/downloads?profile=${BEN}`)).body[0].mine, false);
});

test("the same film from a second profile: 'already on its way', still one job; a remove answers as it always did", async () => {
  await reset();
  const film = FILM(2);
  sources[film.imdbId] = [source("b")];
  assert.equal((await post(`/api/profiles/${ANN}/watchlist`, { stream: film, add: true })).body.download.queued, true);
  await idle();
  const second = await post(`/api/profiles/${BEN}/watchlist`, { stream: film, add: true });
  assert.deepEqual(second.body.download, { queued: false, reason: "already-queued", what: "film" });
  await idle();
  assert.equal(jobs().length, 1);
  assert.equal(lookups.length, 1, "one source lookup for the two of them");

  // Ann takes it off: Ben still wants it — the download goes on, a remove has no `download`
  const off = await post(`/api/profiles/${ANN}/watchlist`, { stream: film, add: false });
  assert.deepEqual(Object.keys(off.body), ["watchlist"]);
  assert.ok(["approved", "downloading"].includes(jobs()[0].status));
  // Ben too: nobody wants it any more, so the download is cancelled
  await post(`/api/profiles/${BEN}/watchlist`, { stream: film, add: false });
  assert.equal(jobs()[0].status, "canceled");
  const st = (await get("/api/admin/mylist", admin)).body;
  assert.equal(st.records.find((x) => x.imdbId === film.imdbId).state, "canceled");
});

test("a show: the first episode; a kids profile over its limit: nothing; the feature off: nothing", async () => {
  await reset();
  metas[SHOW.imdbId] = {
    title: SHOW.title, year: 2020, poster: null,
    seasons: [{ number: 1, episodes: [{ season: 1, episode: 1, released: "2020-01-01" }, { season: 1, episode: 2, released: "2020-01-08" }] }],
  };
  sources[SHOW.imdbId] = [source("c")];
  const r = await post(`/api/profiles/${ANN}/watchlist`, { stream: SHOW, add: true });
  assert.deepEqual(r.body.download, { queued: true, what: "episode", season: 1, episode: 1 });
  await idle();
  assert.equal(jobs().length, 1);
  assert.equal(jobs()[0].type, "show");
  assert.equal(`${jobs()[0].season}:${jobs()[0].episode}`, "1:1");
  assert.equal(jobs()[0].label, "List Show · S1 E1");
  assert.deepEqual(lookups, [{ type: "series", imdbId: SHOW.imdbId, season: 1, episode: 1 }]);

  // Ben is in the middle of the show (real progress on an episode of it, as a
  // stream): his add starts nothing — the next-episode download while watching
  // is what serves a show someone is already in
  await post(`/api/profiles/${ANN}/watchlist`, { stream: SHOW, add: false });
  assert.equal(jobs()[0].status, "canceled");
  const played = await post(`/api/profiles/${BEN}/progress`, {
    itemId: `torrent|${HASH("9")}|0`, position: 400, duration: 2400,
    item: { imdbId: SHOW.imdbId, season: 1, episode: 2, title: SHOW.title, type: "show" },
  });
  assert.equal(played.status, 200);
  const ben = await post(`/api/profiles/${BEN}/watchlist`, { stream: SHOW, add: true });
  assert.deepEqual(ben.body.download, { queued: false, reason: "started" });
  await idle();
  assert.equal(jobs().length, 1);
  assert.equal(lookups.length, 1);

  // a kids profile and a film nobody rated: on the list, never downloaded
  const film = FILM(3);
  sources[film.imdbId] = [source("d")];
  const kid = await post(`/api/profiles/${KID}/watchlist`, { stream: film, add: true });
  assert.equal(kid.body.watchlist.length, 1);
  assert.deepEqual(kid.body.download, { queued: false, reason: "kids" });
  await idle();
  assert.equal(jobs().length, 1);
  assert.equal(lookups.length, 1);

  // switched off by the admin
  const off = await post("/api/admin/mylist/settings", { myListDownloads: false }, admin);
  assert.equal(off.status, 200);
  assert.equal(settings.data.myListDownloads, false);
  const film2 = FILM(4);
  sources[film2.imdbId] = [source("e")];
  assert.deepEqual((await post(`/api/profiles/${BEN}/watchlist`, { stream: film2, add: true })).body.download, { queued: false, reason: "off" });
  await idle();
  assert.equal(jobs().length, 1);
});

test("the disk gate refusing: on the list, nothing in the queue, nobody asked to approve anything", async () => {
  await reset();
  const film = FILM(5);
  sources[film.imdbId] = [source("f", { sizeBytes: 1 })];
  config.DOWNLOAD_MIN_FREE_PERCENT = 100; // no drive is 100% free: the gate says no to everything
  const r = await post(`/api/profiles/${ANN}/watchlist`, { stream: film, add: true });
  assert.deepEqual(r.body.download, { queued: false, reason: "disk", what: "film" });
  await idle();
  assert.equal(jobs().length, 0, "not even a 'pending approval' row");
  assert.equal(lookups.length, 0);
});

test("pressing Download by hand on the source being fetched takes the job over: it is nobody's to clean up", async () => {
  await reset();
  const film = FILM(6);
  sources[film.imdbId] = [source("1")];
  await post(`/api/profiles/${ANN}/watchlist`, { stream: film, add: true });
  await idle();
  const id = jobs()[0].id;
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
  sources[film.imdbId] = [source("1")];
  await post(`/api/profiles/${ANN}/watchlist`, { stream: film, add: true });
  await idle();
  downloads.create({ infoHash: HASH("1"), fileIdx: 0, type: "movie", imdbId: film.imdbId, title: film.title, smart: true, profile: BEN });
  assert.equal(jobs()[0].auto, "mylist");
});

test("the admin routes: behind the admin password, settings validated, defaults reported", async () => {
  await reset();
  assert.equal((await get("/api/admin/mylist")).status, 403);
  assert.equal((await post("/api/admin/mylist/settings", { myListStaleDays: 3 })).status, 403);
  const st = (await get("/api/admin/mylist", admin)).body;
  assert.deepEqual(st.settings, {
    myListDownloads: true, myListShows: true, myListAutoDelete: true,
    myListStaleDays: 14, myListDeleteDays: 21, myListDailyCap: 5, myListRetries: 1,
    myListYield: "always",
  });
  assert.deepEqual(st.records, []);
  const bad = await post("/api/admin/mylist/settings", { myListStaleDays: "30" }, admin);
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Delete after must not be sooner than Stale after/);
  assert.equal(settings.data.myListStaleDays, undefined, "a refused change stores nothing");
  const good = await post("/api/admin/mylist/settings", { myListStaleDays: "10", myListDeleteDays: "12", myListDailyCap: 3 }, admin);
  assert.equal(good.status, 200);
  assert.equal(good.body.settings.myListDeleteDays, 12);
  assert.equal((await get("/api/admin/mylist", admin)).body.settings.myListDailyCap, 3);
  assert.equal((await post("/api/admin/mylist/keep", { key: "tt0" }, admin)).status, 404);
  // how a My List download gives way (media/dlslots.js): one of two words
  const yieldBad = await post("/api/admin/mylist/settings", { myListYield: "sometimes" }, admin);
  assert.equal(yieldBad.status, 400);
  assert.match(yieldBad.body.error, /Gives way must be one of: always, slots/);
  assert.equal((await post("/api/admin/mylist/settings", { myListYield: "slots" }, admin)).body.settings.myListYield, "slots");
  // "Start now" on a waiting download: the admin's, and only for a job that exists
  assert.equal((await post("/api/admin/downloads/000000000000/start", {})).status, 403);
  assert.equal((await post("/api/admin/downloads/000000000000/start", {}, admin)).status, 404);
});

test("a landed copy, for real: marked stale in the library tree at 14 days, the file gone at 21, the title still on the list", async () => {
  await reset();
  const film = FILM(7);
  sources[film.imdbId] = [source("7")];
  await post(`/api/profiles/${ANN}/watchlist`, { stream: film, add: true });
  await idle();
  const job = D.store.data.find((j) => j.imdbId === film.imdbId);

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
  sources[film.imdbId] = [source("8")];
  await post(`/api/profiles/${BEN}/watchlist`, { stream: film, add: true });
  await idle();
  const job = D.store.data.find((j) => j.imdbId === film.imdbId);
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
