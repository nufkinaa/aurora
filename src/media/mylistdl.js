// My List downloads (elia, 2026-10-10): "we want to download the first episode
// / the movie when somebody added it to their list. After two weeks if they
// haven't watched it it goes stale (means we can suggest it on the delete
// suggestions freely) and after 3 it deletes automatically."
//
// One hook, server-side, in the watchlist-add route (routes/profiles.js) — so
// the website and the TV app behave the same and neither can forget it.
//
// THE RULES
//
//   Trigger   Adding a title to any profile's list asks for: a film → the
//             film; a show → its FIRST episode, S1E1 — and only when the
//             ADDING profile has not started the show (no progress on any of
//             its episodes, finished or not, played or marked). A show that
//             profile is already in is left to smart downloads (smartdl.js),
//             which fetch the next episode while one is being watched (the
//             owner's decision, 2026-10-10). It is the adding profile that
//             counts, not "anyone": somebody else being three seasons in
//             says nothing about whether this person has a first episode to
//             start with.
//   Not when  the feature is off, torrents are off, shows are excluded, the
//             profile is a kids profile and the title is over its limit or
//             unrated (lib/kids.js — unknown is "no"), the copy is already in
//             the library, a download of it is already queued (by anyone, by
//             hand or not — two profiles adding one title is ONE download),
//             the disk gate says no, or the profile has used its daily cap
//             (then it waits for a later daily pass instead of being lost).
//   How       Same source pick and same queue as smart downloads
//             (smartdl.pickSource → downloads.create). The job carries
//             `auto: "mylist"` and `smart: true`: the queue, the slots, the
//             second-source race, the disk gate at start time and the
//             "tidy up after watching" rule for episodes all apply unchanged.
//   Last      In the queue it is the LOWEST priority of all, and it is put on
//             hold — what it has is kept — while anything else needs to be
//             downloaded (the owner, 2026-10-10; the rule is dlslots.plan(),
//             the setting is myListYield). Waiting or on hold, its job is
//             simply still "approved" in the queue: nothing here changes, and
//             the clocks below start when it LANDS, however much later.
//
//   Watched   Any profile has real progress on the copy SINCE it was asked
//             for: finished (a hand mark counts) or at least a minute in.
//             Progress from before does not count — the clock is about
//             whether THIS copy gets used.
//   Clock     Starts when the download finished, and starts again when the
//             title is added to a list again while the copy is on disk.
//   Stale     staleDays (14) on the clock, never watched → listed as a free
//             candidate in the admin's "Free up space" suggestions, with why.
//   Delete    deleteDays (21) on the clock, never watched → the file and its
//             sidecar subtitles are removed through lib/libfiles.js (the same
//             path the admin's Delete uses), the library is rescanned. The
//             title STAYS on the person's list — it is stream-only again.
//             Never while it is being played or was touched in the last six
//             hours, never while a download is writing it, never when its
//             drive is unplugged, never a file somebody asked for by hand.
//   Watched   at any point: both clocks stop for good and the copy is an
//             ordinary library title from then on.
//   Removed   from every list before it is watched: a download still in the
//             queue is cancelled; a finished copy becomes stale at once and
//             is still deleted at its deleteDays.
//   Failed    (no source, the engine gave up, the disk gate refused): written
//             down, retried on a later DAILY pass at most `retries` (1) times,
//             then left alone.
//
// What is ours is decided by this module's own record (data/mylistdl.json),
// keyed by the TITLE ("tt123" / "tt123:1:1"), never by a path: a rescan or a
// rename does not lose it. A renamed file is recognised by title + exact size;
// anything else under that title is somebody else's file and is never touched.
//
// Every decision is one log line starting "[mylist] ".
"use strict";

const DAY_MS = 24 * 3600 * 1000;
const WATCHED_S = 60;                 // "real progress": a minute in (the admin tree's own line)
const IN_USE_MS = 6 * 3600 * 1000;    // touched this recently = someone may be on it right now
const RETRY_GAP_MS = 20 * 3600 * 1000; // a failed fetch is tried again by a LATER daily pass, not this one
const KEEP_HISTORY_MS = 60 * DAY_MS;  // closed records stay this long for the admin's list
const TERMINAL = new Set(["watched", "deleted", "gone", "claimed", "canceled", "gave-up", "have"]);
const LIVE_JOB = new Set(["pending", "approved", "downloading"]);

// ---------- settings ----------
// Stored in data/settings.json (lib/settings.js) under these names. A file
// written before a key existed reads as the default.
const DEFAULTS = Object.freeze({
  myListDownloads: true,   // the feature
  myListShows: true,       // shows too (the first episode, for someone who has not started it), not only films
  myListStaleDays: 14,     // unwatched this long → a free delete suggestion
  myListDeleteDays: 21,    // unwatched this long → deleted
  myListAutoDelete: true,  // false: nothing is deleted by itself, stale copies only show as suggestions
  myListDailyCap: 5,       // downloads one profile's list may start per 24 hours
  myListRetries: 1,        // how many later daily passes may try a failed one again
  // How a My List download gives way to the others (media/dlslots.js):
  // "always" — on hold while any other download is waiting or running;
  // "slots"  — only while another download is waiting for a slot.
  myListYield: "always",
});
const LIMITS = Object.freeze({
  myListStaleDays: [1, 365],
  myListDeleteDays: [1, 730],
  myListDailyCap: [1, 50],
  myListRetries: [0, 5],
});
const BOOLS = ["myListDownloads", "myListShows", "myListAutoDelete"];
const YIELD_MODES = require("./dlslots").YIELD_MODES;
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
  out.myListYield = YIELD_MODES.includes(d.myListYield) ? d.myListYield : DEFAULTS.myListYield;
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
  const names = {
    myListStaleDays: "Stale after", myListDeleteDays: "Delete after",
    myListDailyCap: "Per person per day", myListRetries: "Retries",
  };
  for (const k of NUMS) {
    if (b[k] === undefined) continue;
    const n = wholeIn(b[k], LIMITS[k]);
    if (n == null) return { error: `${names[k]} must be a whole number from ${LIMITS[k][0]} to ${LIMITS[k][1]}.` };
    next[k] = n;
  }
  if (b.myListYield !== undefined) {
    if (!YIELD_MODES.includes(b.myListYield)) return { error: `Gives way must be one of: ${YIELD_MODES.join(", ")}.` };
    next.myListYield = b.myListYield;
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

// Is there a first episode to fetch? From the show's episode list:
// "ok" | "not-aired" | "no-episodes". (Season 0 is specials — never "first".)
const firstEpisode = (meta, now) => {
  const s1 = ((meta && meta.seasons) || []).find((s) => Number(s.number) === 1);
  const e1 = s1 && (s1.episodes || []).find((e) => Number(e.episode) === 1);
  if (!e1) return "no-episodes";
  if (e1.released && new Date(e1.released).getTime() > now) return "not-aired";
  return "ok";
};

// The lifecycle of one finished copy, pure. Everything is handed in:
//   rec        the record (doneAt, addedAt, at, orphanedAt)
//   file       "present" | "away" (its drive is unplugged) | "gone"
//   manual     somebody asked for this file by hand
//   watched    { at, by } | null — real progress since it was asked for
//   inUse      touched in the last few hours (someone may be on it now)
//   writing    a download is writing this file
// → { state, staleAt, deleteAt, why }
//   state: fresh | stale | delete | hold | watched | claimed | gone
const judge = ({ rec, now, settings, file = "present", manual = false, watched = null, inUse = false, writing = false }) => {
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
    if (inUse) return { ...base, state: "hold", why: `${why} — someone opened it in the last few hours` };
    return { ...base, state: "delete", why };
  }
  if (now >= staleAt) return { ...base, state: "stale", why };
  return { ...base, state: "fresh", why: `added to My List on ${day}` };
};

// What the watchlist route hands back for the client's toast.
const answer = (queued, rest) => ({ queued, ...rest });

// ---------- the feature, over injected dependencies ----------
// `deps` is everything that touches a store, the library, the queue, the
// disk or the network (realDeps() below wires the server's own). The tests
// hand in fakes and a clock, so nothing real is ever downloaded or deleted.
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

  // A watchlist entry (library id string, or stream ref) → the title behind
  // it: { imdbId, type, title, year, poster, libShowId? } | { none: reason }.
  const titleOf = (item) => {
    if (item && typeof item === "object") {
      if (!/^tt\d{4,12}$/.test(String(item.imdbId || ""))) return { none: "unknown-title" };
      return {
        imdbId: String(item.imdbId), type: item.type === "show" ? "show" : "movie",
        title: String(item.title || "").slice(0, 160) || "Untitled", year: item.year || null, poster: item.poster || null,
      };
    }
    const lib = typeof item === "string" ? d.libraryItem(item) : null;
    if (!lib) return { none: "unknown-title" };
    if (lib.showId) return { none: "in-library" }; // an episode id: it is on disk
    if (lib.type !== "show") return { none: "in-library", imdbId: lib.imdbId || null, type: "movie" };
    if (!lib.imdbId) return { none: "unknown-title" };
    return { imdbId: lib.imdbId, type: "show", title: lib.title, year: lib.year || null, poster: null, libShowId: lib.id };
  };

  const recordsOf = (imdbId) => Object.values(records()).filter((r) => r.imdbId === imdbId);
  // A job for exactly this film / episode that is on its way or has landed.
  const jobFor = (want) =>
    d.jobs().find(
      (j) =>
        j.imdbId === want.imdbId &&
        (want.type !== "show" || (Number(j.season) === Number(want.season) && Number(j.episode) === Number(want.episode))) &&
        (want.type === "show") === (j.type === "show") &&
        (LIVE_JOB.has(j.status) || j.status === "done"),
    ) || null;

  const startedToday = (profileId, now) =>
    Object.values(records()).filter((r) =>
      r.by === profileId && !r.waiting && r.state !== "have" && !(r.state === "canceled" && !r.queuedAt) &&
      (r.acceptedAt || 0) > now - DAY_MS).length;

  // ----- the trigger -----
  // Synchronous and local: it only reads what the server already holds, so the
  // My List button answers as fast as it always did. The source lookup and the
  // queueing happen after, one title at a time (fetch()).
  const onAdd = (profileId, item) => {
    const now = d.now();
    const s = settings();
    const t = titleOf(item);
    // The copy this feature fetched is on disk and the title was just added
    // (again): its clock starts again, and it is nobody's orphan any more.
    const touch = (imdbId) => {
      let any = false;
      for (const r of recordsOf(imdbId)) {
        if (r.state !== "done") continue;
        r.addedAt = now;
        delete r.orphanedAt;
        delete r.staleSaid;
        if (!r.profiles.includes(profileId)) r.profiles.push(profileId);
        any = true;
      }
      if (any) save();
    };
    if (t.none) {
      if (t.imdbId) touch(t.imdbId);
      return answer(false, { reason: t.none });
    }
    touch(t.imdbId);
    if (!s.myListDownloads) return answer(false, { reason: "off" });
    if (!d.torrentsOn()) return answer(false, { reason: "torrents-off" });
    if (t.type === "show" && !s.myListShows) return answer(false, { reason: "shows-off" });
    const profile = d.profile(profileId);
    if (!profile) return answer(false, { reason: "unknown-profile" });
    if (!d.kidsAllowed(profileId, t.imdbId)) {
      log(`skipped ${t.title} for ${profile.name}: over the kids limit (or unrated)`);
      return answer(false, { reason: "kids" });
    }

    let want = { ...t };
    if (t.type === "show") {
      // Already in it → nothing from here; the next-episode download while
      // watching (smart downloads) is what keeps a started show supplied.
      if (d.startedShow(profileId, t.imdbId, t.libShowId || null)) return answer(false, { reason: "started" });
      const meta = d.metaCached("series", t.imdbId);
      const first = meta ? firstEpisode(meta, now) : "ok"; // (not cached: the fetch step reads the list)
      if (first !== "ok") return answer(false, { reason: first });
      want = { ...t, season: 1, episode: 1 };
    }
    const what = want.type === "show" ? { what: "episode", season: 1, episode: 1 } : { what: "film" };

    if (d.inLibrary(want)) return answer(false, { reason: "in-library", ...what });
    const key = keyOf(want.imdbId, want.season, want.episode);
    const cur = records()[key];
    if (open(cur) && cur.state !== "done") {
      // Somebody's list already asked for it: one download, two people waiting.
      if (!cur.profiles.includes(profileId)) { cur.profiles.push(profileId); save(); }
      return answer(false, { reason: cur.waiting ? "waiting" : "already-queued", ...what });
    }
    if (jobFor(want)) return answer(false, { reason: "already-queued", ...what });

    const rec = {
      key, imdbId: want.imdbId, type: want.type, title: want.title, year: want.year, poster: want.poster,
      season: want.season ?? null, episode: want.episode ?? null,
      by: profileId, profiles: [profileId], at: now, addedAt: now,
      state: "wanted", attempts: 0,
    };
    if (startedToday(profileId, now) >= s.myListDailyCap) {
      rec.waiting = "cap";
      records()[key] = rec;
      save();
      log(`waiting ${labelOf(rec)} for ${profile.name}: ${s.myListDailyCap} already started from this list today`);
      return answer(false, { reason: "daily-cap", ...what });
    }
    const gate = d.diskGate(want.type, 0);
    if (!gate.ok) {
      records()[key] = { ...rec, state: "failed", attempts: 1, failedAt: now, failReason: "disk" };
      save();
      warn(`could not queue ${labelOf(rec)} for ${profile.name}: ${gate.reason || "not enough free space"}`);
      return answer(false, { reason: "disk", ...what });
    }
    rec.acceptedAt = now;
    records()[key] = rec;
    save();
    enqueue(key);
    return answer(true, what);
  };

  // ----- one title at a time: find a source, hand it to the queue -----
  let chain = Promise.resolve();
  const enqueue = (key) => {
    chain = chain.then(() => fetch(key)).catch((e) => warn(`pass failed: ${(e && e.message) || e}`));
    return chain;
  };
  const failed = (rec, reason) => {
    rec.state = "failed";
    rec.attempts = (rec.attempts || 0) + 1;
    rec.failedAt = d.now();
    rec.failReason = String(reason || "failed").slice(0, 200);
    delete rec.jobId;
    save();
    warn(`could not queue ${labelOf(rec)}: ${rec.failReason}`);
  };
  const close = (rec, state, why) => {
    rec.state = state;
    rec.closedAt = d.now();
    if (why) rec.note = String(why).slice(0, 200);
    save();
  };
  const listed = (rec) =>
    d.listsWith({ imdbId: rec.imdbId, type: rec.type, title: rec.title, year: rec.year });

  const fetch = async (key) => {
    const rec = records()[key];
    if (!rec || rec.state !== "wanted" || rec.waiting) return;
    const s = settings();
    if (!s.myListDownloads || !d.torrentsOn()) return close(rec, "canceled", "switched off before it started");
    const on = listed(rec);
    if (!on.length) { log(`dropped ${labelOf(rec)}: no longer on anyone's list`); return close(rec, "canceled", "taken off every list"); }
    if (!on.includes(rec.by)) rec.by = on[0];

    // A show: is there a first episode out yet? (An unreadable list does not
    // stop it — a show with no S1E1 simply finds no source below.) And the
    // person may have started it in the meantime (a retry runs a day later).
    if (rec.type === "show") {
      if (d.startedShow(rec.by, rec.imdbId, null)) { log(`nothing to fetch for ${labelOf(rec)}: ${nameOf(rec.by)} has started the show`); return close(rec, "have", "the show was started"); }
      const meta = await d.meta("series", rec.imdbId).catch(() => null);
      if (meta) {
        const first = firstEpisode(meta, d.now());
        if (first !== "ok") { log(`nothing to fetch for ${rec.title}: ${first}`); return close(rec, "have", first); }
        if (!rec.year) rec.year = meta.year || null;
        if (!rec.poster) rec.poster = meta.poster || null;
        save();
      }
      if (records()[key] !== rec || rec.state !== "wanted") return; // (awaited: it may have been taken off the list)
    }
    const want = { imdbId: rec.imdbId, type: rec.type, title: rec.title, year: rec.year, season: rec.season, episode: rec.episode };
    if (d.inLibrary(want)) { log(`nothing to fetch for ${labelOf(rec)}: already in the library`); return close(rec, "have", "already in the library"); }
    const job = jobFor(want);
    if (job) {
      if (job.auto === "mylist" && LIVE_JOB.has(job.status)) { rec.state = "queued"; rec.jobId = job.id; save(); return; }
      log(`nothing to fetch for ${labelOf(rec)}: a download of it is already in the queue`);
      return close(rec, "have", "someone's own download covers it");
    }
    let gate = d.diskGate(rec.type, 0);
    if (!gate.ok) return failed(rec, gate.reason || "not enough free space");

    let streams = [];
    try {
      streams = ((await d.sources(rec.type === "show" ? "series" : "movie", rec.imdbId, rec.year, rec.season, rec.episode)) || {}).streams || [];
    } catch (e) {
      return failed(rec, `no source (${(e && e.message) || e})`);
    }
    const pick = d.pickSource(streams, null);
    if (!pick) return failed(rec, "no source");
    gate = d.diskGate(rec.type, pick.sizeBytes || 0);
    if (!gate.ok) return failed(rec, gate.reason || "not enough free space");
    // (everything above awaited: look once more before anything is created)
    if (records()[rec.key] !== rec || rec.state !== "wanted") return;
    if (!listed(rec).length) { log(`dropped ${labelOf(rec)}: no longer on anyone's list`); return close(rec, "canceled", "taken off every list"); }

    const r = d.createJob({
      infoHash: pick.infoHash, fileIdx: pick.fileIdx || 0,
      type: rec.type, imdbId: rec.imdbId, title: rec.title, label: rec.type === "show" ? labelOf(rec) : null,
      year: rec.year, poster: rec.poster, quality: pick.quality, sizeBytes: pick.sizeBytes,
      season: rec.season, episode: rec.episode, provider: pick.provider, seeders: pick.seeders,
      profile: rec.by, profileName: nameOf(rec.by),
      smart: true, auto: "mylist",
    }) || {};
    if (r.error) return failed(rec, r.error);
    if (r.alreadyAvailable) { log(`nothing to fetch for ${labelOf(rec)}: already in the library`); return close(rec, "have", "already in the library"); }
    if (r.duplicate && !(r.job && r.job.auto === "mylist")) {
      log(`nothing to fetch for ${labelOf(rec)}: that source is already someone's download`);
      return close(rec, "have", "someone's own download covers it");
    }
    rec.state = "queued";
    rec.jobId = r.job && r.job.id;
    rec.quality = pick.quality || null;
    rec.queuedAt = d.now();
    delete rec.failReason;
    save();
    log(`queued ${labelOf(rec)} for ${nameOf(rec.by)} (${pick.quality || "?"}, ${pick.seeders || 0} seeders${r.needsApproval ? ", waiting for approval: disk" : ""})`);
  };

  // ----- what the queue did with our job -----
  const settle = (rec, job) => {
    if (!job) {
      // The row left the queue's history. A copy we can still recognise keeps
      // its clock; otherwise there is nothing of ours to look after.
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
      rec.state = "failed";
      rec.attempts = (rec.attempts || 0) + 1;
      rec.failedAt = d.now();
      rec.failReason = String(job.error || "download failed").slice(0, 200);
      save();
      warn(`download failed ${labelOf(rec)}: ${rec.failReason}`);
      return;
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
  const sync = () => {
    const jobs = d.jobs();
    for (const rec of Object.values(records())) {
      if (rec.state !== "queued") continue;
      settle(rec, jobs.find((j) => j.id === rec.jobId) || null);
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
    // Download on the very source we were fetching (the queue then hands our
    // job over to them — see downloads.create).
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
    const verdict = judge({
      rec, now, settings: settings(), file: where.file, manual, writing, inUse,
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

  // The daily round: settle, sweep, then the ones that are waiting or failed.
  const daily = async (now = d.now()) => {
    sync();
    const swept = sweep(now);
    const s = settings();
    let retried = 0;
    let started = 0;
    const byAge = Object.values(records()).sort((a, b) => (a.at || 0) - (b.at || 0));
    for (const rec of byAge) {
      if (rec.state === "failed") {
        if ((rec.attempts || 0) > s.myListRetries) { log(`gave up on ${labelOf(rec)}: ${rec.failReason || "failed"}`); close(rec, "gave-up", rec.failReason); continue; }
        if (!s.myListDownloads || !d.torrentsOn()) continue;
        if (now - (rec.failedAt || 0) < RETRY_GAP_MS) continue;
        rec.state = "wanted";
        if (!rec.acceptedAt) rec.acceptedAt = now;
        save();
        retried++;
        log(`trying ${labelOf(rec)} again (${rec.failReason || "failed"})`);
        enqueue(rec.key);
      } else if (rec.state === "wanted" && rec.waiting === "cap") {
        if (now - (rec.at || 0) > s.myListStaleDays * DAY_MS) { log(`dropped ${labelOf(rec)}: waited ${s.myListStaleDays} days for a free slot in the daily cap`); close(rec, "canceled", "waited too long"); continue; }
        if (!s.myListDownloads || !d.torrentsOn()) continue;
        if (startedToday(rec.by, now) >= s.myListDailyCap) continue;
        delete rec.waiting;
        rec.acceptedAt = now;
        save();
        started++;
        enqueue(rec.key);
      } else if (rec.state === "wanted") {
        enqueue(rec.key); // accepted, then the server stopped before the lookup ran
      }
    }
    for (const [key, rec] of Object.entries(records())) {
      if (TERMINAL.has(rec.state) && now - (rec.closedAt || rec.at || 0) > KEEP_HISTORY_MS) { delete records()[key]; save(); }
    }
    await chain;
    sync();
    const bits = [];
    if (swept.deleted) bits.push(`${swept.deleted} deleted (${Math.round(swept.freedBytes / 1e6)} MB)`);
    if (swept.stale) bits.push(`${swept.stale} stale`);
    if (swept.watched) bits.push(`${swept.watched} watched`);
    if (swept.held) bits.push(`${swept.held} held`);
    if (retried) bits.push(`${retried} retried`);
    if (started) bits.push(`${started} started`);
    return bits.join(", ") || null;
  };

  // ----- taken off a list -----
  const onRemove = (profileId, item) => {
    const t = titleOf(item);
    const imdbId = t.imdbId || null;
    if (!imdbId) return;
    const now = d.now();
    for (const rec of recordsOf(imdbId)) {
      if (!open(rec)) continue;
      rec.profiles = rec.profiles.filter((p) => p !== profileId);
      const on = listed(rec);
      if (on.length) {
        if (!on.includes(rec.by)) rec.by = on[0];
        save();
        continue;
      }
      if (rec.state === "done") {
        if (!rec.orphanedAt) { rec.orphanedAt = now; save(); log(`stale ${labelOf(rec)}: taken off every list before anyone watched it`); }
        continue;
      }
      if (rec.state === "queued") {
        const job = d.jobs().find((j) => j.id === rec.jobId);
        if (job && job.auto === "mylist" && LIVE_JOB.has(job.status)) {
          // (closed first: the queue reports the cancel straight back to onJob)
          close(rec, "canceled", "taken off every list");
          log(`canceled ${labelOf(rec)}: taken off every list before it finished downloading`);
          try { d.cancelJob(job.id); } catch (e) { warn(`pass failed: ${(e && e.message) || e}`); }
          continue;
        }
        settle(rec, job || null);
        if (rec.state === "done" && !rec.orphanedAt) { rec.orphanedAt = now; save(); log(`stale ${labelOf(rec)}: taken off every list before anyone watched it`); }
        continue;
      }
      log(`dropped ${labelOf(rec)}: taken off every list`);
      close(rec, "canceled", "taken off every list");
    }
  };

  // ----- for the admin -----
  const view = (rec, now) => {
    const base = {
      key: rec.key, imdbId: rec.imdbId, type: rec.type, title: rec.title, label: labelOf(rec),
      season: rec.season, episode: rec.episode, by: nameOf(rec.by), people: (rec.profiles || []).map(nameOf),
      addedAt: rec.addedAt || rec.at || null, doneAt: rec.doneAt || null, sizeBytes: rec.sizeBytes || 0,
      state: rec.waiting ? "waiting" : rec.state, why: rec.note || rec.failReason || (rec.waiting === "cap" ? "over today's cap — starts on a later day" : null),
      staleAt: null, deleteAt: null, libraryId: null, attempts: rec.attempts || 0, closedAt: rec.closedAt || null,
    };
    if (rec.state !== "done") return base;
    const v = look(rec, now);
    return { ...base, state: v.state === "delete" ? "stale" : v.state, due: v.state === "delete" || v.state === "hold", why: v.why, staleAt: v.staleAt, deleteAt: v.deleteAt, libraryId: v.libraryId };
  };
  const status = (now = d.now()) => {
    sync();
    const s = settings();
    return {
      settings: s, limits: LIMITS, defaults: DEFAULTS,
      records: Object.values(records()).map((r) => view(r, now)).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)),
    };
  };
  // library id → what the "On disk" list and "Free up space" say about a copy
  // this feature fetched and nobody has watched.
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
    // The queue reads myListYield on its next look — make that look now.
    if (changed.includes("myListYield") && d.requeue) { try { d.requeue(); } catch (e) { warn(`pass failed: ${(e && e.message) || e}`); } }
    return { ok: true, settings: r.value };
  };

  return { onAdd, onRemove, onJob, sync, sweep, daily, status, libraryMarks, keep, setSettings, settings, idle: () => chain, _records: records };
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
  const discover = require("./discover");
  const torrent = require("./torrent");
  const downloads = require("./downloads");
  const profiles = require("../profiles");
  const kids = require("../lib/kids");
  const libfiles = require("../lib/libfiles");
  const realtime = require("../realtime");
  const { pickSource } = require("./smartdl")._internals;

  // The same reading of a title's age the request gate uses (routes/api.js):
  // the strictest known age, else the cached label; unknown is "no".
  const certOf = kids.makeCertOf({
    cached: (imdbId) => discover.certificateCached(imdbId),
    strict: (imdbId) => {
      const age = discover.certificateAge(imdbId);
      if (age == null) discover.warmCertificate(null, imdbId);
      return age;
    },
  });
  const roots = () => [...config.LIBRARIES.movies, ...config.LIBRARIES.shows];
  const at = (row) => Math.max(row.updatedAt || 0, row.markedAt || 0);

  return {
    store: new JsonStore(path.join(config.DATA_DIR, "mylistdl.json"), () => ({ records: {} })),
    settingsData: () => settingsStore.data,
    saveSettings: () => settingsStore.save(),
    now: () => Date.now(),
    log: (m) => console.log(m),
    warn: (m) => console.warn(m),
    torrentsOn: () => require("../lib/torrentgate").enabled(),
    profile: (id) => profiles.list().find((p) => p.id === id) || null,
    kidsAllowed: (profileId, imdbId) => {
      const k = profiles.kidsOf(profileId);
      return !k || kids.allowed({ imdbId, _isTorrent: true }, k.maxAge, certOf);
    },
    libraryItem: (id) => {
      identity.ensureStamped();
      const it = scanner.findById(id);
      if (!it) return null;
      return { id: it.id, type: it.type, showId: it.showId || null, title: it.title, year: it.year || null, imdbId: it.imdbId || identity.imdbIdFor(it) || null };
    },
    inLibrary: (want) => !!identity.findLibraryPlayable(want),
    locate: (want) => {
      const it = identity.findLibraryPlayable(want);
      const entry = it ? scanner.resolve(it.id) : null;
      return entry && entry.kind === "video" ? entry.path : null;
    },
    libraryIdForPath: (p) => scanner.idForPath(p),
    // Has this profile any history in the show — an episode played (from the
    // library or as a stream) or marked, finished or not?
    startedShow: (profileId, imdbId, libShowId) => {
      const touched = (r) => !!r && (r.finished || (r.position || 0) > 0);
      // every episode's shared history row is keyed "<imdbId>:<s>:<e>"
      const rows = profiles.streamEpisodeProgress(profileId) || {};
      if (Object.keys(rows).some((k) => k.startsWith(`${imdbId}:`) && touched(rows[k]))) return true;
      // …and a library copy whose IMDb id was not known when it was played
      const lib = scanner.findById(libShowId || "") || identity.findLibraryFor({ imdbId, type: "show" });
      if (!lib || lib.type !== "show") return false;
      const progress = profiles.getProgress(profileId) || {};
      return (lib.seasons || []).some((s) => (s.episodes || []).some((e) => touched(progress[e.id])));
    },
    metaCached: (type, imdbId) => discover.metaCached(type, imdbId),
    meta: (type, imdbId) => discover.meta(type, imdbId),
    sources: (type, imdbId, year, season, episode) => torrent.getSources(type, imdbId, year, season, episode),
    pickSource,
    jobs: () => downloads.rawJobs(),
    createJob: (fields) => downloads.create(fields),
    cancelJob: (id) => downloads.cancel(id),
    requeue: () => downloads.pumpNow(),
    diskGate: (type, sizeBytes) => downloads.diskGate(type, sizeBytes),
    listsWith: (title) => {
      const lib = identity.findLibraryFor(title);
      return profiles.list().filter((p) =>
        (profiles.getWatchlist(p.id) || []).some((e) =>
          typeof e === "string" ? !!lib && e === lib.id : e && e.imdbId === title.imdbId)).map((p) => p.id);
    },
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
    fileSize: (p) => { try { return fs.statSync(p).size; } catch { return 0; } },
    away: (p) => { try { return require("../lib/libroots").under(p); } catch { return false; } },
    deleteFile: (p) => libfiles.deleteVideoFile(p, roots(), config.SUBTITLE_EXTENSIONS),
    afterDelete: () => {
      scanner.scan();
      downloads.pruneGone();
      realtime.broadcastAll({ type: "library_updated" });
    },
  };
};

let live = null;
let liveDeps = null;
const instance = () => live || (live = make((liveDeps = realDeps())));

module.exports = {
  // the running server's instance, made on first use
  onAdd: (profileId, item) => instance().onAdd(profileId, item),
  onRemove: (profileId, item) => instance().onRemove(profileId, item),
  onJob: (job) => instance().onJob(job),
  daily: () => instance().daily(),
  status: () => instance().status(),
  libraryMarks: () => instance().libraryMarks(),
  keep: (key) => instance().keep(key),
  setSettings: (body) => instance().setSettings(body),
  make,
  _internals: {
    // Test only (a private copy of the server, never a running one): swap what
    // the live instance asks the outside world — the source lookup, the clock.
    use: (over) => { instance(); Object.assign(liveDeps, over); return liveDeps; },
    idle: () => instance().idle(),
    records: () => instance()._records(),
    DEFAULTS, LIMITS, readSettings, parseSettings, firstEpisode, judge, keyOf, labelOf, WATCHED_S, IN_USE_MS, DAY_MS, RETRY_GAP_MS,
  },
};
