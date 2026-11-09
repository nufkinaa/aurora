// A restore asked for on the admin page (lib/drivecopies.js restore) is put
// in place HERE, at the very start of the next run, before any store has read
// its file — so no running server can save its memory over the restored data.
// server.js calls applyPendingSync() right after the config is read.
//
//   data/restore-pending.json   what to restore (written by the admin's restore)
//   data/.restore-pending/<copy> the copy itself, fetched from its drive and checked
//   data/restore-last.json      how the last restore went (the admin shows it)
//
// The steps, each before the next:
//   1. the copy is checked again (every file against its manifest)
//   2. the data as it is now is copied ASIDE: data/before-restore-<time>/
//      (every file a backup holds), and a snapshot of it is made in the
//      backups folder, so "undo" is one more restore from the same card
//   3. restore-last.json says "applying" and the request is removed (a crash
//      from here on can never restore twice)
//   4. each data file of the copy is written over its live one, atomically;
//      the last-good copies of those stores are removed (they hold the state
//      being replaced); a journal the copy does not have is removed (it would
//      be laid over the restored profiles)
//   5. restore-last.json says "done"
// A failure in 4 puts the aside copy back. A run that died in 4 (the file
// still says "applying") is put back the same way at the next start.
// config.json and .env are never touched. A request older than 30 minutes is
// not carried out (the restart it was for did not happen).
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const backup = require("./backup");

const PENDING_FILE = "restore-pending.json";
const LAST_FILE = "restore-last.json";
const PENDING_DIR = ".restore-pending";
const MAX_AGE_MS = 30 * 60 * 1000;
const ASIDE_PREFIX = "before-restore-";

const { tarPack, sha256, verifyBufferSync, nameFor, EXCLUDE_FILES, INCLUDE_DIRS } = backup._internals;

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const write = (file, data) => require("./jsonstore").atomicWriteSync(file, typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 1));
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");

// Every file a backup of `dataDir` holds, as [{ rel: "profiles.json" | "usage/x.jsonl", abs }].
const householdFiles = (dataDir) => {
  const out = [];
  let top = [];
  try { top = fs.readdirSync(dataDir, { withFileTypes: true }); } catch {}
  for (const e of top) {
    if (e.isFile() && e.name.toLowerCase().endsWith(".json") && !e.name.startsWith(".") && !EXCLUDE_FILES.has(e.name.toLowerCase())) out.push({ rel: e.name, abs: path.join(dataDir, e.name) });
  }
  const walk = (abs, rel) => {
    let es = [];
    try { es = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (/\.(tmp|partial)$/i.test(e.name)) continue;
      if (e.isDirectory()) walk(path.join(abs, e.name), `${rel}/${e.name}`);
      else if (e.isFile()) out.push({ rel: `${rel}/${e.name}`, abs: path.join(abs, e.name) });
    }
  };
  for (const d of INCLUDE_DIRS) walk(path.join(dataDir, d), d);
  return out;
};

// The data as it is now: copied file by file into `asideDir`, and packed as a
// snapshot (named like every other) into `backupDir`.
const putAside = (dataDir, backupDir, now, version) => {
  const asideDir = path.join(dataDir, `${ASIDE_PREFIX}${stamp(now)}`);
  fs.mkdirSync(asideDir, { recursive: true });
  const entries = [];
  const files = [];
  for (const f of householdFiles(dataDir)) {
    let data;
    let st;
    try { data = fs.readFileSync(f.abs); st = fs.statSync(f.abs); } catch { continue; }
    const to = path.join(asideDir, ...f.rel.split("/"));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, data);
    entries.push({ name: `data/${f.rel}`, data, mtime: st.mtimeMs });
    files.push({ path: `data/${f.rel}`, size: data.length, sha256: sha256(data), mtime: new Date(st.mtimeMs).toISOString() });
  }
  let snapshot = null;
  try {
    const manifest = { format: "aurora-backup", formatVersion: 1, app: "aurora", version, createdAt: new Date(now).toISOString(), host: require("os").hostname(), platform: process.platform, kind: "before-restore", note: "The data as it was just before a restore (lib/restoreboot.js).", warnings: [], files };
    const gz = zlib.gzipSync(tarPack([{ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2)), mtime: now }, ...entries]), { level: 6 });
    fs.mkdirSync(backupDir, { recursive: true });
    let t = now;
    while (fs.existsSync(path.join(backupDir, nameFor(t)))) t += 1000;
    const name = nameFor(t);
    const partial = path.join(backupDir, `.${name}.partial`);
    fs.writeFileSync(partial, gz);
    if (!verifyBufferSync(fs.readFileSync(partial)).ok) throw new Error("it failed its check");
    fs.renameSync(partial, path.join(backupDir, name));
    snapshot = name;
  } catch (e) {
    console.warn(`[restore] the snapshot of the data before the restore could not be made (${(e && e.message) || e}); the copy in ${asideDir} is kept`);
  }
  return { asideDir, snapshot, files: files.length };
};

// Put the aside copy back: every file of it in place, and what the restore
// added that was not there before removed.
const rollBack = (dataDir, asideDir, added = []) => {
  let n = 0;
  const walk = (abs, rel) => {
    let es = [];
    try { es = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(abs, e.name), r);
      else if (e.isFile()) { write(path.join(dataDir, ...r.split("/")), fs.readFileSync(path.join(abs, e.name))); n++; }
    }
  };
  walk(asideDir, "");
  for (const rel of added) { try { fs.unlinkSync(path.join(dataDir, ...rel.split("/"))); } catch {} }
  return n;
};

const cleanPending = (dataDir) => {
  try { fs.unlinkSync(path.join(dataDir, PENDING_FILE)); } catch {}
  try { fs.rmSync(path.join(dataDir, PENDING_DIR), { recursive: true, force: true }); } catch {}
};

const say = (dataDir, rec) => { try { write(path.join(dataDir, LAST_FILE), rec); } catch {} };

// -> { applied, ... } | { skipped: why } | { failed: error } — never throws.
const applyPendingSync = ({ dataDir, backupDir, version = null, now = Date.now() } = {}) => {
  try {
    if (!dataDir) return { skipped: "no data folder" };
    // a run that died while putting a copy in place: put the data back as it was
    const last = readJson(path.join(dataDir, LAST_FILE));
    if (last && last.status === "applying" && last.aside) {
      const asideDir = path.join(dataDir, last.aside);
      let n = 0;
      try { n = rollBack(dataDir, asideDir, last.added || []); } catch (e) { console.error(`[restore] putting the data back after an interrupted restore failed: ${(e && e.message) || e}`); }
      say(dataDir, { ...last, status: "failed", error: "the server stopped while the copy was being put in place; the data from before was put back", rolledBack: n, endedAt: now });
      console.error(`[restore] the restore of ${last.name} was interrupted — the data from before it was put back (${n} files)`);
    }
    const reqFile = path.join(dataDir, PENDING_FILE);
    if (!fs.existsSync(reqFile)) return { skipped: "nothing to restore" };
    const req = readJson(reqFile);
    if (!req || !backup._internals.isSnapshotName(req.name)) { cleanPending(dataDir); return { skipped: "the request could not be read" }; }
    const base = { name: req.name, location: req.location || null, locationName: req.locationName || null, createdAt: req.createdAt || null, requestedAt: req.requestedAt || null, summary: req.summary || null };
    if (!(now - (req.requestedAt || 0) <= MAX_AGE_MS)) {
      cleanPending(dataDir);
      say(dataDir, { ...base, status: "expired", at: now, error: "the restart it was asked for did not come within 30 minutes; nothing was changed" });
      console.warn(`[restore] a restore of ${req.name} was asked for at ${new Date(req.requestedAt || 0).toISOString()} and not carried out (too old) — nothing was changed`);
      return { skipped: "too old" };
    }
    // another live Aurora holds this folder: not now (it would write over us)
    try {
      const other = require("./jsonstore").foreignOwnerOf(path.join(dataDir, "x"));
      if (other) { console.warn(`[restore] another Aurora (pid ${other}) holds ${dataDir} — the restore waits`); return { skipped: "another server holds the data folder" }; }
    } catch {}
    const archive = path.join(dataDir, PENDING_DIR, req.name);
    let check;
    try {
      const gz = fs.readFileSync(archive);
      if (req.sha256 && sha256(gz) !== req.sha256) throw new Error("the fetched copy changed since it was checked");
      check = verifyBufferSync(gz);
      if (!check.ok) throw new Error(check.error);
    } catch (e) {
      cleanPending(dataDir);
      const error = `the copy failed its check (${(e && e.message) || e}); nothing was changed`;
      say(dataDir, { ...base, status: "failed", at: now, error });
      console.error(`[restore] ${req.name}: ${error}`);
      return { failed: error };
    }
    // the names come from a file: plain data/ paths only
    const todo = [];
    for (const f of check.manifest.files) {
      const parts = String(f.path).split("/");
      if (parts[0] !== "data") continue; // config/* is never put back from here
      if (parts.length < 2 || parts.some((s) => !s || s === "." || s === "..") || f.path.includes("\\") || f.path.includes("\0") || /^[A-Za-z]:/.test(parts[1])) {
        cleanPending(dataDir);
        say(dataDir, { ...base, status: "failed", at: now, error: `unsafe path in the copy (${f.path}); nothing was changed` });
        return { failed: "unsafe path" };
      }
      if (parts.length === 2 && parts[1].startsWith(".")) continue; // (an older backup's copy of the server's lock file: never put back)
      todo.push({ rel: parts.slice(1).join("/"), data: check.entries.get(f.path) });
    }
    const aside = putAside(dataDir, backupDir || path.join(dataDir, "backups"), now, version);
    const had = new Set(householdFiles(dataDir).map((f) => f.rel));
    const added = todo.map((t) => t.rel).filter((r) => !had.has(r));
    const rec = { ...base, status: "applying", at: now, aside: path.basename(aside.asideDir), beforeSnapshot: aside.snapshot, added };
    say(dataDir, rec);
    cleanPending(dataDir);
    let written = 0;
    try {
      for (const t of todo) {
        const abs = path.join(dataDir, ...t.rel.split("/"));
        write(abs, t.data);
        for (const extra of [`${abs}.good1`, `${abs}.good2`, `${abs}.start-empty`]) { try { fs.unlinkSync(extra); } catch {} }
        written++;
      }
      // a journal the copy does not have would be laid over the restored store at boot
      const restored = new Set(todo.map((t) => t.rel));
      const dropped = [];
      for (const name of fs.readdirSync(dataDir)) {
        if (!/-journal\.json$/i.test(name) || restored.has(name)) continue;
        try { fs.unlinkSync(path.join(dataDir, name)); dropped.push(name); } catch {}
        for (const extra of [".good1", ".good2"]) { try { fs.unlinkSync(path.join(dataDir, name + extra)); } catch {} }
      }
      say(dataDir, { ...rec, status: "done", files: written, dropped, endedAt: Date.now() });
      console.log(`[restore] ${req.name} (made ${req.createdAt ? new Date(req.createdAt).toISOString() : "?"}) is in place: ${written} files. The data from before is in data/${rec.aside}${aside.snapshot ? ` and ${aside.snapshot}` : ""}.`);
      return { applied: true, files: written, aside: rec.aside, beforeSnapshot: aside.snapshot };
    } catch (e) {
      const error = (e && e.message) || String(e);
      let n = 0;
      try { n = rollBack(dataDir, aside.asideDir, added); } catch {}
      say(dataDir, { ...rec, status: "failed", error: `${error} — the data from before was put back`, rolledBack: n, endedAt: Date.now() });
      console.error(`[restore] ${req.name} could not be put in place (${error}) — the data from before was put back (${n} files)`);
      return { failed: error };
    }
  } catch (e) {
    console.error(`[restore] ${(e && e.message) || e}`);
    return { failed: String((e && e.message) || e) };
  }
};

module.exports = { applyPendingSync, PENDING_FILE, LAST_FILE, PENDING_DIR, MAX_AGE_MS, _internals: { householdFiles, putAside, rollBack } };
