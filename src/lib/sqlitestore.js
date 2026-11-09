// SQLite under the JSON stores (lib/jsonstore.js): the stores that grow, or
// are rewritten while people watch, keep their rows in one database file per
// data folder (<folder>/aurora.db) instead of one JSON file each. Callers see
// no difference: a store is still `store.data` in memory, `save()`, `flush()`.
// Only what changed since the last write goes to the disk.
//
// WHICH STORES. jsonstore.js SQLITE_STORES, by file name (like CRITICAL).
// Everything else stays a JSON file.
//
// THE ENGINE. Node's built-in `node:sqlite` (Node 22.13+, no flag). Without
// it (an older Node, or switched off: "sqlite": false in config.json, or
// AURORA_SQLITE=0) every store is a JSON file, exactly as before.
// Settings: WAL, synchronous=NORMAL (a commit is a write into the WAL, no
// fsync; a power cut can lose the last seconds, never the file's integrity),
// a busy timeout, and an explicit schema_version table.
//
// ROWS. A store's data is split into rows by its layout (LAYOUTS below):
//   ""          the top level is the collection (an array, or a map by key)
//   ["a", "b"]  data.a and data.b are collections; the rest is one "head" row
// A map row is keyed by its key. An array row is keyed by the identity of its
// element (a WeakMap: the same object keeps its key while the array is
// unshifted, spliced, filtered or trimmed), so a new viewing session at the
// front of 8,000 is ONE insert, not 8,000 rewrites. An array that holds
// anything but objects is keyed by index. Order is kept exactly (a `pos`
// column; see positions()). After every write, rebuilding the rows gives
// exactly JSON.parse(JSON.stringify(store.data)).
//
// WRITES. On the event loop, one transaction per store write (the store's
// debounce batches the changes): no fsync, typically well under a
// millisecond. The WAL is checkpointed (the part that does fsync) by a
// worker thread with its own connection, every few seconds while something
// changed, so a slow disk never holds the loop. Reads never touch SQLite:
// the store is in memory; it is read once at boot.
//
// THE SWITCH (once per store, on the first start of a build that has this):
//   1. the store is loaded from its JSON file exactly as before — with every
//      recovery (last-good copy, backup, safe mode) that implies;
//   2. inside ONE transaction its rows are written, read back, rebuilt and
//      compared: row count, and the md5 of the content both ways. Only if
//      they match is the transaction committed;
//   3. then the JSON file is renamed <name>.migrated-<date>-<time> (kept,
//      never deleted).
// If any step fails the store stays a JSON file, as before, and says so in
// the log. A kill at any moment is safe: before the commit nothing happened;
// after it, the next start finds the JSON file it was made from (same md5)
// and only finishes the rename.
//
// A JSON FILE THAT COMES BACK. When a store is in SQLite and its JSON file
// appears again (an export for a downgrade, an older build ran, a backup was
// restored, the SQLite write failed and the store fell back to JSON):
//   - written AFTER the last SQLite write: it is the newer truth, and is
//     imported (the same verified transaction); the SQLite content it
//     replaces is kept as <name>.sqlite-before-<time>.json when it differs;
//   - older than the last SQLite write: SQLite stays the truth and the file is
//     set aside as <name>.conflict-<time> (kept), said in the log.
//
// GOING BACK. `node scripts/sqlite-export.js` (server stopped) writes every
// SQLite store back as its JSON file; any older build then reads them. Or set
// "sqlite": false in config.json: the next start hands every store back to
// its JSON file by itself. Turning it on again imports them again.
//
// BACKUPS (lib/backup.js). A snapshot holds, for every store in SQLite, its
// content as data/<name>.json (exactly what the file would have held), taken
// from ONE consistent `VACUUM INTO` copy of the database, plus that copy as
// sqlite/aurora.db. So the drill, the restore, and the boot's "restore a
// damaged store from the newest backup" work unchanged.
//
// LAST-GOOD COPIES. Stores in SQLite keep their <name>.good1 / .good2 JSON
// copies (at most every ten minutes, written off the loop), which serve the
// boot's recovery if the database is ever damaged — and an older build
// started without the export (it restores from .good1, at most ten minutes
// behind, and says so).
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const DB_NAME = "aurora.db";
const SCHEMA_VERSION = 1;
const BUSY_TIMEOUT_MS = 2000; // a writer waits at most this for another connection
const CHECKPOINT_EVERY_MS = 5000; // while something changed
const WAL_LIMIT_BYTES = 64 * 1024 * 1024; // the WAL is truncated after a checkpoint beyond this
const FALLBACK_AFTER_FAILURES = 3; // consecutive failed SQLite writes before a store goes back to JSON
const OPEN_TRIES = 20; // x 100 ms: a database locked for a moment is not damaged
const DAMAGE = /not a database|malformed|corrupt|SQLITE_CORRUPT|SQLITE_NOTADB/i;
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };

// How each store is split into rows. A store not listed here splits at the
// top level ("" : the array or map itself).
const LAYOUTS = {
  "reports.json": ["reports"],
  "auth-log.json": ["events"],
  "replacements.json": ["list"],
  "healer.json": ["fingerprints", "errHours", "days", "repairs", "repairLog", "growth", "notes", "declinedSeen"],
};
const layoutFor = (name) => LAYOUTS[String(name).toLowerCase()] || [""];
// Test seams: called inside a migration after each row, and between its
// commit and the rename of the JSON file (the crash tests kill the process there).
const hooks = { row: null, beforeRename: null };

const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const md5 = (text) => crypto.createHash("md5").update(text).digest("hex");
const stamp = (ms = Date.now()) => new Date(ms).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15); // 20261109-121700
const mtimeOf = (file) => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };
// own property, even "__proto__"
const put = (o, k, v) => {
  if (k === "__proto__") Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  else o[k] = v;
};

// ------------------------------------------------------------- the engine
let engine; // undefined: not tried; null: not available
let engineProblem = null;
const switchedOff = () => {
  if (/^(0|false|off|no)$/i.test(String(process.env.AURORA_SQLITE || "").trim())) return "AURORA_SQLITE=0";
  try {
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "config.json"), "utf8"));
    if (c && c.sqlite === false) return "\"sqlite\": false in config.json";
  } catch {}
  return null;
};
// node:sqlite says "ExperimentalWarning: SQLite is an experimental feature"
// once per process: not something the owner can act on, so not printed.
const quietRequire = () => {
  const emit = process.emitWarning;
  process.emitWarning = function (w, ...rest) {
    const msg = typeof w === "string" ? w : w && w.message;
    if (/SQLite is an experimental feature/i.test(String(msg || ""))) return;
    return emit.call(this, w, ...rest);
  };
  try { return require("node:sqlite"); } finally { process.emitWarning = emit; }
};
const loadEngine = () => {
  if (engine !== undefined) return engine;
  engine = null;
  try {
    const m = quietRequire();
    if (!m || typeof m.DatabaseSync !== "function") throw new Error("no DatabaseSync");
    engine = m;
  } catch (e) {
    engineProblem = `node:sqlite is not available in Node ${process.versions.node} (${(e && e.message) || e})`;
  }
  return engine;
};
let sqliteVersion = null;

// ------------------------------------------------------------- the codec
// Pure functions: data <-> { head, rows }. `state` carries what the last
// write left on disk, so a write can be just the difference:
//   { ids: Map(coll -> WeakMap(obj -> key)), rows: Map(coll -> Map(key -> { v: json, pos })),
//     head, nextKey, count, bytes }
const ck = (coll, k) => `${coll}\u0001${k}`;
const newState = () => ({ ids: new Map(), rows: new Map(), head: null, nextKey: 1, count: 0, bytes: 0 });

// Positions that keep the order exactly while moving as few rows as
// possible: rows whose old position still fits the order keep it; the
// others (new, or moved) get a position between their neighbours. Prepending
// to the front, appending, deleting, trimming and moving one row each touch
// only those rows. Returns { pos: number[], renumbered }.
const positions = (known) => {
  const n = known.length;
  const keep = new Array(n).fill(false);
  let prev = -Infinity;
  for (let i = 0; i < n; i++) if (known[i] !== undefined && known[i] > prev) { keep[i] = true; prev = known[i]; }
  const pos = new Array(n);
  let i = 0;
  let left = -Infinity;
  while (i < n) {
    if (keep[i]) { pos[i] = known[i]; left = known[i]; i++; continue; }
    let j = i;
    while (j < n && !keep[j]) j++;
    const count = j - i;
    const right = j < n ? known[j] : Infinity;
    for (let t = 0; t < count; t++) {
      let p;
      if (left === -Infinity && right === Infinity) p = t + 1;
      else if (right === Infinity) p = left + t + 1;
      else if (left === -Infinity) p = right - count + t;
      else p = left + ((right - left) * (t + 1)) / (count + 1);
      pos[i + t] = p;
    }
    if (left !== -Infinity && right !== Infinity && (right - left) / (count + 1) < 1e-7 * Math.max(1, Math.abs(left), Math.abs(right))) {
      return { pos: known.map((_, x) => x + 1), renumbered: true };
    }
    i = j;
  }
  return { pos, renumbered: false };
};

// What `data` is as rows, against `state`: { head, nextKey, count, ops, changed }
// with ops = { up: [{ coll, k, pos, v }], move: [{ coll, k, pos }], del: [{ coll, k }], headChanged }.
// `fresh`: as a whole new copy (migration, import): every row is in `up`.
// Nothing in `state` changes here except the identity keys of new elements.
const plan = (data, colls, state, { fresh = false } = {}) => {
  const kinds = {};
  let headObj = null;
  let order = null;
  if (colls.length === 1 && colls[0] === "") {
    kinds[""] = Array.isArray(data) ? "array" : isObject(data) ? "object" : "none";
    if (kinds[""] === "none") headObj = data === undefined ? null : data;
  } else {
    headObj = {};
    order = [];
    if (isObject(data)) {
      for (const k of Object.keys(data)) {
        if (JSON.stringify(data[k]) === undefined) continue; // as JSON would leave it out
        order.push(k);
        if (colls.includes(k) && (Array.isArray(data[k]) || isObject(data[k]))) kinds[k] = Array.isArray(data[k]) ? "array" : "object";
        else put(headObj, k, data[k]);
      }
    } else {
      headObj = data === undefined ? null : data;
      order = null;
    }
  }
  let nextKey = state.nextKey;
  let count = 0;
  const up = [];
  const move = [];
  const del = [];
  const live = new Set(Object.keys(kinds).filter((c) => kinds[c] !== "none"));
  for (const coll of live) {
    const val = coll === "" ? data : data[coll];
    const old = fresh ? null : state.rows.get(coll) || null;
    const keys = [];
    const vals = [];
    if (Array.isArray(val)) {
      if (val.every((el) => el !== null && typeof el === "object")) {
        let wm = state.ids.get(coll);
        if (!wm) { wm = new WeakMap(); state.ids.set(coll, wm); }
        const seen = new Set();
        for (const el of val) {
          let k = wm.get(el);
          if (k === undefined || seen.has(el)) {
            k = String(nextKey++);
            if (!seen.has(el)) wm.set(el, k);
          }
          seen.add(el);
          keys.push(k);
          vals.push(JSON.stringify(el));
        }
      } else {
        for (let i = 0; i < val.length; i++) {
          const v = JSON.stringify(val[i]);
          keys.push(`#${i}`);
          vals.push(v === undefined ? "null" : v);
        }
      }
    } else {
      for (const k of Object.keys(val)) {
        const v = JSON.stringify(val[k]);
        if (v === undefined) continue;
        keys.push(k);
        vals.push(v);
      }
    }
    const n = keys.length;
    count += n;
    const known = new Array(n);
    const entries = new Array(n);
    let hits = 0;
    if (old) for (let i = 0; i < n; i++) { const e = old.get(keys[i]); entries[i] = e; if (e) { known[i] = e.pos; hits++; } }
    const { pos } = positions(known);
    for (let i = 0; i < n; i++) {
      const e = entries[i];
      if (!e || e.v !== vals[i]) up.push({ coll, k: keys[i], pos: pos[i], v: vals[i] });
      else if (e.pos !== pos[i]) move.push({ coll, k: keys[i], pos: pos[i] });
    }
    if (old && hits < old.size) {
      const here = new Set(keys);
      for (const k of old.keys()) if (!here.has(k)) del.push({ coll, k });
    }
  }
  // a collection that is gone (or no longer an array or a map): all its rows
  if (!fresh) for (const [coll, old] of state.rows) if (!live.has(coll)) for (const k of old.keys()) del.push({ coll, k });
  const head = JSON.stringify({ v: 1, kinds, order, h: headObj });
  const headChanged = fresh || head !== state.head;
  return { head, nextKey, count, ops: { up, move, del, headChanged }, changed: headChanged || up.length > 0 || move.length > 0 || del.length > 0 };
};

// `state` once a plan has been written (`fresh`: it replaced everything).
const applied = (state, p, { fresh = false } = {}) => {
  if (fresh) { state.rows = new Map(); state.bytes = 0; state.head = null; }
  const mapOf = (coll) => { let m = state.rows.get(coll); if (!m) { m = new Map(); state.rows.set(coll, m); } return m; };
  let bytes = state.bytes - (state.head ? state.head.length : 0) + p.head.length;
  for (const r of p.ops.up) {
    const m = mapOf(r.coll);
    const e = m.get(r.k);
    if (e) { bytes += r.v.length - e.v.length; e.v = r.v; e.pos = r.pos; } else { bytes += r.v.length; m.set(r.k, { v: r.v, pos: r.pos }); }
  }
  for (const r of p.ops.move) { const e = mapOf(r.coll).get(r.k); if (e) e.pos = r.pos; }
  for (const r of p.ops.del) {
    const m = state.rows.get(r.coll);
    const e = m && m.get(r.k);
    if (e) { bytes -= e.v.length; m.delete(r.k); if (!m.size) state.rows.delete(r.coll); }
  }
  state.head = p.head;
  state.nextKey = p.nextKey;
  state.count = p.count;
  state.bytes = bytes;
};

// rows (in coll, pos order; v already parsed as `val`) + head -> data.
// With `state`, array elements are registered for identity on the way.
const rebuild = (headText, rows, state = null) => {
  const head = JSON.parse(headText);
  if (!head || head.v !== 1 || !isObject(head.kinds)) throw new Error("an unknown head row");
  const colls = {};
  for (const [coll, kind] of Object.entries(head.kinds)) if (kind === "array") colls[coll] = []; else if (kind === "object") colls[coll] = {};
  for (const r of rows) {
    const c = colls[r.coll];
    if (c === undefined) throw new Error(`a row of an unknown collection (${r.coll || "top"})`);
    if (Array.isArray(c)) {
      c.push(r.val);
      if (state && !r.k.startsWith("#") && r.val !== null && typeof r.val === "object") {
        let wm = state.ids.get(r.coll);
        if (!wm) { wm = new WeakMap(); state.ids.set(r.coll, wm); }
        wm.set(r.val, r.k);
      }
    } else put(c, r.k, r.val);
  }
  if ("" in head.kinds) return head.kinds[""] === "none" ? head.h : colls[""];
  if (!Array.isArray(head.order)) return head.h;
  const out = {};
  for (const k of head.order) put(out, k, k in colls && Object.prototype.hasOwnProperty.call(colls, k) ? colls[k] : head.h[k]);
  return out;
};

// ------------------------------------------------------------- one database
const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL, applied_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS stores (
  name TEXT PRIMARY KEY,
  head TEXT NOT NULL,
  next_key INTEGER NOT NULL,
  rows INTEGER NOT NULL,
  migrated_at INTEGER NOT NULL,
  migrated_from TEXT,
  source_md5 TEXT,
  content_md5 TEXT,
  updated_at INTEGER NOT NULL,
  writes INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS rows (
  store TEXT NOT NULL,
  coll TEXT NOT NULL,
  k TEXT NOT NULL,
  pos REAL NOT NULL,
  v TEXT NOT NULL,
  PRIMARY KEY (store, coll, k)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS rows_order ON rows (store, coll, pos);
CREATE TABLE IF NOT EXISTS events (at INTEGER NOT NULL, store TEXT, what TEXT NOT NULL, detail TEXT);
`;

const dbs = new Map(); // abs dir -> Db

class Db {
  constructor(dir) {
    this.dir = path.resolve(dir);
    this.file = path.join(this.dir, DB_NAME);
    this.db = null;
    this.problem = null; // why it cannot be used
    this.damaged = null; // it was damaged at open and set aside: { problem, keptAs }
    this.readOnly = false;
    this.dirty = false;
    this.worker = null;
    this.workerFailed = false;
    this.timer = null;
    this.seq = 0;
    this.waiting = new Map();
    this.stmts = {};
  }

  // `create`: may create the file. Returns this when usable.
  open({ create = true, readOnly = false } = {}) {
    if (this.db) return this;
    const sqlite = loadEngine();
    if (!sqlite) { this.problem = engineProblem; return null; }
    const existed = fs.existsSync(this.file);
    if (!existed && !create) { this.problem = "no database yet"; return null; }
    try {
      // Damage (not a database, malformed, a failed quick_check) is set
      // aside; anything else — locked for a moment by a scanner, say — is
      // asked again for up to two seconds and is never taken for damage.
      let bad = null;
      for (let i = 0; ; i++) {
        try {
          this._connect(sqlite, readOnly);
          bad = existed ? this._check() : null;
          break;
        } catch (e) {
          try { if (this.db) this.db.close(); } catch {}
          this.db = null;
          const msg = (e && e.message) || String(e);
          if (DAMAGE.test(msg)) { bad = msg; break; }
          if (i >= OPEN_TRIES - 1) throw e;
          sleepSync(100);
        }
      }
      if (bad) {
        if (readOnly) throw new Error(`the database is damaged (${bad})`);
        this._setAside(bad);
        this._connect(sqlite, readOnly);
      }
      if (!readOnly) this._schema();
      const v = this._version();
      if (v > SCHEMA_VERSION) {
        this.readOnly = true;
        throw new Error(`the database was made by a newer Aurora (schema ${v}, this one knows ${SCHEMA_VERSION}) — run that version's scripts/sqlite-export.js before going back`);
      }
      this._prepare();
      if (!sqliteVersion) { try { sqliteVersion = this.db.prepare("SELECT sqlite_version() AS v").get().v; } catch {} }
      return this;
    } catch (e) {
      this.problem = (e && e.message) || String(e);
      try { if (this.db) this.db.close(); } catch {}
      this.db = null;
      return null;
    }
  }

  _connect(sqlite, readOnly) {
    this.db = new sqlite.DatabaseSync(this.file);
    this.readOnly = !!readOnly;
    this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    if (!readOnly) {
      const mode = this.db.prepare("PRAGMA journal_mode = WAL").get();
      if (!mode || String(Object.values(mode)[0]).toLowerCase() !== "wal") throw new Error(`WAL is not possible here (journal mode ${mode && Object.values(mode)[0]}) — a network folder?`);
      this.db.exec("PRAGMA synchronous = NORMAL");
      // checkpoints are the worker's (below); on the loop only if it cannot run
      this.db.exec("PRAGMA wal_autocheckpoint = 0");
    } else {
      this.db.exec("PRAGMA query_only = 1");
    }
  }

  // null when fine, or what is wrong
  _check() {
    try {
      const r = this.db.prepare("PRAGMA quick_check").all();
      const words = r.map((x) => String(Object.values(x)[0]));
      return words.length === 1 && words[0] === "ok" ? null : words.slice(0, 3).join("; ");
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (DAMAGE.test(msg)) return msg;
      throw e; // not damage (locked, busy): asked again
    }
  }

  // A damaged database is never written over: it is moved aside, with its
  // WAL, and a new one is started. The stores it held come back through the
  // boot's recovery (last-good copies, the newest backup).
  _setAside(problem) {
    try { this.db.close(); } catch {}
    this.db = null;
    const keptAs = `${this.file}.corrupt-${Date.now()}`;
    for (const ext of ["", "-wal", "-shm"]) { try { fs.renameSync(this.file + ext, keptAs + ext); } catch {} }
    this.damaged = { problem, keptAs: path.basename(keptAs) };
    console.error(`Corrupt store ${this.file} — backed up to ${keptAs} (${problem}); a new database is started and each store in it is recovered on its own`);
  }

  _schema() {
    this.db.exec(SCHEMA);
    const n = this.db.prepare("SELECT COUNT(*) AS n FROM schema_version").get().n;
    if (!n) this.db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(SCHEMA_VERSION, Date.now());
  }

  _version() {
    try { return this.db.prepare("SELECT MAX(version) AS v FROM schema_version").get().v || 0; } catch { return 0; }
  }

  _prepare() {
    const d = this.db;
    this.stmts = {
      reg: d.prepare("SELECT * FROM stores WHERE name = ?"),
      regs: d.prepare("SELECT name, rows, migrated_at, migrated_from, updated_at, writes FROM stores ORDER BY name"),
      rows: d.prepare("SELECT coll, k, pos, v FROM rows WHERE store = ? ORDER BY coll, pos"),
      count: d.prepare("SELECT COUNT(*) AS n FROM rows WHERE store = ?"),
    };
    if (this.readOnly) return;
    Object.assign(this.stmts, {
      up: d.prepare("INSERT INTO rows (store, coll, k, pos, v) VALUES (?, ?, ?, ?, ?) ON CONFLICT (store, coll, k) DO UPDATE SET pos = excluded.pos, v = excluded.v"),
      move: d.prepare("UPDATE rows SET pos = ? WHERE store = ? AND coll = ? AND k = ?"),
      del: d.prepare("DELETE FROM rows WHERE store = ? AND coll = ? AND k = ?"),
      clear: d.prepare("DELETE FROM rows WHERE store = ?"),
      head: d.prepare("UPDATE stores SET head = ?, next_key = ?, rows = ?, updated_at = ?, writes = writes + 1 WHERE name = ?"),
      register: d.prepare("INSERT OR REPLACE INTO stores (name, head, next_key, rows, migrated_at, migrated_from, source_md5, content_md5, updated_at, writes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)"),
      event: d.prepare("INSERT INTO events (at, store, what, detail) VALUES (?, ?, ?, ?)"),
    });
  }

  tx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    let r;
    try {
      r = fn();
      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw e;
    }
    this.dirty = true;
    this._schedule();
    return r;
  }

  event(store, what, detail) {
    if (this.readOnly || !this.db) return;
    try { this.stmts.event.run(Date.now(), store, what, detail == null ? null : String(detail).slice(0, 2000)); this.dirty = true; this._schedule(); } catch {}
  }

  registry(name) {
    try { return this.stmts.reg.get(name) || null; } catch { return null; }
  }

  readRows(name) {
    return this.stmts.rows.all(name);
  }

  // ---- checkpoints, off the loop
  _schedule() {
    if (this.timer || this.readOnly) return;
    this.timer = setTimeout(() => { this.timer = null; this.checkpoint(); }, CHECKPOINT_EVERY_MS);
    this.timer.unref?.();
  }

  _startWorker() {
    if (this.worker || this.workerFailed) return this.worker;
    try {
      const { Worker } = require("worker_threads");
      this.worker = new Worker(path.join(__dirname, "sqlitestore-worker.js"), { workerData: { file: this.file, mod: __filename } });
      this.worker.unref();
      this.worker.on("message", (m) => {
        const w = this.waiting.get(m.id);
        if (!w) return;
        this.waiting.delete(m.id);
        if (m.ok) w.res(m); else w.rej(new Error(m.error));
      });
      const down = (why) => {
        if (!this.worker) return;
        this.worker = null;
        this.workerFailed = true;
        for (const w of this.waiting.values()) w.rej(new Error(why));
        this.waiting.clear();
        // checkpoints go back to SQLite's own, on the loop
        try { if (this.db && !this.readOnly) this.db.exec("PRAGMA wal_autocheckpoint = 1000"); } catch {}
      };
      this.worker.on("error", (e) => { console.error(`[sqlite] the checkpoint worker failed (${e && e.message}); SQLite checkpoints on its own from now on`); down("worker failed"); });
      this.worker.on("exit", () => down("worker exited"));
    } catch (e) {
      this.workerFailed = true;
      try { if (this.db && !this.readOnly) this.db.exec("PRAGMA wal_autocheckpoint = 1000"); } catch {}
    }
    return this.worker;
  }

  ask(msg) {
    const w = this._startWorker();
    if (!w) return Promise.reject(new Error("no worker"));
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.waiting.set(id, { res, rej });
      w.postMessage({ ...msg, id });
    });
  }

  checkpoint() {
    if (!this.db || this.readOnly || !this.dirty) return Promise.resolve(false);
    this.dirty = false;
    let walBytes = 0;
    try { walBytes = fs.statSync(`${this.file}-wal`).size; } catch {}
    const mode = walBytes > WAL_LIMIT_BYTES ? "TRUNCATE" : "PASSIVE";
    return this.ask({ op: "checkpoint", mode }).then(() => true, () => {
      // no worker: SQLite's own autocheckpoint has taken over
      return false;
    });
  }

  // At shutdown: everything into the main file, on the loop (the process is
  // ending; nothing is waiting).
  checkpointNow() {
    if (!this.db || this.readOnly) return;
    try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); this.dirty = false; } catch {}
  }

  close() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.worker) { try { this.worker.terminate(); } catch {} this.worker = null; }
    if (this.db) { try { this.db.close(); } catch {} this.db = null; }
  }

  sizes() {
    const s = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
    return { bytes: s(this.file), walBytes: s(`${this.file}-wal`) };
  }
}

const dbFor = (dir, opts) => {
  const abs = path.resolve(dir);
  let d = dbs.get(abs);
  if (d && d.db) return d;
  if (!d) { d = new Db(abs); dbs.set(abs, d); }
  return d.open(opts);
};

// ------------------------------------------------------------- one store
// What lib/jsonstore.js holds for a store kept in SQLite.
class Backend {
  constructor(db, name) {
    this.db = db;
    this.name = name;
    this.colls = layoutFor(name);
    this.state = newState();
    this.failures = 0;
  }

  get file() { return this.db.file; }

  registry() { return this.db.registry(this.name); }

  // What the boot should do. { migrated, json: "none"|"leftover"|"newer"|"older", reg }
  inspect(jsonFile) {
    const reg = this.registry();
    if (!reg) return { migrated: false, json: fs.existsSync(jsonFile) ? "newer" : "none", reg: null };
    if (!fs.existsSync(jsonFile)) return { migrated: true, json: "none", reg };
    let text = null;
    try { text = fs.readFileSync(jsonFile, "utf8"); } catch {}
    if (text !== null && reg.source_md5 && md5(text) === reg.source_md5) return { migrated: true, json: "leftover", reg };
    return { migrated: true, json: mtimeOf(jsonFile) > reg.updated_at ? "newer" : "older", reg };
  }

  // The rows, parsed: { ok, data } or { ok: false, problem }.
  load() {
    const reg = this.registry();
    if (!reg) return { ok: false, problem: "not in the database" };
    let rows;
    try { rows = this.db.readRows(this.name); } catch (e) { return { ok: false, problem: `its rows cannot be read (${e.message})` }; }
    if (rows.length !== reg.rows) return { ok: false, problem: `${reg.rows} rows were written, ${rows.length} are there` };
    for (const r of rows) {
      try { r.val = JSON.parse(r.v); } catch { return { ok: false, problem: `a row is not valid JSON (${r.coll}/${r.k})` }; }
    }
    const state = newState();
    let data;
    try { data = rebuild(reg.head, rows, state); } catch (e) { return { ok: false, problem: e.message }; }
    state.nextKey = reg.next_key;
    state.head = reg.head;
    let bytes = reg.head.length;
    for (const r of rows) {
      let m = state.rows.get(r.coll);
      if (!m) { m = new Map(); state.rows.set(r.coll, m); }
      m.set(r.k, { v: r.v, pos: r.pos });
      bytes += r.v.length;
    }
    state.count = rows.length;
    state.bytes = bytes;
    this.state = state;
    this.reg = reg;
    return { ok: true, data, rows: rows.length };
  }

  // The content as the JSON file would hold it (from the database, not from
  // memory). null when not in the database.
  exportText() {
    const r = new Backend(this.db, this.name).load();
    return r.ok ? JSON.stringify(r.data) : null;
  }

  // The whole store replaced by `data`, verified before it is committed:
  // row count, and the content read back and compared (md5 both ways).
  // `data` must be the object the store will hold (its array elements are
  // registered for identity). Returns { ok, rows, ms } or { ok: false, problem }.
  replaceAll(data, { from = null, sourceText = null } = {}) {
    if (this.db.readOnly) return { ok: false, problem: "the database is read-only here" };
    const t0 = process.hrtime.bigint();
    const text = JSON.stringify(data);
    if (typeof text !== "string") return { ok: false, problem: "nothing serialisable" };
    const want = md5(text);
    const state = newState();
    const p = plan(data, this.colls, state, { fresh: true });
    const rowsIn = p.ops.up;
    const s = this.db.stmts;
    const now = Date.now();
    try {
      this.db.tx(() => {
        s.clear.run(this.name);
        s.register.run(this.name, p.head, p.nextKey, rowsIn.length, now, from, sourceText != null ? md5(sourceText) : null, want, now);
        for (let i = 0; i < rowsIn.length; i++) {
          const r = rowsIn[i];
          s.up.run(this.name, r.coll, r.k, r.pos, r.v);
          if (hooks.row) hooks.row(i, this.name);
        }
        // read back, inside the same transaction
        const n = s.count.get(this.name).n;
        if (n !== rowsIn.length) throw new Error(`${rowsIn.length} rows written, ${n} read back`);
        const back = this.db.readRows(this.name);
        for (const r of back) r.val = JSON.parse(r.v);
        const reg = s.reg.get(this.name);
        const got = md5(JSON.stringify(rebuild(reg.head, back)));
        if (got !== want) throw new Error(`the content read back differs (md5 ${got.slice(0, 8)} instead of ${want.slice(0, 8)})`);
      });
    } catch (e) {
      return { ok: false, problem: (e && e.message) || String(e) };
    }
    applied(state, p, { fresh: true });
    this.state = state;
    this.failures = 0;
    return { ok: true, rows: rowsIn.length, ms: Number(process.hrtime.bigint() - t0) / 1e6, md5: want };
  }

  // One write: only the difference. Returns "written" | "unchanged"; throws
  // when the database refused it (memory is untouched then, and the next
  // write carries the same difference again).
  write(data) {
    const p = plan(data, this.colls, this.state);
    if (!p.changed) return "unchanged";
    const s = this.db.stmts;
    const { up, move, del } = p.ops;
    this.db.tx(() => {
      for (const r of up) s.up.run(this.name, r.coll, r.k, r.pos, r.v);
      for (const r of move) s.move.run(r.pos, this.name, r.coll, r.k);
      for (const r of del) s.del.run(this.name, r.coll, r.k);
      const res = s.head.run(p.head, p.nextKey, p.count, Date.now(), this.name);
      if (!res || res.changes !== 1) throw new Error("the store is not registered in the database");
    });
    applied(this.state, p);
    this.failures = 0;
    this.lastOps = { up: up.length, move: move.length, del: del.length };
    return "written";
  }

  rows() { return this.state.count; }
  bytes() { return this.state.bytes; }
}

// The backend for a store file, or null (with the reason in `why`).
// mode: "use" (normal), "handback" (switched off: only to hand stores back).
const backendFor = (filePath, { foreign = false } = {}) => {
  const off = switchedOff();
  const dir = path.dirname(path.resolve(filePath));
  const name = path.basename(filePath);
  if (off) {
    // switched off: only an existing database is opened, to hand back
    if (!fs.existsSync(path.join(dir, DB_NAME))) return { backend: null, mode: "off", why: `switched off (${off})` };
    const db = dbFor(dir, { create: false, readOnly: foreign });
    if (!db) return { backend: null, mode: "off", why: `switched off (${off})` };
    return { backend: new Backend(db, name), mode: "handback", why: `switched off (${off})` };
  }
  if (!loadEngine()) return { backend: null, mode: "none", why: engineProblem };
  // a process that does not own the folder only reads, and never creates
  const db = dbFor(dir, { create: !foreign, readOnly: foreign });
  if (!db) {
    const d = dbs.get(dir);
    const why = (d && d.problem) || "the database cannot be opened";
    return { backend: null, mode: "none", why: foreign && why === "no database yet" ? null : why };
  }
  return { backend: new Backend(db, name), mode: "use", why: null };
};

// ------------------------------------------------------------- exports
// Every store a database file holds, as the JSON its file would hold:
// { name: { text, rows, updatedAt } }. Read in one transaction.
const exportFromFile = (file) => {
  const sqlite = loadEngine();
  if (!sqlite) throw new Error(engineProblem);
  const db = new sqlite.DatabaseSync(file);
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec("BEGIN");
    const out = {};
    try {
      const regs = db.prepare("SELECT name, head, rows, updated_at FROM stores").all();
      const rowsOf = db.prepare("SELECT coll, k, pos, v FROM rows WHERE store = ? ORDER BY coll, pos");
      for (const reg of regs) {
        const rows = rowsOf.all(reg.name);
        if (rows.length !== reg.rows) throw new Error(`${reg.name}: ${reg.rows} rows were written, ${rows.length} are there`);
        for (const r of rows) r.val = JSON.parse(r.v);
        out[reg.name] = { text: JSON.stringify(rebuild(reg.head, rows)), rows: rows.length, updatedAt: reg.updated_at };
      }
    } finally {
      try { db.exec("COMMIT"); } catch {}
    }
    return out;
  } finally {
    db.close();
  }
};

let snapSeq = 0;
// A consistent copy of `dir`'s database (VACUUM INTO): through the worker
// when this process has the database open (off the loop), else directly.
// Resolves the copy's path (a temp file the caller removes).
const snapshotTo = async (dir, to) => {
  const abs = path.resolve(dir);
  const file = path.join(abs, DB_NAME);
  if (!fs.existsSync(file)) return null;
  const target = to || path.join(os.tmpdir(), `aurora-db-snapshot-${process.pid}-${Date.now()}-${++snapSeq}.db`);
  try { fs.unlinkSync(target); } catch {}
  const d = dbs.get(abs);
  if (d && d.db && !d.readOnly) {
    try { await d.ask({ op: "vacuumInto", to: target }); return target; } catch {}
  }
  const sqlite = loadEngine();
  if (!sqlite) throw new Error(engineProblem);
  const db = new sqlite.DatabaseSync(file);
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.prepare("VACUUM INTO ?").run(target);
  } finally {
    db.close();
  }
  return target;
};

// For lib/backup.js: what a snapshot of `dataDir` holds for the stores in
// SQLite. [{ as, data: Buffer, mtime }] — data/<name>.json for every store
// whose truth is the database (a JSON file beside it that is newer is the
// truth instead: backup.js copies that file as it is), and the database
// copy itself as sqlite/aurora.db. Empty when there is no database.
const backupEntries = async (dataDir) => {
  const abs = path.resolve(dataDir);
  if (!fs.existsSync(path.join(abs, DB_NAME)) || !loadEngine()) return [];
  const snap = await snapshotTo(abs);
  if (!snap) return [];
  try {
    const d = dbs.get(abs);
    let stores;
    if (d && d.worker && !d.workerFailed) {
      try { stores = (await d.ask({ op: "export", file: snap })).stores; } catch { stores = null; }
    }
    if (!stores) stores = exportFromFile(snap);
    const out = [];
    for (const [name, s] of Object.entries(stores)) {
      const jsonFile = path.join(abs, name);
      if (fs.existsSync(jsonFile) && mtimeOf(jsonFile) > s.updatedAt) continue;
      out.push({ as: `data/${name}`, data: Buffer.from(s.text), mtime: s.updatedAt });
    }
    out.push({ as: `sqlite/${DB_NAME}`, data: fs.readFileSync(snap), mtime: Date.now() });
    return out;
  } finally {
    for (const ext of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(snap + ext); } catch {} }
  }
};

// ------------------------------------------------------------- status
const status = () => {
  const off = switchedOff();
  const out = { engine: loadEngine() ? `node:sqlite (SQLite ${sqliteVersion || "?"})` : null, problem: off ? `switched off (${off})` : engine ? null : engineProblem, databases: [] };
  for (const d of dbs.values()) {
    if (!d.db) { if (d.problem) out.databases.push({ file: d.file, problem: d.problem }); continue; }
    let stores = [];
    try { stores = d.stmts.regs.all().map((r) => ({ name: r.name, rows: r.rows, migratedAt: r.migrated_at, migratedFrom: r.migrated_from, updatedAt: r.updated_at, writes: r.writes })); } catch {}
    out.databases.push({ file: d.file, ...d.sizes(), readOnly: d.readOnly, checkpointer: d.worker ? "worker" : d.workerFailed ? "sqlite" : "idle", damaged: d.damaged, stores });
  }
  return out;
};

// At shutdown (jsonstore flushAll): the WAL into the main file.
const checkpointAll = () => { for (const d of dbs.values()) d.checkpointNow(); };
const closeAll = () => { for (const d of dbs.values()) d.close(); dbs.clear(); };
process.on("exit", closeAll);

module.exports = {
  DB_NAME, SCHEMA_VERSION, LAYOUTS, layoutFor,
  loadEngine, switchedOff, backendFor, exportFromFile, snapshotTo, backupEntries, status, checkpointAll, closeAll, stamp, md5,
  _internals: { hooks, plan, applied, rebuild, positions, newState, Backend, Db, dbs, dbFor, ck, CHECKPOINT_EVERY_MS, FALLBACK_AFTER_FAILURES, resetEngine: () => { engine = undefined; engineProblem = null; } },
};
