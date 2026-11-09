// "Nobody touched it for 45 days" (src/media/untouched.js): the rule behind
// the admin's delete suggestions. Every rule on a fake clock, with fake
// stores and no files: the module itself has no way to delete anything — it
// only answers what to SUGGEST, and the admin's confirmed delete does the rest
// (test/untouched-route.test.js).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const U = require("../src/media/untouched");
const { judge, realPlay, readSettings, parseSettings, dayText, RETURN_GAP_MS } = U._internals;

const DAY = 86400e3;
const HOUR = 3600e3;
const GB = 1024 ** 3;
const T0 = Date.parse("2026-09-01T20:00:00Z"); // "day 0"
const day = (n) => T0 + n * DAY;

const film = (id, title, o = {}) => ({ id, kind: "movie", name: `${title} (2001)`, title, path: `/lib/movies/${title}/${title}.mkv`, sizeBytes: 4 * GB, addedAt: day(0), key: `tt-${id}`, cover: null, show: null, inUse: false, drive: "Media", down: false, busy: null, ...o });
const SHOW = { id: "show1", title: "Long Show", cover: null };
const ep = (s, e, o = {}) => ({ id: `e${s}${e}`, kind: "episode", name: `Long Show S0${s}E0${e}`, title: `Ep ${e}`, path: `/lib/shows/Long Show/S0${s}E0${e}.mkv`, sizeBytes: GB, addedAt: day(0), key: `tt-show:${s}:${e}`, cover: null, show: SHOW, season: s, episode: e, inUse: false, drive: "Media", down: false, busy: null, ...o });

// a fake world for make(): stores in memory, a clock the test moves
const world = (o = {}) => {
  const w = {
    now: o.now ?? day(0),
    items: o.items || [],
    people: o.people || [{ id: "pa", name: "Ann" }, { id: "pb", name: "Ben" }, { id: "pm", name: "Maya" }],
    progress: o.progress || {},
    titles: o.titles || {},
    jobs: o.jobs || [],
    uploads: o.uploads || [],
    lists: o.lists || {},
    access: o.access || {},
    sessions: o.sessions || {},
    settings: o.settings || {},
    store: { data: o.data || {}, saves: 0, save() { this.saves++; } },
    logs: [],
  };
  w.u = U.make({
    store: w.store,
    settingsData: () => w.settings,
    saveSettings: () => {},
    now: () => w.now,
    log: (m) => w.logs.push(m),
    norm: (p) => String(p || "").toLowerCase(),
    people: () => w.people,
    progressView: (pid) => w.progress[pid] || {},
    titles: (pid) => w.titles[pid] || {},
    streamItems: () => ({}),
    titleKeyFor: (itemId) => { const it = w.items.find((x) => x.id === itemId); return it ? it.key : null; },
    accessLast: (pid) => w.access[pid] || 0,
    sessionsLast: (pid) => w.sessions[pid] || 0,
    watchlist: (pid) => new Set(w.lists[pid] || []),
    jobs: () => w.jobs,
    uploadsDone: () => w.uploads,
    items: () => w.items,
  });
  return w;
};
const ids = (rows) => rows.map((r) => r.id).sort();
// a person plays for a while: two progress saves, the position moving
const watch = (w, pid, id, at = w.now) => {
  w.u.notePlay(pid, id, { position: 100 }, 130, null, at);
};

test("realPlay: only a position that moved forward is play — opening, a resume point, a step back are not", () => {
  assert.equal(realPlay(null, 0), false, "opened and closed at the start");
  assert.equal(realPlay({ position: 1200 }, 1200), false, "a resume point reached again");
  assert.equal(realPlay({ position: 1200 }, 1201), false, "a second is not play");
  assert.equal(realPlay({ position: 1200 }, 1205), true, "five seconds played");
  assert.equal(realPlay({ position: 1200 }, 30), false, "back to the start");
  assert.equal(realPlay(null, 6), true, "the first save of a fresh start");
});

test("settings: 45 days, uploads exempt, My List does not protect — and bad values change nothing", () => {
  assert.deepEqual(readSettings({}), { untouchedDays: 45, untouchedUploads: false, untouchedKeepMyList: false });
  assert.deepEqual(readSettings({ untouchedDays: "x", untouchedUploads: "yes" }), { untouchedDays: 45, untouchedUploads: false, untouchedKeepMyList: false });
  assert.deepEqual(parseSettings({ untouchedDays: 30 }, {}).value.untouchedDays, 30);
  assert.match(parseSettings({ untouchedDays: 0 }, {}).error, /whole number from 1 to 3650/);
  assert.match(parseSettings({ untouchedKeepMyList: "on" }, {}).error, /true or false/);
  const w = world();
  assert.equal(w.u.setSettings({ untouchedDays: 60, untouchedKeepMyList: true }).ok, true);
  assert.deepEqual(w.u.settings(), { untouchedDays: 60, untouchedUploads: false, untouchedKeepMyList: true });
  assert.ok(w.u.setSettings({ untouchedDays: -1 }).error);
  assert.equal(w.u.settings().untouchedDays, 60, "a refused value changed nothing");
});

test("started 46 days ago and not touched since: suggested, with who and when", () => {
  const w = world({ items: [film("f1", "Started Film")] });
  w.u.backfill();
  watch(w, "pa", "f1", day(1));
  w.u.seen("pa", day(1) + 3 * HOUR); // Ann was on Aurora since: not away
  w.now = day(47);
  const g = w.u.gather();
  assert.deepEqual(ids(g.idle), ["f1"]);
  assert.equal(g.never.length, 0);
  assert.equal(g.idle[0].why, "Nobody watched for 46 days · last played by Ann on Sep 2");
  assert.equal(g.idle[0].key, "x:f1");
  assert.equal(g.idle[0].drive, "Media");
  assert.equal(g.idle[0].idleDays, 45, "counted from her last touch: back on Aurora three hours after the play");
});

test("never played and landed 46 days ago: suggested as Never played; at 44 days it is not", () => {
  const w = world({ items: [film("f1", "Unplayed Film")] });
  w.now = day(44);
  assert.equal(w.u.gather().never.length, 0);
  w.now = day(46);
  const g = w.u.gather();
  assert.deepEqual(ids(g.never), ["f1"]);
  assert.equal(g.never[0].why, "Never played · arrived Sep 1");
  assert.equal(g.never[0].group, "never");
});

test("touched on day 40 (played, asked for, landed): kept on day 46", () => {
  for (const how of ["played", "asked", "landed"]) {
    const w = world({ items: [film("f1", "Kept Film")] });
    w.u.backfill();
    if (how === "played") { watch(w, "pa", "f1", day(40)); w.u.seen("pa", day(40) + 3 * HOUR); }
    if (how === "asked") w.jobs.push({ status: "error", smart: false, auto: null, destPath: null, imdbId: "tt-f1", type: "movie", at: day(40), doneAt: 0, by: "Ben" });
    if (how === "landed") w.items[0].addedAt = day(40);
    w.now = day(46);
    const g = w.u.gather();
    assert.equal(g.idle.length + g.never.length, 0, `${how} on day 40 keeps it`);
    w.now = day(86);
    const later = w.u.gather();
    assert.equal(later.idle.length + later.never.length, 1, `${how}: 46 days after that it is suggested`);
    if (how === "asked") assert.match(later.never[0].why, /^Never played · arrived Sep 1 · asked for by Ben on Oct 11$/);
  }
});

test("opening a film is not watching it: the clock does not move", () => {
  const w = world({ items: [film("f1", "Opened Film")] });
  w.u.backfill();
  w.u.notePlay("pa", "f1", { position: 1200 }, 1200, null, day(30)); // opened at its resume point, closed
  w.now = day(46);
  assert.deepEqual(ids(w.u.gather().never), ["f1"], "still never played, still counted from the day it landed");
});

test("several people on one title: the latest touch counts", () => {
  const w = world({ items: [film("f1", "Shared Film")] });
  w.u.backfill();
  watch(w, "pa", "f1", day(2));
  watch(w, "pb", "f1", day(30));
  w.u.seen("pa", day(31)); w.u.seen("pb", day(31));
  w.now = day(60);
  assert.equal(w.u.gather().idle.length, 0, "Ben watched 30 days ago");
  w.now = day(76);
  const g = w.u.gather();
  assert.equal(g.idle[0].why, "Nobody watched for 46 days · last played by Ben on Oct 1");
});

test("being played right now: listed, greyed, never counted", () => {
  const w = world({ items: [film("f1", "Playing Film", { inUse: true })] });
  w.now = day(50);
  const g = w.u.gather();
  assert.equal(g.never.length, 1);
  assert.equal(g.never[0].inUse, true);
  assert.equal(g.never[0].sizeBytes, 0);
  assert.deepEqual(U.totalsOf(g.never), { count: 0, bytes: 0 });
});

test("downloading, being moved, a drive not answering: held, never offered", () => {
  const w = world({
    items: [
      film("f1", "Downloading Film"),
      film("f2", "Moving Film", { busy: "being moved to another drive" }),
      film("f3", "Away Drive Film", { down: true }),
      film("f4", "Plain Film"),
    ],
    jobs: [{ status: "downloading", smart: false, auto: null, destPath: null, imdbId: "tt-f1", type: "movie", at: day(0), doneAt: 0, by: "Ann" }],
  });
  // the job was asked for on day 0: on day 50 that is no touch any more, but it is still on its way
  w.now = day(50);
  const g = w.u.gather();
  assert.deepEqual(ids(g.never), ["f4"]);
  assert.deepEqual(g.held.map((h) => [h.id, h.why]).sort(), [
    ["f1", "a download for it is on its way"], ["f2", "being moved to another drive"], ["f3", "its drive is not answering"],
  ]);
  for (const id of ["f1", "f2", "f3"]) assert.ok(g.keepIds.has(id), `${id} is kept out of every other list too`);
});

test("the Keep pin: a pinned film or show is never suggested, and is listed as Kept by you", () => {
  const w = world({ items: [film("f1", "Pinned Film"), film("f2", "Other Film"), ep(1, 1), ep(1, 2)] });
  w.now = day(50);
  assert.equal(w.u.pin("f1", true, { name: "Pinned Film (2001)", kind: "movie" }).ok, true);
  assert.equal(w.u.pin("show1", true, { name: "Long Show", kind: "show" }).ok, true);
  assert.ok(w.u.pin("nope", true, {}).error, "not in the library");
  const g = w.u.gather();
  assert.deepEqual(ids(g.never), ["f2"]);
  assert.deepEqual(g.pinned.map((p) => p.id).sort(), ["f1", "show1"]);
  const show = g.pinned.find((p) => p.id === "show1");
  assert.equal(show.episodes, 2);
  assert.equal(show.sizeBytes, 2 * GB);
  assert.equal(show.why, "Kept by you on Oct 21 — never suggested");
  assert.ok(g.keepIds.has("e11") && g.keepIds.has("f1"));
  assert.equal(w.u.pin("f1", false).ok, true);
  assert.deepEqual(ids(w.u.gather().never), ["f1", "f2"], "unpinned: suggested again");
});

test("My List: does not protect by default; the toggle makes it", () => {
  const w = world({ items: [film("f1", "Listed Film"), ep(1, 1)], lists: { pb: ["f1", "show1"] } });
  w.now = day(50);
  assert.deepEqual(ids(w.u.gather().never), ["e11", "f1"]);
  w.u.setSettings({ untouchedKeepMyList: true });
  const g = w.u.gather();
  assert.equal(g.never.length, 0);
  assert.equal(g.exempt.mylist, 2);
});

test("admin uploads are never suggested by default; the setting lets them in", () => {
  const w = world({ items: [film("f1", "My Own Video"), film("f2", "A Download")], uploads: [{ path: "/lib/movies/My Own Video/My Own Video.mkv", at: day(0) }] });
  w.now = day(50);
  const g = w.u.gather();
  assert.deepEqual(ids(g.never), ["f2"]);
  assert.equal(g.exempt.uploads, 1);
  assert.ok(g.keepIds.has("f1"));
  w.uploads.length = 0; // the upload job was dismissed: still remembered
  w.u.setSettings({ untouchedUploads: true });
  assert.deepEqual(ids(w.u.gather().never), ["f1", "f2"]);
});

test("away: the last thing someone watched, while they have not been on Aurora since, is kept for them", () => {
  const w = world({ items: [film("f1", "Last Film"), film("f2", "Earlier Film")] });
  w.u.backfill();
  watch(w, "pm", "f2", day(1));
  watch(w, "pm", "f1", day(2));
  w.now = day(60);
  const g = w.u.gather();
  assert.deepEqual(ids(g.idle), ["f2"], "the earlier film is suggested");
  assert.deepEqual(ids(g.away), ["f1"], "the last one is kept");
  assert.equal(g.away[0].why, "Kept for Maya — away since Sep 3 · the last thing they watched");
  assert.equal(g.away[0].key, "a:f1");
  assert.match(g.away[0].reason, /^Nobody watched for 58 days · last played by Maya on Sep 3$/);
  assert.ok(g.keepIds.has("f1"));
  assert.ok(!g.suggestIds.has("f1"));
});

test("away, then back on day 50: from then the normal 45 days count — suggested on day 96, not before", () => {
  const w = world({ items: [film("f1", "Last Film")] });
  w.u.backfill();
  watch(w, "pm", "f1", day(0));
  w.now = day(49);
  assert.deepEqual(ids(w.u.gather().away), ["f1"]);
  // a heartbeat the same evening is the same sitting, not a return
  w.u.seen("pm", day(0) + HOUR);
  w.now = day(49);
  assert.deepEqual(ids(w.u.gather().away), ["f1"]);
  // Maya opens Aurora on day 50 (any screen) — she is back
  w.u.seen("pm", day(50));
  assert.ok(w.logs.some((l) => /Maya is back/.test(l)), "one log line says so");
  w.now = day(60);
  let g = w.u.gather();
  assert.equal(g.away.length, 0);
  assert.equal(g.idle.length, 0, "10 days after her return: not suggested");
  w.now = day(94);
  assert.equal(w.u.gather().idle.length, 0, "44 days after her return: not yet");
  w.now = day(96);
  g = w.u.gather();
  assert.deepEqual(ids(g.idle), ["f1"], "46 days after her return");
  assert.equal(g.idle[0].why, "Nobody watched for 96 days · last played by Maya on Sep 1 · Maya came back on Oct 21");
});

test("back, watches something else, goes away again: the first title keeps its 45 days from the return", () => {
  const w = world({ items: [film("f1", "First Film"), film("f2", "Second Film")] });
  w.u.backfill();
  watch(w, "pm", "f1", day(0));
  w.u.seen("pm", day(50));          // back
  watch(w, "pm", "f2", day(51));    // a new last title, then away again
  w.now = day(80);
  const g = w.u.gather();
  assert.equal(g.idle.length, 0, "First Film: 30 days since she came back");
  assert.deepEqual(ids(g.away), [], "Second Film is not idle yet, so nothing to list");
  assert.ok(g.keepIds.has("f2"), "but it is kept for her");
});

test("a connection read from the sign-in sessions or the device log also counts as coming back", () => {
  const w = world({ items: [film("f1", "Last Film")], sessions: {} });
  w.u.backfill();
  watch(w, "pm", "f1", day(0));
  w.sessions.pm = day(20); // a signed-in request on day 20
  w.now = day(30);
  const g = w.u.gather();
  assert.equal(g.away.length, 0);
  w.now = day(66);
  assert.deepEqual(ids(w.u.gather().idle), ["f1"], "45 days from day 20");
});

test("episodes: judged one by one; an away person's last episode AND the next one on disk are kept", () => {
  const w = world({ items: [ep(1, 1), ep(1, 2), ep(1, 3), ep(1, 4)] });
  w.u.backfill();
  watch(w, "pm", "e11", day(1));
  watch(w, "pm", "e12", day(2));
  w.now = day(60);
  const g = w.u.gather();
  assert.deepEqual(ids(g.idle), ["e11"]);
  assert.deepEqual(ids(g.never), ["e14"]);
  assert.deepEqual(ids(g.away), ["e12", "e13"]);
  assert.match(g.away.find((r) => r.id === "e13").why, /^Kept for Maya — away since Sep 3 · the episode after their last one$/);
  // she comes back: both get 45 days from then
  w.u.seen("pm", day(61));
  w.now = day(100);
  assert.deepEqual(ids(w.u.gather().idle), ["e11"]);
  assert.deepEqual(ids(w.u.gather().never), ["e14"]);
  w.now = day(107);
  assert.deepEqual(ids(w.u.gather().idle), ["e11", "e12"]);
  assert.deepEqual(ids(w.u.gather().never), ["e13", "e14"]);
});

test("episodes: a last episode streamed (not on disk) keeps the next one that is on disk", () => {
  const w = world({ items: [ep(1, 3), ep(1, 4)] });
  w.u.backfill();
  // S1E2 was streamed: its title key only
  w.u.notePlay("pm", "torrent|abc|2", { position: 10 }, 40, null, day(1));
  w.u._data().lastPlay.pm.key = "tt-show:1:2";
  w.now = day(60);
  const g = w.u.gather();
  assert.deepEqual(ids(g.away), ["e13"]);
  assert.deepEqual(ids(g.never), ["e14"]);
});

test("the history already there is read once: a minute in or finished counts, a mark or a peek does not", () => {
  const w = world({
    items: [film("f1", "Watched Before"), film("f2", "Peeked"), film("f3", "Marked")],
    progress: {
      pa: {
        f1: { position: 3000, duration: 6000, finished: false, updatedAt: day(5) },
        f2: { position: 20, duration: 6000, finished: false, updatedAt: day(6) },
        f3: { position: 6000, duration: 6000, finished: true, updatedAt: 0, marked: true },
      },
    },
    access: { pa: day(6) + 3 * HOUR },
  });
  w.now = day(55);
  const g = w.u.gather();
  assert.deepEqual(ids(g.idle), ["f1"]);
  // (Ann was on Aurora a day later, from the device log: a return, too close to the play to mention)
  assert.equal(g.idle[0].why, "Nobody watched for 50 days · last played by Ann on Sep 6");
  assert.deepEqual(ids(g.never), ["f2", "f3"]);
  assert.ok(w.logs.some((l) => /first look: \d+ plays/.test(l)));
  // read once: a later change to the old rows is not read again
  w.progress.pa.f2.position = 4000;
  w.progress.pa.f2.updatedAt = day(54);
  assert.deepEqual(ids(w.u.gather().never), ["f2", "f3"]);
});

test("what it remembers survives a restart (a new instance over the same store)", () => {
  const w = world({ items: [film("f1", "Last Film"), film("f2", "Pinned")] });
  w.u.backfill();
  watch(w, "pm", "f1", day(0));
  w.u.pin("f2", true, { name: "Pinned (2001)" });
  w.u.seen("pm", day(50));
  const again = world({ items: w.items, data: JSON.parse(JSON.stringify(w.store.data)) });
  again.now = day(60);
  const g = again.u.gather();
  assert.equal(g.idle.length + g.away.length, 0, "the return on day 50 is remembered");
  assert.deepEqual(g.pinned.map((p) => p.id), ["f2"], "the pin is remembered");
});

test("Removed recently: what the admin removed, newest first, with why and size", () => {
  const w = world();
  w.now = day(10);
  w.u.noteRemoved([{ name: "Old Film (2001)", kind: "movie", sizeBytes: 4 * GB, why: "Nobody watched for 52 days · last played by Ann on Sep 18", group: "idle", drive: "Media" }]);
  w.now = day(11);
  w.u.noteRemoved([{ name: "Long Show S01E01", kind: "episode", sizeBytes: GB, why: "Never played · arrived Sep 10", group: "never" }]);
  const g = w.u.gather();
  assert.deepEqual(g.removed.map((r) => r.name), ["Long Show S01E01", "Old Film (2001)"]);
  assert.equal(g.removed[1].why, "Nobody watched for 52 days · last played by Ann on Sep 18");
  assert.equal(g.removed[1].sizeBytes, 4 * GB);
  assert.ok(w.logs.some((l) => /^\[cleanup\] removed Old Film \(2001\) \(4295 MB\) — Nobody watched/.test(l)));
});

test("the module never deletes: its whole surface is suggestions, notes, pins and settings", () => {
  const w = world({ items: [film("f1", "Any Film")] });
  const surface = Object.keys(w.u).sort();
  assert.deepEqual(surface, ["_data", "backfill", "gather", "noteRemoved", "notePlay", "noteUpload", "pin", "seen", "setSettings", "settings", "settleReturns"].sort());
  assert.ok(!/unlink|rmSync|rmdir|deleteVideoFile|deleteLibrary/.test(require("fs").readFileSync(require.resolve("../src/media/untouched"), "utf8")), "no file operation in the module");
});

test("dayText: the year only when it is not this year", () => {
  assert.equal(dayText(Date.parse("2026-09-18T12:00:00"), Date.parse("2026-11-09T12:00:00")), "Sep 18");
  assert.equal(dayText(Date.parse("2025-12-30T12:00:00"), Date.parse("2026-11-09T12:00:00")), "Dec 30, 2025");
  assert.ok(RETURN_GAP_MS >= HOUR);
  assert.equal(typeof judge, "function");
});
