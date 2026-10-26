// What My List downloads left behind (src/media/mylistdl.js). The feature
// itself — an add to My List starting a download — is gone (elia,
// 2026-10-26); the copies it fetched still run out the clock they were
// fetched under, and nothing new ever enters it. Everything the module
// touches is handed in — a fake queue, a fake library, a clock the test owns.
// Nothing here can start a download, ask a provider, send a notification or
// delete a file outside the temp folder one test makes for itself.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const mylist = require("../src/media/mylistdl");
const I = mylist._internals;
const DAY = I.DAY_MS;

const FILM = { imdbId: "tt1000001", type: "movie", title: "Some Film", year: 2020 };
const SHOW = { imdbId: "tt2000002", type: "show", title: "Some Show", year: 2019, season: 1, episode: 1 };

// The world the module sees. Everything is a plain field the test can set.
const world = (over = {}) => {
  const w = {
    now: Date.UTC(2026, 9, 1, 12),
    settings: {},                       // data/settings.json as stored
    store: { data: {}, saves: 0, save() { this.saves++; } },
    profiles: [{ id: "p1", name: "Alice" }, { id: "p2", name: "Bob" }],
    files: new Map(),                   // path → size
    away: new Set(),
    jobs: [],
    rows: {},                           // title key → [{ name, position, finished, at }]
    playing: new Set(),
    streamed: new Set(),                // paths whose bytes are being read right now (lib/fileinuse.js)
    logs: [], warns: [], deleted: [], scans: 0,
    ...over,
  };
  let seq = 0;
  w.deps = {
    store: w.store,
    settingsData: () => w.settings,
    saveSettings: () => { w.settingsSaved = (w.settingsSaved || 0) + 1; },
    now: () => w.now,
    log: (m) => w.logs.push(m),
    warn: (m) => w.warns.push(m),
    profile: (id) => w.profiles.find((p) => p.id === id) || null,
    locate: () => w.located || null,
    libraryIdForPath: (p) => (w.files.has(p) ? "lib-" + path.basename(p) : null),
    jobs: () => w.jobs,
    watchRows: (key) => w.rows[key] || [],
    playing: (title) => w.playing.has(title),
    fileInUse: (p) => w.streamed.has(p),
    fileExists: (p) => w.files.has(p) && !w.away.has(p),
    fileSize: (p) => w.files.get(p) || 0,
    away: (p) => w.away.has(p),
    deleteFile: (p) => {
      if (w.deleteError) throw new Error(w.deleteError);
      const size = w.files.get(p) || 0;
      w.files.delete(p);
      w.deleted.push(p);
      return { freedBytes: size, deleted: [path.basename(p)] };
    },
    afterDelete: () => { w.scans++; },
  };
  w.m = mylist.make(w.deps);
  w.rec = (key) => w.store.data.records[key];
  // What the removed feature left in data/mylistdl.json and in the queue: a
  // record and its job, `auto: "mylist"`, still on its way.
  w.seed = (title = FILM, { state = "queued", by = "p1" } = {}) => {
    const key = I.keyOf(title.imdbId, title.season ?? null, title.episode ?? null);
    const job = { id: `job${++seq}`, status: "approved", type: title.type, imdbId: title.imdbId, title: title.title,
      season: title.season ?? null, episode: title.episode ?? null, smart: true, auto: "mylist", profile: by };
    if (!w.store.data.records) w.store.data.records = {};
    w.store.data.records[key] = {
      key, imdbId: title.imdbId, type: title.type, title: title.title, year: title.year, poster: null,
      season: title.season ?? null, episode: title.episode ?? null,
      by, profiles: [by], at: w.now, addedAt: w.now, state, attempts: state === "failed" ? 1 : 0,
      ...(state === "queued" ? { jobId: job.id, queuedAt: w.now } : {}),
    };
    if (state === "queued") w.jobs.push(job);
    return job;
  };
  // the queue finishes a job: the file is in the library
  w.land = (job, { size = 2e9 } = {}) => {
    job.status = "done";
    job.doneAt = new Date(w.now).toISOString();
    job.destPath = path.join("L:", "lib", `${job.id}.mkv`);
    w.files.set(job.destPath, size);
    w.m.onJob(job);
    return job.destPath;
  };
  // a leftover film, landed
  w.landed = (title = FILM) => w.land(w.seed(title));
  return w;
};
const said = (w, re) => [...w.logs, ...w.warns].some((l) => re.test(l));

// ====================================================================
// nothing new
// ====================================================================

test("the module has no way to start anything: no add hook, no fetch, no queue call", () => {
  const w = world();
  for (const gone of ["onAdd", "onRemove", "fetch", "enqueue"]) assert.equal(w.m[gone], undefined, gone);
  for (const gone of ["onAdd", "onRemove"]) assert.equal(mylist[gone], undefined, gone);
  // its dependencies have nothing that could create, find a source for or cancel a download
  for (const dep of ["createJob", "sources", "pickSource", "cancelJob", "diskGate"]) assert.equal(w.deps[dep], undefined, dep);
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "media", "mylistdl.js"), "utf8");
  assert.doesNotMatch(src, /downloads\.create|getSources|pickSource/);
});

test("records that never reached the queue (waiting for the daily cap, failed, about to retry) are closed on the next pass", async () => {
  const w = world();
  w.seed({ ...FILM, imdbId: "tt1000003", title: "Waiting" }, { state: "wanted" });
  w.seed({ ...FILM, imdbId: "tt1000004", title: "Failed" }, { state: "failed" });
  await w.m.daily();
  assert.equal(w.rec("tt1000003").state, "canceled");
  assert.equal(w.rec("tt1000004").state, "canceled");
  assert.equal(w.jobs.length, 0, "nothing was queued for them");
  assert.ok(said(w, /^\[mylist\] dropped Waiting: My List downloads were switched off before it was fetched/));
  assert.equal(w.m.status().open, 0, "nothing left to look after: the admin's card has nothing to show");
});

test("a job the feature queued is left alone in the queue; when it lands, its copy gets the clock", async () => {
  const w = world();
  const job = w.seed();
  await w.m.daily();
  assert.equal(w.rec(FILM.imdbId).state, "queued", "existing downloads are left alone");
  assert.equal(job.status, "approved");
  assert.equal(w.m.status().open, 1);
  w.land(job);
  assert.equal(w.rec(FILM.imdbId).state, "done");
  assert.ok(said(w, /^\[mylist\] landed Some Film — stale in 14 days, deleted in 21/));
});

test("a leftover job that fails, or is cancelled, or leaves the queue: closed, never tried again", async () => {
  const w = world();
  const j = w.seed();
  j.status = "error";
  j.error = "no peers for 30 minutes";
  w.m.onJob(j);
  assert.equal(w.rec(FILM.imdbId).state, "gave-up");
  assert.ok(said(w, /^\[mylist\] download failed Some Film: no peers/));
  w.now += 3 * DAY;
  await w.m.daily();
  assert.equal(w.jobs.length, 1, "no new job");

  const w2 = world();
  const j2 = w2.seed();
  j2.status = "canceled";
  w2.m.onJob(j2);
  assert.equal(w2.rec(FILM.imdbId).state, "canceled");

  const w3 = world();
  w3.seed();
  w3.jobs.length = 0; // the admin removed its row
  await w3.m.daily();
  assert.equal(w3.rec(FILM.imdbId).state, "canceled");
});

// ====================================================================
// the lifecycle clock
// ====================================================================

test("not stale at 13 days, stale at 14, deleted at 21", async () => {
  const w = world();
  const file = w.landed();
  const t0 = w.now;

  w.now = t0 + 13 * DAY;
  await w.m.daily();
  assert.equal(w.m.status().records[0].state, "fresh");
  assert.equal(w.m.libraryMarks().get("lib-job1.mkv").state, "fresh");
  assert.equal(w.deleted.length, 0);

  w.now = t0 + 14 * DAY;
  await w.m.daily();
  const v = w.m.status().records[0];
  assert.equal(v.state, "stale");
  assert.match(v.why, /^added to My List on 2026-10-01, never watched$/);
  assert.equal(v.deleteAt, t0 + 21 * DAY);
  assert.ok(said(w, /^\[mylist\] stale Some Film: added to My List on 2026-10-01, never watched/));
  assert.equal(w.deleted.length, 0, "stale is a suggestion, not a deletion");
  const staleLines = w.logs.filter((l) => /^\[mylist\] stale /.test(l)).length;
  w.now = t0 + 20 * DAY;
  await w.m.daily();
  assert.equal(w.logs.filter((l) => /^\[mylist\] stale /.test(l)).length, staleLines, "said once, not every day");
  assert.equal(w.deleted.length, 0);

  w.now = t0 + 21 * DAY;
  const summary = await w.m.daily();
  assert.deepEqual(w.deleted, [file]);
  assert.equal(w.scans, 1, "the library is rescanned after a deletion");
  assert.equal(w.rec(FILM.imdbId).state, "deleted");
  assert.ok(said(w, /^\[mylist\] deleted Some Film: added to My List on 2026-10-01, never watched — freed 2000 MB/));
  assert.match(summary, /1 deleted \(2000 MB\)/);
  assert.equal(w.m.status().open, 0);
});

test("the delete suggestion entry: a stale copy is marked on its library item with why and when it goes", async () => {
  const w = world();
  w.landed();
  const t0 = w.now;
  w.now = t0 + 15 * DAY;
  const mark = w.m.libraryMarks().get("lib-job1.mkv");
  assert.deepEqual(mark, {
    state: "stale", why: "added to My List on 2026-10-01, never watched", by: "Alice",
    addedAt: t0, staleAt: t0 + 14 * DAY, deleteAt: t0 + 21 * DAY,
  });
  // with automatic deletion off it stays a suggestion for as long as it sits there
  w.settings.myListAutoDelete = false;
  w.now = t0 + 40 * DAY;
  await w.m.daily();
  assert.equal(w.deleted.length, 0);
  assert.equal(w.m.libraryMarks().get("lib-job1.mkv").state, "stale");
  assert.equal(w.m.libraryMarks().get("lib-job1.mkv").deleteAt, null);
});

test("watched at any point — even partly — stops both clocks for good", async () => {
  for (const row of [
    { position: 61, finished: false },   // a minute in
    { position: 0, finished: true },     // marked as watched by hand
  ]) {
    const w = world();
    w.landed();
    const t0 = w.now;
    w.rows[FILM.imdbId] = [{ name: "Bob", ...row, at: t0 + 3 * DAY }];
    w.now = t0 + 30 * DAY;
    await w.m.daily();
    assert.equal(w.deleted.length, 0);
    assert.equal(w.rec(FILM.imdbId).state, "watched");
    assert.ok(said(w, /^\[mylist\] kept Some Film: watched by Bob/));
    assert.equal(w.m.libraryMarks().size, 0, "an ordinary library title: no mark, no suggestion from here");
    w.now += 60 * DAY;
    await w.m.daily();
    assert.equal(w.deleted.length, 0);
  }
});

test("watched late — on day 20 of 21 — still saves it; a peek of a few seconds, or progress from before it was asked for, does not", async () => {
  let w = world();
  w.landed();
  let t0 = w.now;
  w.rows[FILM.imdbId] = [{ name: "Alice", position: 900, finished: false, at: t0 + 20 * DAY }];
  w.now = t0 + 22 * DAY;
  await w.m.daily();
  assert.equal(w.deleted.length, 0);
  assert.equal(w.rec(FILM.imdbId).state, "watched");

  w = world();
  w.landed();
  t0 = w.now;
  w.rows[FILM.imdbId] = [
    { name: "Alice", position: 12, finished: false, at: t0 + DAY },        // opened and closed
    { name: "Bob", position: 5000, finished: true, at: t0 - 300 * DAY },   // saw it last year, as a stream
  ];
  w.now = t0 + 21 * DAY;
  await w.m.daily();
  assert.equal(w.deleted.length, 1, "neither is this copy being used");
});

test("never anything a person chose: a file someone asked for by hand is kept, whatever its age", async () => {
  // someone's own job landed on the very same file
  let w = world();
  const file = w.landed();
  w.jobs.push({ id: "hand", status: "done", type: "movie", imdbId: FILM.imdbId, destPath: file, auto: null, smart: false });
  w.now += 30 * DAY;
  await w.m.daily();
  assert.equal(w.deleted.length, 0);
  assert.equal(w.rec(FILM.imdbId).state, "claimed");

  // someone pressed Download on the source it was fetching: the queue hands the job over (auto cleared)
  w = world();
  const j = w.seed();
  j.auto = null;
  j.smart = false;
  w.land({ ...j }); // (the queue's own hook is silent for a job that is not ours any more)
  j.status = "done";
  w.now += 30 * DAY;
  await w.m.daily();
  assert.equal(w.deleted.length, 0);
  assert.equal(w.rec(FILM.imdbId).state, "claimed");

  // …or pressed it after it had landed
  w = world();
  w.landed();
  w.jobs[0].auto = null;
  w.jobs[0].smart = false;
  w.now += 30 * DAY;
  await w.m.daily();
  assert.equal(w.deleted.length, 0);
  assert.equal(w.rec(FILM.imdbId).state, "claimed");

  // a download this feature never started has no record at all: nothing to sweep
  w = world();
  w.jobs.push({ id: "hand", status: "done", type: "movie", imdbId: "tt555", destPath: "L:/lib/hand.mkv", auto: null, smart: false, doneAt: new Date(w.now).toISOString() });
  w.files.set("L:/lib/hand.mkv", 5e9);
  w.now += 365 * DAY;
  await w.m.daily();
  assert.equal(w.deleted.length, 0);
  assert.equal(w.m.status().records.length, 0);
});

test("a copy whose bytes are being read right now (any device, no profile row) is held, and deleted on a later pass", async () => {
  const w = world();
  const file = w.landed();
  w.now += 21 * DAY;
  w.streamed.add(file);
  const first = await w.m.daily();
  assert.equal(w.deleted.length, 0, "never from under a viewer");
  assert.equal(w.rec(FILM.imdbId).state, "done", "still ours, still due");
  assert.ok(said(w, /^\[mylist\] not deleting Some Film yet: .*someone is playing it right now/));
  assert.equal(first, "1 held");
  w.streamed.clear();
  w.now += DAY;
  await w.m.daily();
  assert.deepEqual(w.deleted, [file]);
  assert.equal(w.rec(FILM.imdbId).state, "deleted");
});

test("never while it is being played, was just opened, or is being written; never when its drive is away", async () => {
  let w = world();
  const file = w.landed();
  const t0 = w.now;
  w.now = t0 + 21 * DAY;
  w.playing.add("Some Film");
  await w.m.daily();
  assert.equal(w.deleted.length, 0);
  assert.equal(w.rec(FILM.imdbId).state, "done");
  assert.ok(said(w, /^\[mylist\] not deleting Some Film yet: .*someone opened it in the last few hours/));
  w.playing.clear();
  w.rows[FILM.imdbId] = [{ name: "Bob", position: 10, finished: false, at: w.now - 3600e3 }];
  await w.m.daily();
  assert.equal(w.deleted.length, 0);
  w.now += DAY;
  await w.m.daily();
  assert.deepEqual(w.deleted, [file]);

  // another download of the same title is in flight
  w = world();
  w.landed();
  w.jobs.push({ id: "again", status: "downloading", type: "movie", imdbId: FILM.imdbId, auto: null, smart: false });
  w.now += 21 * DAY;
  await w.m.daily();
  assert.equal(w.deleted.length, 0);
  assert.ok(said(w, /a download is writing it/));

  // the library drive is unplugged: "cannot see it" is not "delete it" — and not "it is gone" either
  w = world();
  const f2 = w.landed();
  w.away.add(f2);
  w.now += 21 * DAY;
  await w.m.daily();
  assert.equal(w.deleted.length, 0);
  assert.equal(w.rec(FILM.imdbId).state, "done");
  w.away.clear();
  await w.m.daily();
  assert.equal(w.deleted.length, 1, "back the next day, it goes then");

  // Windows refusing to unlink an open file: tried again tomorrow
  w = world({ deleteError: "EBUSY: resource busy or locked, unlink" });
  w.landed();
  w.now += 21 * DAY;
  await w.m.daily();
  assert.equal(w.rec(FILM.imdbId).state, "done");
  assert.ok(said(w, /^\[mylist\] could not delete Some Film yet: EBUSY/));
});

test("a rescan or a rename does not lose the copy; a different file under the same title is never touched", async () => {
  let w = world();
  const file = w.landed();
  w.files.delete(file);
  w.files.set("L:/lib/Some Film (2020)/Some.Film.mkv", 2e9);
  w.located = "L:/lib/Some Film (2020)/Some.Film.mkv";
  w.now += 21 * DAY;
  await w.m.daily();
  assert.deepEqual(w.deleted, ["L:/lib/Some Film (2020)/Some.Film.mkv"]);

  // replaced by somebody's own, better copy (another size): not ours
  w = world();
  const f2 = w.landed();
  w.files.delete(f2);
  w.files.set("L:/lib/Some Film (2020)/Remux.mkv", 40e9);
  w.located = "L:/lib/Some Film (2020)/Remux.mkv";
  w.now += 21 * DAY;
  await w.m.daily();
  assert.equal(w.deleted.length, 0);
  assert.equal(w.rec(FILM.imdbId).state, "gone");

  // deleted by the admin in the meantime: forgotten, nothing to do
  w = world();
  const f3 = w.landed();
  w.files.delete(f3);
  w.now += DAY;
  await w.m.daily();
  assert.equal(w.rec(FILM.imdbId).state, "gone");
  assert.ok(said(w, /^\[mylist\] forgot Some Film: the file is no longer in the library/));
});

test("an episode has the same clock", async () => {
  const w = world();
  const file = w.landed(SHOW);
  const key = `${SHOW.imdbId}:1:1`;
  const t0 = w.now;
  w.now = t0 + 14 * DAY;
  assert.equal(w.m.status().records[0].state, "stale");
  assert.equal(w.m.status().records[0].label, "Some Show · S1 E1");
  w.now = t0 + 21 * DAY;
  await w.m.daily();
  assert.deepEqual(w.deleted, [file]);
  assert.equal(w.rec(key).state, "deleted");
});

test("the pure verdict: every state, and the lines are exactly the settings", () => {
  const s = I.readSettings({});
  const t0 = Date.UTC(2026, 0, 1);
  const rec = { doneAt: t0, addedAt: t0 - 3600e3, at: t0 - 3600e3 };
  const at = (days, over = {}) => I.judge({ rec, now: t0 + days * DAY, settings: s, ...over }).state;
  assert.equal(at(0), "fresh");
  assert.equal(at(13.99), "fresh");
  assert.equal(at(14), "stale");
  assert.equal(at(20.99), "stale");
  assert.equal(at(21), "delete");
  assert.equal(at(21, { watched: { at: t0, by: "A" } }), "watched");
  assert.equal(at(1, { watched: { at: t0, by: "A" } }), "watched");
  assert.equal(at(21, { manual: true }), "claimed");
  assert.equal(at(21, { file: "gone" }), "gone");
  assert.equal(at(21, { file: "away" }), "hold");
  assert.equal(at(21, { inUse: true }), "hold");
  assert.equal(at(21, { writing: true }), "hold");
  assert.equal(at(21, { playing: true }), "hold");
  assert.match(I.judge({ rec, now: t0 + 21 * DAY, settings: s, playing: true }).why, /someone is playing it right now$/);
  assert.equal(at(15, { inUse: true }), "stale", "holding only matters once it would be deleted");
  const s2 = I.readSettings({ myListStaleDays: 3, myListDeleteDays: 5 });
  assert.equal(I.judge({ rec, now: t0 + 3 * DAY, settings: s2 }).state, "stale");
  assert.equal(I.judge({ rec, now: t0 + 5 * DAY, settings: s2 }).state, "delete");
  // a record orphaned back when lists were watched is stale from then, and keeps its delete day
  const orphan = I.judge({ rec: { ...rec, orphanedAt: t0 + DAY }, now: t0 + DAY, settings: s });
  assert.equal(orphan.state, "stale");
  assert.equal(orphan.staleAt, t0 + DAY);
  assert.equal(orphan.deleteAt, t0 + 21 * DAY);
});

// ====================================================================
// persistence
// ====================================================================

test("the bookkeeping survives a restart: a real store on disk, read back by a new instance", async () => {
  const { JsonStore } = require("../src/lib/jsonstore");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-mylist-"));
  try {
    const file = path.join(dir, "mylistdl.json");
    const store = new JsonStore(file, () => ({ records: {} }));
    const w = world({ store });
    w.landed();
    const t0 = w.now;
    store.flush();

    const again = new JsonStore(file, () => ({ records: {} }));
    assert.equal(again.data.records[FILM.imdbId].state, "done");
    assert.equal(again.data.records[FILM.imdbId].doneAt, t0);
    w.deps.store = again;
    const m2 = mylist.make(w.deps);
    w.now = t0 + 14 * DAY;
    assert.equal(m2.status().records.find((r) => r.key === FILM.imdbId).state, "stale", "the clock ran through the restart");
    w.now = t0 + 21 * DAY;
    await m2.daily();
    assert.equal(w.deleted.length, 1);
    again.flush();
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).records[FILM.imdbId].state, "deleted");

    // a job that finished while the server was down is picked up from the queue itself
    const w3 = world({ store: new JsonStore(path.join(dir, "b.json"), () => ({ records: {} })) });
    const j = w3.seed();
    j.status = "done"; j.doneAt = new Date(w3.now).toISOString(); j.destPath = "L:/lib/x.mkv";
    w3.files.set(j.destPath, 1e9);
    const m3 = mylist.make(w3.deps); // (nobody called onJob)
    assert.equal(m3.status().records[0].state, "fresh");
    assert.equal(w3.rec(FILM.imdbId).sizeBytes, 1e9);
    w3.deps.store.flush();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("closed records are kept for the admin's list for a while, then dropped — the record only shrinks", async () => {
  const w = world();
  w.seed(FILM, { state: "failed" });
  await w.m.daily();
  assert.equal(w.rec(FILM.imdbId).state, "canceled");
  w.now += 59 * DAY;
  await w.m.daily();
  assert.ok(w.rec(FILM.imdbId));
  w.now += 2 * DAY;
  await w.m.daily();
  assert.equal(w.rec(FILM.imdbId), undefined);
  assert.deepEqual(w.m.status().records, []);
});

// ====================================================================
// the real deletion path
// ====================================================================

test("deletion goes through lib/libfiles: the video and its subtitles go, the folder is swept, nothing outside the library is reachable", async () => {
  const libfiles = require("../src/lib/libfiles");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-mylist-lib-"));
  try {
    const dir = path.join(root, "Some Film (2020)");
    fs.mkdirSync(dir, { recursive: true });
    const video = path.join(dir, "Some Film (2020).mkv");
    fs.writeFileSync(video, Buffer.alloc(4096, 1));
    fs.writeFileSync(path.join(dir, "Some Film (2020).English.srt"), "1\n");
    const other = path.join(root, "Other Film (2021)", "Other Film (2021).mkv");
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, Buffer.alloc(1024, 2));

    const w = world();
    w.deps.fileExists = (p) => fs.existsSync(p);
    w.deps.fileSize = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };
    w.deps.libraryIdForPath = () => "lib1";
    w.deps.deleteFile = (p) => libfiles.deleteVideoFile(p, [root], [".srt", ".vtt"]);
    const j = w.seed();
    j.status = "done"; j.doneAt = new Date(w.now).toISOString(); j.destPath = video;
    w.m.onJob(j);
    assert.equal(w.rec(FILM.imdbId).sizeBytes, 4096);

    w.now += 21 * DAY;
    await w.m.daily();
    assert.equal(fs.existsSync(video), false);
    assert.equal(fs.existsSync(dir), false, "the emptied film folder is swept");
    assert.equal(fs.existsSync(other), true, "the title next to it is untouched");
    assert.equal(fs.existsSync(root), true, "a library root is never removed");
    assert.equal(w.rec(FILM.imdbId).state, "deleted");
    assert.equal(w.rec(FILM.imdbId).freedBytes, 4096 + 2);

    // a record pointing outside the library is refused by the same guard
    const w2 = world();
    const outside = path.join(os.tmpdir(), `aurora-mylist-outside-${process.pid}.mkv`);
    fs.writeFileSync(outside, "x");
    try {
      w2.deps.fileExists = (p) => fs.existsSync(p);
      w2.deps.fileSize = () => 1;
      w2.deps.deleteFile = (p) => libfiles.deleteVideoFile(p, [root], [".srt", ".vtt"]);
      const j2 = w2.seed();
      j2.status = "done"; j2.doneAt = new Date(w2.now).toISOString(); j2.destPath = outside;
      w2.m.onJob(j2);
      w2.now += 21 * DAY;
      await w2.m.daily();
      assert.equal(fs.existsSync(outside), true);
      assert.ok(said(w2, /could not delete Some Film yet: Refusing to delete outside the library/));
    } finally {
      fs.rmSync(outside, { force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ====================================================================
// settings and the admin's view
// ====================================================================

test("settings: the tidy-up's defaults; the removed feature's own switches are ignored", () => {
  assert.deepEqual(I.readSettings({}), { myListAutoDelete: true, myListStaleDays: 14, myListDeleteDays: 21 });
  assert.deepEqual(I.readSettings(undefined), I.readSettings({}));
  assert.deepEqual(I.readSettings({ maxActiveDownloads: 4, myListDownloads: true, myListYield: "slots", myListDailyCap: 5 }), I.readSettings({}));
  const odd = I.readSettings({ myListStaleDays: -3, myListDeleteDays: "soon", myListAutoDelete: "yes" });
  assert.deepEqual(odd, I.readSettings({}));
  assert.equal(I.readSettings({ myListStaleDays: 30, myListDeleteDays: 10 }).myListDeleteDays, 30);
});

test("settings validation: only the keys sent change, and a refused value changes nothing", () => {
  const cur = {};
  assert.deepEqual(I.parseSettings({ myListStaleDays: 7 }, cur).value, { ...I.readSettings({}), myListStaleDays: 7 });
  assert.deepEqual(I.parseSettings({ myListStaleDays: "10", myListDeleteDays: " 30 " }, cur).value.myListDeleteDays, 30, "numbers as typed in a form");
  assert.equal(I.parseSettings({ myListAutoDelete: false }, cur).value.myListAutoDelete, false);
  assert.equal(I.parseSettings({ myListDownloads: true }, cur).value.myListDownloads, undefined, "the old switch is not a setting any more");
  for (const bad of [
    { myListStaleDays: 0 }, { myListStaleDays: 366 }, { myListStaleDays: 1.5 }, { myListStaleDays: "two weeks" }, { myListStaleDays: "" },
    { myListStaleDays: null }, { myListStaleDays: true }, { myListDeleteDays: 731 }, { myListAutoDelete: null },
  ]) {
    assert.ok(I.parseSettings(bad, cur).error, `refused: ${JSON.stringify(bad)}`);
  }
  assert.match(I.parseSettings({ myListStaleDays: 30 }, cur).error, /Delete after must not be sooner/);
  assert.match(I.parseSettings({ myListDeleteDays: 7 }, cur).error, /Delete after must not be sooner/);
  assert.ok(I.parseSettings({ myListStaleDays: 21, myListDeleteDays: 21 }, cur).value, "the same day is allowed");

  const w = world();
  assert.ok(w.m.setSettings({ myListStaleDays: 999 }).error);
  assert.deepEqual(w.settings, {});
  assert.equal(w.settingsSaved, undefined);
  const r = w.m.setSettings({ myListStaleDays: 7, myListDeleteDays: 10 });
  assert.equal(r.ok, true);
  assert.equal(w.settings.myListStaleDays, 7);
  assert.equal(w.settingsSaved, 1);
  assert.ok(said(w, /^\[mylist\] settings changed: myListStaleDays=7, myListDeleteDays=10/));
});

test("changing the days moves a copy's state at once", async () => {
  const w = world();
  w.landed();
  w.now += 8 * DAY;
  assert.equal(w.m.status().records[0].state, "fresh");
  w.m.setSettings({ myListStaleDays: 7 });
  assert.equal(w.m.status().records[0].state, "stale");
});

test("the admin's view: every record with its state, how many are still looked after, and Keep stops the clock", async () => {
  const w = world();
  w.landed();
  w.seed({ ...FILM, imdbId: "tt1000003", title: "On its way" });
  const st = w.m.status();
  assert.deepEqual(st.settings, I.readSettings({}));
  assert.equal(st.open, 2);
  assert.deepEqual(st.records.map((r) => [r.label, r.state, r.by]).sort(), [["On its way", "queued", "Alice"], ["Some Film", "fresh", "Alice"]]);
  const film = st.records.find((r) => r.key === FILM.imdbId);
  assert.equal(film.libraryId, "lib-job1.mkv");
  assert.equal(film.staleAt, film.doneAt + 14 * DAY);
  assert.ok(w.m.keep("nope").error);
  assert.deepEqual(w.m.keep(FILM.imdbId), { ok: true });
  w.now += 30 * DAY;
  await w.m.daily();
  assert.equal(w.deleted.length, 0);
  assert.equal(w.rec(FILM.imdbId).state, "claimed");
});
