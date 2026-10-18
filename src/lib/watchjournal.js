// The watch journal: where playback progress goes between full writes of
// profiles.json (server round 2026-10-18, STORAGE).
//
// WHY. Every player reports its position every 5 s, and each report used to
// rewrite the WHOLE profiles.json (every profile, every history row): about
// 720 rewrites per viewer-hour; on a household with a year or two of history
// that is gigabytes an hour and saves of a second or more on the event loop.
//
// WHAT. profiles.json is unchanged: the same file, the same format, every
// profile's whole state in it — so an older build reads it as it always did.
// It is just written less: on every change that is not a playback tick
// (exactly as before), at a CHECKPOINT at most every CHECKPOINT_MS while
// ticks are waiting, and at a graceful shutdown. A playback tick changes the
// profile's rows of three kinds — progress (what was played), titles (the
// shared history row) and streamItems (a torrent's play-item) — in MEMORY at
// once (every device reads memory, so nothing anyone sees changes or waits)
// and is noted here. This file, data/watch-journal.json, holds every row
// changed since the last full write of profiles.json:
//   { v: 1, base: <md5 of that profiles.json>, at, rows: { <profileId>: {
//       progress: { <itemId>: row | null }, titles: {…}, streamItems: {…} } } }
// (null: the row was removed meanwhile.) It is small — the rows being watched
// — and is a JsonStore like any other: temp file, fsync, rename, last-good
// copies, recovery from a damaged file, the recovery record.
//
// WHEN IT IS WRITTEN. Within the store debounce (1.5 s) when something
// happened that matters if the power went now — a title started or resumed
// after a pause, a seek, a title finished, the player stopped (realtime.js
// tells noteStop) — and otherwise at most every ROUTINE_MS (60 s). A hard
// kill loses at most that much of a resume position; a graceful stop nothing.
//
// AT BOOT the journal is laid over profiles.json:
//   - its `base` is the md5 of the profiles.json just read: profiles.json is
//     exactly the file the journal was built on, so the journal is applied as
//     it stands (rows set, nulls removed);
//   - anything else — profiles.json was put back from a last-good copy or a
//     backup, edited by hand, or written by an OLDER build that ran in
//     between — its rows are MERGED: a row is taken only when it is newer
//     (updatedAt) than the one in profiles.json, or there is none; nothing is
//     removed. Then a checkpoint is written at once. So a downgrade followed
//     by an upgrade loses nothing that either build saw.
// A profiles.json in safe mode takes nothing from the journal, and the
// journal is left as it is on disk.
//
// AT A FULL WRITE of profiles.json (afterWrite): every row is in it, so the
// journal is emptied, re-based on the new file's md5, and — when the file on
// disk still holds rows — written at once, in the same tick.
//
// BACKUPS read this file BEFORE profiles.json (lib/backup.js), so a snapshot
// taken across a checkpoint holds an older journal over a newer profiles.json
// — which the merge rule above reads correctly.
"use strict";
const path = require("path");
const { JsonStore, md5, SHAPES } = require("./jsonstore");

const FILE = "watch-journal.json";
const KINDS = ["progress", "titles", "streamItems"];
const ROUTINE_MS = 60 * 1000;
const CHECKPOINT_MS = 15 * 60 * 1000;
const STOP_WINDOW_MS = 15 * 1000; // a save this soon after a stop is the player's last word
const BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const blank = () => ({ v: 1, base: null, at: 0, rows: {} });
const shape = (d) => SHAPES[FILE](d); // (lib/jsonstore.js, where the backup's checks find it too)
const countRows = (rows) => {
  let n = 0;
  for (const r of Object.values(rows || {})) for (const k of KINDS) n += Object.keys((r && r[k]) || {}).length;
  return n;
};

// Pure: lay one profile's journal rows over its state. exact: as written
// (nulls remove). Otherwise newest-wins, nothing removed. Returns how many
// rows were taken.
const applyRows = (state, rows, exact) => {
  let taken = 0;
  for (const kind of KINDS) {
    const src = rows && rows[kind];
    if (!isObject(src)) continue;
    if (!isObject(state[kind])) state[kind] = {};
    const dst = state[kind];
    for (const [key, val] of Object.entries(src)) {
      if (BAD_KEYS.has(key)) continue;
      if (val === null) {
        if (exact && key in dst) { delete dst[key]; taken++; }
        continue;
      }
      if (!isObject(val)) continue;
      if (exact) { dst[key] = val; taken++; continue; }
      const cur = dst[key];
      if (kind === "streamItems") {
        if (!cur) { dst[key] = val; taken++; }
        continue;
      }
      if (!cur || (Number(val.updatedAt) || 0) > (Number(cur.updatedAt) || 0)) { dst[key] = val; taken++; }
    }
  }
  return taken;
};

// main: the profiles.json JsonStore (made with digestOnLoad). stateOf(pid):
// that profile's live state object, or null when there is no such profile.
// dir: where the journal lives. JournalStore: injectable for tests.
class WatchJournal {
  constructor({ main, stateOf, dir, JournalStore = JsonStore, now = () => Date.now() }) {
    this.main = main;
    this.stateOf = stateOf;
    this.now = now;
    this.dirty = new Map(); // pid -> { progress: Map(key -> gen), titles: …, streamItems: … }
    this.gen = 0; // moves with every row noted: what a write of profiles.json covered is "up to gen N"
    this.stopping = new Map(); // pid -> until
    this.base = main.loadedMd5 || null;
    this.lastCheckpointAt = now();
    this.disabled = !!main.safeMode;
    this.diskRows = 0;
    this.stats = { notes: 0, urgent: 0, checkpoints: 0, boot: null };
    this.store = new JournalStore(path.join(dir, FILE), blank, {
      shape,
      prepare: () => this._build(),
      afterWrite: () => { this.diskRows = countRows(this.store.data.rows); },
    });
    this.diskRows = countRows(this.store.data && this.store.data.rows);
    // profiles.json in safe mode: the journal on disk is all there is of
    // those rows — it is kept exactly as it is, never written
    if (this.disabled) this.store._writeNow = () => false;
  }

  // Lay what the journal holds over the state just loaded. Call once, after
  // profiles.json is in memory.
  boot() {
    const j = this.store.data || blank();
    const pids = Object.keys(j.rows || {});
    const out = { mode: "none", rows: 0, taken: 0, skippedProfiles: 0 };
    this.stats.boot = out;
    if (this.disabled) { out.mode = "safe-mode"; return out; }
    if (!pids.length) return out;
    const exact = !!j.base && j.base === this.main.loadedMd5;
    out.mode = exact ? "exact" : "merge";
    for (const pid of pids) {
      if (BAD_KEYS.has(pid)) continue;
      const st = this.stateOf(pid);
      if (!st) { out.skippedProfiles++; continue; }
      const rows = j.rows[pid];
      out.rows += countRows({ x: rows });
      out.taken += applyRows(st, rows, exact);
      if (exact) for (const kind of KINDS) for (const key of Object.keys((rows && rows[kind]) || {})) this._mark(pid, kind, key);
    }
    if (!exact) {
      console.warn(`[store] ${FILE} was written over a different profiles.json (restored, recovered, or written by another build): merged ${out.taken} of ${out.rows} rows, newest first, nothing removed; writing a full profiles.json now`);
      this.main.save();
      this.main.flush();
    } else if (out.taken) {
      console.log(`[store] ${FILE}: ${out.taken} watch row(s) since the last full write of profiles.json put back`);
    }
    return out;
  }

  _mark(pid, kind, key) {
    let d = this.dirty.get(pid);
    if (!d) this.dirty.set(pid, (d = { progress: new Map(), titles: new Map(), streamItems: new Map() }));
    d[kind].set(key, ++this.gen);
  }

  // A playback tick changed these rows of `pid` (in memory already).
  // keys: { progress: [ids], titles: [keys], streamItems: [ids] }.
  note(pid, keys, { urgent = false } = {}) {
    if (this.disabled || !pid || BAD_KEYS.has(pid)) return;
    for (const kind of KINDS) for (const key of (keys && keys[kind]) || []) if (key && !BAD_KEYS.has(key)) this._mark(pid, kind, key);
    this.stats.notes++;
    const until = this.stopping.get(pid);
    if (until) {
      if (this.now() < until) urgent = true;
      else this.stopping.delete(pid);
    }
    if (urgent) this.stats.urgent++;
    // time for profiles.json to catch up (its afterWrite empties the journal);
    // the journal is written all the same, in case that write cannot be done
    if (this.now() - this.lastCheckpointAt >= CHECKPOINT_MS) this.main.save();
    if (urgent) this.store.save();
    else this.store.save({ within: ROUTINE_MS });
  }

  // The player of a device on this profile stopped (or went away): what is
  // waiting is written now, and so is a last save that follows straight on.
  noteStop(pid) {
    if (this.disabled || !pid) return;
    this.stopping.set(String(pid), this.now() + STOP_WINDOW_MS);
    if (this.dirty.has(String(pid))) this.store.save();
  }

  // The journal's content, from memory, just before it is written.
  _build() {
    const rows = {};
    for (const [pid, d] of this.dirty) {
      const st = this.stateOf(pid);
      if (!st) { this.dirty.delete(pid); continue; }
      const r = {};
      for (const kind of KINDS) {
        if (!d[kind].size) continue;
        const src = isObject(st[kind]) ? st[kind] : {};
        const o = (r[kind] = {});
        for (const key of d[kind].keys()) o[key] = Object.prototype.hasOwnProperty.call(src, key) ? src[key] : null;
      }
      rows[pid] = r;
    }
    this.store.data = { v: 1, base: this.base, at: this.now(), rows };
  }

  // profiles.json was just written whole (or found already holding `text`):
  // every row noted up to `upTo` (the gen when its text was taken — the
  // write itself happened off the loop, and ticks went on meanwhile) is in it.
  mainWritten(text, upTo) {
    if (this.disabled) return;
    this.base = md5(text);
    this.lastCheckpointAt = this.now();
    this.stats.checkpoints++;
    const limit = Number.isFinite(upTo) ? upTo : Infinity;
    for (const [pid, d] of this.dirty) {
      for (const kind of KINDS) for (const [key, g] of d[kind]) if (g <= limit) d[kind].delete(key);
      if (!d.progress.size && !d.titles.size && !d.streamItems.size) this.dirty.delete(pid);
    }
    if (this.diskRows > 0) {
      this.store.persist(); // rows on disk that profiles.json now holds: re-based (and emptied) at once
    } else if (!this.dirty.size && this.store.saveTimer) {
      // nothing on disk to take back, and nothing left to say
      clearTimeout(this.store.saveTimer);
      this.store.saveTimer = null;
      this.store.saveDueAt = 0;
      this.store.dirty = false;
    }
  }

  // Shutdown: profiles.json is written whole when anything is waiting here,
  // so an older build started next finds it all in the file it knows.
  beforeShutdown() {
    if (this.disabled) return;
    if (this.dirty.size || this.diskRows > 0) this.main.dirty = true;
  }

  pending() { let n = 0; for (const d of this.dirty.values()) for (const k of KINDS) n += d[k].size; return n; }

  // For profiles.json's prepare: how far the rows noted so far go.
  upTo() { return this.gen; }
}

module.exports = { WatchJournal, FILE, KINDS, ROUTINE_MS, CHECKPOINT_MS, STOP_WINDOW_MS, _internals: { applyRows, shape, blank, countRows } };
