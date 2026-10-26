// The copies My List downloads left behind.
//
// My List downloads (2026-10-10 → 2026-10-26) fetched a film / a show's first
// episode the moment a title was added to someone's list. elia, 2026-10-26:
// "we need to get rid of the auto download when added to my list, it's not
// used well at all" — it ran to download films that were only out as cinema
// recordings. The feature is gone: adding to My List only adds to the list
// (routes/profiles.js), and nothing here ever starts a download.
//
// What stays is the promise those copies were fetched under, and only for
// them: a copy the feature fetched that nobody has watched goes stale and then
// leaves, exactly as before. Nothing NEW enters this — the record of what is
// ours (data/mylistdl.json) only shrinks, and the admin's card disappears
// once the last of it is settled.
//
// THE RULES (unchanged for those copies)
//
//   Watched   Any profile has real progress on the copy SINCE it was asked
//             for: finished (a hand mark counts) or at least a minute in.
//   Clock     Starts when the download finished (or the title was last added
//             to a list while the copy was on disk, back when that counted).
//   Stale     staleDays (14) on the clock, never watched → listed as a free
//             candidate in the admin's "Free up space" suggestions, with why.
//   Delete    deleteDays (21) on the clock, never watched → the file and its
//             sidecar subtitles are removed through lib/libfiles.js (the same
//             path the admin's Delete uses), the library is rescanned. The
//             title STAYS on the person's list — it is stream-only again.
//             Never while it is being played or was touched in the last six
//             hours, never while a download is writing it, never when its
//             drive is unplugged, NEVER a file somebody asked for by hand
//             (a person pressing Download on it, or the admin's Keep).
//   A job     the feature queued that is still in the queue is left alone (the
//             owner: "existing downloads are left alone"); when it lands, its
//             copy gets the same clock. Records that never reached the queue
//             (waiting for a daily cap, failed, about to retry) are closed —
//             nothing will fetch them any more.
//
// What is ours is decided by this module's own record, keyed by the TITLE
// ("tt123" / "tt123:1:1"), never by a path: a rescan or a rename does not
// lose it. A renamed file is recognised by title + exact size; anything else
// under that title is somebody else's file and is never touched.
//
// Every decision is one log line starting "[mylist] ".
"use strict";

const DAY_MS = 24 * 3600 * 1000;
const WATCHED_S = 60;                 // "real progress": a minute in (the admin tree's own line)
const IN_USE_MS = 6 * 3600 * 1000;    // touched this recently = someone may be on it right now
const KEEP_HISTORY_MS = 60 * DAY_MS;  // closed records stay this long for the admin's list
const TERMINAL = new Set(["watched", "deleted", "gone", "claimed", "canceled", "gave-up", "have"]);
const LIVE_JOB = new Set(["pending", "approved", "downloading"]);

// ---------- settings ----------
// Stored in data/settings.json (lib/settings.js) under these names. A file
// written before a key existed reads as the default. (The feature's own
// switches — myListDownloads, myListShows, myListDailyCap, myListRetries,
// myListYield — are gone with it; a file that still has them is ignored.)
const DEFAULTS = Object.freeze({
  myListStaleDays: 14,     // unwatched this long → a free delete suggestion
  myListDeleteDays: 21,    // unwatched this long → deleted
  myListAutoDelete: true,  // false: nothing is deleted by itself, stale copies only show as suggestions
});
const LIMITS = Object.freeze({
  myListStaleDays: [1, 365],
  myListDeleteDays: [1, 730],
});
const BOOLS = ["myListAutoDelete"];
const NUMS = Object.keys(LIMITS);

const wholeIn = (v, [lo, hi]) => {
  if (typeof v === "boolean" || v === null || v === "") return null;
  const n = typeof v === "number" ? v : /^\s*\d{1,4}\s*$/.test(String(v)) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
};

// What is in force, whatever the settings file holds (an unreadable value
// reads as the default; a delete line under the stale line is lifted to it).
const readSettings = (data) => {
  const d = data && typeof data === "object" ? data : {};
  const out = {};
  for (const k of BOOLS) out[k] = typeof d[k] === "boolean" ? d[k] : DEFAULTS[k];
  for (const k of NUMS) out[k] = wholeIn(d[k], LIMITS[k]) ?? DEFAULTS[k];
  if (out.myListDeleteDays < out.myListStaleDays) out.myListDeleteDays = out.myListStaleDays;
  return out;
};

// A change from the admin page: only the keys sent are touched, everything is
// checked before anything is stored. → { value } (the full new set) | { error }.
const parseSettings = (body, current) => {
  const next = { ...readSettings(current) };
  const b = body && typeof body === "object" ? body : {};
  for (const k of BOOLS) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== "boolean") return { error: `${k} must be true or false.` };
    next[k] = b[k];
  }
  const names = { myListStaleDays: "Stale after", myListDeleteDays: "Delete after" };
  for (const k of NUMS) {
    if (b[k] === undefined) continue;
    const n = wholeIn(b[k], LIMITS[k]);
    if (n == null) return { error: `${names[k]} must be a whole number from ${LIMITS[k][0]} to ${LIMITS[k][1]}.` };
    next[k] = n;
  }
  if (next.myListDeleteDays < next.myListStaleDays) {
    return { error: "Delete after must not be sooner than Stale after." };
  }
  return { value: next };
};

// ---------- pure rules ----------
const keyOf = (imdbId, season, episode) =>
  season != null && episode != null ? `${imdbId}:${Number(season)}:${Number(episode)}` : String(imdbId);

const labelOf = (rec) =>
  rec.type === "show" && rec.season != null ? `${rec.title} · S${rec.season} E${rec.episode}` : rec.title;

// The lifecycle of one finished copy, pure. Everything is handed in:
//   rec        the record (doneAt, addedAt, at, orphanedAt)
//   file       "present" | "away" (its drive is unplugged) | "gone"
//   manual     somebody asked for this file by hand
//   watched    { at, by } | null — real progress since it was asked for
//   inUse      touched in the last few hours (someone may be on it now)
//   playing    its bytes are being read right now (lib/fileinuse.js)
//   writing    a download is writing this file
// → { state, staleAt, deleteAt, why }
//   state: fresh | stale | delete | hold | watched | claimed | gone
const judge = ({ rec, now, settings, file = "present", manual = false, watched = null, inUse = false, writing = false, playing = false }) => {
  const clock = Math.max(rec.doneAt || 0, rec.addedAt || 0);
  const deleteAt = clock + settings.myListDeleteDays * DAY_MS;
  const staleAt = Math.min(deleteAt, rec.orphanedAt ? Math.min(rec.orphanedAt, clock + settings.myListStaleDays * DAY_MS) : clock + settings.myListStaleDays * DAY_MS);
  const base = { staleAt, deleteAt };
  if (file === "gone") return { ...base, state: "gone", why: "the file is no longer in the library" };
  if (manual) return { ...base, state: "claimed", why: "someone asked for it by hand" };
  if (watched) return { ...base, state: "watched", why: `watched${watched.by ? ` by ${watched.by}` : ""}` };
  const day = new Date(rec.addedAt || rec.at || clock).toISOString().slice(0, 10);
  const why = rec.orphanedAt
    ? `added to My List on ${day}, taken off every list, never watched`
    : `added to My List on ${day}, never watched`;
  if (now >= deleteAt && settings.myListAutoDelete) {
    if (file === "away") return { ...base, state: "hold", why: `${why} — its drive is not reachable` };
    if (writing) return { ...base, state: "hold", why: `${why} — a download is writing it` };
    if (playing) return { ...base, state: "hold", why: `${why} — someone is playing it right now` };
    if (inUse) return { ...base, state: "hold", why: `${why} — someone opened it in the last few hours` };
    return { ...base, state: "delete", why };
  }
  if (now >= staleAt) return { ...base, state: "stale", why };
  return { ...base, state: "fresh", why: `added to My List on ${day}` };
};

// ---------- over injected dependencies ----------
// `deps` is everything that touches a store, the library, the queue or the
// disk (realDeps() below wires the server's own). The tests hand in fakes and
// a clock, so nothing real is ever deleted.
const make = (deps) => {
  const d = deps;
  const records = () => {
    if (!d.store.data || typeof d.store.data !== "object" || Array.isArray(d.store.data)) d.store.data = {};
    if (!d.store.data.records) d.store.data.records = {};
    return d.store.data.records;
  };
  const save = () => d.store.save();
  const settings = () => readSettings(d.settingsData());
  const log = (m) => d.log(`[mylist] ${m}`);
  const warn = (m) => d.warn(`[mylist] ${m}`);
  const nameOf = (profileId) => { const p = d.profile(profileId); return p ? p.name : profileId; };
  const open = (rec) => rec && !TERMINAL.has(rec.state);

  const close = (rec, state, why) => {
    rec.state = state;
    rec.closedAt = d.now();
    if (why) rec.note = String(why).slice(0, 200);
    save();
  };

  // ----- what the queue did with a job the feature queued -----
  const settle = (rec, job) => {
    if (!job) {
      // The row left the queue's history: nothing of ours to look after.
      return close(rec, "canceled", "its download left the queue");
    }
    if (job.auto !== "mylist") { log(`kept ${labelOf(rec)}: someone asked for it by hand`); return close(rec, "claimed", "someone asked for it by hand"); }
    if (job.status === "done" && job.destPath) {
      rec.state = "done";
      rec.doneAt = Date.parse(job.doneAt) || d.now();
      rec.destPath = job.destPath;
      rec.sizeBytes = d.fileSize(job.destPath);
      save();
      log(`landed ${labelOf(rec)} — stale in ${settings().myListStaleDays} days, deleted in ${settings().myListDeleteDays} unless someone watches it`);
      return;
    }
    if (job.status === "error") {
      warn(`download failed ${labelOf(rec)}: ${String(job.error || "download failed").slice(0, 200)}`);
      return close(rec, "gave-up", job.error || "download failed");
    }
    if (job.status === "canceled" || job.status === "declined") {
      log(`dropped ${labelOf(rec)}: its download was ${job.status}`);
      return close(rec, "canceled", `its download was ${job.status}`);
    }
  };
  // Called by the queue the moment one of its jobs finishes or fails…
  const onJob = (job) => {
    if (!job || job.auto !== "mylist") return;
    const rec = Object.values(records()).find((r) => r.state === "queued" && r.jobId === job.id);
    if (rec) settle(rec, job);
  };
  // …and re-read from the queue itself, so a restart in between loses nothing.
  // A record that never reached the queue is closed: nothing fetches it now.
  const sync = () => {
    const jobs = d.jobs();
    for (const rec of Object.values(records())) {
      if (rec.state === "queued") settle(rec, jobs.find((j) => j.id === rec.jobId) || null);
      else if (rec.state === "wanted" || rec.state === "failed") {
        log(`dropped ${labelOf(rec)}: My List downloads were switched off before it was fetched`);
        close(rec, "canceled", "My List downloads were removed before it was fetched");
      }
    }
  };

  // ----- the finished copy -----
  // Where the copy is now: its path if it is still where it landed; the
  // library's file for this title when that file is byte-for-byte as big
  // (renamed / moved by a rescan); "away"; or null — not ours any more.
  const whereIs = (rec) => {
    if (rec.destPath && d.fileExists(rec.destPath)) return { file: "present", path: rec.destPath };
    if (rec.destPath && d.away(rec.destPath)) return { file: "away", path: rec.destPath };
    const p = d.locate({ imdbId: rec.imdbId, type: rec.type, title: rec.title, year: rec.year, season: rec.season, episode: rec.episode });
    if (p && rec.sizeBytes > 0 && d.fileExists(p) && d.fileSize(p) === rec.sizeBytes) {
      rec.destPath = p;
      save();
      return { file: "present", path: p };
    }
    return { file: "gone", path: null };
  };
  const look = (rec, now = d.now()) => {
    const where = whereIs(rec);
    const jobs = d.jobs();
    // By hand: a person's own job landed on this file, or a person pressed
    // Download on the very source the feature was fetching (the queue then
    // hands the job over to them — see create() in media/downloads.js).
    const manual = !!where.path && jobs.some((j) =>
      j.status === "done" && j.destPath === where.path && j.auto !== "mylist" && (j.id === rec.jobId || !j.smart));
    const writing = !!where.path && jobs.some((j) => j.id !== rec.jobId && LIVE_JOB.has(j.status) && j.imdbId === rec.imdbId &&
      (rec.type !== "show" || (Number(j.season) === Number(rec.season) && Number(j.episode) === Number(rec.episode))));
    const libraryId = where.path ? d.libraryIdForPath(where.path) : null;
    const rows = d.watchRows(rec.key, libraryId) || [];
    const since = rec.at || 0;
    const hit = rows
      .filter((r) => (r.finished || (r.position || 0) >= WATCHED_S) && (r.at || 0) >= since)
      .sort((a, b) => (a.at || 0) - (b.at || 0))[0];
    const inUse = rows.some((r) => (r.at || 0) > now - IN_USE_MS) || !!d.playing(rec.title);
    // Being read right now (any device, signed in or not): the next pass asks again.
    const playing = !!where.path && !!(d.fileInUse && d.fileInUse(where.path));
    const verdict = judge({
      rec, now, settings: settings(), file: where.file, manual, writing, inUse, playing,
      watched: hit ? { at: hit.at, by: hit.name || null } : null,
    });
    return { ...verdict, path: where.path, libraryId };
  };

  // The lifecycle pass (daily). Returns what it did.
  const sweep = (now = d.now()) => {
    const out = { watched: 0, stale: 0, deleted: 0, freedBytes: 0, held: 0 };
    let removed = false;
    for (const rec of Object.values(records())) {
      if (rec.state !== "done") continue;
      const v = look(rec, now);
      if (v.state === "watched") { out.watched++; log(`kept ${labelOf(rec)}: ${v.why} — an ordinary library title from now on`); close(rec, "watched", v.why); continue; }
      if (v.state === "claimed") { log(`kept ${labelOf(rec)}: ${v.why}`); close(rec, "claimed", v.why); continue; }
      if (v.state === "gone") { log(`forgot ${labelOf(rec)}: ${v.why}`); close(rec, "gone", v.why); continue; }
      if (v.state === "hold") { out.held++; log(`not deleting ${labelOf(rec)} yet: ${v.why}`); continue; }
      if (v.state === "stale") {
        out.stale++;
        if (!rec.staleSaid) { rec.staleSaid = now; save(); log(`stale ${labelOf(rec)}: ${v.why}`); }
        continue;
      }
      if (v.state !== "delete") continue;
      try {
        const r = d.deleteFile(v.path) || {};
        out.deleted++;
        out.freedBytes += r.freedBytes || 0;
        removed = true;
        rec.freedBytes = r.freedBytes || 0;
        close(rec, "deleted", v.why);
        log(`deleted ${labelOf(rec)}: ${v.why} — freed ${Math.round((r.freedBytes || 0) / 1e6)} MB (it stays on the list, to stream)`);
      } catch (e) {
        // A file open on Windows refuses to unlink: tomorrow's pass tries again.
        out.held++;
        warn(`could not delete ${labelOf(rec)} yet: ${(e && e.message) || e}`);
      }
    }
    if (removed) { try { d.afterDelete(); } catch (e) { warn(`pass failed: ${(e && e.message) || e}`); } }
    return out;
  };

  // The daily round: settle, sweep, forget what is long closed.
  const daily = async (now = d.now()) => {
    sync();
    const swept = sweep(now);
    for (const [key, rec] of Object.entries(records())) {
      if (TERMINAL.has(rec.state) && now - (rec.closedAt || rec.at || 0) > KEEP_HISTORY_MS) { delete records()[key]; save(); }
    }
    const bits = [];
    if (swept.deleted) bits.push(`${swept.deleted} deleted (${Math.round(swept.freedBytes / 1e6)} MB)`);
    if (swept.stale) bits.push(`${swept.stale} stale`);
    if (swept.watched) bits.push(`${swept.watched} watched`);
    if (swept.held) bits.push(`${swept.held} held`);
    return bits.join(", ") || null;
  };

  // ----- for the admin -----
  const view = (rec, now) => {
    const base = {
      key: rec.key, imdbId: rec.imdbId, type: rec.type, title: rec.title, label: labelOf(rec),
      season: rec.season, episode: rec.episode, by: nameOf(rec.by), people: (rec.profiles || []).map(nameOf),
      addedAt: rec.addedAt || rec.at || null, doneAt: rec.doneAt || null, sizeBytes: rec.sizeBytes || 0,
      state: rec.state, why: rec.note || rec.failReason || null,
      staleAt: null, deleteAt: null, libraryId: null, closedAt: rec.closedAt || null,
    };
    if (rec.state !== "done") return base;
    const v = look(rec, now);
    return { ...base, state: v.state === "delete" ? "stale" : v.state, due: v.state === "delete" || v.state === "hold", why: v.why, staleAt: v.staleAt, deleteAt: v.deleteAt, libraryId: v.libraryId };
  };
  // `open`: how many copies (or jobs on their way) are still looked after —
  // 0 and the admin's card has nothing left to show.
  const status = (now = d.now()) => {
    sync();
    const all = Object.values(records());
    return {
      settings: settings(), limits: LIMITS, defaults: DEFAULTS,
      open: all.filter(open).length,
      records: all.map((r) => view(r, now)).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)),
    };
  };
  // library id → what the "On disk" list and "Free up space" say about a copy
  // the feature fetched and nobody has watched.
  const libraryMarks = (now = d.now()) => {
    const out = new Map();
    const s = settings();
    for (const rec of Object.values(records())) {
      if (rec.state !== "done") continue;
      const v = look(rec, now);
      if (!v.libraryId || !["fresh", "stale", "delete", "hold"].includes(v.state)) continue;
      out.set(v.libraryId, {
        state: v.state === "fresh" ? "fresh" : "stale", why: v.why, by: nameOf(rec.by),
        addedAt: rec.addedAt || rec.at, staleAt: v.staleAt, deleteAt: s.myListAutoDelete ? v.deleteAt : null,
      });
    }
    return out;
  };
  // The admin's "keep this one": the clocks stop, as if it had been watched.
  const keep = (key) => {
    const rec = records()[key];
    if (!rec || rec.state !== "done") return { error: "Nothing to keep under that name." };
    log(`kept ${labelOf(rec)}: the admin said to keep it`);
    close(rec, "claimed", "kept by the admin");
    return { ok: true };
  };
  const setSettings = (body) => {
    const r = parseSettings(body, d.settingsData());
    if (r.error) return r;
    const before = settings();
    Object.assign(d.settingsData(), r.value);
    d.saveSettings();
    const changed = Object.keys(r.value).filter((k) => r.value[k] !== before[k]);
    if (changed.length) log(`settings changed: ${changed.map((k) => `${k}=${r.value[k]}`).join(", ")}`);
    return { ok: true, settings: r.value };
  };

  return { onJob, sync, sweep, daily, status, libraryMarks, keep, setSettings, settings, _records: records };
};

// ---------- the server's own wiring ----------
const realDeps = () => {
  const path = require("path");
  const fs = require("fs");
  const config = require("../config");
  const { JsonStore } = require("../lib/jsonstore");
  const settingsStore = require("../lib/settings");
  const scanner = require("./scanner");
  const identity = require("./identity");
  const downloads = require("./downloads");
  const profiles = require("../profiles");
  const libfiles = require("../lib/libfiles");
  const realtime = require("../realtime");

  const roots = () => [...config.LIBRARIES.movies, ...config.LIBRARIES.shows];
  const at = (row) => Math.max(row.updatedAt || 0, row.markedAt || 0);

  return {
    store: new JsonStore(path.join(config.DATA_DIR, "mylistdl.json"), () => ({ records: {} })),
    settingsData: () => settingsStore.data,
    saveSettings: () => settingsStore.save(),
    now: () => Date.now(),
    log: (m) => console.log(m),
    warn: (m) => console.warn(m),
    profile: (id) => profiles.list().find((p) => p.id === id) || null,
    locate: (want) => {
      const it = identity.findLibraryPlayable(want);
      const entry = it ? scanner.resolve(it.id) : null;
      return entry && entry.kind === "video" ? entry.path : null;
    },
    libraryIdForPath: (p) => scanner.idForPath(p),
    jobs: () => downloads.rawJobs(),
    watchRows: (key, libraryId) => {
      const rows = [];
      for (const p of profiles.list()) {
        const t = profiles.getTitleRow(p.id, key);
        if (t) rows.push({ name: p.name, position: t.position, finished: !!t.finished, at: at(t) });
        const r = libraryId ? (profiles.getProgress(p.id) || {})[libraryId] : null;
        if (r) rows.push({ name: p.name, position: r.position, finished: !!r.finished, at: at(r) });
      }
      return rows;
    },
    // On screen right now: a device that says it is watching this title
    // (presence carries the title's name, not an id — realtime.js "activity").
    playing: (title) => {
      const want = String(title || "").toLowerCase();
      if (!want) return false;
      try {
        for (const c of realtime.clients.values()) {
          if (c.activity === "Watching" && c.details && String(c.details).toLowerCase().includes(want)) return true;
        }
      } catch {}
      return false;
    },
    fileExists: (p) => fs.existsSync(p),
    fileInUse: (p) => require("../lib/fileinuse").fileInUse(p),
    fileSize: (p) => { try { return fs.statSync(p).size; } catch { return 0; } },
    away: (p) => { try { return require("../lib/libroots").under(p); } catch { return false; } },
    deleteFile: (p) => libfiles.deleteVideoFile(p, roots(), config.SUBTITLE_EXTENSIONS),
    afterDelete: () => {
      scanner.scan();
      downloads.pruneGone();
      realtime.libraryUpdated();
    },
  };
};

let live = null;
let liveDeps = null;
const instance = () => live || (live = make((liveDeps = realDeps())));

module.exports = {
  // the running server's instance, made on first use
  onJob: (job) => instance().onJob(job),
  daily: () => instance().daily(),
  status: () => instance().status(),
  libraryMarks: () => instance().libraryMarks(),
  keep: (key) => instance().keep(key),
  setSettings: (body) => instance().setSettings(body),
  make,
  _internals: {
    // Test only (a private copy of the server, never a running one): swap what
    // the live instance asks the outside world — the clock, above all.
    use: (over) => { instance(); Object.assign(liveDeps, over); return liveDeps; },
    records: () => instance()._records(),
    DEFAULTS, LIMITS, readSettings, parseSettings, judge, keyOf, labelOf, WATCHED_S, IN_USE_MS, DAY_MS,
  },
};
