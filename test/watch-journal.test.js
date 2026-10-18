// The watch journal (src/lib/watchjournal.js): a playback tick no longer
// rewrites profiles.json; its rows wait in data/watch-journal.json, which is
// laid back over profiles.json at boot — exactly when profiles.json is the
// file it was built on, newest-wins (nothing removed) when it is not (a
// restore, a recovery, an older build that ran in between). profiles.json is
// written whole at a checkpoint and at shutdown, keeping its format.
// Everything happens in temp folders, with real stores.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const js = require("../src/lib/jsonstore");
const { JsonStore } = js;
const I = js._internals;
const wj = require("../src/lib/watchjournal");
const { WatchJournal } = wj;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "aurora-journal-"));
const rm = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
const forget = (s) => { if (!s) return; if (s.saveTimer) clearTimeout(s.saveTimer); if (s.retryTimer) clearTimeout(s.retryTimer); I.instances.delete(s); };
const quiet = (fn) => {
  const saved = { error: console.error, warn: console.warn, log: console.log };
  const lines = [];
  console.error = console.warn = console.log = (...a) => lines.push(a.join(" "));
  try { return { value: fn(), lines }; } finally { Object.assign(console, saved); }
};
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const HOUSE = () => ({
  profiles: [{ id: "ann", name: "Ann" }, { id: "bob", name: "Bob" }],
  state: { ann: { progress: { old: { position: 50, duration: 100, finished: false, updatedAt: 1000 } }, titles: {}, streamItems: {}, watchlist: ["x"] }, bob: { progress: {}, titles: {}, streamItems: {} } },
  pending: [], access: {},
});

// A household as profiles.js builds it: the main store + its journal.
const open = (dir, { now } = {}) => {
  let journal = null;
  const main = new JsonStore(path.join(dir, "profiles.json"), () => ({ profiles: [], state: {} }), { digestOnLoad: true, afterWrite: (t) => journal && journal.mainWritten(t) });
  const stateOf = (pid) => {
    if (!main.data.profiles.some((p) => p.id === pid)) return null;
    const s = main.data.state[pid] || (main.data.state[pid] = {});
    for (const k of ["progress", "titles", "streamItems"]) if (!s[k]) s[k] = {};
    return s;
  };
  journal = new WatchJournal({ main, stateOf, dir, ...(now ? { now } : {}) });
  const boot = quiet(() => journal.boot());
  const tick = (pid, itemId, position, { urgent = false, at = Date.now(), title = null } = {}) => {
    const st = stateOf(pid);
    st.progress[itemId] = { position, duration: 7200, finished: false, updatedAt: at };
    if (title) st.titles[title] = { position, duration: 7200, finished: false, updatedAt: at, itemId };
    journal.note(pid, { progress: [itemId], titles: title ? [title] : [] }, { urgent });
  };
  const close = () => { forget(main); forget(journal.store); };
  return { main, journal, stateOf, tick, close, boot: boot.value, bootLines: boot.lines };
};
const settle = async (h) => { await h.journal.store.idle(); await h.main.idle(); await h.journal.store.idle(); };
const seed = (dir, house = HOUSE()) => fs.writeFileSync(path.join(dir, "profiles.json"), JSON.stringify(house));
const pfile = (dir) => path.join(dir, "profiles.json");
const jfile = (dir) => path.join(dir, wj.FILE);

test("a playback tick does not rewrite profiles.json: it waits in the journal (a minute at most; at once when it matters)", async (t) => {
  const dir = tmp();
  seed(dir);
  const before = fs.readFileSync(pfile(dir), "utf8");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = open(dir);
  try {
    for (let i = 0; i < 12; i++) h.tick("ann", "film", 100 + i * 5, { title: "tt1" });
    t.mock.timers.tick(I.DEBOUNCE_MS + 10);
    await settle(h);
    assert.ok(!fs.existsSync(jfile(dir)), "routine ticks wait");
    t.mock.timers.tick(wj.ROUTINE_MS);
    await settle(h);
    const j = read(jfile(dir));
    assert.equal(j.rows.ann.progress.film.position, 155, "the latest position, within the minute");
    assert.equal(j.rows.ann.titles.tt1.position, 155);
    assert.equal(j.base, js.md5(before), "built on the profiles.json on disk");
    assert.equal(fs.readFileSync(pfile(dir), "utf8"), before, "profiles.json was not touched");

    h.tick("ann", "film", 2000, { urgent: true }); // a seek
    t.mock.timers.tick(I.DEBOUNCE_MS);
    await settle(h);
    assert.equal(read(jfile(dir)).rows.ann.progress.film.position, 2000, "an urgent one within the debounce");

    h.tick("ann", "film", 2005);
    h.journal.noteStop("ann");
    t.mock.timers.tick(I.DEBOUNCE_MS);
    await settle(h);
    assert.equal(read(jfile(dir)).rows.ann.progress.film.position, 2005, "a stop writes what is waiting");
    h.tick("ann", "film", 2007); // the player's last save, straight after the stop
    t.mock.timers.tick(I.DEBOUNCE_MS);
    await settle(h);
    assert.equal(read(jfile(dir)).rows.ann.progress.film.position, 2007, "and the save that follows it");
    assert.equal(h.journal.stats.urgent >= 2, true);
  } finally {
    h.close();
    rm(dir);
  }
});

test("boot: the journal is laid over the profiles.json it was built on — rows set, removed rows removed", () => {
  const dir = tmp();
  seed(dir);
  let h = open(dir);
  h.tick("ann", "film", 321, { title: "tt1" });
  h.tick("bob", "ep", 42);
  delete h.stateOf("ann").progress.old; // removed meanwhile (say, a failed full write)
  h.journal.note("ann", { progress: ["old"] });
  h.journal.store.flush();
  h.close();
  const profilesBefore = fs.readFileSync(pfile(dir), "utf8");

  h = open(dir);
  try {
    assert.equal(h.boot.mode, "exact");
    const ann = h.main.data.state.ann;
    assert.equal(ann.progress.film.position, 321);
    assert.equal(ann.titles.tt1.position, 321);
    assert.equal(h.main.data.state.bob.progress.ep.position, 42);
    assert.equal("old" in ann.progress, false, "a null in the journal removes the row");
    assert.deepEqual(ann.watchlist, ["x"], "nothing else moved");
    assert.equal(fs.readFileSync(pfile(dir), "utf8"), profilesBefore, "an exact boot writes nothing");
    assert.equal(h.journal.pending(), 4, "the rows stay in the journal until the next full write");
  } finally {
    h.close();
    rm(dir);
  }
});

test("a full write of profiles.json (any other change, a checkpoint) carries every row; the journal is emptied and re-based at once", async () => {
  const dir = tmp();
  seed(dir);
  const h = open(dir);
  try {
    h.tick("ann", "film", 500, { title: "tt1" });
    h.journal.store.flush();
    assert.equal(Object.keys(read(jfile(dir)).rows).length, 1);
    h.main.data.state.ann.watchlist.push("y"); // any change that is not a tick
    h.main.save();
    h.main.flush();
    await settle(h);
    const p = read(pfile(dir));
    assert.equal(p.state.ann.progress.film.position, 500, "the row is in profiles.json now");
    assert.deepEqual(p.state.ann.watchlist, ["x", "y"]);
    const j = read(jfile(dir));
    assert.deepEqual(j.rows, {}, "the journal on disk was emptied in the same step");
    assert.equal(j.base, js.md5(fs.readFileSync(pfile(dir), "utf8")), "and built on the new file");
    assert.equal(h.journal.pending(), 0);
  } finally {
    h.close();
    rm(dir);
  }
});

test("a checkpoint: with rows waiting for CHECKPOINT_MS, the next tick has profiles.json written whole", async (t) => {
  const dir = tmp();
  seed(dir);
  let clock = 1_000_000;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = open(dir, { now: () => clock });
  try {
    h.tick("ann", "film", 100);
    clock += wj.CHECKPOINT_MS - 1000;
    h.tick("ann", "film", 105);
    t.mock.timers.tick(I.DEBOUNCE_MS);
    await settle(h);
    assert.equal(read(pfile(dir)).state.ann.progress.film, undefined, "not yet");
    clock += 2000;
    h.tick("ann", "film", 110);
    t.mock.timers.tick(I.DEBOUNCE_MS);
    await settle(h);
    assert.equal(read(pfile(dir)).state.ann.progress.film.position, 110, "profiles.json caught up");
    assert.equal(h.journal.stats.checkpoints, 1);
    assert.equal(h.journal.pending(), 0);
    t.mock.timers.tick(wj.ROUTINE_MS);
    await settle(h);
    assert.ok(!fs.existsSync(jfile(dir)) || Object.keys(read(jfile(dir)).rows).length === 0, "and the journal holds nothing (it never had to be written)");
  } finally {
    h.close();
    rm(dir);
  }
});

test("shutdown: what the journal holds goes into profiles.json, so an older build finds it all in the file it knows", () => {
  const dir = tmp();
  seed(dir);
  const h = open(dir);
  try {
    h.tick("ann", "film", 777, { title: "tt1" });
    h.journal.store.flush();
    h.journal.beforeShutdown();
    js.flushAll();
    const p = read(pfile(dir));
    assert.equal(p.state.ann.progress.film.position, 777);
    assert.equal(p.state.ann.titles.tt1.position, 777);
    assert.ok(Array.isArray(p.profiles) && p.state && p.pending, "the same format: profiles, state, pending");
    assert.deepEqual(read(jfile(dir)).rows, {});
  } finally {
    h.close();
    rm(dir);
  }
});

test("an older build ran in between (or profiles.json was restored): the journal is MERGED newest-wins, nothing removed, then written whole", async () => {
  const dir = tmp();
  seed(dir);
  let h = open(dir);
  h.tick("ann", "film", 300, { at: 5000, title: "tt1" });
  h.tick("ann", "other", 50, { at: 5000 });
  h.tick("bob", "ep", 10, { at: 5000 });
  delete h.stateOf("ann").progress.old;
  h.journal.note("ann", { progress: ["old"] });
  h.journal.store.flush();
  h.close(); // a hard kill: profiles.json never got these

  // the older build: reads profiles.json, knows nothing of the journal, and writes
  const old = read(pfile(dir));
  old.state.ann.progress.film = { position: 900, duration: 7200, finished: false, updatedAt: 9000 }; // watched on, later
  old.state.ann.watchlist.push("from-old-build");
  fs.writeFileSync(pfile(dir), JSON.stringify(old));

  h = open(dir);
  try {
    await settle(h);
    assert.equal(h.boot.mode, "merge");
    assert.ok(h.bootLines.some((l) => /merged/.test(l)), "said out loud");
    const ann = h.main.data.state.ann;
    assert.equal(ann.progress.film.position, 900, "the older build's newer row wins");
    assert.equal(ann.progress.other.position, 50, "a row only the journal had comes back");
    assert.equal(ann.titles.tt1.position, 300);
    assert.ok(ann.progress.old, "nothing is removed by a merge");
    assert.ok(ann.watchlist.includes("from-old-build"));
    assert.equal(h.main.data.state.bob.progress.ep.position, 10);
    const p = read(pfile(dir));
    assert.equal(p.state.ann.progress.other.position, 50, "written whole at once");
    assert.deepEqual(read(jfile(dir)).rows, {}, "and the journal emptied");
  } finally {
    h.close();
    rm(dir);
  }
});

test("a profile that is gone takes nothing back; bad keys are never applied", () => {
  const dir = tmp();
  seed(dir);
  fs.writeFileSync(jfile(dir), JSON.stringify({ v: 1, base: js.md5(fs.readFileSync(pfile(dir), "utf8")), at: 1, rows: {
    gone: { progress: { a: { position: 1, updatedAt: 1 } } },
    ann: { progress: { __proto__x: null, constructor: { position: 1 }, ok: { position: 9, updatedAt: 2 }, bad: "text" } },
  } }));
  const h = open(dir);
  try {
    assert.equal(h.boot.skippedProfiles, 1);
    assert.equal(h.main.data.state.gone, undefined);
    assert.equal(h.main.data.state.ann.progress.ok.position, 9);
    assert.equal(Object.prototype.hasOwnProperty.call(h.main.data.state.ann.progress, "constructor"), false);
    assert.equal(h.main.data.state.ann.progress.bad, undefined, "a row that is not an object is not taken");
  } finally {
    h.close();
    rm(dir);
  }
});

test("profiles.json in SAFE MODE: the journal is neither applied nor touched", () => {
  const dir = tmp();
  fs.writeFileSync(pfile(dir), "{ this is not json");
  const journalText = JSON.stringify({ v: 1, base: "abc", at: 1, rows: { ann: { progress: { f: { position: 5, updatedAt: 1 } } } } });
  fs.writeFileSync(jfile(dir), journalText);
  const saved = I.setBackupLookup;
  I.setBackupLookup(() => null);
  let h;
  try {
    const r = quiet(() => open(dir));
    h = r.value;
    assert.ok(h.main.safeMode, "profiles.json is in safe mode");
    assert.equal(h.boot.mode, "safe-mode");
    h.journal.note("ann", { progress: ["f"] }, { urgent: true });
    h.journal.store.flush();
    assert.equal(fs.readFileSync(jfile(dir), "utf8"), journalText, "the journal on disk is kept as it was");
  } finally {
    I.setBackupLookup((f) => { try { return require("../src/lib/backup").newestGoodCopySync(f); } catch { return null; } });
    void saved;
    if (h) h.close();
    rm(dir);
  }
});

test("a damaged journal: put back from its last-good copy, recorded; profiles.json is untouched", () => {
  const dir = tmp();
  seed(dir);
  const base = js.md5(fs.readFileSync(pfile(dir), "utf8"));
  const good = { v: 1, base, at: 1, rows: { ann: { progress: { f: { position: 60, duration: 100, finished: false, updatedAt: 2 } } } } };
  fs.writeFileSync(jfile(dir) + ".good1", JSON.stringify(good));
  fs.writeFileSync(jfile(dir), "{\"v\":1,\"base\":\"" + base + "\",\"rows\":{\"ann\":{\"progr"); // cut off mid-write
  const before = fs.readFileSync(pfile(dir), "utf8");
  const r = quiet(() => open(dir));
  const h = r.value;
  try {
    assert.ok(h.journal.store.recovered, "recovered");
    assert.equal(h.journal.store.recovered.source, "last-good");
    assert.equal(h.main.data.state.ann.progress.f.position, 60, "and laid over profiles.json");
    assert.equal(fs.readFileSync(pfile(dir), "utf8"), before);
    const rec = JSON.parse(fs.readFileSync(path.join(dir, "store-recovery.json"), "utf8"));
    assert.ok(rec.some((x) => x.store === wj.FILE));
  } finally {
    h.close();
    rm(dir);
  }
});

test("applyRows (pure): exact sets and removes; merge takes only newer rows, adds missing play-items, removes nothing", () => {
  const { applyRows } = wj._internals;
  const st = () => ({ progress: { a: { position: 1, updatedAt: 10 }, b: { position: 2, updatedAt: 10 } }, titles: {}, streamItems: { s: { title: "kept" } } });
  const rows = { progress: { a: { position: 9, updatedAt: 5 }, b: null, c: { position: 3, updatedAt: 1 } }, streamItems: { s: { title: "journal" }, t: { title: "new" } } };
  const e = st();
  assert.equal(applyRows(e, rows, true), 5);
  assert.equal(e.progress.a.position, 9, "exact: as written, even an older stamp");
  assert.equal("b" in e.progress, false);
  assert.equal(e.streamItems.s.title, "journal");
  const m = st();
  applyRows(m, rows, false);
  assert.equal(m.progress.a.position, 1, "merge: the newer row stays");
  assert.equal(m.progress.b.position, 2, "merge: nothing is removed");
  assert.equal(m.progress.c.position, 3, "merge: a missing row is added");
  assert.equal(m.streamItems.s.title, "kept");
  assert.equal(m.streamItems.t.title, "new");
});

test("isPlaybackTick (profiles.js): steady playback is routine; a start, a resume after a pause, a seek, a finish are not", () => {
  const { isPlaybackTick } = require("../src/profiles")._internals;
  const prev = { position: 100, duration: 7200, finished: false, updatedAt: 1_000_000 };
  const next = (position, dt, finished = false) => ({ position, duration: 7200, finished, updatedAt: 1_000_000 + dt });
  assert.equal(isPlaybackTick(prev, next(105, 5000)), true);
  assert.equal(isPlaybackTick(prev, next(130, 60000)), true, "a slower report");
  assert.equal(isPlaybackTick(null, next(105, 5000)), false, "the first save of a title");
  assert.equal(isPlaybackTick(prev, next(105, 10 * 60000)), false, "after a pause");
  assert.equal(isPlaybackTick(prev, next(800, 5000)), false, "a seek forward");
  assert.equal(isPlaybackTick(prev, next(20, 5000)), false, "a seek back");
  assert.equal(isPlaybackTick(prev, next(6900, 5000, true)), false, "finished");
  assert.equal(isPlaybackTick({ ...prev, marked: true }, next(105, 5000)), false, "over a row a mark made");
});

test("backups: the journal is read before profiles.json, and its rows count in the household", async () => {
  const backup = require("../src/lib/backup");
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, "a-store.json"), "{}");
    seed(dir);
    fs.writeFileSync(jfile(dir), JSON.stringify({ v: 1, base: null, at: 1, rows: { ann: { progress: { new1: { position: 1, updatedAt: 1 }, old: { position: 2, updatedAt: 2 } }, titles: { tt9: { position: 1, updatedAt: 1 } } } } }));
    const files = (await backup._internals.collect(dir)).map((f) => f.as);
    assert.ok(files.indexOf(`data/${wj.FILE}`) < files.indexOf("data/profiles.json"), files.join(","));
    const entries = new Map(files.map((as) => [as, fs.readFileSync(path.join(dir, as.slice(5)))]));
    const sum = backup._internals.summarize(entries);
    assert.equal(sum.problems.length, 0, sum.problems.join("; "));
    assert.equal(sum.historyRows, 1 + 2, "profiles.json's one row + the two the journal adds (old is already there)");
  } finally {
    rm(dir);
  }
});
