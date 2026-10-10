// My List downloads (src/media/mylistdl.js): the trigger, the lifecycle clock
// and the settings, on the feature's own rules with everything it touches
// handed in — a fake queue, a fake library, a clock the test owns. Nothing
// here can start a download, ask a provider, send a notification or delete a
// file outside the temp folder one test makes for itself.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const mylist = require("../src/media/mylistdl");
const I = mylist._internals;
const DAY = I.DAY_MS;

const FILM = { stream: true, imdbId: "tt1000001", type: "movie", title: "Some Film", year: 2020, poster: null };
const SHOW = { stream: true, imdbId: "tt2000002", type: "show", title: "Some Show", year: 2019, poster: null };
const EP = (season, episode, released = "2019-01-01") => ({ season, episode, released });
const META = {
  title: "Some Show", year: 2019, poster: null,
  seasons: [
    { number: 0, episodes: [EP(0, 1)] },
    { number: 1, episodes: [EP(1, 1), EP(1, 2), EP(1, 3)] },
    { number: 2, episodes: [EP(2, 1), EP(2, 2, "2999-01-01")] },
  ],
};
const SRC = (hash, over = {}) => ({ infoHash: hash.repeat(40).slice(0, 40), fileIdx: 0, quality: "1080p", sizeBytes: 2e9, seeders: 40, provider: "prov", ...over });

// The world the feature sees. Everything is a plain field the test can set.
const world = (over = {}) => {
  const w = {
    now: Date.UTC(2026, 9, 1, 12),
    settings: {},                       // data/settings.json as stored
    store: { data: {}, saves: 0, save() { this.saves++; } },
    profiles: [{ id: "p1", name: "Alice" }, { id: "p2", name: "Bob" }, { id: "kid", name: "Kid", kids: { maxAge: 7 } }],
    lists: { p1: [], p2: [], kid: [] }, // profile → [imdbId] on its list
    ages: { tt1000001: 16 },            // known age ratings; anything else is unrated
    onDisk: new Set(),                  // title keys in the library
    files: new Map(),                   // path → size
    away: new Set(),
    libraryItems: {},                   // library id → { id, type, title, imdbId, showId }
    started: new Set(),                 // "profile|imdbId": that profile has progress in the show
    metaCached: {}, meta: {},
    sources: { tt1000001: [SRC("a")], tt2000002: [SRC("b")] },
    lookups: [],
    jobs: [],
    rows: {},                           // title key → [{ name, position, finished, at }]
    playing: new Set(),
    gate: { ok: true },
    torrents: true,
    logs: [], warns: [], canceled: [], deleted: [], scans: 0,
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
    torrentsOn: () => w.torrents,
    profile: (id) => w.profiles.find((p) => p.id === id) || null,
    kidsAllowed: (profileId, imdbId) => {
      const p = w.profiles.find((x) => x.id === profileId);
      if (!p || !p.kids) return true;
      return typeof w.ages[imdbId] === "number" && w.ages[imdbId] <= p.kids.maxAge;
    },
    libraryItem: (id) => w.libraryItems[id] || null,
    inLibrary: (want) => w.onDisk.has(I.keyOf(want.imdbId, want.type === "show" ? want.season : null, want.type === "show" ? want.episode : null)),
    locate: (want) => w.located || null,
    libraryIdForPath: (p) => (w.files.has(p) ? "lib-" + path.basename(p) : null),
    startedShow: (profileId, imdbId) => w.started.has(`${profileId}|${imdbId}`),
    metaCached: (type, imdbId) => w.metaCached[imdbId] || null,
    meta: async (type, imdbId) => { if (!w.meta[imdbId]) throw new Error("offline"); return w.meta[imdbId]; },
    sources: async (type, imdbId, year, season, episode) => {
      w.lookups.push({ type, imdbId, season, episode });
      if (w.sources[imdbId] === "throw") throw new Error("provider down");
      return { streams: w.sources[imdbId] || [] };
    },
    pickSource: require("../src/media/smartdl")._internals.pickSource,
    jobs: () => w.jobs,
    createJob: (fields) => {
      if (w.createError) return { error: w.createError };
      const job = { id: `job${++seq}`, status: "approved", ...fields, auto: fields.auto || null, smart: !!fields.smart };
      w.jobs.push(job);
      return { job: { id: job.id, auto: job.auto } };
    },
    cancelJob: (id) => { w.canceled.push(id); const j = w.jobs.find((x) => x.id === id); if (j) { j.status = "canceled"; w.m.onJob(j); } },
    diskGate: (type, sizeBytes) => (typeof w.gate === "function" ? w.gate(type, sizeBytes) : w.gate),
    listsWith: (title) => Object.keys(w.lists).filter((p) => w.lists[p].includes(title.imdbId)),
    watchRows: (key) => w.rows[key] || [],
    playing: (title) => w.playing.has(title),
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
  // a person presses the button: the list changes, then the hook runs
  w.add = (profileId, ref) => { if (!w.lists[profileId].includes(ref.imdbId)) w.lists[profileId].push(ref.imdbId); return w.m.onAdd(profileId, ref); };
  w.remove = (profileId, ref) => { w.lists[profileId] = w.lists[profileId].filter((x) => x !== ref.imdbId); return w.m.onRemove(profileId, ref); };
  w.idle = () => w.m.idle();
  w.rec = (key) => w.store.data.records[key];
  // the queue finishes a job: the file is in the library
  w.land = (job, { size = 2e9 } = {}) => {
    job.status = "done";
    job.doneAt = new Date(w.now).toISOString();
    job.destPath = path.join("L:", "lib", `${job.id}.mkv`);
    w.files.set(job.destPath, size);
    w.onDisk.add(I.keyOf(job.imdbId, job.type === "show" ? job.season : null, job.type === "show" ? job.episode : null));
    w.m.onJob(job);
    return job.destPath;
  };
  // a film added, fetched and landed, in one go
  w.landed = async (profileId = "p1", ref = FILM) => {
    w.add(profileId, ref);
    await w.idle();
    return w.land(w.jobs[w.jobs.length - 1]);
  };
  return w;
};
const said = (w, re) => [...w.logs, ...w.warns].some((l) => re.test(l));

// ====================================================================
// the trigger
// ====================================================================

test("a film added to a list: one job for the film, tagged as a My List download", async () => {
  const w = world();
  assert.deepEqual(w.add("p1", FILM), { queued: true, what: "film" });
  assert.equal(w.jobs.length, 0, "the answer does not wait for the source lookup");
  await w.idle();
  assert.equal(w.jobs.length, 1);
  const j = w.jobs[0];
  assert.equal(j.auto, "mylist", "told apart from a download someone asked for");
  assert.equal(j.smart, true, "and quiet like smart downloads, on every client that knows nothing new");
  assert.equal(j.type, "movie");
  assert.equal(j.imdbId, FILM.imdbId);
  assert.equal(j.profile, "p1");
  assert.equal(j.profileName, "Alice");
  assert.equal(j.season, null);
  assert.deepEqual(w.lookups, [{ type: "movie", imdbId: FILM.imdbId, season: null, episode: null }]);
  assert.equal(w.rec(FILM.imdbId).state, "queued");
  assert.ok(said(w, /^\[mylist\] queued Some Film for Alice/), "one line per decision, with the stable prefix");
});

test("a show nobody has watched: its first episode, S1E1 — specials are not 'first'", async () => {
  const w = world({ metaCached: { [SHOW.imdbId]: META }, meta: { [SHOW.imdbId]: META } });
  assert.deepEqual(w.add("p1", SHOW), { queued: true, what: "episode", season: 1, episode: 1 });
  await w.idle();
  assert.equal(w.jobs.length, 1);
  assert.equal(w.jobs[0].type, "show");
  assert.equal(w.jobs[0].season, 1);
  assert.equal(w.jobs[0].episode, 1);
  assert.equal(w.jobs[0].label, "Some Show · S1 E1");
  assert.deepEqual(w.lookups, [{ type: "series", imdbId: SHOW.imdbId, season: 1, episode: 1 }]);
});

test("a show the adding profile has already started: nothing — smart downloads serve a show someone is in", async () => {
  const w = world({ metaCached: { [SHOW.imdbId]: META }, meta: { [SHOW.imdbId]: META } });
  w.started.add(`p1|${SHOW.imdbId}`);
  assert.deepEqual(w.add("p1", SHOW), { queued: false, reason: "started" }, "the toast is just 'Added to My List'");
  await w.idle();
  assert.equal(w.jobs.length, 0);
  assert.equal(w.lookups.length, 0);
  assert.equal(Object.keys(w.store.data.records || {}).length, 0, "nothing is written down either");
  // it is the ADDING profile that counts: Bob has not started it, so Bob gets S1E1
  assert.deepEqual(w.add("p2", SHOW), { queued: true, what: "episode", season: 1, episode: 1 });
  await w.idle();
  assert.equal(`${w.jobs[0].season}:${w.jobs[0].episode}`, "1:1");
  assert.equal(w.jobs[0].profile, "p2");
});

test("is there a first episode: S1E1 must exist and have aired — specials do not count", () => {
  const now = Date.UTC(2026, 9, 1);
  assert.equal(I.firstEpisode(META, now), "ok");
  assert.equal(I.firstEpisode({ seasons: [{ number: 1, episodes: [EP(1, 1, "2999-01-01")] }] }, now), "not-aired");
  assert.equal(I.firstEpisode({ seasons: [{ number: 0, episodes: [EP(0, 1)] }] }, now), "no-episodes");
  assert.equal(I.firstEpisode({ seasons: [] }, now), "no-episodes");
  assert.equal(I.firstEpisode({ seasons: [{ number: 2, episodes: [EP(2, 1)] }, { number: 1, episodes: [EP(1, 2), EP(1, 1)] }] }, now), "ok", "whatever order the provider lists them in");
  assert.equal(I.firstEpisode({ seasons: [{ number: 1, episodes: [{ season: 1, episode: 1 }] }] }, now), "ok", "no air date on file is not 'unaired'");
  // through the trigger, with the list cached: an unaired show asks for nothing
  const w = world({ metaCached: { [SHOW.imdbId]: { seasons: [{ number: 1, episodes: [EP(1, 1, "2999-01-01")] }] } } });
  assert.deepEqual(w.add("p1", SHOW), { queued: false, reason: "not-aired" });
});

test("a show with nothing cached: accepted at the press, and the fetch step reads the real list", async () => {
  // the list says S1E1 is out: fetched
  let w = world({ meta: { [SHOW.imdbId]: META } });
  assert.deepEqual(w.add("p1", SHOW), { queued: true, what: "episode", season: 1, episode: 1 });
  await w.idle();
  assert.equal(w.jobs.length, 1);
  // the list says it has not aired: nothing, and no retry
  w = world({ meta: { [SHOW.imdbId]: { seasons: [{ number: 1, episodes: [EP(1, 1, "2999-01-01")] }] } } });
  assert.equal(w.add("p1", SHOW).queued, true);
  await w.idle();
  assert.equal(w.jobs.length, 0);
  assert.equal(w.lookups.length, 0);
  assert.equal(w.rec(`${SHOW.imdbId}:1:1`).state, "have");
  w.now += DAY;
  await w.m.daily();
  assert.equal(w.lookups.length, 0);
  // the list cannot be read at all: S1E1 is still asked for by its id
  w = world();
  w.add("p1", SHOW);
  await w.idle();
  assert.equal(w.jobs.length, 1);
  // started between the press and a retry a day later: nothing more
  w = world({ sources: {}, meta: { [SHOW.imdbId]: META } });
  w.add("p1", SHOW);
  await w.idle();
  assert.equal(w.rec(`${SHOW.imdbId}:1:1`).state, "failed");
  w.started.add(`p1|${SHOW.imdbId}`);
  w.sources[SHOW.imdbId] = [SRC("b")];
  w.now += DAY;
  await w.m.daily();
  assert.equal(w.jobs.length, 0);
  assert.equal(w.rec(`${SHOW.imdbId}:1:1`).state, "have");
});

test("already in the library: nothing is queued", async () => {
  const w = world({ metaCached: { [SHOW.imdbId]: META } });
  w.onDisk.add(FILM.imdbId);
  w.onDisk.add(`${SHOW.imdbId}:1:1`);
  assert.deepEqual(w.add("p1", FILM), { queued: false, reason: "in-library", what: "film" });
  assert.deepEqual(w.add("p1", SHOW), { queued: false, reason: "in-library", what: "episode", season: 1, episode: 1 }, "S1E1 is on disk: there is something to play");
  // a library title added by its library id
  w.libraryItems.lib9 = { id: "lib9", type: "movie", title: "Owned", imdbId: "tt9" };
  assert.deepEqual(w.m.onAdd("p1", "lib9"), { queued: false, reason: "in-library" });
  await w.idle();
  assert.equal(w.jobs.length, 0);
  assert.equal(w.lookups.length, 0, "no provider was asked");
});

test("a library show added by its library id follows the same rule", async () => {
  // some later episodes on disk, S1E1 not, and this profile has not started it → S1E1
  const w = world({ metaCached: { [SHOW.imdbId]: META }, meta: { [SHOW.imdbId]: META } });
  w.libraryItems.libshow = { id: "libshow", type: "show", title: "Some Show", year: 2019, imdbId: SHOW.imdbId };
  w.onDisk.add(`${SHOW.imdbId}:1:3`);
  w.lists.p1.push(SHOW.imdbId);
  assert.deepEqual(w.m.onAdd("p1", "libshow"), { queued: true, what: "episode", season: 1, episode: 1 });
  await w.idle();
  assert.equal(w.jobs[0].episode, 1);
  // S1E1 on disk → nothing
  const w2 = world({ metaCached: { [SHOW.imdbId]: META } });
  w2.libraryItems.libshow = w.libraryItems.libshow;
  w2.onDisk.add(`${SHOW.imdbId}:1:1`);
  assert.equal(w2.m.onAdd("p1", "libshow").reason, "in-library");
  // a library show whose IMDb id is not known cannot be asked for
  w2.libraryItems.mystery = { id: "mystery", type: "show", title: "Mystery", imdbId: null };
  assert.deepEqual(w2.m.onAdd("p1", "mystery"), { queued: false, reason: "unknown-title" });
});

test("already queued or downloading — by hand or not: nothing new", async () => {
  const w = world();
  w.jobs.push({ id: "hand", status: "downloading", type: "movie", imdbId: FILM.imdbId, auto: null, smart: false });
  assert.deepEqual(w.add("p1", FILM), { queued: false, reason: "already-queued", what: "film" });
  await w.idle();
  assert.equal(w.jobs.length, 1);
  assert.equal(w.rec(FILM.imdbId), undefined, "someone's own download is not ours to look after");
  // a failed or cancelled earlier job does not block
  w.jobs[0].status = "error";
  assert.equal(w.add("p2", FILM).queued, true);
});

test("the same title from two profiles: one download", async () => {
  const w = world();
  assert.equal(w.add("p1", FILM).queued, true);
  assert.deepEqual(w.add("p2", FILM), { queued: false, reason: "already-queued", what: "film" }, "before the lookup has even run");
  await w.idle();
  assert.deepEqual(w.add("p2", FILM), { queued: false, reason: "already-queued", what: "film" }, "and after");
  await w.idle();
  assert.equal(w.jobs.length, 1);
  assert.equal(w.lookups.length, 1);
  assert.deepEqual(w.rec(FILM.imdbId).profiles, ["p1", "p2"]);
});

test("switched off, torrents off, shows excluded: nothing is queued and no provider is asked", async () => {
  let w = world({ settings: { myListDownloads: false } });
  assert.deepEqual(w.add("p1", FILM), { queued: false, reason: "off" });
  w = world({ torrents: false });
  assert.deepEqual(w.add("p1", FILM), { queued: false, reason: "torrents-off" });
  w = world({ settings: { myListShows: false }, metaCached: { [SHOW.imdbId]: META } });
  assert.deepEqual(w.add("p1", SHOW), { queued: false, reason: "shows-off" });
  assert.equal(w.add("p1", FILM).queued, true, "films still are");
  await w.idle();
  assert.equal(w.jobs.length, 1);
  assert.equal(w.lookups.length, 1);
});

test("a kids profile: over its limit or unrated → nothing; inside it → fetched", async () => {
  const w = world();
  assert.deepEqual(w.add("kid", FILM), { queued: false, reason: "kids" }, "rated 16, the limit is 7");
  assert.deepEqual(w.add("kid", { ...FILM, imdbId: "tt1000009", title: "Unrated" }), { queued: false, reason: "kids" }, "unknown is not fine");
  await w.idle();
  assert.equal(w.jobs.length, 0);
  assert.equal(w.lookups.length, 0);
  assert.ok(said(w, /^\[mylist\] skipped Some Film for Kid: over the kids limit/));
  w.ages.tt1000007 = 6;
  w.sources.tt1000007 = [SRC("c")];
  assert.equal(w.add("kid", { ...FILM, imdbId: "tt1000007", title: "Cartoon" }).queued, true);
  await w.idle();
  assert.equal(w.jobs.length, 1);
  // a grown-up adding the 16+ film is unaffected
  assert.equal(w.add("p1", FILM).queued, true);
});

test("the disk gate says no: nothing is queued, it is written down, and a later daily pass tries once", async () => {
  const w = world({ gate: { ok: false, reason: "Low disk space: 3.0 GB free" } });
  assert.deepEqual(w.add("p1", FILM), { queued: false, reason: "disk", what: "film" });
  await w.idle();
  assert.equal(w.jobs.length, 0);
  assert.equal(w.lookups.length, 0);
  assert.equal(w.rec(FILM.imdbId).state, "failed");
  assert.ok(said(w, /^\[mylist\] could not queue Some Film for Alice: Low disk space/));
  // room for the lookup, not for the file the source turned out to be
  const w2 = world({ gate: (type, size) => (size > 1e9 ? { ok: false, reason: "too big for what is free" } : { ok: true }) });
  assert.equal(w2.add("p1", FILM).queued, true);
  await w2.idle();
  assert.equal(w2.jobs.length, 0);
  assert.equal(w2.rec(FILM.imdbId).failReason, "too big for what is free");
});

test("the daily cap per profile: the extra ones wait for a later day instead of starting twenty at once", async () => {
  const w = world({ settings: { myListDailyCap: 2 } });
  const film = (n) => ({ ...FILM, imdbId: `tt30000${n}`, title: `Film ${n}` });
  for (let n = 1; n <= 5; n++) w.sources[`tt30000${n}`] = [SRC(String(n))];
  assert.equal(w.add("p1", film(1)).queued, true);
  assert.equal(w.add("p1", film(2)).queued, true);
  assert.deepEqual(w.add("p1", film(3)), { queued: false, reason: "daily-cap", what: "film" });
  assert.deepEqual(w.add("p1", film(4)), { queued: false, reason: "daily-cap", what: "film" });
  assert.equal(w.add("p2", film(5)).queued, true, "the cap is per profile");
  await w.idle();
  assert.equal(w.jobs.length, 3);
  // the same day's daily pass starts nothing more
  await w.m.daily();
  assert.equal(w.jobs.length, 3);
  // a day later: the two that waited start, oldest first, inside the cap
  w.now += DAY + 1000;
  await w.m.daily();
  assert.equal(w.jobs.length, 5);
  assert.deepEqual(w.jobs.slice(3).map((j) => j.title), ["Film 3", "Film 4"]);
});

test("a title with no IMDb id, or an episode's own id: nothing to do", () => {
  const w = world();
  assert.deepEqual(w.m.onAdd("p1", { stream: true, imdbId: "nonsense", type: "movie", title: "X" }), { queued: false, reason: "unknown-title" });
  assert.deepEqual(w.m.onAdd("p1", "no-such-id"), { queued: false, reason: "unknown-title" });
  w.libraryItems.ep1 = { id: "ep1", type: "episode", showId: "s1", title: "Pilot" };
  assert.deepEqual(w.m.onAdd("p1", "ep1"), { queued: false, reason: "in-library" });
});

// ====================================================================
// failures
// ====================================================================

test("no source: written down, not retried in a loop — once, by a LATER daily pass, then left alone", async () => {
  const w = world({ sources: {} });
  assert.equal(w.add("p1", FILM).queued, true);
  await w.idle();
  assert.equal(w.jobs.length, 0);
  assert.equal(w.rec(FILM.imdbId).state, "failed");
  assert.equal(w.rec(FILM.imdbId).failReason, "no source");
  assert.ok(said(w, /^\[mylist\] could not queue Some Film: no source/));
  assert.equal(w.lookups.length, 1);

  await w.m.daily();
  assert.equal(w.lookups.length, 1, "the same day's pass does not try again");
  w.now += DAY;
  await w.m.daily();
  assert.equal(w.lookups.length, 2, "the next day's does, once");
  assert.equal(w.rec(FILM.imdbId).state, "failed");
  w.now += DAY;
  await w.m.daily();
  assert.equal(w.lookups.length, 2, "and that was the one retry");
  assert.equal(w.rec(FILM.imdbId).state, "gave-up");
  w.now += DAY;
  await w.m.daily();
  assert.equal(w.lookups.length, 2);
  // "retries": 0 means never again
  const w0 = world({ sources: {}, settings: { myListRetries: 0 } });
  w0.add("p1", FILM);
  await w0.idle();
  w0.now += DAY;
  await w0.m.daily();
  assert.equal(w0.lookups.length, 1);
  assert.equal(w0.rec(FILM.imdbId).state, "gave-up");
});

test("a download the queue gave up on: the retry finds a source again and the copy is tracked like any other", async () => {
  const w = world();
  w.add("p1", FILM);
  await w.idle();
  const j = w.jobs[0];
  j.status = "error";
  j.error = "no peers for 30 minutes";
  w.m.onJob(j);
  assert.equal(w.rec(FILM.imdbId).state, "failed");
  assert.ok(said(w, /^\[mylist\] download failed Some Film: no peers/));
  w.now += DAY;
  await w.m.daily();
  assert.equal(w.jobs.length, 2, "one more job, a day later");
  assert.equal(w.rec(FILM.imdbId).state, "queued");
  w.land(w.jobs[1]);
  assert.equal(w.rec(FILM.imdbId).state, "done");
  // a provider that throws is a failure like any other
  const w2 = world({ sources: { [FILM.imdbId]: "throw" } });
  w2.add("p1", FILM);
  await w2.idle();
  assert.match(w2.rec(FILM.imdbId).failReason, /^no source \(provider down\)/);
});

test("a failed one is not retried once the title is off every list", async () => {
  const w = world({ sources: {} });
  w.add("p1", FILM);
  await w.idle();
  w.remove("p1", FILM);
  assert.equal(w.rec(FILM.imdbId).state, "canceled");
  w.now += DAY;
  await w.m.daily();
  assert.equal(w.lookups.length, 1);
});

// ====================================================================
// the lifecycle clock
// ====================================================================

test("not stale at 13 days, stale at 14, deleted at 21 — and it stays on the list", async () => {
  const w = world();
  const file = await w.landed();
  const t0 = w.now;
  assert.ok(said(w, /^\[mylist\] landed Some Film — stale in 14 days, deleted in 21/));

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
  assert.deepEqual(w.lists.p1, [FILM.imdbId], "the title is still on the person's list — stream-only again");
  assert.equal(w.canceled.length, 0);
});

test("the delete suggestion entry: a stale copy is marked on its library item with why and when it goes", async () => {
  const w = world();
  await w.landed();
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
    await w.landed();
    const t0 = w.now;
    w.rows[FILM.imdbId] = [{ name: "Bob", ...row, at: t0 + 3 * DAY }];
    w.now = t0 + 30 * DAY;
    await w.m.daily();
    assert.equal(w.deleted.length, 0);
    assert.equal(w.rec(FILM.imdbId).state, "watched");
    assert.ok(said(w, /^\[mylist\] kept Some Film: watched by Bob/));
    assert.equal(w.m.libraryMarks().size, 0, "an ordinary library title: no mark, no suggestion from here");
    // …and for good: taking it off the list, or more time, changes nothing
    w.remove("p1", FILM);
    w.now += 60 * DAY;
    await w.m.daily();
    assert.equal(w.deleted.length, 0);
  }
});

test("watched late — on day 20 of 21 — still saves it; a peek of a few seconds, or progress from before it was asked for, does not", async () => {
  let w = world();
  await w.landed();
  let t0 = w.now;
  w.rows[FILM.imdbId] = [{ name: "Alice", position: 900, finished: false, at: t0 + 20 * DAY }];
  w.now = t0 + 22 * DAY;
  await w.m.daily();
  assert.equal(w.deleted.length, 0);
  assert.equal(w.rec(FILM.imdbId).state, "watched");

  w = world();
  await w.landed();
  t0 = w.now;
  w.rows[FILM.imdbId] = [
    { name: "Alice", position: 12, finished: false, at: t0 + DAY },        // opened and closed
    { name: "Bob", position: 5000, finished: true, at: t0 - 300 * DAY },   // saw it last year, as a stream
  ];
  w.now = t0 + 21 * DAY;
  await w.m.daily();
  assert.equal(w.deleted.length, 1, "neither is this copy being used");
});

test("taken off every list before anyone watched it: stale at once, still deleted at its 21 days", async () => {
  const w = world();
  w.add("p1", FILM);
  w.add("p2", FILM);
  await w.idle();
  w.land(w.jobs[0]);
  const t0 = w.now;
  w.now = t0 + 2 * DAY;
  w.remove("p1", FILM);
  assert.equal(w.m.status().records[0].state, "fresh", "Bob still has it on his list");
  w.remove("p2", FILM);
  const v = w.m.status().records[0];
  assert.equal(v.state, "stale");
  assert.match(v.why, /taken off every list, never watched/);
  assert.ok(said(w, /^\[mylist\] stale Some Film: taken off every list before anyone watched it/));
  w.now = t0 + 20 * DAY;
  await w.m.daily();
  assert.equal(w.deleted.length, 0);
  w.now = t0 + 21 * DAY;
  await w.m.daily();
  assert.equal(w.deleted.length, 1);
});

test("taken off every list while still downloading: the download is cancelled; while another list has it, it is not", async () => {
  const w = world();
  w.add("p1", FILM);
  w.add("p2", FILM);
  await w.idle();
  w.jobs[0].status = "downloading";
  w.remove("p1", FILM);
  assert.deepEqual(w.canceled, []);
  assert.equal(w.rec(FILM.imdbId).by, "p2", "it is Bob's now");
  w.remove("p2", FILM);
  assert.deepEqual(w.canceled, ["job1"]);
  assert.equal(w.rec(FILM.imdbId).state, "canceled");
  assert.ok(said(w, /^\[mylist\] canceled Some Film: taken off every list before it finished downloading/));
  // add → remove before the lookup even ran: no provider is asked, nothing is created
  const w2 = world();
  w2.add("p1", FILM);
  w2.remove("p1", FILM);
  await w2.idle();
  assert.equal(w2.jobs.length, 0);
  assert.equal(w2.lookups.length, 0);
  // …and that slip does not use up the day's cap
  w2.settings.myListDailyCap = 1;
  assert.equal(w2.add("p1", FILM).queued, true);
});

test("added to a list again while the copy is on disk: the clock starts again", async () => {
  const w = world();
  await w.landed();
  const t0 = w.now;
  w.remove("p1", FILM);
  w.now = t0 + 18 * DAY;
  assert.equal(w.m.status().records[0].state, "stale");
  assert.deepEqual(w.add("p2", FILM), { queued: false, reason: "in-library", what: "film" });
  assert.equal(w.m.status().records[0].state, "fresh", "someone wants it again");
  w.now = t0 + 21 * DAY;
  await w.m.daily();
  assert.equal(w.deleted.length, 0);
  w.now = t0 + 18 * DAY + 21 * DAY;
  await w.m.daily();
  assert.equal(w.deleted.length, 1);
});

test("never a manual download: a file someone asked for by hand is kept, whatever its age", async () => {
  // someone's own job landed on the very same file
  let w = world();
  const file = await w.landed();
  w.jobs.push({ id: "hand", status: "done", type: "movie", imdbId: FILM.imdbId, destPath: file, auto: null, smart: false });
  w.now += 30 * DAY;
  await w.m.daily();
  assert.equal(w.deleted.length, 0);
  assert.equal(w.rec(FILM.imdbId).state, "claimed");

  // someone pressed Download on the source we were fetching: the queue hands the job over (auto cleared)
  w = world();
  w.add("p1", FILM);
  await w.idle();
  w.jobs[0].auto = null;
  w.jobs[0].smart = false;
  w.land({ ...w.jobs[0] }); // (the queue's own hook is silent for a job that is not ours any more)
  w.jobs[0].status = "done";
  w.now += 30 * DAY;
  await w.m.daily();
  assert.equal(w.deleted.length, 0);
  assert.equal(w.rec(FILM.imdbId).state, "claimed");

  // …or pressed it after it had landed
  w = world();
  await w.landed();
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

test("never while it is being played, was just opened, or is being written; never when its drive is away", async () => {
  // on screen right now
  let w = world();
  const file = await w.landed();
  const t0 = w.now;
  w.now = t0 + 21 * DAY;
  w.playing.add("Some Film");
  await w.m.daily();
  assert.equal(w.deleted.length, 0);
  assert.equal(w.rec(FILM.imdbId).state, "done");
  assert.ok(said(w, /^\[mylist\] not deleting Some Film yet: .*someone opened it in the last few hours/));
  // opened ten seconds of it an hour ago (too little to count as watched)
  w.playing.clear();
  w.rows[FILM.imdbId] = [{ name: "Bob", position: 10, finished: false, at: w.now - 3600e3 }];
  await w.m.daily();
  assert.equal(w.deleted.length, 0);
  // nobody came back: the next day it goes
  w.now += DAY;
  await w.m.daily();
  assert.deepEqual(w.deleted, [file]);

  // another download of the same title is in flight
  w = world();
  await w.landed();
  w.jobs.push({ id: "again", status: "downloading", type: "movie", imdbId: FILM.imdbId, auto: null, smart: false });
  w.now += 21 * DAY;
  await w.m.daily();
  assert.equal(w.deleted.length, 0);
  assert.ok(said(w, /a download is writing it/));

  // the library drive is unplugged: "cannot see it" is not "delete it" — and not "it is gone" either
  w = world();
  const f2 = await w.landed();
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
  await w.landed();
  w.now += 21 * DAY;
  await w.m.daily();
  assert.equal(w.rec(FILM.imdbId).state, "done");
  assert.ok(said(w, /^\[mylist\] could not delete Some Film yet: EBUSY/));
});

test("a rescan or a rename does not lose the copy; a different file under the same title is never touched", async () => {
  // renamed: same title, same size → ours, at its new path
  let w = world();
  const file = await w.landed("p1", FILM);
  w.files.delete(file);
  w.files.set("L:/lib/Some Film (2020)/Some.Film.mkv", 2e9);
  w.located = "L:/lib/Some Film (2020)/Some.Film.mkv";
  w.now += 21 * DAY;
  await w.m.daily();
  assert.deepEqual(w.deleted, ["L:/lib/Some Film (2020)/Some.Film.mkv"]);

  // replaced by somebody's own, better copy (another size): not ours
  w = world();
  const f2 = await w.landed("p1", FILM);
  w.files.delete(f2);
  w.files.set("L:/lib/Some Film (2020)/Remux.mkv", 40e9);
  w.located = "L:/lib/Some Film (2020)/Remux.mkv";
  w.now += 21 * DAY;
  await w.m.daily();
  assert.equal(w.deleted.length, 0);
  assert.equal(w.rec(FILM.imdbId).state, "gone");

  // deleted by the admin in the meantime: forgotten, nothing to do
  w = world();
  const f3 = await w.landed("p1", FILM);
  w.files.delete(f3);
  w.now += DAY;
  await w.m.daily();
  assert.equal(w.rec(FILM.imdbId).state, "gone");
  assert.ok(said(w, /^\[mylist\] forgot Some Film: the file is no longer in the library/));
});

test("an episode has the same clock, and a job cancelled or removed from the queue leaves nothing behind", async () => {
  const w = world({ metaCached: { [SHOW.imdbId]: META }, meta: { [SHOW.imdbId]: META } });
  w.add("p1", SHOW);
  await w.idle();
  const file = w.land(w.jobs[0]);
  const key = `${SHOW.imdbId}:1:1`;
  const t0 = w.now;
  w.now = t0 + 14 * DAY;
  assert.equal(w.m.status().records[0].state, "stale");
  assert.equal(w.m.status().records[0].label, "Some Show · S1 E1");
  w.now = t0 + 21 * DAY;
  await w.m.daily();
  assert.deepEqual(w.deleted, [file]);
  assert.equal(w.rec(key).state, "deleted");

  // the admin cancels our job / removes its row: the record closes, no retry
  const w2 = world();
  w2.add("p1", FILM);
  await w2.idle();
  w2.jobs[0].status = "canceled";
  w2.m.onJob(w2.jobs[0]);
  assert.equal(w2.rec(FILM.imdbId).state, "canceled");
  const w3 = world();
  w3.add("p1", FILM);
  await w3.idle();
  w3.jobs.length = 0;
  await w3.m.daily();
  assert.equal(w3.rec(FILM.imdbId).state, "canceled");
  w3.now += 5 * DAY;
  await w3.m.daily();
  assert.equal(w3.lookups.length, 1);
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
  assert.equal(at(15, { inUse: true }), "stale", "holding only matters once it would be deleted");
  // other numbers
  const s2 = I.readSettings({ myListStaleDays: 3, myListDeleteDays: 5 });
  assert.equal(I.judge({ rec, now: t0 + 3 * DAY, settings: s2 }).state, "stale");
  assert.equal(I.judge({ rec, now: t0 + 5 * DAY, settings: s2 }).state, "delete");
  // an orphan is stale from the moment it was orphaned, and keeps its delete day
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
    await w.landed();
    const t0 = w.now;
    w.add("p2", { ...FILM, imdbId: "tt1000002", title: "Second" }); // no source: a failure on file
    await w.idle();
    store.flush();

    // "restart": new store object from the file, new instance, same world outside
    const again = new JsonStore(file, () => ({ records: {} }));
    assert.equal(again.data.records[FILM.imdbId].state, "done");
    assert.equal(again.data.records[FILM.imdbId].doneAt, t0);
    assert.equal(again.data.records.tt1000002.state, "failed");
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
    w3.add("p1", FILM);
    await w3.idle();
    const j = w3.jobs[0];
    j.status = "done"; j.doneAt = new Date(w3.now).toISOString(); j.destPath = "L:/lib/x.mkv";
    w3.files.set(j.destPath, 1e9);
    const m3 = mylist.make(w3.deps); // (nobody called onJob)
    assert.equal(m3.status().records[0].state, "fresh");
    assert.equal(w3.rec(FILM.imdbId).sizeBytes, 1e9);
    // closed records leave the file after two months
    w3.deps.store.flush();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("closed records are kept for the admin's list for a while, then dropped", async () => {
  const w = world({ sources: {}, settings: { myListRetries: 0 } });
  w.add("p1", FILM);
  await w.idle();
  w.now += DAY;
  await w.m.daily();
  assert.equal(w.rec(FILM.imdbId).state, "gave-up");
  w.now += 59 * DAY;
  await w.m.daily();
  assert.ok(w.rec(FILM.imdbId));
  w.now += 2 * DAY;
  await w.m.daily();
  assert.equal(w.rec(FILM.imdbId), undefined);
  // and a closed record never blocks asking again
  const w2 = world({ sources: {}, settings: { myListRetries: 0 } });
  w2.add("p1", FILM);
  await w2.idle();
  w2.now += DAY;
  await w2.m.daily();
  w2.sources[FILM.imdbId] = [SRC("a")];
  w2.remove("p1", FILM);
  assert.equal(w2.add("p1", FILM).queued, true);
  await w2.idle();
  assert.equal(w2.jobs.length, 1);
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
    w.add("p1", FILM);
    await w.idle();
    const j = w.jobs[0];
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
      w2.add("p1", FILM);
      await w2.idle();
      const j2 = w2.jobs[0];
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

test("settings: the owner's defaults, and a file from before the feature reads as them", () => {
  assert.deepEqual(I.readSettings({}), {
    myListDownloads: true, myListShows: true, myListAutoDelete: true,
    myListStaleDays: 14, myListDeleteDays: 21, myListDailyCap: 5, myListRetries: 1,
    myListYield: "always",
  });
  assert.deepEqual(I.readSettings(undefined), I.readSettings({}));
  assert.deepEqual(I.readSettings({ maxActiveDownloads: 4, aria2MaxDownload: "0" }), I.readSettings({}));
  // nonsense in the file reads as the default, never as something dangerous
  const odd = I.readSettings({ myListStaleDays: -3, myListDeleteDays: "soon", myListDailyCap: 0, myListDownloads: "yes", myListRetries: 99 });
  assert.deepEqual(odd, I.readSettings({}));
  // a delete line under the stale line is lifted to it: nothing is deleted before it was ever suggested
  assert.equal(I.readSettings({ myListStaleDays: 30, myListDeleteDays: 10 }).myListDeleteDays, 30);
});

test("settings validation: only the keys sent change, and a refused value changes nothing", () => {
  const cur = {};
  assert.deepEqual(I.parseSettings({ myListStaleDays: 7 }, cur).value, { ...I.readSettings({}), myListStaleDays: 7 });
  assert.deepEqual(I.parseSettings({ myListStaleDays: "10", myListDeleteDays: " 30 " }, cur).value.myListDeleteDays, 30, "numbers as typed in a form");
  assert.equal(I.parseSettings({ myListDownloads: false }, cur).value.myListDownloads, false);
  for (const bad of [
    { myListStaleDays: 0 }, { myListStaleDays: 366 }, { myListStaleDays: 1.5 }, { myListStaleDays: "two weeks" }, { myListStaleDays: "" },
    { myListStaleDays: null }, { myListStaleDays: true }, { myListDeleteDays: 731 }, { myListDailyCap: 0 }, { myListDailyCap: 51 },
    { myListRetries: -1 }, { myListRetries: 6 }, { myListDownloads: "on" }, { myListShows: 1 }, { myListAutoDelete: null },
  ]) {
    assert.ok(I.parseSettings(bad, cur).error, `refused: ${JSON.stringify(bad)}`);
  }
  assert.match(I.parseSettings({ myListStaleDays: 30 }, cur).error, /Delete after must not be sooner/, "30 days stale against the default 21 to delete");
  assert.match(I.parseSettings({ myListDeleteDays: 7 }, cur).error, /Delete after must not be sooner/);
  assert.ok(I.parseSettings({ myListStaleDays: 21, myListDeleteDays: 21 }, cur).value, "the same day is allowed");

  // through the feature: stored, logged, and a refusal stores nothing
  const w = world();
  assert.ok(w.m.setSettings({ myListDailyCap: 99 }).error);
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
  await w.landed();
  w.now += 8 * DAY;
  assert.equal(w.m.status().records[0].state, "fresh");
  w.m.setSettings({ myListStaleDays: 7 });
  assert.equal(w.m.status().records[0].state, "stale");
});

test("switching the feature off stops new downloads; copies already fetched still run out their clock", async () => {
  const w = world();
  await w.landed();
  w.m.setSettings({ myListDownloads: false });
  assert.equal(w.add("p2", { ...FILM, imdbId: "tt1000005", title: "Later" }).reason, "off");
  w.now += 21 * DAY;
  await w.m.daily();
  assert.equal(w.deleted.length, 1);
});

test("the admin's view: every record with its state, and Keep stops the clock", async () => {
  const w = world({ settings: { myListDailyCap: 1 } });
  await w.landed();
  w.add("p1", { ...FILM, imdbId: "tt1000003", title: "Waiting" });
  const st = w.m.status();
  assert.deepEqual(st.settings, I.readSettings({ myListDailyCap: 1 }));
  assert.deepEqual(st.records.map((r) => [r.label, r.state, r.by]).sort(), [["Some Film", "fresh", "Alice"], ["Waiting", "waiting", "Alice"]]);
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
