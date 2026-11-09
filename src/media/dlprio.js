// WHO GOES FIRST, and when one download may push the others aside for a few
// minutes. Pure functions over plain data; media/downloads.js does the I/O.
//
// elia, 2026-11-03: "I think that the next episode for someone is more
// important then someone's just downloading something else, if an episode
// has more then some number of peers and less then a gig for example and we
// know it's download will take almost no time we can pause other downloads
// which is lower priority and start the next episode for someone so it will
// be smooth for all."
//
// THE CLASSES (lower goes first):
//   0  NOW        what somebody is watching right now — the next episode of
//                 the show on their screen (smart downloads, the player's Up
//                 next), or a download that is being streamed while it lands
//   1  PERSON     a person asked for it (Download, Save & watch, Get another
//                 version, Try again)
//   2  AUTO       the next episode smart downloads fetched for later
//   3  BACKGROUND a followed show's new episode, what My List left behind,
//                 the episode after next downloaded ahead (media/overnight.js)
//
// FAIRNESS: a waiting job moves up one class for every AGE_STEP_MS it has
// waited — never past PERSON (only a real viewer makes NOW) — so automatic
// work is never starved for good. Inside a class: the job that has waited
// longest goes first.
//
// NOW jumps the queue: it starts at once, past "Downloads at once", the hold
// while people watch and the per-account limit — at most NOW_EXTRA of them
// over the setting at a time.
//
// PRE-EMPTING: when a NOW job looks QUICK (small, well seeded, a few minutes
// at the speed this line has shown lately), every lower-class download that
// is running is throttled to a trickle (aria2's per-download speed limit — it
// keeps its peers and its place) until the NOW job is in, then let go again.
// Never for long, never for ever:
//   * it ends when the NOW job finishes, fails, is cancelled or stalls, when
//     it turns out not to be quick after all (judged on its live speed after
//     QUICK_CHECK_MS), or after PREEMPT_MAX_MS at the latest;
//   * a person's own download is held back for at most VICTIM_BUDGET_MS in
//     any VICTIM_WINDOW_MS, then it is left alone however urgent the rest;
//   * a NOW job that was not quick does not pre-empt again (hysteresis), and
//     after a pre-emption ends nothing starts a new one for COOLDOWN_MS.
"use strict";

const MIN = 60 * 1000;
const MB = 1e6;

const NOW = 0;
const PERSON = 1;
const AUTO = 2;
const BACKGROUND = 3;
const LABELS = ["Watching now", "Asked for", "Next episode", "Background"];

const DEFAULTS = {
  ageStepMs: 30 * MIN,        // waiting this long moves a job up one class (never past PERSON)
  nowExtra: 2,                // NOW jobs allowed past "Downloads at once"
  urgentTailMs: 20 * MIN,     // a next episode stays NOW this long after the last progress report
  // ---- what "quick" means ----
  quickMaxBytes: 1.5e9,       // "less than a gig, for example": a 1080p episode is 0.5–1.5 GB
  quickMinSeeders: 10,        // the source list's seeders ("more than some number of peers")
  quickMaxEtaMs: 6 * MIN,     // the estimate, at the speed below
  perSeederBps: 300 * 1024,   // a seeder on a public swarm gives ~0.1–1 MB/s; this is a cautious middle
  defaultLineBps: 8 * MB,     // a line we have not measured yet: 64 Mbit/s
  // ---- live check: is it really quick? ----
  quickCheckMs: 90 * 1000,    // after this long running…
  quickAbortEtaMs: 15 * MIN,  // …a live ETA over this ends the pre-emption
  // ---- limits ----
  preemptMaxMs: 12 * MIN,     // one pre-emption never lasts longer
  victimBudgetMs: 20 * MIN,   // a person's download is held back at most this long…
  victimWindowMs: 2 * 3600e3, // …in any two hours
  cooldownMs: 2 * MIN,        // after a pre-emption ends, none starts for this long
  trickleBps: 24 * 1024,      // what a held-back download may still fetch (keeps its peers talking)
};

const resolveConfig = (raw) => {
  const cfg = { ...DEFAULTS };
  if (raw && typeof raw === "object") {
    for (const k of Object.keys(DEFAULTS)) {
      const v = raw[k];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) cfg[k] = v;
    }
  }
  return cfg;
};

// The class a job was asked in, before any ageing. `t` and `urgentUntil` are
// wall-clock ms (urgency is set from progress reports, which are wall clock).
//   streaming  a set of lower-case infoHashes being streamed right now
const baseClass = (job, t = Date.now(), streaming = null) => {
  if (!job) return BACKGROUND;
  if (job.urgentUntil && job.urgentUntil > t) return NOW;
  if (streaming && job.infoHash && streaming.has(String(job.infoHash).toLowerCase())) return NOW;
  if (!job.smart) return PERSON;
  if (job.auto === "follow" || job.auto === "mylist" || job.auto === "ahead") return BACKGROUND;
  return AUTO;
};

// …and after ageing: `waitedMs` is how long it has been waiting its turn.
const effectiveClass = (base, waitedMs, cfg = DEFAULTS) => {
  if (base <= PERSON) return base;
  const steps = cfg.ageStepMs > 0 ? Math.floor(Math.max(0, waitedMs) / cfg.ageStepMs) : 0;
  return Math.max(PERSON, base - steps);
};

// The queue in the order jobs start. `waiting`: [{ id, cls, since }] where
// `since` is when it started waiting (ms); stable for equal keys.
const order = (waiting) =>
  (waiting || []).map((w, i) => ({ w, i }))
    .sort((a, b) => (a.w.cls - b.w.cls) || ((a.w.since || 0) - (b.w.since || 0)) || (a.i - b.i))
    .map((x) => x.w);

// ---------- the start plan ----------
// What to start now.
//   cap        "Downloads at once" (2 while someone watches — dlslots.startCap)
//   setting    the setting itself (NOW may go NOW_EXTRA past it, never the hold)
//   holders    [{ id, owner, key, cls }] — running jobs that hold a slot right
//              now (a stalled one does not; `key` groups jobs on ONE torrent:
//              a season pack fetching three episodes is one slot)
//   waiting    [{ id, owner, key, cls, since }]
//   perOwner   the per-account limit (0 = none)
// → { start: [id…], overLimit: [id…] }
const plan = ({ cap, setting = cap, holders = [], waiting = [], perOwner = 3 }, cfg = DEFAULTS) => {
  const start = [];
  const keys = new Set(holders.map((h) => h.key || h.id));
  const owned = new Map();
  const ownedKeys = new Map();
  const own = (o, key) => {
    if (!o) return;
    const ks = ownedKeys.get(o) || new Set();
    if (ks.has(key)) return;            // a second episode of the same pack: no extra count
    ks.add(key);
    ownedKeys.set(o, ks);
    owned.set(o, (owned.get(o) || 0) + 1);
  };
  for (const h of holders) own(h.owner, h.key || h.id);
  const fits = (w) => !w.owner || !(perOwner > 0) || (owned.get(w.owner) || 0) < perOwner || (ownedKeys.get(w.owner) || new Set()).has(w.key || w.id);
  // NOW may run past the hold while people watch (the next episode IS what
  // the watching needs) and up to NOW_EXTRA past the setting itself.
  const nowCeiling = Math.max(cap, setting) + cfg.nowExtra;
  for (const w of order(waiting)) {
    const key = w.key || w.id;
    const joins = keys.has(key);        // rides on a torrent that is already running: free
    if (w.cls === NOW) {
      if (!joins && keys.size >= nowCeiling) continue;
      start.push(w.id);
      keys.add(key);
      own(w.owner, key);
      continue;
    }
    if (!joins && keys.size >= cap) continue;
    if (!fits(w)) continue;
    start.push(w.id);
    keys.add(key);
    own(w.owner, key);
  }
  const overLimit = (waiting || []).filter((w) => !start.includes(w.id) && w.cls !== NOW && !fits(w)).map((w) => w.id);
  return { start, overLimit };
};

// ---------- quick? ----------
// Before it starts: from the source list (size, seeders) and the speed this
// line has shown lately. → { quick, etaMs, why }
const quickEstimate = ({ sizeBytes, seeders, lineBps }, cfg = DEFAULTS) => {
  const size = Number(sizeBytes) || 0;
  const seeds = Number(seeders) || 0;
  if (!(size > 0)) return { quick: false, etaMs: Infinity, why: "its size is not known" };
  if (size > cfg.quickMaxBytes) return { quick: false, etaMs: Infinity, why: `it is ${(size / 1e9).toFixed(1)} GB (quick means under ${(cfg.quickMaxBytes / 1e9).toFixed(1)} GB)` };
  if (seeds < cfg.quickMinSeeders) return { quick: false, etaMs: Infinity, why: `only ${seeds} seeder${seeds === 1 ? "" : "s"} listed (quick needs ${cfg.quickMinSeeders})` };
  const line = lineBps > 0 ? lineBps : cfg.defaultLineBps;
  const rate = Math.min(line, seeds * cfg.perSeederBps);
  const etaMs = (size / rate) * 1000;
  if (etaMs > cfg.quickMaxEtaMs) return { quick: false, etaMs, why: `about ${Math.round(etaMs / MIN)} min at this line's speed` };
  return { quick: true, etaMs, why: null };
};

// While it runs: is it still worth holding the others back?
//   runMs   how long the NOW job has been downloading
//   etaMs   its live time remaining (from its smoothed speed)
// → "keep" | "end"
const liveVerdict = ({ runMs, etaMs, stalled }, cfg = DEFAULTS) => {
  if (stalled) return "end";
  if (runMs < cfg.quickCheckMs) return "keep";
  return etaMs > cfg.quickAbortEtaMs ? "end" : "keep";
};

// Who is held back. `running`: [{ id, cls, key, heldMs }] — heldMs: how long
// this job has been held back inside the last victimWindowMs. A job on the
// same torrent as the NOW job is never held back (it IS the same download).
const victims = ({ urgentKeys, running }, cfg = DEFAULTS) =>
  (running || []).filter((r) => r.cls > NOW && !(urgentKeys && urgentKeys.has(r.key)) &&
    (r.cls > PERSON || (r.heldMs || 0) < cfg.victimBudgetMs)).map((r) => r.id);

// A job's record of being held back: [{ from, to }] (ms) → ms inside the window.
const heldWithin = (spans, t, cfg = DEFAULTS) => {
  let ms = 0;
  for (const s of spans || []) {
    const from = Math.max(s.from || 0, t - cfg.victimWindowMs);
    const to = s.to || t;
    if (to > from) ms += to - from;
  }
  return ms;
};

module.exports = {
  NOW, PERSON, AUTO, BACKGROUND, LABELS, DEFAULTS, resolveConfig,
  baseClass, effectiveClass, order, plan, quickEstimate, liveVerdict, victims, heldWithin,
};
