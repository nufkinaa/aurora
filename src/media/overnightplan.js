// OVERNIGHT — the rules, pure (elia 2026-11-09: "Prepare tomorrow's episodes
// overnight … We can even pre download.").
//
// nufurora has no graphics card: two or three live encodes at once is all it
// can do. Most of what the household watches in a day is known the night
// before — the next episode of the shows people are in the middle of, the
// top of Continue watching, what somebody asked for and has not watched yet.
// So two things happen ahead of time:
//
//   AHEAD     the next episode (and, when the disk is comfortable, the one
//             after) of every show a person played in the last ACTIVE_DAYS is
//             downloaded before they need it — smart downloads' own path
//             (media/smartdl.js ahead), in the queue's "Next episode" and
//             "Background" classes (media/dlprio.js). Shows only, never films
//             (the removed My List auto-download is NOT back: a film is only
//             ever fetched because somebody asked for it).
//   PREPARED  at quiet hours, while nobody watches, what tomorrow likely needs
//             is made playable without a live conversion — for the devices
//             these people really use (media/avcaps.js reports, the decision
//             table media/playpath.js), and only where one of them cannot play
//             the file as it is:
//               copy   the picture copied, the sound made AAC, in an MP4 — for
//                      a device that decodes the picture but not the sound or
//                      the container (it would get the live repackaging)
//               h264   a 1080p (never upscaled) 8-bit H.264 + AAC MP4, tone
//                      mapped when the source is HDR — for a device that
//                      cannot decode the picture (it would get a live encode)
//             A device whose start would be a live REPACKAGING is never handed
//             the h264 one (a 4K HDR TV that only lacks DTS keeps its 4K).
//
// Everything here is a function of what it is handed: media/overnight.js
// gathers the facts and does the work; test/overnight-plan.test.js holds the
// rules.
"use strict";
const playpath = require("./playpath");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const GB = 1024 ** 3;

// What the admin sets (Admin → Downloads → Overnight → Details).
const DEFAULTS = Object.freeze({
  on: true,            // on unless turned off
  from: "02:00",       // the quiet hours, house time (the server's clock)
  to: "07:00",
  budgetPct: 10,       // prepared files may use at most this share of the free space
  aheadEpisodes: 2,    // 0 = nothing downloaded ahead, 1 = the next episode, 2 = and the one after
});
const BUDGET_PCT = { min: 1, max: 50 };

// The clock and the thresholds — config.json "overnight" may override any of
// them by name (the tests and the rig run on a short clock).
const TIMING = Object.freeze({
  activeDays: 14,          // a show played in the last 14 days is one somebody is watching
  deviceDays: 30,          // a device report seen in the last 30 days is a device of the house
  landedDays: 3,           // a download somebody asked for, landed in the last 3 days
  continueTop: 3,          // the first 3 of each person's Continue watching
  staleDays: 7,            // a prepared file nothing wanted or played for 7 days goes
  quietStartMs: 10 * MIN,  // nobody watching for 10 minutes before a run starts
  resumeQuietMs: 3 * MIN,  // a paused job goes on after 3 quiet minutes
  maxPauseMs: 30 * MIN,    // paused this long: stopped, tried again when it is quiet
  tickMs: 5000,            // how often the runner looks (and so how fast it pauses)
  planEveryMs: 15 * MIN,   // the plan is made again this often during a run
  aheadEveryMs: HOUR,      // the downloads-ahead sweep runs this often, day and night
  headroomBytes: 5 * GB,   // free space that always stays free, whatever the budget says
  forecastStopDays: 7,     // the disk full in under a week: nothing downloaded ahead
  forecastOneDays: 30,     // under a month: only the next episode
  watchedSec: 60,          // a play this long (or a finished one) counts as watching the show
});

const timingOf = (raw) => {
  const out = { ...TIMING };
  if (raw && typeof raw === "object") {
    for (const k of Object.keys(TIMING)) {
      const v = raw[k];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = v;
    }
  }
  return out;
};

// ------------------------------------------------------------- settings
const hhmm = (s) => {
  const m = /^\s*([01]?\d|2[0-3])[:.]([0-5]\d)\s*$/.exec(String(s == null ? "" : s));
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
};
const minutesOf = (s) => {
  const [h, m] = String(s).split(":").map(Number);
  return h * 60 + m;
};

/** The settings as kept → a whole, valid set (anything odd reads as its default). */
const settingsOf = (raw) => {
  const r = raw && typeof raw === "object" ? raw : {};
  let from = hhmm(r.from) || DEFAULTS.from;
  let to = hhmm(r.to) || DEFAULTS.to;
  if (from === to) { from = DEFAULTS.from; to = DEFAULTS.to; } // no window at all is no setting
  const pct = Math.round(Number(r.budgetPct));
  const ahead = Math.round(Number(r.aheadEpisodes));
  return {
    on: r.on !== false,
    from,
    to,
    budgetPct: Number.isFinite(pct) && r.budgetPct !== "" && r.budgetPct != null ? Math.min(BUDGET_PCT.max, Math.max(BUDGET_PCT.min, pct)) : DEFAULTS.budgetPct,
    aheadEpisodes: Number.isFinite(ahead) && r.aheadEpisodes !== "" && r.aheadEpisodes != null ? Math.min(2, Math.max(0, ahead)) : DEFAULTS.aheadEpisodes,
  };
};

// ------------------------------------------------------------- the hours
// (local time: the server's clock is the house's — nufurora runs in it)
const minuteOfDay = (t) => { const d = new Date(t); return d.getHours() * 60 + d.getMinutes(); };

/** Is `t` inside the quiet hours? (from 23:00 to 06:00 wraps past midnight) */
const inWindow = (t, s) => {
  const m = minuteOfDay(t);
  const a = minutesOf(s.from);
  const b = minutesOf(s.to);
  return a < b ? m >= a && m < b : m >= a || m < b;
};

const atMinute = (t, minute) => {
  const c = new Date(t);
  c.setHours(Math.floor(minute / 60), minute % 60, 0, 0);
  return c;
};
/** When the next quiet hours begin (strictly after `t`). */
const nextStart = (t, s) => {
  const c = atMinute(t, minutesOf(s.from));
  if (c.getTime() <= t) c.setDate(c.getDate() + 1);
  return c.getTime();
};
/** When the quiet hours `t` is in (or the next ones) end. */
const windowEnd = (t, s) => {
  const c = atMinute(t, minutesOf(s.to));
  if (c.getTime() <= t) c.setDate(c.getDate() + 1);
  return c.getTime();
};
const clockOf = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

// ------------------------------------------------------------- who watches what
/** A progress row counts as finished: marked so, or within the last tenth. */
const isFinished = (r) => !!(r && (r.finished || (r.duration > 0 && r.position / r.duration >= 0.9)));

/**
 * The shows a person is actually watching: one entry per show, played in the
 * last `activeDays` (a real play — a minute in, or finished; a peek is not
 * watching), the latest episode they touched as its anchor. Newest first.
 *   rows   [{ itemId, ep: { imdbId, season, episode, quality } | null,
 *             position, duration, finished, updatedAt }]
 */
const activeShows = (rows, { now = Date.now(), activeDays = TIMING.activeDays, watchedSec = TIMING.watchedSec } = {}) => {
  const by = new Map();
  for (const r of rows || []) {
    if (!r || !r.ep || !r.ep.imdbId || r.ep.season == null || r.ep.episode == null) continue;
    if (!(now - (r.updatedAt || 0) <= activeDays * DAY)) continue;
    if (!isFinished(r) && !(r.position >= watchedSec)) continue;
    const had = by.get(r.ep.imdbId);
    if (!had || (r.updatedAt || 0) > (had.updatedAt || 0)) by.set(r.ep.imdbId, r);
  }
  return [...by.values()]
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map((r) => ({ imdbId: r.ep.imdbId, anchor: { season: Number(r.ep.season), episode: Number(r.ep.episode), quality: r.ep.quality || null, finished: isFinished(r), itemId: r.itemId, updatedAt: r.updatedAt || 0 } }));
};

/**
 * The episodes this person plays next, in order, from the catalogue's real
 * list (specials left out, across seasons): the anchor itself first when it
 * is not finished (they will go back to it), then what follows — `depth` of
 * them, never one that has not aired. [] when the catalogue does not know the
 * anchor (an odd numbering) or the series ends there.
 *   seasons  [{ number, episodes: [{ season, episode, title, released }] }]
 */
const upcoming = (seasons, anchor, depth, now = Date.now()) => {
  if (!anchor || !(depth > 0)) return [];
  const flat = (seasons || [])
    .filter((s) => Number(s.number) > 0)
    .flatMap((s) => s.episodes || [])
    .filter((e) => e && Number.isFinite(Number(e.season)) && Number.isFinite(Number(e.episode)));
  const i = flat.findIndex((e) => Number(e.season) === Number(anchor.season) && Number(e.episode) === Number(anchor.episode));
  if (i < 0) return [];
  const out = [];
  for (let j = anchor.finished ? i + 1 : i; j < flat.length && out.length < depth; j++) {
    const e = flat[j];
    if (e.released && Date.parse(e.released) > now) break; // not aired yet: nothing after it has either
    out.push({ season: Number(e.season), episode: Number(e.episode), title: e.title || null, nth: out.length });
  }
  return out;
};

/** How many episodes ahead may be downloaded, by the setting and the disk forecast (media/diskforecast.js). */
const aheadDepth = ({ setting = DEFAULTS.aheadEpisodes, forecast = null, timing = TIMING } = {}) => {
  if (!(setting > 0)) return { depth: 0, why: "turned off" };
  if (forecast && forecast.state === "filling" && Number.isFinite(forecast.daysLeft)) {
    if (forecast.daysLeft < timing.forecastStopDays) return { depth: 0, why: `the disk is ${forecast.short || "nearly full"} at this week's pace — nothing is downloaded ahead` };
    if (forecast.daysLeft < timing.forecastOneDays && setting > 1) return { depth: 1, why: `the disk is ${forecast.short || "filling"} at this week's pace — only the next episode` };
  }
  return { depth: setting, why: null };
};

// ------------------------------------------------------------- what a device needs
const AAC = Object.freeze({ index: 0, codec: "aac", channels: 2, profile: null, atmos: false });
const KINDS = ["copy", "h264"];

/** The facts of the "copy" rendition of a file (playpath facts), or null when there can be none. */
const copyFacts = (f) => {
  const v = f && f.video;
  if (!v || !playpath.COPYABLE.has(v.codec)) return null;
  // Dolby Vision's RPU does not reliably survive a repackaging into MP4: a
  // picture with the wrong colours is worse than the live copy
  if (v.hdr === "dolby-vision") return null;
  return { container: "mp4", width: f.width || 0, height: f.height || 0, video: { ...v }, audio: [{ ...AAC }] };
};

/** The height of the h264 rendition: the source's, never more than 1080 (never upscaled). */
const h264Height = (f) => (f && f.height > 0 ? Math.min(1080, f.height) : 1080);

/** The facts of the "h264" rendition, or null. `tonemap`: this server can map HDR to SDR. */
const h264Facts = (f, { tonemap = true } = {}) => {
  const v = f && f.video;
  if (!v || !v.codec) return null;
  if (v.hdr === "dolby-vision" && (v.dvCompat === 0 || v.dvProfile === 5)) return null; // no base layer the filters can map
  if (v.hdr && !tonemap) return null; // a grey, washed-out copy is worse than the live encode
  const h = h264Height(f);
  const w = f.height > 0 && f.width > 0 ? Math.round((f.width * h) / f.height / 2) * 2 : Math.round((h * 16) / 9 / 2) * 2;
  return { container: "mp4", width: w, height: h, video: { codec: "h264", bitDepth: 8, hdr: null, fps: v.fps || 0, profile: "High", dvProfile: null, dvCompat: null }, audio: [{ ...AAC }] };
};

const renditionFacts = (kind, f, opts) => (kind === "copy" ? copyFacts(f) : kind === "h264" ? h264Facts(f, opts) : null);

/**
 * What one device needs for one file: { mode, kind, why } — `mode` how the
 * file starts there as it is (direct / remux / transcode), `kind` the
 * rendition that would make it start directly ("copy" | "h264" | null).
 *   track   the audio track the person starts on (its index)
 */
const needFor = (facts, caps, { track = null, tonemap = true } = {}) => {
  const d = playpath.decide(facts, caps, { track });
  if (!d) return { mode: null, kind: null, why: "no decision" };
  if (d.mode === "direct") return { mode: "direct", kind: null, why: "plays as it is" };
  const c = copyFacts(facts);
  if (c && playpath.decide(c, caps).mode === "direct") return { mode: d.mode, kind: "copy", why: `${d.mode} live → a copy plays directly` };
  // the h264 one only where the start would be a live ENCODE anyway: a device
  // that only needs the sound fixed keeps its full picture (the live copy)
  if (d.mode !== "transcode") return { mode: d.mode, kind: null, why: "the live copy keeps the full picture here" };
  const h = h264Facts(facts, { tonemap });
  if (h && playpath.decide(h, caps).mode === "direct") return { mode: d.mode, kind: "h264", why: "encode live → a 1080p H.264 plays directly" };
  return { mode: d.mode, kind: null, why: "nothing this server makes plays directly there" };
};

/** Every device's need → the kinds to make (a Set) and one row per device. */
const needsOf = (facts, devices, opts = {}) => {
  const kinds = new Set();
  const rows = [];
  for (const dev of devices || []) {
    if (!dev || !dev.caps) continue;
    const n = needFor(facts, dev.caps, opts);
    rows.push({ id: dev.id, client: dev.caps.client, model: dev.caps.model || "", ...n });
    if (n.kind) kinds.add(n.kind);
  }
  return { kinds, rows };
};

/**
 * Which ready rendition a device plays, for the title read it asked
 * (/api/item?caps=): the copy first (the full picture), then the h264 — only
 * one that plays DIRECTLY there, and the h264 only where the file itself
 * would be a live encode. null = play the file the way it always did.
 *   ready   [{ kind, facts }]   original  the decision for the file as it is
 */
const pickReady = (ready, caps, original) => {
  if (!caps || !original || original.mode === "direct") return null;
  for (const kind of KINDS) {
    if (kind === "h264" && original.mode !== "transcode") continue;
    const r = (ready || []).find((x) => x && x.kind === kind && x.facts);
    if (!r) continue;
    const d = playpath.decide(r.facts, caps);
    if (d && d.mode === "direct") return { ...r, play: d };
  }
  return null;
};

// ------------------------------------------------------------- sizes and the budget
// kbit/s of the h264 rendition, picture + sound (veryfast, crf 21 — a little
// above the phone copies' crf-23 table in media/offline.js)
const H264_KBPS = (h) => (h >= 1000 ? 5400 : h >= 700 ? 2800 : 1300);
/** What a rendition will weigh, before it is made (an estimate, said as one). */
const estimateBytes = (kind, { sizeBytes = 0, duration = 0, height = 0 } = {}) => {
  if (kind === "copy") return Math.max(0, sizeBytes || 0); // the picture again, and a lighter sound
  if (kind === "h264") return duration > 0 ? Math.round(((H264_KBPS(Math.min(1080, height || 1080)) * 1000) / 8) * duration) : Math.max(0, Math.round((sizeBytes || 0) * 0.6));
  return 0;
};

/**
 * The disk the prepared files may use: budgetPct of the free space they could
 * have (what is free + what they already use), never so much that less than
 * `headroomBytes` would stay free. 0 when the free space is not known.
 */
const budgetBytes = ({ freeBytes, preparedBytes = 0, pct = DEFAULTS.budgetPct, headroomBytes = TIMING.headroomBytes } = {}) => {
  if (!(typeof freeBytes === "number" && freeBytes >= 0)) return 0;
  const pool = freeBytes + Math.max(0, preparedBytes);
  const cap = Math.floor((pool * pct) / 100);
  return Math.max(0, Math.min(cap, pool - headroomBytes));
};

// Why a title is wanted, the most pressing first.
const REASONS = { next: 0, continue: 1, landed: 2 };
const REASON_WORDS = { next: "the next episode of a show someone is watching", continue: "near the top of Continue watching", landed: "asked for and not watched yet" };

/**
 * Tonight's list, inside the budget.
 *   wants   [{ key, id, kind, bytes, reason, at, label, persons }] — at: how recent (ms)
 *   have    Map(key → { bytes }) — what is already on disk
 *   budget  bytes
 * → { make: [want…], keep: [key…], skip: [{ …want, why }], evict: [{ key, why }], usedBytes }
 * Order: the reason (next episode first), then the h264 before the copy (a
 * live encode is the scarce thing, a live copy is cheap), then the most
 * recent. What is on disk and still wanted keeps its place before anything
 * new of the same standing; what is on disk and NOT wanted any more goes
 * first when the budget is short.
 */
const fit = ({ wants = [], have = new Map(), budget = 0 } = {}) => {
  const ordered = wants
    .map((w, i) => ({ w, i }))
    .sort((a, b) =>
      (REASONS[a.w.reason] ?? 9) - (REASONS[b.w.reason] ?? 9) ||
      (a.w.kind === b.w.kind ? 0 : a.w.kind === "h264" ? -1 : 1) ||
      (have.has(b.w.key) ? 1 : 0) - (have.has(a.w.key) ? 1 : 0) ||
      (b.w.at || 0) - (a.w.at || 0) ||
      a.i - b.i)
    .map((x) => x.w);
  const make = [];
  const keep = [];
  const skip = [];
  const evict = [];
  const seen = new Set();
  let used = 0;
  for (const w of ordered) {
    if (seen.has(w.key)) continue;
    seen.add(w.key);
    const had = have.get(w.key);
    const bytes = had ? had.bytes || 0 : w.bytes || 0;
    if (used + bytes <= budget) {
      used += bytes;
      (had ? keep : make).push(had ? w.key : w);
    } else if (had) {
      evict.push({ key: w.key, why: "the disk budget is needed for something wanted more" });
    } else {
      skip.push({ ...w, why: "over the disk budget" });
    }
  }
  // on disk, wanted by nobody tonight: kept while there is room (the clean-up
  // rules take it later), the oldest first out when there is none
  const rest = [...have.entries()].filter(([k]) => !seen.has(k)).sort((a, b) => (a[1].usedAt || a[1].madeAt || 0) - (b[1].usedAt || b[1].madeAt || 0));
  let restBytes = rest.reduce((n, [, v]) => n + (v.bytes || 0), 0);
  for (const [k, v] of rest) {
    if (used + restBytes <= budget) break;
    evict.push({ key: k, why: "not wanted tonight, and the budget is short" });
    restBytes -= v.bytes || 0;
  }
  return { make, keep, skip, evict, usedBytes: used };
};

/**
 * The prepared files that go, whatever the budget:
 *   items  [{ key, id, kind, bytes, persons, madeAt, usedAt, srcMtime }]
 *   f      { mtimeOf(id) → ms | null (not in the library), finished(id, person) → bool,
 *            partWay(id) → bool (someone is in the middle of it), playing(id) → bool,
 *            wanted: Set(key) }
 * → [{ key, why }]
 */
const cleanup = (items, f, { now = Date.now(), staleDays = TIMING.staleDays } = {}) => {
  const out = [];
  for (const it of items || []) {
    if (!it || !it.key) continue;
    if (f.playing && f.playing(it.id)) continue; // never from under somebody
    const mt = f.mtimeOf(it.id);
    if (mt == null) { out.push({ key: it.key, why: "the title is no longer in the library" }); continue; }
    if (it.srcMtime && Math.floor(mt) !== Math.floor(it.srcMtime)) { out.push({ key: it.key, why: "the file it was made from was replaced" }); continue; }
    const wanted = !!(f.wanted && f.wanted.has(it.key));
    const persons = (it.persons || []).filter(Boolean);
    if (!wanted && persons.length && persons.every((p) => f.finished(it.id, p)) && !(f.partWay && f.partWay(it.id))) {
      out.push({ key: it.key, why: "watched by everyone it was made for" });
      continue;
    }
    if (!wanted && now - Math.max(it.madeAt || 0, it.usedAt || 0) > staleDays * DAY) {
      out.push({ key: it.key, why: `not needed for ${staleDays} days` });
    }
  }
  return out;
};

// ------------------------------------------------------------- the runner
/**
 * One look of the runner: what to do now.
 *   on        the feature is on        inWindow  inside the quiet hours
 *   forced    the admin pressed Run now (the hours do not apply; nobody watching still does)
 *   busy      somebody is watching (presence, a stream request, a viewer encode)
 *   quietMs   how long nobody has been watching
 *   job       { running, paused, pausedMs } of the conversion under way, or null
 *   pending   something is left to make
 * → "start" | "go-on" | "pause" | "hold" | "resume" | "stop" | "wait" | "idle"
 *   stop: the hours are over (or it was turned off) — or it has been paused
 *   too long; the file is left for later and the job tried again
 */
const step = ({ on = true, inWindow: inside = false, forced = false, busy = false, quietMs = Infinity, job = null, pending = false, timing = TIMING } = {}) => {
  const allowed = on && (inside || forced);
  if (job && job.running) {
    if (!allowed) return "stop";
    if (busy) {
      if (!job.paused) return "pause";
      return job.pausedMs >= timing.maxPauseMs ? "stop" : "hold";
    }
    if (job.paused) {
      if (job.pausedMs >= timing.maxPauseMs) return "stop";
      return quietMs >= timing.resumeQuietMs ? "resume" : "hold";
    }
    return "go-on";
  }
  if (!allowed || !pending) return "idle";
  if (busy || quietMs < timing.quietStartMs) return "wait";
  return "start";
};

// ------------------------------------------------------------- the line
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
/**
 * The admin's one calm line:
 *   "Overnight: 6 episodes prepared, 3 downloaded ahead · next run 02:00"
 *   prepared  { episodes, films }   ahead  how many downloaded ahead (last day)
 *   state     "idle" | "running" | "paused" | "waiting"
 */
const statusLine = ({ on = true, prepared = { episodes: 0, films: 0 }, ahead = 0, aheadOn = true, nextRunAt = null, state = "idle", making = null } = {}) => {
  if (!on) return aheadOn && ahead > 0 ? `Overnight: off · ${ahead} downloaded ahead` : "Overnight: off";
  const ep = prepared.episodes || 0;
  const fl = prepared.films || 0;
  const n = ep + fl;
  const parts = [];
  if (n > 0) parts.push(fl === 0 ? `${plural(ep, "episode", "episodes")} prepared` : ep === 0 ? `${plural(fl, "film", "films")} prepared` : `${plural(n, "title", "titles")} prepared`);
  if (ahead > 0) parts.push(`${ahead} downloaded ahead`);
  const what = parts.length ? parts.join(", ") : "nothing prepared yet";
  const tail =
    state === "running" ? `preparing${making ? ` ${making}` : ""} now`
      : state === "paused" ? "paused while someone watches"
        : state === "waiting" ? "waiting for everyone to stop watching"
          : nextRunAt ? `next run ${clockOf(nextRunAt)}` : "";
  return `Overnight: ${what}${tail ? ` · ${tail}` : ""}`;
};

module.exports = {
  DEFAULTS, TIMING, BUDGET_PCT, KINDS, REASONS, REASON_WORDS,
  timingOf, settingsOf, hhmm, inWindow, nextStart, windowEnd, clockOf,
  isFinished, activeShows, upcoming, aheadDepth,
  copyFacts, h264Facts, h264Height, renditionFacts, needFor, needsOf, pickReady,
  estimateBytes, budgetBytes, fit, cleanup, step, statusLine,
};
