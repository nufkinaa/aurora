// The stores kept in SQLite (src/lib/sqlitestore.js under src/lib/jsonstore.js):
// the switch from JSON is verified and loses nothing, a kill at any moment of
// it is safe, a damaged JSON file or database is recovered the way a damaged
// file always was (never an empty house), writes are only the difference,
// several writers and readers get along, a JSON file that comes back is
// handled by its age, and the way back (the export, the switch-off) gives the
// files an older build reads. Everything happens in temp folders.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const sq = require("../src/lib/sqlitestore");
const js = require("../src/lib/jsonstore");
const { JsonStore } = js;
const I = js._internals;
const Q = sq._internals;

const HAVE = !!sq.loadEngine() && !sq.switchedOff();
const skip = HAVE ? false : `node:sqlite is not available here (Node ${process.versions.node}) or switched off`;

const JSONSTORE = require.resolve("../src/lib/jsonstore");
const SQLITESTORE = require.resolve("../src/lib/sqlitestore");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "aurora-sqlite-"));
const rm = (dir) => { sq.closeAll(); try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {} };
const forget = (s) => { if (s.saveTimer) clearTimeout(s.saveTimer); if (s.retryTimer) clearTimeout(s.retryTimer); I.instances.delete(s); };
const quiet = (fn) => {
  const saved = { error: console.error, warn: console.warn, log: console.log };
  const lines = [];
  console.error = (...a) => lines.push(a.join(" "));
  console.warn = (...a) => lines.push(a.join(" "));
  console.log = (...a) => lines.push(a.join(" "));
  try { fn(lines); } finally { Object.assign(console, saved); }
  return lines;
};
const open = (file, fallback, opts) => { let s; quiet(() => { s = new JsonStore(file, fallback, opts); }); return s; };
// a fresh process's view: every database connection closed, a new store
const reopen = (s, fallback) => { forget(s); sq.closeAll(); return open(s.filePath, fallback); };
const files = (dir) => fs.readdirSync(dir).sort();
const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 1));
const same = (a, b, msg) => assert.equal(JSON.stringify(a), JSON.stringify(b), msg);

// Data shaped like each store's real content (see the callers).
const now = 1762680000000;
const session = (i) => ({ id: `s${i}`, clientId: `c${i % 7}`, profile: `p${i % 5}`, ip: "192.168.1.20", device: { device: "TV", os: "Android" }, content: { title: `Film ${i}`, type: "movie" }, startedAt: now - i * 3600e3, updatedAt: now - i * 3600e3 + 60e3, position: i * 10, watchSec: i, live: false });
const SEEDS = {
  "watch-sessions.json": () => Array.from({ length: 300 }, (_, i) => session(i)),
  "telemetry-hours.json": () => Object.fromEntries(Array.from({ length: 400 }, (_, i) => [new Date(now - i * 3600e3).toISOString().slice(0, 13), { plays: i % 4, peak: i % 3, cpu: i / 10 }])),
  "watch-history.json": () => Array.from({ length: 120 }, (_, i) => ({ id: `h${i}`, ip: "1.2.3.4", device: { browser: "Chrome" }, profile: "Ann", content: `Show ${i}`, timestamp: new Date(now - i * 6e5).toISOString(), lastSeen: null, count: 1 })),
  "downloads.json": () => Array.from({ length: 12 }, (_, i) => ({ id: `d${i}`, infoHash: `ih${i}`, type: "movie", title: `Film ${i}`, status: i % 2 ? "done" : "downloading", progress: i / 12, files: [{ name: "a.mkv", size: 123 }] })),
  "uploads.json": () => [{ id: "u1", name: "home video.mp4", parts: [{ received: 3 }, { received: 0 }], status: "receiving" }],
  "requests.json": () => [{ id: "r1", title: "Dune", status: "open", by: "Ann" }, { id: "r2", title: "Heat", status: "done", by: "Bob" }],
  "reports.json": () => ({ reports: [{ id: "x1", text: "stutter", at: now, status: "open", errors: ["e1"] }] }),
  "replacements.json": () => ({ list: [{ id: "rp1", status: "done", title: "Arrival" }] }),
  "auth-log.json": () => ({ events: Array.from({ length: 50 }, (_, i) => ({ at: now - i, ip: "1.1.1.1", ok: i % 3 !== 0, who: "ann" })) }),
  "sub-audiosync.json": () => Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`file:E:\\Movies\\Film ${i}\\Film ${i}.srt`, { offset: i * 0.1, score: 0.9, at: now }])),
  "sub-langs.json": () => Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`E:\\Movies\\F${i}.srt`, { lang: i % 2 ? "en" : "he", sure: 0.9 }])),
  "intro-auto.json": () => Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`ep${i}`, { start: 10, end: 80, credits: 2500 + i }])),
  "intro-prints.json": () => ({ showA: { prints: Array.from({ length: 50 }, (_, i) => i * 7) }, showB: { prints: [1, 2, 3] } }),
  "healer.json": () => ({ fingerprints: { fp1: { first: 1, last: 2, n: 3, sample: "x" } }, errHours: { "2026-11-08T10": 2 }, days: { "2026-11-08": { plays: 3 } }, repairs: { "r|x": [1, 2] }, repairLog: [{ at: 1, repair: "r" }], ai: { day: null, n: 0 }, growth: {}, notes: {}, delivery: {}, roots: {}, declinedSeen: {}, memo: {} }),
};
// What each store's callers do to it (unshift + trim, splice, in place, delete, reassign).
const MUTATE = {
  "watch-sessions.json": (d) => { d.unshift(session(999)); d[3].position = 12345; d.splice(10, 1); d.length = 290; },
  "telemetry-hours.json": (d) => { d["2026-11-09T12"] = { plays: 9 }; delete d[Object.keys(d)[5]]; },
  "watch-history.json": (d) => { d.unshift({ id: "new", count: 1 }); d[1].count++; d.pop(); },
  "downloads.json": (d) => { d.unshift({ id: "dn", status: "queued" }); d[2].progress = 1; d.splice(5, 1); },
  "uploads.json": (d) => { d[0].parts[1].received = 2; d.push({ id: "u2", parts: [], status: "receiving" }); },
  "requests.json": (d) => { d.unshift({ id: "r3", title: "Up", status: "open" }); d[2].status = "done"; },
  "reports.json": (d) => { d.reports.unshift({ id: "x2", text: "no sound" }); d.reports[1].status = "closed"; },
  "replacements.json": (d) => { d.list.unshift({ id: "rp2", status: "running" }); },
  "auth-log.json": (d) => { d.events.push({ at: now + 1, ok: true }); d.events.splice(0, 5); },
  "sub-audiosync.json": (d) => { d["file:new.srt"] = { offset: 1 }; },
  "sub-langs.json": (d) => { delete d[Object.keys(d)[0]]; d["x.srt"] = { lang: "fr" }; },
  "intro-auto.json": (d) => { d.ep3.end = 90; },
  "intro-prints.json": (d) => { d.showC = { prints: [9] }; },
  "healer.json": (d) => { d.repairLog.push({ at: 2 }); d.repairs["r|x"] = [...d.repairs["r|x"], 3]; d.ai = { day: "2026-11-09", n: 1 }; },
};

// ------------------------------------------------------------ the codec

test("the codec: rebuilding the rows gives exactly the data, under random unshift/splice/sort/trim/delete/reassign (pure)", () => {
  let seed = 7;
  const R = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let round = 0; round < 120; round++) {
    const colls = round % 2 ? ["list", "m"] : [""];
    let data = round % 2 ? { a: 1, list: [], m: {}, z: "x" } : round % 4 === 0 ? [] : {};
    const state = Q.newState();
    const db = new Map();
    let head = null;
    const writeOnce = (fresh) => {
      const p = Q.plan(data, colls, state, { fresh });
      if (fresh) db.clear();
      for (const r of p.ops.up) db.set(Q.ck(r.coll, r.k), { ...r });
      for (const r of p.ops.move) db.get(Q.ck(r.coll, r.k)).pos = r.pos;
      for (const r of p.ops.del) db.delete(Q.ck(r.coll, r.k));
      head = p.head;
      Q.applied(state, p, { fresh });
    };
    const readBack = () => Q.rebuild(head, [...db.values()].sort((a, b) => (a.coll < b.coll ? -1 : a.coll > b.coll ? 1 : a.pos - b.pos)).map((r) => ({ ...r, val: JSON.parse(r.v) })));
    writeOnce(true);
    for (let step = 0; step < 40; step++) {
      const arr = Array.isArray(data) ? data : data.list;
      const map = Array.isArray(data) ? null : round % 2 ? data.m : data;
      if (arr) {
        const op = R(9);
        if (op === 0) arr.unshift({ id: R(1e6) });
        else if (op === 1) arr.push({ id: R(1e6), n: [1, 2] });
        else if (op === 2 && arr.length) arr.splice(R(arr.length), 1);
        else if (op === 3 && arr.length) { const el = arr[R(arr.length)]; if (el && typeof el === "object") el.x = step; }
        else if (op === 4 && arr.length > 3) arr.length -= 2;
        else if (op === 5) arr.sort((a, b) => ((a && a.id) || 0) - ((b && b.id) || 0));
        else if (op === 6 && arr.length) arr.splice(R(arr.length + 1), 0, arr[R(arr.length)]); // the same object twice
        else if (op === 7) arr.push(step % 2 ? "a string" : null); // not objects: by index
        else if (round % 2) data.list = arr.filter((_, i) => i % 2); // reassigned
      }
      if (map) {
        const k = `k${R(15)}`;
        if (R(3) === 0) delete map[k]; else { delete map[k]; map[k] = { v: step, u: undefined }; }
        if (R(6) === 0) map[String(R(4))] = step; // integer-like keys order themselves
        if (R(9) === 0) Object.defineProperty(map, "__proto__", { value: { own: 1 }, enumerable: true, configurable: true, writable: true });
      }
      if (round % 2 && R(5) === 0) data.z = R(2) ? step : undefined;
      writeOnce(false);
      same(readBack(), JSON.parse(JSON.stringify(data)), `round ${round} step ${step}`);
    }
  }
});

test("positions: prepend, append, delete and one move touch only those rows; a crowded gap renumbers", () => {
  assert.deepEqual(Q.positions([undefined, 1, 2, 3]).pos, [0, 1, 2, 3]);
  assert.deepEqual(Q.positions([1, 2, 3, undefined]).pos, [1, 2, 3, 4]);
  assert.deepEqual(Q.positions([1, 3]).pos, [1, 3]);
  const moved = Q.positions([2, 3, 4, 1]).pos; // 1 moved to the end
  assert.deepEqual(moved.slice(0, 3), [2, 3, 4]);
  assert.ok(moved[3] > 4);
  const between = Q.positions([1, undefined, undefined, 2]).pos;
  assert.ok(between[1] > 1 && between[2] > between[1] && between[2] < 2);
  assert.equal(Q.positions([1, undefined, 1 + 1e-12]).renumbered, true);
});

// ------------------------------------------------------------ every store

for (const name of Object.keys(SEEDS)) {
  test(`${name}: moved from JSON verified, then only the difference written; a restart (twice) gives back exactly what was in memory`, { skip }, () => {
    assert.ok(js.SQLITE_STORES.has(name), `${name} is one of the SQLite stores`);
    const dir = tmp();
    try {
      const file = path.join(dir, name);
      const seed = SEEDS[name]();
      write(file, seed);
      const fallback = Array.isArray(seed) ? [] : {};
      let s;
      const lines = quiet(() => { s = new JsonStore(file, fallback); });
      assert.equal(s.backend, "sqlite");
      same(s.data, seed, "the same data as the file");
      assert.ok(lines.some((l) => /moved into SQLite — \d+ rows, verified/.test(l)), lines.join("\n"));
      assert.ok(!fs.existsSync(file), "the JSON file is renamed…");
      const kept = files(dir).filter((n) => n.startsWith(`${name}.migrated-`));
      assert.equal(kept.length, 1, "…and kept");
      same(JSON.parse(fs.readFileSync(path.join(dir, kept[0]), "utf8")), seed, "the kept file is the original");
      MUTATE[name](s.data);
      const expect = JSON.parse(JSON.stringify(s.data));
      assert.equal(s.flush(), true);
      assert.equal(s.writes, 1);
      assert.equal(s.flush(), true);
      assert.equal(s.skipped, 1, "nothing changed: nothing written");
      s = reopen(s, fallback);
      assert.equal(s.backend, "sqlite");
      same(s.data, expect, "after a restart");
      MUTATE[name](s.data);
      const expect2 = JSON.parse(JSON.stringify(s.data));
      s.flush();
      s = reopen(s, fallback);
      same(s.data, expect2, "after a second restart");
      assert.ok(!fs.existsSync(file), "no JSON file came back");
      forget(s);
    } finally {
      rm(dir);
    }
  });
}

test("a new viewing session at the front of 8,000 is one row written (plus the one trimmed off the end), not 8,000", { skip }, () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "watch-sessions.json");
    write(file, Array.from({ length: 8000 }, (_, i) => session(i)));
    let s = open(file, []);
    s.data.unshift(session(-1));
    s.data.length = 8000;
    s.flush();
    assert.deepEqual({ ...s._sql.lastOps, whole: undefined }, { whole: undefined,  up: 1, move: 0, del: 1 });
    s.data[0].position = 77; // a live session moving on
    s.flush();
    assert.deepEqual({ ...s._sql.lastOps, whole: undefined }, { whole: undefined,  up: 1, move: 0, del: 0 });
    s.data.splice(4000, 1); // a blip removed from the middle
    s.flush();
    assert.deepEqual({ ...s._sql.lastOps, whole: undefined }, { whole: undefined,  up: 0, move: 0, del: 1 });
    const expect = JSON.stringify(s.data);
    s = reopen(s, []);
    assert.equal(JSON.stringify(s.data), expect);
    forget(s);
  } finally {
    rm(dir);
  }
});

// ------------------------------------------------------------ a kill mid-switch

// A child process that loads the store; `hook` decides when it dies.
const child = (dir, name, hook) => spawnSync(process.execPath, ["-e", `
  const sq = require(${JSON.stringify(SQLITESTORE)});
  const kill = () => process.kill(process.pid, "SIGKILL");
  ${hook}
  const { JsonStore } = require(${JSON.stringify(JSONSTORE)});
  const s = new JsonStore(${JSON.stringify(path.join(dir, name))}, []);
  process.stdout.write("ALIVE " + s.backend + " " + s.data.length);
`], { encoding: "utf8", timeout: 60000 });

test("a kill in the middle of the switch's transaction: nothing changed, the next start moves it whole (no row lost or doubled)", { skip }, () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "watch-sessions.json");
    const seed = Array.from({ length: 3000 }, (_, i) => session(i));
    write(file, seed);
    const before = fs.readFileSync(file, "utf8");
    const r = child(dir, "watch-sessions.json", "sq._internals.hooks.row = (i) => { if (i === 1500) kill(); };");
    assert.ok(!/ALIVE/.test(r.stdout), "it died mid-migration");
    assert.equal(fs.readFileSync(file, "utf8"), before, "the JSON file is untouched");
    const again = child(dir, "watch-sessions.json", "");
    assert.match(again.stdout, /ALIVE sqlite 3000/, again.stderr);
    sq.closeAll();
    const s = open(file, []);
    assert.equal(s.backend, "sqlite");
    same(s.data, seed);
    assert.equal(s._sql.rows(), 3000, "3,000 rows, not 4,500");
    forget(s);
  } finally {
    rm(dir);
  }
});

test("a kill after the commit, before the JSON file is renamed: the next start only finishes the rename", { skip }, () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "watch-sessions.json");
    const seed = Array.from({ length: 500 }, (_, i) => session(i));
    write(file, seed);
    const r = child(dir, "watch-sessions.json", "sq._internals.hooks.beforeRename = () => kill();");
    assert.ok(!/ALIVE/.test(r.stdout));
    assert.ok(fs.existsSync(file), "the JSON file is still there");
    let s;
    const lines = quiet(() => { s = new JsonStore(file, []); });
    assert.equal(s.backend, "sqlite");
    same(s.data, seed);
    assert.ok(!fs.existsSync(file), "renamed now");
    assert.ok(!lines.some((l) => /imported|conflict|moved into/.test(l)), `not imported again: ${lines.join(" | ")}`);
    assert.equal(s._sql.rows(), 500);
    forget(s);
  } finally {
    rm(dir);
  }
});

test("killed at random moments while it migrates and writes, five times: every start whole, nothing lost or doubled", { skip, timeout: 180000 }, async () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "watch-sessions.json");
    write(file, Array.from({ length: 6000 }, (_, i) => session(i)));
    // each run: load (migrating the first time), then add a session and flush, forever
    const script = `
      const { JsonStore } = require(${JSON.stringify(JSONSTORE)});
      const s = new JsonStore(${JSON.stringify(file)}, []);
      let n = 0;
      process.stdout.write("UP " + s.data.length + " " + s.data.filter((x) => x.id.startsWith("live")).length + "\\n");
      setInterval(() => { s.data.unshift({ id: "live" + Date.now() + "-" + n++, content: { title: "x" } }); s.flush(); process.stdout.write("W " + s.data.length + "\\n"); }, 5);
    `;
    let lastWritten = null;
    for (let round = 0; round < 5; round++) {
      const p = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      p.stdout.on("data", (b) => { out += b; });
      await new Promise((res) => setTimeout(res, 300 + Math.floor(Math.random() * 900)));
      p.kill("SIGKILL");
      await new Promise((res) => p.on("exit", res));
      const up = /UP (\d+) (\d+)/.exec(out);
      if (up && lastWritten !== null) assert.ok(Number(up[1]) >= lastWritten, `round ${round}: started with ${up[1]}, at least the ${lastWritten} last flushed`);
      const ws = [...out.matchAll(/W (\d+)/g)].map((m) => Number(m[1]));
      if (ws.length) lastWritten = ws[ws.length - 1];
    }
    sq.closeAll();
    const s = open(file, []);
    assert.equal(s.backend, "sqlite");
    const ids = s.data.map((x) => x.id);
    assert.equal(new Set(ids).size, ids.length, "no session twice");
    assert.ok(ids.filter((x) => /^s\d+$/.test(x)).length === 6000, "all 6,000 original sessions");
    if (lastWritten !== null) assert.ok(s.data.length >= lastWritten, `at least the ${lastWritten} last flushed`);
    forget(s);
  } finally {
    rm(dir);
  }
});

// ------------------------------------------------------------ damaged input

test("a damaged JSON file at the switch: recovered from its last-good copy first (as always), then moved; the damaged file is kept", { skip }, () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "watch-history.json");
    const good = SEEDS["watch-history.json"]();
    fs.writeFileSync(`${file}.good1`, JSON.stringify(good));
    fs.writeFileSync(file, '[{"id":"h1", "trunc');
    let s;
    const lines = quiet(() => { s = new JsonStore(file, []); });
    assert.ok(lines.some((l) => /^Corrupt store .+ RESTORED from its last good copy/.test(l)), "said the way the healer reads it");
    assert.equal(s.backend, "sqlite");
    same(s.data, good, "the good copy, not an empty list");
    assert.ok(files(dir).some((n) => /\.corrupt-\d+$/.test(n)), "the damaged file is kept");
    assert.ok(s.recovered && s.recovered.source === "last-good");
    s = reopen(s, []);
    same(s.data, good);
    forget(s);
  } finally {
    rm(dir);
  }
});

test("damaged with nothing good anywhere: started from defaults and recorded (a non-critical store) — never silently; profiles.json is never in SQLite", { skip }, () => {
  assert.ok(!js.SQLITE_STORES.has("profiles.json") && !js.SQLITE_STORES.has("sessions.json") && !js.SQLITE_STORES.has("settings.json"), "the critical stores stay JSON files with their safe mode");
  const dir = tmp();
  try {
    const file = path.join(dir, "requests.json");
    fs.writeFileSync(file, "{not json");
    let s;
    const lines = quiet(() => { s = new JsonStore(file, [], { backupLookup: () => null }); });
    assert.ok(lines.some((l) => /^Corrupt store .+ starting from defaults/.test(l)));
    assert.ok(files(dir).some((n) => /\.corrupt-\d+$/.test(n)), "kept");
    assert.ok(I.readRecoveries(dir).some((r) => r.store === "requests.json"), "recorded for the admin page");
    forget(s);
  } finally {
    rm(dir);
  }
});

test("a damaged database: set aside whole (never written over), each store recovered from its last-good copy, nothing silent", { skip }, () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "downloads.json");
    const seed = SEEDS["downloads.json"]();
    write(file, seed);
    let s = open(file, []);
    assert.equal(s.backend, "sqlite");
    s.data[0].status = "done";
    s.flush();
    const expect = JSON.parse(JSON.stringify(s.data));
    fs.writeFileSync(`${file}.good1`, JSON.stringify(expect)); // (as the ten-minute copy would be)
    forget(s);
    sq.closeAll();
    const db = path.join(dir, sq.DB_NAME);
    const buf = fs.readFileSync(db);
    buf.fill(0x41, 0, 100); // the header gone
    fs.writeFileSync(db, buf);
    let lines;
    lines = quiet(() => { s = new JsonStore(file, []); });
    assert.ok(lines.some((l) => /^Corrupt store .+aurora\.db/.test(l)), lines.join("\n"));
    assert.ok(files(dir).some((n) => /^aurora\.db\.corrupt-\d+$/.test(n)), "the damaged database is kept");
    assert.equal(s.backend, "sqlite", "a new database");
    same(s.data, expect, "recovered, not empty");
    assert.ok(s.recovered && /damaged/.test(s.recovered.problem) && s.recovered.source === "last-good");
    forget(s);
  } finally {
    rm(dir);
  }
});

test("a damaged row: the rows are written out raw, the store recovered from its last-good copy and rewritten", { skip }, () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "intro-auto.json");
    const seed = SEEDS["intro-auto.json"]();
    write(file, seed);
    let s = open(file, {});
    fs.writeFileSync(`${file}.good1`, JSON.stringify(seed));
    forget(s);
    sq.closeAll();
    const { DatabaseSync } = sq.loadEngine();
    const raw = new DatabaseSync(path.join(dir, sq.DB_NAME));
    raw.prepare("UPDATE rows SET v = '{broken' WHERE store = ? AND k = ?").run("intro-auto.json", "ep2");
    raw.close();
    const lines = quiet(() => { s = new JsonStore(file, {}); });
    assert.ok(lines.some((l) => /^Corrupt store .+ RESTORED from its last good copy/.test(l)), lines.join("\n"));
    same(s.data, seed);
    assert.ok(files(dir).some((n) => /^intro-auto\.json\.corrupt-\d+$/.test(n)), "the raw rows are kept");
    s = reopen(s, {});
    same(s.data, seed, "and the database is whole again");
    forget(s);
  } finally {
    rm(dir);
  }
});

// ------------------------------------------------------------ more than one writer

test("concurrent writes: many stores in one database interleaved, a second connection writing, a reader exporting meanwhile — all whole", { skip }, async () => {
  const dir = tmp();
  try {
    const names = ["watch-sessions.json", "telemetry-hours.json", "downloads.json", "healer.json", "auth-log.json"];
    const stores = names.map((n) => { write(path.join(dir, n), SEEDS[n]()); return open(path.join(dir, n), Array.isArray(SEEDS[n]()) ? [] : {}); });
    // another connection on the same file (a tool, the backup's copy) writing its own table
    const { DatabaseSync } = sq.loadEngine();
    const other = new DatabaseSync(path.join(dir, sq.DB_NAME));
    other.exec("PRAGMA busy_timeout = 2000; CREATE TABLE IF NOT EXISTS scratch (n INTEGER)");
    for (let i = 0; i < 200; i++) {
      for (const s of stores) { MUTATE[s.name](s.data); s.save(); }
      if (i % 3 === 0) other.prepare("INSERT INTO scratch VALUES (?)").run(i);
      if (i % 50 === 0) {
        const snap = await sq.snapshotTo(dir);
        const got = sq.exportFromFile(snap);
        for (const s of stores) assert.ok(got[s.name], `${s.name} in the copy`);
        for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(snap + ext); } catch {} }
      }
      if (i % 7 === 0) for (const s of stores) s.flush();
    }
    other.close();
    for (const s of stores) s.flush();
    const expect = stores.map((s) => JSON.stringify(s.data));
    stores.forEach(forget);
    sq.closeAll();
    names.forEach((n, i) => {
      const s = open(path.join(dir, n), Array.isArray(SEEDS[n]()) ? [] : {});
      assert.equal(JSON.stringify(s.data), expect[i], n);
      forget(s);
    });
  } finally {
    rm(dir);
  }
});

test("two processes writing the same store (no server owns the folder): last writer wins, the rows are always whole", { skip }, () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "watch-history.json");
    write(file, SEEDS["watch-history.json"]());
    const s = open(file, []);
    // a second process: its own connection on the same file
    const db2 = new Q.Db(dir).open();
    const other = new Q.Backend(db2, "watch-history.json");
    const mine = other.load();
    assert.ok(mine.ok);
    mine.data.unshift({ id: "from-the-other-process" });
    mine.data.splice(50, 30);
    assert.equal(other.write(mine.data), "written");
    s.data.unshift({ id: "from-this-process" });
    s.flush();
    assert.equal(s._sql.lastOps.whole, true, "it saw the other write and wrote the store whole");
    s.data[0].count = 5;
    s.flush();
    assert.equal(s._sql.lastOps.whole, false, "and differences again after that");
    const expect = JSON.stringify(s.data);
    db2.close();
    const again = reopen(s, []);
    assert.equal(JSON.stringify(again.data), expect, "exactly the last writer's data, nothing of the other mixed in");
    forget(again);
  } finally {
    rm(dir);
  }
});

test("a process that does not own the folder reads the database but writes nothing — and moves nothing", { skip }, () => {
  const dir = tmp();
  try {
    write(path.join(dir, "requests.json"), SEEDS["requests.json"]());
    write(path.join(dir, "reports.json"), SEEDS["reports.json"]());
    let s = open(path.join(dir, "requests.json"), []);
    assert.equal(s.backend, "sqlite");
    forget(s);
    sq.closeAll();
    // a live server owns the folder (this test's parent process stands in: a live pid)
    fs.writeFileSync(path.join(dir, js.OWNER_FILE), JSON.stringify({ pid: process.ppid || 1, at: new Date().toISOString() }));
    const r = spawnSync(process.execPath, ["-e", `
      const { JsonStore } = require(${JSON.stringify(JSONSTORE)});
      const a = new JsonStore(${JSON.stringify(path.join(dir, "requests.json"))}, []);
      const b = new JsonStore(${JSON.stringify(path.join(dir, "reports.json"))}, { reports: [] });
      const n = a.data.length;
      a.data.push({ id: "foreign" }); a.flush(); b.flush();
      process.stdout.write(JSON.stringify({ a: a.backend, n, b: b.backend, bn: b.data.reports.length }));
    `], { encoding: "utf8", timeout: 30000 });
    const out = JSON.parse(r.stdout);
    assert.equal(out.n, 2, "read from the database");
    assert.equal(out.b, "json", "reports.json is not moved by a process that does not own the folder");
    assert.ok(fs.existsSync(path.join(dir, "reports.json")));
    fs.unlinkSync(path.join(dir, js.OWNER_FILE));
    s = open(path.join(dir, "requests.json"), []);
    assert.equal(s.data.length, 2, "its write was refused");
    forget(s);
  } finally {
    rm(dir);
  }
});

// ------------------------------------------------------------ a JSON file that comes back

test("the way back: the export writes the files an older build reads; coming forward imports them, keeping what SQLite held when it differs", { skip }, () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "watch-sessions.json");
    write(file, SEEDS["watch-sessions.json"]());
    let s = open(file, []);
    MUTATE["watch-sessions.json"](s.data);
    s.flush();
    const inSql = JSON.stringify(s.data);
    forget(s);
    sq.closeAll();
    // the export, the server stopped
    const out = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "sqlite-export.js"), "--data", dir], { encoding: "utf8", timeout: 30000 });
    assert.equal(out.status, 0, out.stderr + out.stdout);
    assert.match(out.stdout, /watch-sessions\.json\s+written: 290 rows/);
    assert.equal(fs.readFileSync(file, "utf8"), inSql, "exactly what SQLite held");
    // an older build: a plain JSON store
    let old = open(file, [], { sqlite: false });
    assert.equal(JSON.stringify(old.data), inSql);
    old.data.unshift({ id: "watched-on-the-old-build" });
    old.flush();
    forget(old);
    // forward again: the newer JSON file is imported
    let lines;
    lines = quiet(() => { s = new JsonStore(file, []); });
    assert.equal(s.backend, "sqlite");
    assert.equal(s.data[0].id, "watched-on-the-old-build");
    assert.ok(lines.some((l) => /imported into SQLite/.test(l)), lines.join("\n"));
    assert.ok(files(dir).some((n) => /^watch-sessions\.json\.sqlite-before-.+\.json$/.test(n)), "what SQLite held is kept (it differs)");
    forget(s);
  } finally {
    rm(dir);
  }
});

test("an export straight back in (nothing changed meanwhile) imports without keeping a copy", { skip }, () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "reports.json");
    write(file, SEEDS["reports.json"]());
    let s = open(file, { reports: [] });
    forget(s);
    sq.closeAll();
    const out = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "sqlite-export.js"), "--data", dir], { encoding: "utf8", timeout: 30000 });
    assert.equal(out.status, 0, out.stderr);
    s = open(file, { reports: [] });
    assert.equal(s.backend, "sqlite");
    assert.ok(!files(dir).some((n) => /sqlite-before/.test(n)));
    same(s.data, SEEDS["reports.json"]());
    forget(s);
  } finally {
    rm(dir);
  }
});

test("a JSON file OLDER than the rows (an old copy put back by hand): SQLite stays the truth, the file is set aside and kept", { skip }, () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "telemetry-hours.json");
    write(file, SEEDS["telemetry-hours.json"]());
    let s = open(file, {});
    s.data.newest = { plays: 1 };
    s.flush();
    const expect = JSON.stringify(s.data);
    forget(s);
    sq.closeAll();
    write(file, { stale: true });
    const old = new Date(Date.now() - 86400e3);
    fs.utimesSync(file, old, old);
    let lines;
    lines = quiet(() => { s = new JsonStore(file, {}); });
    assert.equal(JSON.stringify(s.data), expect);
    assert.ok(lines.some((l) => /older than its SQLite rows/.test(l)));
    assert.ok(files(dir).some((n) => /^telemetry-hours\.json\.conflict-/.test(n)));
    forget(s);
  } finally {
    rm(dir);
  }
});

test("switched off (AURORA_SQLITE=0): each store is handed back to its JSON file at the next start, whole", { skip }, () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "sub-langs.json");
    write(file, SEEDS["sub-langs.json"]());
    let s = open(file, {});
    MUTATE["sub-langs.json"](s.data);
    s.flush();
    const expect = JSON.stringify(s.data);
    forget(s);
    sq.closeAll();
    const r = spawnSync(process.execPath, ["-e", `
      const { JsonStore } = require(${JSON.stringify(JSONSTORE)});
      const s = new JsonStore(${JSON.stringify(file)}, {});
      process.stdout.write(s.backend + " " + JSON.stringify(s.data));
    `], { encoding: "utf8", env: { ...process.env, AURORA_SQLITE: "0" }, timeout: 30000 });
    assert.equal(r.stdout, `json ${expect}`, r.stderr);
    assert.equal(fs.readFileSync(file, "utf8"), expect, "the file holds it");
    s = open(file, {}); // on again: imported, nothing kept twice
    assert.equal(s.backend, "sqlite");
    assert.equal(JSON.stringify(s.data), expect);
    forget(s);
  } finally {
    rm(dir);
  }
});

test("writes that keep failing: unsaved and retried, then the store goes back to its JSON file; the next start imports it", { skip }, () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "uploads.json");
    write(file, SEEDS["uploads.json"]());
    let s = open(file, []);
    const real = s._sql.db.stmts.up;
    s._sql.db.stmts.up = { run: () => { throw Object.assign(new Error("disk I/O error"), { code: "ERR_SQLITE_ERROR" }); } };
    let lines;
    lines = quiet(() => {
      for (let i = 0; i < 3; i++) { s.data[0].parts[0].received = 10 + i; s.flush(); }
    });
    assert.ok(lines.some((l) => /^Failed to save .+uploads\.json:/.test(l)), "the line the healer reads");
    assert.equal(s.backend, "json", "fell back");
    assert.ok(s.unsavedSince);
    quiet(() => s.flush());
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8"))[0].parts[0].received, 12, "the JSON file holds the latest");
    s._sql.db.stmts.up = real;
    const expect = JSON.stringify(s.data);
    s = reopen(s, []);
    assert.equal(s.backend, "sqlite", "back in SQLite");
    assert.equal(JSON.stringify(s.data), expect);
    forget(s);
  } finally {
    rm(dir);
  }
});

test("start empty on purpose (.start-empty) works for a store in SQLite too", { skip }, () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "requests.json");
    write(file, SEEDS["requests.json"]());
    let s = open(file, []);
    forget(s);
    sq.closeAll();
    fs.writeFileSync(`${file}.start-empty`, "");
    s = open(file, []);
    assert.deepEqual(s.data, []);
    assert.ok(!fs.existsSync(`${file}.start-empty`));
    s = reopen(s, []);
    assert.deepEqual(s.data, [], "and it stays empty");
    forget(s);
  } finally {
    rm(dir);
  }
});

// ------------------------------------------------------------ backups

test("a backup holds each SQLite store as data/<name>.json (from one consistent copy) and the copy itself; the drill and the boot's restore read them", { skip }, async () => {
  const backup = require("../src/lib/backup");
  const dir = tmp();
  const bdir = tmp();
  try {
    write(path.join(dir, "profiles.json"), { profiles: [{ id: "a", name: "Ann" }], state: {} });
    const names = ["watch-sessions.json", "healer.json", "reports.json"];
    const stores = names.map((n) => { write(path.join(dir, n), SEEDS[n]()); return open(path.join(dir, n), Array.isArray(SEEDS[n]()) ? [] : {}); });
    for (const s of stores) { MUTATE[s.name](s.data); s.flush(); }
    const snap = await backup.createSnapshot({ dataDir: dir, backupDir: bdir });
    assert.deepEqual(snap.warnings, []);
    const names2 = snap.manifest.files.map((f) => f.path);
    for (const n of names) assert.ok(names2.includes(`data/${n}`), `data/${n} in the snapshot`);
    assert.ok(names2.includes("sqlite/aurora.db"));
    const r = await backup.verify(snap.path);
    assert.ok(r.ok, r.error);
    for (const s of stores) {
      const got = backup._internals.copyFromSnapshotsSync(s.name, [bdir]);
      assert.equal(got.text, JSON.stringify(s.data), `${s.name}: the boot's "restore from the newest backup" gets exactly it`);
    }
    const drill = await backup.drill({ backupDirs: [bdir] });
    assert.ok(drill.ok, drill.error);
    stores.forEach(forget);
  } finally {
    rm(dir);
    rm(bdir);
  }
});

test("status: which stores are in SQLite, their rows, the database", { skip }, () => {
  const dir = tmp();
  try {
    write(path.join(dir, "watch-history.json"), SEEDS["watch-history.json"]());
    const s = open(path.join(dir, "watch-history.json"), []);
    const st = js.status();
    const me = st.stores.find((x) => x.name === "watch-history.json" && x.backend === "sqlite");
    assert.ok(me && me.rows === 120 && me.bytes > 0);
    const db = st.sqlite.databases.find((d) => path.dirname(d.file) === path.resolve(dir));
    assert.ok(db && db.stores.some((x) => x.name === "watch-history.json" && x.rows === 120));
    assert.match(st.sqlite.engine, /node:sqlite/);
    forget(s);
  } finally {
    rm(dir);
  }
});
