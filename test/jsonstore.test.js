// The JSON stores (src/lib/jsonstore.js): a write is atomic and durable, a
// burst of saves is one write, a locked file is retried and never forgotten,
// and a damaged store is restored from a good copy — or, for a critical one
// with nothing good anywhere, put in SAFE MODE rather than replaced by an
// empty house. Everything happens in temp folders.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const js = require("../src/lib/jsonstore");
const { JsonStore } = js;
const I = js._internals;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "aurora-store-"));
const rm = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
const forget = (s) => { if (s.saveTimer) clearTimeout(s.saveTimer); if (s.retryTimer) clearTimeout(s.retryTimer); I.instances.delete(s); };
const quiet = async (fn) => {
  const saved = { error: console.error, warn: console.warn, log: console.log };
  const lines = [];
  console.error = (...a) => lines.push(a.join(" "));
  console.warn = (...a) => lines.push(a.join(" "));
  console.log = (...a) => lines.push(a.join(" "));
  try { await fn(lines); } finally { Object.assign(console, saved); }
  return lines;
};
const HOUSE = { profiles: [{ id: "a", name: "Ann" }, { id: "b", name: "Bob" }, { id: "c", name: "Cy" }], state: { a: { progress: { x: 1 } } } };
const DEFAULT_HOUSE = () => ({ profiles: [{ id: "default", name: "Watcher" }], state: {} });
const files = (dir) => fs.readdirSync(dir).sort();

test("a save is atomic and durable: temp file, fsync, rename; nothing is left behind; a cache skips the fsync", () => {
  const dir = tmp();
  const real = { ...I.io };
  const calls = [];
  I.io.fsyncSync = (fd) => { calls.push("fsync"); return real.fsyncSync(fd); };
  I.io.renameSync = (a, b) => { calls.push(`rename ${path.basename(a)} -> ${path.basename(b)}`); return real.renameSync(a, b); };
  try {
    const s = new JsonStore(path.join(dir, "things.json"), {});
    s.data.x = 1;
    assert.equal(s.flush(), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "things.json"), "utf8")), { x: 1 });
    assert.deepEqual(calls.slice(0, 2), ["fsync", `rename things.json.${process.pid}.tmp -> things.json`], "flushed to disk BEFORE it is given its name");
    assert.ok(!files(dir).some((n) => n.endsWith(".tmp")), "no temp file left");
    forget(s);
    calls.length = 0;
    const c = new JsonStore(path.join(dir, "cache", "posters.json"), {});
    assert.equal(c.kind, "cache");
    c.data.y = 2;
    c.flush();
    assert.ok(!calls.includes("fsync"), "a cache is rebuilt, not fsynced");
    assert.ok(!files(path.join(dir, "cache")).some((n) => /\.good\d$/.test(n)), "and keeps no last-good copies");
    forget(c);
  } finally {
    Object.assign(I.io, real);
    rm(dir);
  }
});

test("what kind of store a file is follows its name and place", () => {
  assert.equal(I.kindFor(path.join("x", "data", "profiles.json")), "critical");
  assert.equal(I.kindFor(path.join("x", "data", "sessions.json")), "critical");
  assert.equal(I.kindFor(path.join("x", "data", "settings.json")), "critical");
  assert.equal(I.kindFor(path.join("x", "data", "downloads.json")), "state");
  assert.equal(I.kindFor(path.join("x", "data", "metadata-cache.json")), "cache");
  assert.equal(I.kindFor(path.join("x", "data", "cache", "discover.json")), "cache");
  // what the backup leaves out as rebuildable is what the stores treat as a cache
  const backup = require("../src/lib/backup");
  for (const n of js.REBUILDABLE) assert.ok(backup._internals.EXCLUDE_FILES.has(n), n);
});

test("a burst of saves is ONE write, and a save that changes nothing is none", (t) => {
  const dir = tmp();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const s = new JsonStore(path.join(dir, "progress.json"), {});
  try {
    for (let i = 0; i < 200; i++) { s.data.pos = i; s.save(); }
    assert.equal(s.writes, 0, "nothing is written during the burst");
    t.mock.timers.tick(I.DEBOUNCE_MS);
    assert.equal(s.writes, 1, "200 saves, one write");
    assert.equal(JSON.parse(fs.readFileSync(s.filePath, "utf8")).pos, 199);
    // the same content again: no write at all
    s.save();
    t.mock.timers.tick(I.DEBOUNCE_MS);
    assert.equal(s.writes, 1);
    assert.equal(s.skipped, 1);
    // a real change writes again
    s.data.pos = 500;
    s.save();
    t.mock.timers.tick(I.DEBOUNCE_MS);
    assert.equal(s.writes, 2);
  } finally {
    t.mock.timers.reset();
    forget(s);
    rm(dir);
  }
});

test("EPERM on rename (a scanner holding the file) is tried again at once and succeeds", () => {
  const dir = tmp();
  const real = { ...I.io };
  let refusals = 3;
  const slept = [];
  I.io.renameSync = (a, b) => {
    if (path.basename(b) === "downloads.json" && refusals-- > 0) throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
    return real.renameSync(a, b);
  };
  I.io.sleepSync = (ms) => slept.push(ms);
  const s = new JsonStore(path.join(dir, "downloads.json"), []);
  try {
    s.data.push({ id: 1 });
    assert.equal(s.flush(), true, "saved despite three refusals");
    assert.deepEqual(slept, [10, 20, 40], "a short, growing wait between tries");
    assert.deepEqual(JSON.parse(fs.readFileSync(s.filePath, "utf8")), [{ id: 1 }]);
    assert.equal(s.unsavedSince, 0);
  } finally {
    Object.assign(I.io, real);
    forget(s);
    rm(dir);
  }
});

test("a file that stays locked: the save is NOT forgotten — marked unsaved, tried again later, the live file never touched", async (t) => {
  const dir = tmp();
  const file = path.join(dir, "downloads.json");
  fs.writeFileSync(file, JSON.stringify([{ id: "old" }]));
  const real = { ...I.io };
  let locked = true;
  I.io.renameSync = (a, b) => {
    if (locked && path.basename(b) === "downloads.json") throw Object.assign(new Error("EBUSY: resource busy or locked, rename"), { code: "EBUSY" });
    return real.renameSync(a, b);
  };
  I.io.sleepSync = () => {};
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const s = new JsonStore(file, []);
  try {
    const lines = await quiet(async () => {
      s.data.push({ id: "new" });
      assert.equal(s.flush(), false);
    });
    assert.ok(lines.some((l) => /^Failed to save .+downloads\.json: EBUSY/.test(l)), "the line the healer knows");
    assert.ok(s.dirty && s.unsavedSince > 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), [{ id: "old" }], "the live file is whole and old, not half-written");
    assert.ok(!files(dir).some((n) => n.endsWith(".tmp")), "the temp file does not pile up");
    assert.deepEqual(js.status().unsaved.filter((n) => n === "downloads.json"), ["downloads.json"]);
    // still locked at the first retry, free at the second
    await quiet(async () => { t.mock.timers.tick(I.RETRY_LATER_MS); });
    assert.ok(s.dirty);
    locked = false;
    await quiet(async () => { t.mock.timers.tick(I.RETRY_LATER_MS); });
    assert.equal(s.dirty, false);
    assert.equal(s.unsavedSince, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), [{ id: "old" }, { id: "new" }]);
  } finally {
    t.mock.timers.reset();
    Object.assign(I.io, real);
    forget(s);
    rm(dir);
  }
});

test("flushAll writes every store with something unwritten, including one whose last write failed", () => {
  const dir = tmp();
  const a = new JsonStore(path.join(dir, "a.json"), {});
  const b = new JsonStore(path.join(dir, "b.json"), {});
  try {
    a.data.x = 1; a.save();
    b.data.y = 2; b.dirty = true; // as after a failed write: no timer pending
    js.flushAll();
    assert.equal(JSON.parse(fs.readFileSync(a.filePath, "utf8")).x, 1);
    assert.equal(JSON.parse(fs.readFileSync(b.filePath, "utf8")).y, 2);
  } finally {
    forget(a); forget(b);
    rm(dir);
  }
});

test("a kill between the temp write and the rename leaves the old file whole; the stale temp file is swept at the next start", () => {
  const dir = tmp();
  const file = path.join(dir, "profiles.json");
  fs.writeFileSync(file, JSON.stringify(HOUSE));
  // what a killed writer leaves: half a new version, under its temp name
  const stale = path.join(dir, "profiles.json.4242.tmp");
  fs.writeFileSync(stale, JSON.stringify(HOUSE).slice(0, 40));
  const old = new Date(Date.now() - 5 * 60 * 1000);
  fs.utimesSync(stale, old, old);
  const s = new JsonStore(file, DEFAULT_HOUSE);
  try {
    assert.equal(s.data.profiles.length, 3, "the old version, whole");
    assert.equal(s.recovered, null, "nothing needed recovering");
    assert.ok(!fs.existsSync(stale), "the leftover is gone");
  } finally {
    forget(s);
    rm(dir);
  }
});

test("a process killed while saving flat out never leaves an unreadable store", { timeout: 120000 }, async () => {
  const dir = tmp();
  const file = path.join(dir, "busy.json");
  const writer = path.join(dir, "writer.js");
  fs.writeFileSync(writer, `
    const { JsonStore } = require(${JSON.stringify(path.join(__dirname, "..", "src", "lib", "jsonstore.js"))});
    const s = new JsonStore(${JSON.stringify(file)}, { n: 0, pad: [] });
    for (let i = 0; i < 4000; i++) s.data.pad[i] = "row " + i + " ".repeat(40);
    s.data.n++; s.flush(); // (the file exists before "ready": a slow machine was killed before its first save)
    process.stdout.write("ready\\n");
    for (;;) { s.data.n++; s.flush(); }
  `);
  try {
    let last = 0;
    for (let round = 0; round < 8; round++) {
      const child = spawn(process.execPath, [writer], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      await new Promise((resolve) => child.stdout.once("data", resolve));
      await new Promise((r) => setTimeout(r, 40 + round * 23));
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
      const d = JSON.parse(fs.readFileSync(file, "utf8")); // throws if it was ever left half-written
      assert.equal(d.pad.length, 4000);
      assert.ok(d.n >= last, "and a completed save is never lost");
      last = d.n;
    }
  } finally {
    rm(dir);
  }
});

// ------------------------------------------------------------- loading

const damaged = {
  truncated: JSON.stringify(HOUSE).slice(0, Math.floor(JSON.stringify(HOUSE).length * 0.6)),
  garbage: "\u0000\u0000\u0000 not json at all \u0000",
  empty: "",
  "wrong shape (a list)": "[]",
  "wrong shape (no profiles)": JSON.stringify({ hello: "world" }),
};
for (const [how, bytes] of Object.entries(damaged)) {
  test(`profiles.json ${how}: restored from its last good copy — never an empty house`, async () => {
    const dir = tmp();
    const file = path.join(dir, "profiles.json");
    fs.writeFileSync(`${file}.good1`, JSON.stringify(HOUSE));
    const t = new Date(Date.now() - 20 * 60 * 1000);
    fs.utimesSync(`${file}.good1`, t, t);
    fs.writeFileSync(file, bytes);
    let s;
    try {
      const lines = await quiet(async () => { s = new JsonStore(file, DEFAULT_HOUSE); });
      assert.deepEqual(s.data.profiles.map((p) => p.name), ["Ann", "Bob", "Cy"]);
      assert.equal(s.safeMode, null);
      assert.ok(lines.some((l) => /^Corrupt store .+ backed up to .+RESTORED from its last good copy/.test(l)), "said loudly, in the words the healer knows");
      // the live file is good again at once (not only in memory)
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).profiles.length, 3);
      // the damaged bytes are kept (an empty file has nothing to keep)
      const aside = files(dir).filter((n) => n.startsWith("profiles.json.corrupt-"));
      assert.equal(aside.length, bytes ? 1 : 0);
      if (bytes) assert.equal(fs.readFileSync(path.join(dir, aside[0]), "utf8"), bytes);
      // and it is on record, with the window that was lost
      const rec = I.readRecoveries(dir);
      assert.equal(rec.length, 1);
      assert.equal(rec[0].store, "profiles.json");
      assert.equal(rec[0].source, "last-good");
      assert.ok(rec[0].lostMs >= 19 * 60 * 1000 && rec[0].lostMs <= 21 * 60 * 1000, `about twenty minutes were lost (${rec[0].lostMs})`);
      assert.match(js.recoverySentence(rec[0]), /restored from its last good copy.*Changes made in the 20 minutes before the damage are lost/);
    } finally {
      if (s) forget(s);
      rm(dir);
    }
  });
}

test("a file that is only LOCKED while the server starts (a scanner reading it) is waited for — never 'recovered' from an older copy", async () => {
  const dir = tmp();
  const file = path.join(dir, "profiles.json");
  fs.writeFileSync(file, JSON.stringify(HOUSE));
  fs.writeFileSync(`${file}.good1`, JSON.stringify(DEFAULT_HOUSE())); // an older state: must NOT be what loads
  const real = { ...I.io };
  let refusals = 5;
  const slept = [];
  I.io.readFileSync = (p, enc) => {
    if (p === file && refusals-- > 0) throw Object.assign(new Error("EBUSY: resource busy or locked, open"), { code: "EBUSY" });
    return real.readFileSync(p, enc);
  };
  I.io.sleepSync = (ms) => slept.push(ms);
  let s;
  try {
    const lines = await quiet(async () => { s = new JsonStore(file, DEFAULT_HOUSE); });
    assert.equal(s.data.profiles.length, 3, "the real file, once it could be read");
    assert.equal(s.recovered, null);
    assert.equal(lines.length, 0, "nothing to report");
    assert.equal(slept.length, 5);
    assert.equal(I.readRecoveries(dir).length, 0);
    forget(s);
    // locked for good (two seconds of trying): only then is it treated as unreadable
    refusals = Infinity;
    slept.length = 0;
    await quiet(async () => { s = new JsonStore(file, DEFAULT_HOUSE); });
    assert.equal(slept.length, 19, "asked twenty times first");
    assert.equal(s.recovered.problem, "unreadable (EBUSY)");
    assert.equal(s.recovered.source, "last-good");
  } finally {
    Object.assign(I.io, real);
    if (s) forget(s);
    rm(dir);
  }
});

test("the newer good copy is damaged too: the older one is used; both damaged: the backup is", async () => {
  const dir = tmp();
  const file = path.join(dir, "profiles.json");
  let s;
  try {
    fs.writeFileSync(file, "{ broken");
    fs.writeFileSync(`${file}.good1`, "also broken");
    fs.writeFileSync(`${file}.good2`, JSON.stringify(HOUSE));
    await quiet(async () => { s = new JsonStore(file, DEFAULT_HOUSE, { backupLookup: () => { throw new Error("must not be asked"); } }); });
    assert.equal(s.data.profiles.length, 3);
    assert.match(I.readRecoveries(dir)[0].from, /good2/);
    forget(s);

    // both copies gone bad: the backup system is asked for this file
    fs.writeFileSync(file, "{ broken");
    fs.writeFileSync(`${file}.good1`, "broken");
    fs.writeFileSync(`${file}.good2`, "[]"); // parses, wrong shape: not good
    const asked = [];
    const backupLookup = (f) => { asked.push(path.basename(f)); return { text: JSON.stringify({ profiles: [{ id: "z", name: "From backup" }], state: {} }), at: Date.now() - 6 * 3600 * 1000, name: "aurora-backup-20261008-031500.tar.gz" }; };
    const lines = await quiet(async () => { s = new JsonStore(file, DEFAULT_HOUSE, { backupLookup }); });
    assert.deepEqual(asked, ["profiles.json"]);
    assert.deepEqual(s.data.profiles.map((p) => p.name), ["From backup"]);
    assert.ok(lines.some((l) => /RESTORED from the backup aurora-backup-20261008-031500\.tar\.gz/.test(l)));
    const rec = I.readRecoveries(dir).pop();
    assert.equal(rec.source, "backup");
    assert.match(js.recoverySentence(rec), /6 hours before the damage are lost/);
  } finally {
    if (s) forget(s);
    rm(dir);
  }
});

test("a backup copy that is itself the wrong shape is not believed", async () => {
  const dir = tmp();
  const file = path.join(dir, "profiles.json");
  fs.writeFileSync(file, "{ broken");
  let s;
  try {
    await quiet(async () => { s = new JsonStore(file, DEFAULT_HOUSE, { backupLookup: () => ({ text: "[1,2,3]", at: 1, name: "x" }) }); });
    assert.ok(s.safeMode, "nothing good anywhere");
  } finally {
    if (s) forget(s);
    rm(dir);
  }
});

test("NOTHING good exists for a critical store: SAFE MODE — defaults in memory, the damaged file never overwritten, until the admin decides", async (t) => {
  const dir = tmp();
  const file = path.join(dir, "profiles.json");
  const bytes = damaged.truncated;
  fs.writeFileSync(file, bytes);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let s;
  try {
    const lines = await quiet(async () => { s = new JsonStore(file, DEFAULT_HOUSE, { backupLookup: () => null }); });
    assert.ok(lines.some((l) => /^Corrupt store .+ backed up to .+NO good copy exists.+SAFE MODE/.test(l)));
    assert.ok(s.safeMode);
    assert.equal(s.safeMode.problem, "not valid JSON");
    assert.deepEqual(s.data.profiles.map((p) => p.name), ["Watcher"], "it runs on its defaults");
    assert.ok(js.inSafeMode("profiles.json") && js.inSafeMode());
    // the server carries on: profiles change, saves are asked for, a shutdown flushes…
    s.data.profiles.push({ id: "n", name: "New" });
    s.save();
    t.mock.timers.tick(I.DEBOUNCE_MS * 3);
    assert.equal(s.flush(), false);
    js.flushAll();
    // …and the file on disk is byte for byte what it was
    assert.equal(fs.readFileSync(file, "utf8"), bytes, "NOT overwritten by an empty house");
    assert.equal(s.writes, 0);
    assert.ok(files(dir).some((n) => n.startsWith("profiles.json.corrupt-")), "and a copy is kept aside");
    const rec = I.readRecoveries(dir)[0];
    assert.equal(rec.safeMode, true);
    assert.match(js.recoverySentence(rec), /SAFE MODE.+saves nothing to that file.+Decide on the admin page/);
    // a restart changes nothing: still safe mode, still untouched
    forget(s);
    await quiet(async () => { s = new JsonStore(file, DEFAULT_HOUSE, { backupLookup: () => null }); });
    assert.ok(s.safeMode);
    assert.equal(fs.readFileSync(file, "utf8"), bytes);
    // the admin decides "start fresh": writing resumes from what is in memory
    await quiet(async () => { assert.equal(s.leaveSafeMode(), true); });
    assert.equal(s.safeMode, null);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).profiles.map((p) => p.name), ["Watcher"]);
    assert.ok(files(dir).some((n) => n.startsWith("profiles.json.corrupt-")), "the damaged file is still kept");
  } finally {
    t.mock.timers.reset();
    if (s) forget(s);
    rm(dir);
  }
});

test("an EMPTY critical file with nothing good is safe mode too (the classic power-cut file); a MISSING one with nothing anywhere is a first start", async () => {
  const dir = tmp();
  let s;
  try {
    fs.writeFileSync(path.join(dir, "sessions.json"), "");
    await quiet(async () => { s = new JsonStore(path.join(dir, "sessions.json"), {}, { backupLookup: () => null }); });
    assert.ok(s.safeMode);
    assert.equal(s.safeMode.problem, "empty");
    forget(s);
    const lines = await quiet(async () => { s = new JsonStore(path.join(dir, "settings.json"), { a: 1 }, { backupLookup: () => null }); });
    assert.equal(s.safeMode, null);
    assert.deepEqual(s.data, { a: 1 });
    assert.equal(lines.length, 0, "a new server says nothing");
    assert.equal(I.readRecoveries(dir).filter((r) => r.store === "settings.json").length, 0);
  } finally {
    if (s) forget(s);
    rm(dir);
  }
});

test("a critical file that has VANISHED is put back from its good copy, or from the backup", async () => {
  const dir = tmp();
  const file = path.join(dir, "profiles.json");
  let s;
  try {
    fs.writeFileSync(`${file}.good1`, JSON.stringify(HOUSE));
    await quiet(async () => { s = new JsonStore(file, DEFAULT_HOUSE); });
    assert.equal(s.data.profiles.length, 3);
    assert.equal(I.readRecoveries(dir)[0].problem, "missing");
    forget(s);
    fs.rmSync(file); fs.rmSync(`${file}.good1`);
    for (const n of files(dir)) if (/good\d$/.test(n)) fs.rmSync(path.join(dir, n));
    await quiet(async () => { s = new JsonStore(file, DEFAULT_HOUSE, { backupLookup: () => ({ text: JSON.stringify(HOUSE), at: 5, name: "aurora-backup-x" }) }); });
    assert.equal(s.data.profiles.length, 3, "from the backup");
  } finally {
    if (s) forget(s);
    rm(dir);
  }
});

test("starting a store empty ON PURPOSE: the .start-empty marker (deleting the file alone brings the good copy back)", async () => {
  const dir = tmp();
  const file = path.join(dir, "downloads.json");
  let s;
  try {
    fs.writeFileSync(`${file}.good1`, JSON.stringify([{ id: 1 }]));
    fs.writeFileSync(`${file}.start-empty`, "");
    await quiet(async () => { s = new JsonStore(file, []); });
    assert.deepEqual(s.data, []);
    s.data.push({ id: 2 });
    s.flush();
    assert.ok(!fs.existsSync(`${file}.start-empty`), "the marker is used once");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), [{ id: 2 }]);
  } finally {
    if (s) forget(s);
    rm(dir);
  }
});

test("an ordinary store with nothing good starts from its defaults, as it always did — its damaged file kept, the event on record", async () => {
  const dir = tmp();
  const file = path.join(dir, "requests.json");
  fs.writeFileSync(file, "{{{{");
  let s;
  try {
    const lines = await quiet(async () => { s = new JsonStore(file, []); });
    assert.deepEqual(s.data, []);
    assert.equal(s.safeMode, null);
    assert.ok(lines.some((l) => /^Corrupt store .+ backed up to .+starting from defaults/.test(l)));
    s.data.push(1);
    assert.equal(s.flush(), true, "and it is saved normally");
    assert.equal(I.readRecoveries(dir)[0].source, "defaults");
  } finally {
    if (s) forget(s);
    rm(dir);
  }
});

test("a cache that cannot be read starts empty and leaves no record (it is rebuilt)", async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "cache"));
  const file = path.join(dir, "cache", "similar.json");
  fs.writeFileSync(file, "nope");
  let s;
  try {
    await quiet(async () => { s = new JsonStore(file, { rows: {} }); });
    assert.deepEqual(s.data, { rows: {} });
    assert.equal(I.readRecoveries(path.join(dir, "cache")).length, 0);
  } finally {
    if (s) forget(s);
    rm(dir);
  }
});

test("last-good copies: one is taken when a good file loads, they rotate at most every ten minutes, are read back before they count, and never hold a wrong shape", () => {
  const dir = tmp();
  const file = path.join(dir, "profiles.json");
  fs.writeFileSync(file, JSON.stringify(HOUSE));
  const s = new JsonStore(file, DEFAULT_HOUSE);
  try {
    assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.good1`, "utf8")), HOUSE, "a good file that loads is copied at once");
    // saved again inside ten minutes: the copy is not rewritten
    s.data.profiles.push({ id: "d", name: "Di" });
    s.flush();
    assert.equal(JSON.parse(fs.readFileSync(`${file}.good1`, "utf8")).profiles.length, 3);
    assert.ok(!fs.existsSync(`${file}.good2`));
    // ten minutes on: it rotates
    s.lastGoodAt = Date.now() - I.GOOD_EVERY_MS - 1;
    s.data.profiles.push({ id: "e", name: "Ed" });
    s.flush();
    assert.equal(JSON.parse(fs.readFileSync(`${file}.good1`, "utf8")).profiles.length, 5);
    assert.equal(JSON.parse(fs.readFileSync(`${file}.good2`, "utf8")).profiles.length, 3, "the previous one is kept behind it");
    // a bug empties the shape in memory: it is saved (so be it) but NEVER becomes a "good" copy
    s.lastGoodAt = Date.now() - I.GOOD_EVERY_MS - 1;
    s.data = { oops: true };
    s.flush();
    assert.equal(JSON.parse(fs.readFileSync(`${file}.good1`, "utf8")).profiles.length, 5);
    assert.ok(!files(dir).some((n) => n.endsWith(".tmp")));
  } finally {
    forget(s);
    rm(dir);
  }
});

test("a recovery is announced ONCE (across restarts), and acknowledging it stops it being a finding", async () => {
  const dir = tmp();
  const file = path.join(dir, "profiles.json");
  fs.writeFileSync(`${file}.good1`, JSON.stringify(HOUSE));
  fs.writeFileSync(file, "broken");
  let s;
  try {
    await quiet(async () => { s = new JsonStore(file, DEFAULT_HOUSE); });
    const told = [];
    const mine = (r) => r.store === "profiles.json" && told.push(r);
    js.announceRecoveries((r, sentence) => { if (path.dirname(file) === dir) { mine(r); assert.match(sentence, /restored from/); } });
    assert.equal(told.length, 1);
    js.announceRecoveries((r) => mine(r));
    assert.equal(told.length, 1, "not said twice");
    const st = js.status();
    const rec = st.recoveries.find((r) => r.store === "profiles.json" && r.at === told[0].at);
    assert.equal(rec.announced, true);
    assert.equal(rec.acknowledged, false);
    assert.ok(js.acknowledgeRecoveries() >= 1);
    assert.equal(I.readRecoveries(dir)[0].acknowledged, true);
  } finally {
    if (s) forget(s);
    rm(dir);
  }
});

test("the sign-in wall closes when settings.json is in safe mode (a damaged file must not open the doors)", () => {
  const settings = require("../src/lib/settings");
  const authmode = require("../src/lib/authmode");
  const was = settings.safeMode;
  const mode = authmode.get();
  try {
    settings.safeMode = { since: Date.now(), problem: "not valid JSON", keptAs: null };
    assert.equal(authmode.get(), "closed");
  } finally {
    settings.safeMode = was;
  }
  assert.equal(authmode.get(), mode);
});

test("the shapes the critical stores must have", () => {
  const P = js.SHAPES["profiles.json"];
  assert.equal(P(HOUSE), null);
  assert.equal(P({ profiles: [], state: {} }), null, "a house whose profiles were all deleted is a legal house");
  assert.match(P([]), /not an object/);
  assert.match(P({ state: {} }), /no list of profiles/);
  assert.match(P({ profiles: [{ name: "no id" }], state: {} }), /no id/);
  assert.match(P({ profiles: [{ id: "a" }] }), /no watch state/);
  assert.equal(js.SHAPES["sessions.json"]({ abc: { profileId: "a" } }), null);
  assert.match(js.SHAPES["sessions.json"]({ abc: "x" }), /not an object/);
  assert.match(js.SHAPES["settings.json"]([]), /not an object/);
});
