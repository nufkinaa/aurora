// Persistent JSON stores: each one a whole object in memory, written whole to
// one file — debounced, atomically, and so that a damaged file can never turn
// into an empty household.
//
// WRITING. save() schedules a write 1.5 s out; a burst of saves is one write.
// save({ within: ms }) says "this may wait up to ms" (a store that changes on
// every tick of something — a viewing session, an hourly chart — is written
// at that cadence instead of after every change); an earlier save() still
// brings the write forward, and a shutdown flush writes it at once.
// The write goes to a temp file, is flushed to the disk (fsync), and is then
// renamed over the store — so the live file is always either the old version
// or the new one, never half of either, and after a power cut too (without
// the fsync the rename can reach the disk before the data does). On Windows a
// rename is refused for the instant a scanner or indexer has the file open
// (EPERM / EBUSY / EACCES): it is tried again a few times at once and, if the
// file stays locked, again every two seconds until it goes through — the
// store stays marked unsaved meanwhile and nothing is forgotten. A write whose
// content is what the disk already holds is skipped.
//
// LAST GOOD COPIES. Beside every store that is not a cache sit up to two
// earlier versions, <name>.good1 (newer) and <name>.good2 — taken at most
// every ten minutes, only from content that passed its shape check, and read
// back and parsed before they are given their name.
//
// LOADING. A store whose file is missing, empty, not JSON, or JSON of the
// wrong shape (profiles.json holding an array, say) is NOT started empty:
//   1. the newest last-good copy that parses and has the right shape is put
//      back; failing that,
//   2. the same file out of the newest verified backup snapshot
//      (lib/backup.js) is put back; and only then
//   3. a CRITICAL store (profiles, sessions, settings) with nothing good
//      anywhere goes into SAFE MODE: it runs on its defaults in memory and is
//      never written, so the damaged file — kept as <name>.corrupt-<time>,
//      and left where it is — cannot be replaced by an empty one. The admin
//      page says so and offers the decision (routes/admin.js "stores").
//      Any other store starts from its defaults, as it always did.
// Every recovery is logged loudly, written to <data>/store-recovery.json with
// the window of time whose changes were lost, and announced once
// (announceRecoveries, called by server.js once the alerts are up).
// A file that is simply not there, with no copy anywhere, is a first start.
//
// To start a store empty ON PURPOSE, deleting its file is no longer enough
// (the last-good copy comes back): create an empty file named
// <name>.start-empty beside it, or delete <name>.good1 / .good2 as well.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEBOUNCE_MS = 1500;
const GOOD_EVERY_MS = 10 * 60 * 1000; // a last-good copy at most this often
const GOOD_COPIES = 2;
const RENAME_TRIES = 6; // at once: 10 + 20 + 40 + 80 + 160 ms
const RETRY_LATER_MS = 2000; // and then again, without blocking
const RECOVERIES_KEPT = 50;
const LOCKED = /^(EPERM|EBUSY|EACCES)$/;

// Stores the household cannot be without. By file name, so that whoever
// constructs the store does not have to remember to say so.
const CRITICAL = new Set(["profiles.json", "sessions.json", "settings.json"]);
// Rebuilt by the server on its own (lib/backup.js leaves the same ones out):
// no last-good copies, no fsync, may start empty.
const REBUILDABLE = new Set(["metadata-cache.json", "online-metadata.json", "ocr-failed.json", "daily.json", "watchdog.json", "health.json"]);

// Every instance registers here so they can all be flushed on shutdown.
const instances = new Set();

const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// What a store must look like to be believed, by file name. Returns null
// when fine, or a few words saying what is wrong.
const SHAPES = {
  "profiles.json": (d) => {
    if (!isObject(d)) return "not an object";
    if (!Array.isArray(d.profiles)) return "no list of profiles";
    if (!d.profiles.every((p) => isObject(p) && typeof p.id === "string" && p.id)) return "a profile has no id";
    if (!isObject(d.state)) return "no watch state";
    return null;
  },
  "sessions.json": (d) => (isObject(d) ? (Object.values(d).every((r) => isObject(r)) ? null : "a session row is not an object") : "not an object"),
  "settings.json": (d) => (isObject(d) ? null : "not an object"),
};

// The generic check: the same kind of thing as the store's defaults (a list
// stays a list, an object an object).
const sameKind = (data, fallbackValue) => {
  if (Array.isArray(fallbackValue)) return Array.isArray(data) ? null : "not a list";
  if (isObject(fallbackValue)) return isObject(data) ? null : "not an object";
  return data === undefined ? "nothing in it" : null;
};

const kindFor = (filePath) => {
  const base = path.basename(filePath).toLowerCase();
  if (CRITICAL.has(base)) return "critical";
  if (REBUILDABLE.has(base)) return "cache";
  if (path.resolve(filePath).split(path.sep).includes("cache")) return "cache";
  return "state";
};

const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };

// Test seam: the file-system calls a write makes, replaceable one by one.
const io = {
  writeFileSync: (...a) => fs.writeFileSync(...a),
  openSync: (...a) => fs.openSync(...a),
  writeSync: (...a) => fs.writeSync(...a),
  fsyncSync: (...a) => fs.fsyncSync(...a),
  closeSync: (...a) => fs.closeSync(...a),
  renameSync: (...a) => fs.renameSync(...a),
  readFileSync: (...a) => fs.readFileSync(...a),
  sleepSync,
};

// rename, tried again while the target is locked. Throws the last error.
const renameRetry = (from, to, tries = RENAME_TRIES) => {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      io.renameSync(from, to);
      return;
    } catch (e) {
      last = e;
      if (!e || !LOCKED.test(e.code || "")) break;
      if (i < tries - 1) io.sleepSync(10 * 2 ** i);
    }
  }
  throw last;
};

const fsyncDir = (dir) => {
  if (process.platform === "win32") return; // a directory cannot be opened for this on Windows
  let fd = null;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch {} finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
};

// Write `text` to `file` so that the file is always whole: temp file, fsync
// (unless `durable: false`), rename with retries, fsync of the folder. The
// temp file never survives a failure. Throws when it cannot be done.
const atomicWriteSync = (file, text, { durable = true } = {}) => {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  let fd = null;
  try {
    fd = io.openSync(tmp, "w");
    io.writeSync(fd, text);
    if (durable) io.fsyncSync(fd);
    io.closeSync(fd);
    fd = null;
    renameRetry(tmp, file);
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
  if (durable) fsyncDir(dir);
};

// Read one file as a store would: { ok, data } or { ok: false, problem }.
// `problem` is "missing", "empty", "not valid JSON" or the shape's words.
//
// A file that is only LOCKED for the moment (Windows: a scanner, an indexer,
// a backup tool reading it — EPERM / EBUSY / EACCES) is not a damaged file:
// it is asked for again for up to two seconds before anything is concluded.
// A good store must never be "recovered" from an older copy because
// something else happened to be looking at it during the boot.
const READ_TRIES = 20;
const readChecked = (file, check, { keepRaw = false } = {}) => {
  let raw;
  for (let i = 0; ; i++) {
    try {
      raw = io.readFileSync(file, "utf-8");
      break;
    } catch (e) {
      if (e && LOCKED.test(e.code || "") && i < READ_TRIES - 1) { io.sleepSync(100); continue; }
      return { ok: false, problem: e.code === "ENOENT" ? "missing" : `unreadable (${e.code || e.message})` };
    }
  }
  if (!raw.trim()) return { ok: false, problem: "empty" };
  let data;
  try { data = JSON.parse(raw); } catch { return { ok: false, problem: "not valid JSON" }; }
  const bad = check ? check(data) : null;
  if (bad) return { ok: false, problem: `the wrong shape (${bad})` };
  return { ok: true, data, bytes: Buffer.byteLength(raw), ...(keepRaw ? { raw } : {}) };
};

const md5 = (text) => crypto.createHash("md5").update(text).digest("hex");
const digest = (text) => (text.length < 262144 ? text : `${text.length}:${crypto.createHash("md5").update(text).digest("hex")}`);
const mtimeOf = (file) => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };

// ------------------------------------------------------ the recovery record
// <dir>/store-recovery.json: what was recovered, from what, and what was
// lost. A plain file (not a JsonStore — it must not depend on what it is
// reporting about).
const recoveryFile = (dir) => path.join(dir, "store-recovery.json");
const readRecoveries = (dir) => {
  try {
    const list = JSON.parse(fs.readFileSync(recoveryFile(dir), "utf-8"));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
};
const writeRecoveries = (dir, list) => {
  try { atomicWriteSync(recoveryFile(dir), JSON.stringify(list.slice(-RECOVERIES_KEPT), null, 1)); } catch {}
};
const recordRecovery = (dir, rec) => {
  const list = readRecoveries(dir);
  list.push(rec);
  writeRecoveries(dir, list);
};

// The backup system's copy of a store, when there is one: (filePath) ->
// { text, at, name } | null. Lazy and fenced — the stores load before
// anything else, and a broken backup folder must never stop a boot.
let backupLookup = (filePath) => {
  try { return require("./backup").newestGoodCopySync(filePath); } catch { return null; }
};

class JsonStore {
  // opts: { kind: "critical" | "state" | "cache", shape: (data) => null | "what is wrong",
  //         backupLookup,
  //         prepare: () => void            called just before each write (a store
  //                                        whose data is built from elsewhere fills it in)
  //         afterWrite: (text) => void     called once the disk holds `text` (written,
  //                                        or already there)
  //         digestOnLoad: true             keep the md5 of the text this run started
  //                                        from in `loadedMd5` }
  // — all optional; the kind and the shape follow the file's name.
  constructor(filePath, fallback, opts = {}) {
    this.filePath = filePath;
    this.name = path.basename(filePath);
    this.kind = opts.kind || kindFor(filePath);
    this._prepare = typeof opts.prepare === "function" ? opts.prepare : null;
    this._afterWrite = typeof opts.afterWrite === "function" ? opts.afterWrite : null;
    this._digestOnLoad = !!opts.digestOnLoad;
    this.loadedMd5 = null; // (digestOnLoad) md5 of what this run started from
    this.saveTimer = null;
    this.saveDueAt = 0; // when the scheduled write fires
    this.retryTimer = null;
    this.rev = 0; // how many times save() was asked for: a cheap "has this changed" for caches built from it
    this.dirty = false; // changed in memory since the last successful write
    this.unsavedSince = 0; // a write is failing since then (0 = fine)
    this.failures = 0;
    this.safeMode = null; // { since, problem, keptAs } — never written while set
    this.recovered = null; // how this run's data was recovered, if it was
    this.lastSavedAt = 0;
    this.lastGoodAt = 0;
    this.writes = 0;
    this.skipped = 0;
    this._written = null; // digest of what the disk holds
    this._fallback = fallback;
    const fallbackValue = () => (typeof fallback === "function" ? fallback() : fallback);
    const named = opts.shape || SHAPES[this.name.toLowerCase()] || null;
    const proto = fallbackValue();
    this._check = (data) => (named ? named(data) : null) || sameKind(data, proto);
    this._backupLookup = opts.backupLookup || backupLookup;
    this.data = this._load(fallbackValue);
    instances.add(this);
  }

  _goodPath(n) { return `${this.filePath}.good${n}`; }

  _load(fallbackValue) {
    const file = this.filePath;
    this._sweepTemp();
    // "start this one empty": said by a marker file, on purpose
    const marker = `${file}.start-empty`;
    if (fs.existsSync(marker)) {
      console.warn(`[store] ${this.name}: starting empty on request (${path.basename(marker)})`);
      this._startEmptyMarker = marker;
      return fallbackValue();
    }
    const live = readChecked(file, this._check, { keepRaw: this._digestOnLoad });
    if (live.ok) {
      if (this._digestOnLoad) this.loadedMd5 = md5(live.raw);
      this._written = null;
      if (this.kind !== "cache") this._noteGoodAtLoad();
      return live.data;
    }
    if (this.kind === "cache") {
      // as it always was: set a damaged one aside, start from defaults
      if (live.problem !== "missing") this._setAside(live.problem, "starting from defaults");
      return fallbackValue();
    }

    // ---- not a cache, and the live file cannot be used
    const damagedAt = mtimeOf(file);
    const candidates = [];
    for (let n = 1; n <= GOOD_COPIES; n++) {
      const r = readChecked(this._goodPath(n), this._check);
      if (r.ok) candidates.push({ from: `its last good copy (${path.basename(this._goodPath(n))})`, source: "last-good", data: r.data, at: mtimeOf(this._goodPath(n)) });
    }
    if (!candidates.length && (live.problem !== "missing" || this.kind === "critical")) {
      let b = null;
      try { b = this._backupLookup(file); } catch { b = null; }
      if (b && typeof b.text === "string") {
        let data;
        let ok = true;
        try { data = JSON.parse(b.text); } catch { ok = false; }
        if (ok && !this._check(data)) candidates.push({ from: `the backup ${b.name}`, source: "backup", data, at: b.at || 0 });
      }
    }
    if (!candidates.length && live.problem === "missing") return fallbackValue(); // a first start

    const keptAs = live.problem === "missing" || live.problem === "empty" ? null : this._copyAside();
    const dir = path.dirname(file);
    if (candidates.length) {
      const c = candidates[0];
      const lostMs = damagedAt && c.at ? Math.max(0, damagedAt - c.at) : null;
      const rec = { at: Date.now(), store: this.name, problem: live.problem, from: c.from, source: c.source, sourceAt: c.at || null, damagedAt: damagedAt || null, lostMs, keptAs: keptAs ? path.basename(keptAs) : null, safeMode: false, announced: false, acknowledged: false };
      // the literal the healer's "store-corrupt" signature reads
      console.error(`Corrupt store ${file} — backed up to ${keptAs || "(nothing to keep: it was " + live.problem + ")"}, RESTORED from ${c.from}${lostMs != null ? `; changes from the ${fmtSpan(lostMs)} before the damage are lost` : ""}`);
      const text = JSON.stringify(c.data);
      if (this._digestOnLoad) this.loadedMd5 = md5(text);
      try {
        atomicWriteSync(file, text);
        this._written = digest(text);
      } catch (e) {
        console.error(`Failed to save ${this.filePath}: ${e.message} (the restored copy is in memory; it will be written again)`);
        this.dirty = true;
        this._retryLater();
      }
      this.recovered = rec;
      recordRecovery(dir, rec);
      return c.data;
    }

    if (this.kind === "critical") {
      const rec = { at: Date.now(), store: this.name, problem: live.problem, from: null, source: "none", sourceAt: null, damagedAt: damagedAt || null, lostMs: null, keptAs: keptAs ? path.basename(keptAs) : null, safeMode: true, announced: false, acknowledged: false };
      this.safeMode = { since: rec.at, problem: live.problem, keptAs: rec.keptAs };
      console.error(`Corrupt store ${file} — backed up to ${keptAs || "(nothing to keep: it was " + live.problem + ")"}, and NO good copy exists (no last-good copy, no backup). SAFE MODE: ${this.name} runs on defaults in memory and is NOT written until the admin decides (admin page → Server → Data safety).`);
      this.recovered = rec;
      recordRecovery(dir, rec);
      return fallbackValue();
    }

    const rec = { at: Date.now(), store: this.name, problem: live.problem, from: null, source: "defaults", sourceAt: null, damagedAt: damagedAt || null, lostMs: null, keptAs: keptAs ? path.basename(keptAs) : null, safeMode: false, announced: false, acknowledged: false };
    console.error(`Corrupt store ${file} — backed up to ${keptAs || "(nothing to keep: it was " + live.problem + ")"}, starting from defaults (no good copy exists)`);
    this.recovered = rec;
    recordRecovery(dir, rec);
    return fallbackValue();
  }

  _copyAside() {
    try {
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      fs.copyFileSync(this.filePath, backup);
      return backup;
    } catch {
      return null;
    }
  }

  // A cache that cannot be read: kept beside it, said, forgotten.
  _setAside(problem, then) {
    const filePath = this.filePath;
    const backup = this._copyAside();
    if (backup) console.error(`Corrupt store ${filePath} — backed up to ${backup}, ${then}`);
  }

  // Temp files of writes that never finished (a kill between the write and
  // the rename): this store's, older than a minute.
  _sweepTemp() {
    try {
      const dir = path.dirname(this.filePath);
      const base = this.name;
      for (const n of fs.readdirSync(dir)) {
        if (!n.startsWith(`${base}.`) || !n.endsWith(".tmp")) continue;
        const p = path.join(dir, n);
        try { if (Date.now() - fs.statSync(p).mtimeMs > 60 * 1000) fs.unlinkSync(p); } catch {}
      }
    } catch {}
  }

  // A live file that just loaded fine IS a good state: make sure a copy of
  // it exists (a settings file may not be saved again for months).
  _noteGoodAtLoad() {
    try {
      const good = mtimeOf(this._goodPath(1));
      this.lastGoodAt = good;
      if (good && good >= mtimeOf(this.filePath)) return;
      const text = fs.readFileSync(this.filePath, "utf-8");
      if (good && Date.now() - good < GOOD_EVERY_MS) return;
      this._writeGood(text);
    } catch {}
  }

  // Rotate in one more last-good copy: written beside the others, read back
  // and parsed, and only then given its name.
  _writeGood(text) {
    const g1 = this._goodPath(1);
    const g2 = this._goodPath(2);
    const tmp = `${g1}.${process.pid}.tmp`;
    try {
      const fd = fs.openSync(tmp, "w");
      try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const back = fs.readFileSync(tmp, "utf-8");
      if (back.length !== text.length || this._check(JSON.parse(back))) throw new Error("the copy did not read back as written");
      if (fs.existsSync(g1)) { try { renameRetry(g1, g2); } catch {} }
      renameRetry(tmp, g1);
      this.lastGoodAt = Date.now();
      return true;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      return false;
    }
  }

  // Returns true when the disk holds what memory holds.
  _writeNow() {
    if (this.safeMode) return false; // never: see the note at the top
    if (this._prepare) {
      try { this._prepare(); } catch (err) { console.error(`Failed to prepare ${this.filePath}:`, err.message); }
    }
    let text;
    try {
      text = JSON.stringify(this.data);
    } catch (err) {
      console.error(`Failed to save ${this.filePath}:`, err.message);
      return false;
    }
    if (typeof text !== "string") return false;
    const d = digest(text);
    if (d === this._written && fs.existsSync(this.filePath)) {
      this.dirty = false;
      this.skipped++;
      this._wrote(text);
      return true;
    }
    try {
      atomicWriteSync(this.filePath, text, { durable: this.kind !== "cache" });
    } catch (err) {
      // not forgotten: marked unsaved, and tried again shortly
      this.failures++;
      if (!this.unsavedSince) this.unsavedSince = Date.now();
      if (this.failures === 1 || this.failures % 30 === 0) console.error(`Failed to save ${this.filePath}:`, `${err.message}${this.failures > 1 ? ` (attempt ${this.failures}; still trying)` : " (will be tried again)"}`);
      this.dirty = true;
      this._retryLater();
      return false;
    }
    if (this.unsavedSince) console.log(`[store] ${this.name} saved again after ${this.failures} failed attempt${this.failures === 1 ? "" : "s"}`);
    this._written = d;
    this.dirty = false;
    this.unsavedSince = 0;
    this.failures = 0;
    this.lastSavedAt = Date.now();
    this.writes++;
    if (this._startEmptyMarker) { try { fs.unlinkSync(this._startEmptyMarker); } catch {} this._startEmptyMarker = null; }
    if (this.kind !== "cache" && Date.now() - this.lastGoodAt >= GOOD_EVERY_MS) {
      let fine = false;
      try { fine = !this._check(this.data); } catch {}
      if (fine) this._writeGood(text);
    }
    this._wrote(text);
    return true;
  }

  _wrote(text) {
    if (!this._afterWrite) return;
    try { this._afterWrite(text); } catch (err) { console.error(`[store] ${this.name}: after-write step failed:`, err.message); }
  }

  _retryLater() {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.dirty && !this.saveTimer) this._writeNow();
    }, RETRY_LATER_MS);
    this.retryTimer.unref?.();
  }

  // save(): written DEBOUNCE_MS from the first of a burst. save({ within }):
  // written at the latest `within` ms from now — a write already due sooner
  // stands, one due later is brought forward.
  save(opts) {
    this.rev++;
    this.dirty = true;
    const within = opts && Number.isFinite(opts.within) && opts.within > DEBOUNCE_MS ? opts.within : DEBOUNCE_MS;
    const due = Date.now() + within;
    if (this.saveTimer) {
      if (this.saveDueAt <= due) return;
      clearTimeout(this.saveTimer);
    }
    this.saveDueAt = due;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveDueAt = 0;
      this._writeNow();
    }, within);
  }

  // Write immediately (e.g. on shutdown)
  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.saveDueAt = 0;
    }
    return this._writeNow();
  }

  // The admin's decision for a store in safe mode: carry on from what is in
  // memory now (the defaults, plus whatever happened since). The damaged
  // file stays kept beside it. Writes resume.
  leaveSafeMode() {
    if (!this.safeMode) return false;
    const was = this.safeMode;
    this.safeMode = null;
    console.warn(`[store] ${this.name}: leaving safe mode on the admin's decision — starting fresh (the damaged file is kept as ${was.keptAs || "nothing: it was empty"})`);
    this.dirty = true;
    this.flush();
    return true;
  }
}

const fmtSpan = (ms) => {
  const m = Math.round(ms / 60000);
  if (m < 2) return `${Math.max(1, Math.round(ms / 1000))} seconds`;
  if (m < 120) return `${m} minutes`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} hours` : `${Math.round(h / 24)} days`;
};

// Flush every store with something unwritten. Called on process shutdown.
// Hooks registered with beforeFlushAll run first (profiles.js: the watch
// journal is folded into profiles.json, so an older build started after this
// one finds everything in the file it knows).
const flushHooks = [];
const beforeFlushAll = (fn) => { if (typeof fn === "function") flushHooks.push(fn); };
const flushAll = () => {
  for (const fn of flushHooks) { try { fn(); } catch (e) { console.error("[store] before-flush step failed:", e && e.message); } }
  for (const s of instances) if (s.saveTimer || s.dirty) s.flush();
};

// ----------------------------------------------------- for the admin page

const statusOf = (s) => {
  let bytes = null;
  try { bytes = fs.statSync(s.filePath).size; } catch {}
  return {
    name: s.name, kind: s.kind, bytes,
    safeMode: s.safeMode ? { ...s.safeMode } : null,
    unsavedSince: s.unsavedSince || null,
    failures: s.failures,
    lastSavedAt: s.lastSavedAt || null,
    lastGoodAt: s.lastGoodAt || null,
    writes: s.writes, skipped: s.skipped,
  };
};

// { stores, safeMode: [names], unsaved: [names], recoveries } — recoveries
// from the record files of every folder a store lives in, newest first.
const status = () => {
  const stores = [...instances].map(statusOf).sort((a, b) => (a.name < b.name ? -1 : 1));
  const dirs = new Set([...instances].filter((s) => s.kind !== "cache").map((s) => path.dirname(s.filePath)));
  const recoveries = [];
  for (const dir of dirs) for (const r of readRecoveries(dir)) recoveries.push(r);
  recoveries.sort((a, b) => b.at - a.at);
  return {
    stores,
    safeMode: stores.filter((s) => s.safeMode).map((s) => s.name),
    unsaved: stores.filter((s) => s.unsavedSince).map((s) => s.name),
    recoveries,
  };
};

const inSafeMode = (name) => {
  for (const s of instances) if (s.safeMode && (!name || s.name === name)) return true;
  return false;
};

const leaveSafeMode = (name) => {
  let done = false;
  for (const s of instances) if (s.name === name && s.safeMode) done = s.leaveSafeMode() || done;
  return done;
};

// One sentence a person can act on, per recovery.
const recoverySentence = (r) => {
  const lost = r.lostMs != null ? ` Changes made in the ${fmtSpan(r.lostMs)} before the damage are lost.` : "";
  const kept = r.keptAs ? ` The damaged file is kept as ${r.keptAs}.` : "";
  if (r.safeMode) {
    return `${r.store} could not be read (${r.problem}) and no good copy exists — no last-good copy and no backup. Aurora is running in SAFE MODE for it: it shows its defaults and saves nothing to that file, so the damaged file cannot be replaced by an empty one.${kept} Decide on the admin page (Server → Data safety): put a good file back and restart, or start it fresh.`;
  }
  if (r.source === "defaults") return `${r.store} could not be read (${r.problem}) and no good copy existed, so it started empty.${kept}`;
  return `${r.store} could not be read (${r.problem}) and was restored from ${r.from}.${lost}${kept}`;
};

// Say each recovery ONCE. `tell(recovery, sentence)` does the telling
// (server.js hands in the health alerts); what was told is marked in the
// record, so a restart does not say it again.
const announceRecoveries = (tell) => {
  const dirs = new Set([...instances].filter((s) => s.kind !== "cache").map((s) => path.dirname(s.filePath)));
  let n = 0;
  for (const dir of dirs) {
    const list = readRecoveries(dir);
    let changed = false;
    for (const r of list) {
      if (r.announced) continue;
      try { tell(r, recoverySentence(r)); } catch {}
      r.announced = true;
      changed = true;
      n++;
    }
    if (changed) writeRecoveries(dir, list);
  }
  return n;
};

// The admin has read them: nothing is deleted, they stop being findings.
const acknowledgeRecoveries = () => {
  const dirs = new Set([...instances].filter((s) => s.kind !== "cache").map((s) => path.dirname(s.filePath)));
  let n = 0;
  for (const dir of dirs) {
    const list = readRecoveries(dir);
    let changed = false;
    for (const r of list) if (!r.acknowledged) { r.acknowledged = true; changed = true; n++; }
    if (changed) writeRecoveries(dir, list);
  }
  return n;
};

// Persist pending writes on normal shutdown so recent progress/state isn't lost.
let flushed = false;
const onExit = () => {
  if (flushed) return;
  flushed = true;
  flushAll();
};
// A process that only requires a store (a tool, a test) still flushes on a
// signal. The server replaces this with its own, fuller shutdown
// (lib/shutdown.js), which calls ownSignals(false) and flushes itself.
let own = true;
const ownSignals = (on) => { own = !!on; };
process.on("SIGINT", () => { if (!own) return; onExit(); process.exit(0); });
process.on("SIGTERM", () => { if (!own) return; onExit(); process.exit(0); });
process.on("beforeExit", onExit);

module.exports = {
  JsonStore, flushAll, beforeFlushAll, ownSignals, atomicWriteSync, readChecked, md5,
  status, inSafeMode, leaveSafeMode, announceRecoveries, acknowledgeRecoveries, recoverySentence,
  CRITICAL, REBUILDABLE, SHAPES,
  _internals: { instances, io, kindFor, renameRetry, sameKind, readRecoveries, fmtSpan, digest, setBackupLookup: (fn) => { backupLookup = fn; }, DEBOUNCE_MS, GOOD_EVERY_MS, RETRY_LATER_MS },
};
