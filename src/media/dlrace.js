// The second-source race ("hedged download"): every decision, as pure
// functions over plain data. media/downloads.js does the I/O and calls these.
//
// What it is: when a download is slow because of its SOURCE, the next-best
// source of the same resolution is started alongside it. Whichever finishes
// first is kept, the other is cancelled. It is conservative on purpose — a
// race that makes a download slower is a bug — so most of this file is
// reasons NOT to race.
//
//   slowReason         is this attempt slow?  (time remaining, not raw speed)
//   shouldRace         …and is it the source's fault, and is now a safe moment?
//   chooseChallenger   which source runs against it
//   probeVerdict       did the challenger connect in its short trial window?
//   knockout           is one attempt so far ahead the other should stop early?
//   noGain             did the race add nothing (the line was the limit)?
//   leader             whose progress the viewer's one card shows
//   settleOnRestart    which attempt survives a server restart
//
// Nothing here knows about aria2, files or the clock: `now` is passed in.

const MIB = 1024 * 1024;

// Every number below can be overridden from config.json:
//   "downloadRace": { "episodeBudgetMin": 30, "maxRaces": 2 }
//   "downloadRace": false          switches the feature off
const DEFAULTS = {
  // ---- 1. is it slow? ----
  // No torrent details (the file list) this long after the start. A healthy
  // swarm answers in seconds; the healer only steps in at 12 minutes.
  noMetaSec: 120,
  // Details arrived, but not one seeder or peer has connected.
  noPeersSec: 180,
  // Speed says nothing in the first minutes (peers are still being found,
  // the first pieces are the slowest). The projected finish is only judged
  // this long after the start…
  slowGraceSec: 300,
  // …and once the smoothed speed has this much history behind it.
  settleSec: 90,
  // The smoothing window for an attempt's speed (an EWMA's time constant).
  speedTauSec: 60,
  // The time a download may reasonably take. An episode projected to finish
  // later than this is slow; a film gets longer.
  episodeBudgetMin: 45,
  filmBudgetMin: 120,
  // Big files are allowed longer than the flat budget: size / this speed
  // (1.5 MiB/s ≈ 12 Mbit/s). A 60 GB remux gets ~11 h, not 2.
  budgetRateBps: 1.5 * MIB,

  // ---- 3. never race a job that is nearly done ----
  nearlyDoneFraction: 0.7,
  nearlyDoneEtaSec: 600,

  // ---- 2. it has to be the source's fault ----
  // The admin's download cap: all downloads together at this share of it or
  // more means the cap, not the source, sets the pace.
  capNear: 0.8,
  // The line: all downloads together at this share of the best total seen
  // lately (a decaying high-water mark) means the line is full…
  lineNear: 0.8,
  // …provided the others really are using it (their share of the total)…
  lineOthersShare: 0.25,
  // …and the high-water mark is a believable line speed. Two dying
  // downloads at 40 KB/s each "fill" a mark of 80 KB/s; that is not a line.
  lineMinBps: 1 * MIB,
  // How fast the mark fades (it halves in this long without a new best).
  lineHalfLifeMin: 15,

  // ---- 4. the challenger ----
  // Its size, as a multiple of the original's.
  sizeBandLow: 0.4,
  sizeBandHigh: 2.5,

  // ---- 5. the probe ----
  // A challenger has this long to fetch the torrent's details AND connect to
  // a real seeder (or move a byte). Otherwise it is cancelled and remembered.
  probeSec: 75,

  // ---- 8. early knockout ----
  // One attempt's time remaining under this share of the other's…
  knockoutRatio: 1 / 3,
  // …for this long, and the slower one is cancelled.
  knockoutHoldSec: 120,
  // And the reverse safeguard: after this long racing, if the two together
  // are not at least gainMin times the original's speed from before the race
  // — and the challenger would not beat the original left alone — the race
  // added nothing but contention, and the challenger is stopped.
  gainCheckSec: 180,
  gainMin: 1.3,

  // ---- 10. hard limits ----
  maxRaces: 1,               // races server-wide at a time
  maxChallengersPerJob: 2,   // challengers STARTED per job in its lifetime
  // After a race ends without a winner, or no source qualified: how long
  // before that job is considered again.
  retryMin: 10,

  // ---- 9. memory ----
  memoryDays: 42,            // how long a source's outcome is remembered
};

// config.json's "downloadRace" → the numbers in use. Unknown keys and values
// that are not non-negative numbers are ignored, never fatal.
const resolveConfig = (raw) => {
  const cfg = { enabled: raw !== false, ...DEFAULTS };
  if (raw && typeof raw === "object") {
    if (raw.enabled === false) cfg.enabled = false;
    for (const k of Object.keys(DEFAULTS)) {
      const v = raw[k];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) cfg[k] = v;
    }
  }
  cfg.maxRaces = Math.floor(cfg.maxRaces);
  cfg.maxChallengersPerJob = Math.floor(cfg.maxChallengersPerJob);
  if (cfg.maxRaces < 1 || cfg.maxChallengersPerJob < 1) cfg.enabled = false;
  return cfg;
};

// ---------- speed and time ----------

// One step of an exponentially weighted average over samples that do not
// arrive on an exact beat: a sample `dtMs` after the last one moves the
// average by 1 − e^(−dt/τ).
const ewma = (prev, sample, dtMs, tauMs) => {
  if (!(dtMs > 0) || !(tauMs > 0)) return sample;
  const a = 1 - Math.exp(-dtMs / tauMs);
  return prev + a * (sample - prev);
};

const etaSec = (remainingBytes, speedBps) => {
  if (!(remainingBytes > 0)) return 0;
  if (!(speedBps > 0)) return Infinity;
  return remainingBytes / speedBps;
};

// "5M" / "500K" / "1048576" (aria2's format: K and M are powers of 1024) →
// bytes per second; 0 = no cap.
const parseRate = (s) => {
  const m = /^(\d+)([KM]?)$/i.exec(String(s ?? "").trim());
  if (!m) return 0;
  return Number(m[1]) * (m[2] ? (m[2].toUpperCase() === "M" ? MIB : 1024) : 1);
};

const fmtDur = (sec) => {
  if (!Number.isFinite(sec)) return "no end in sight";
  if (sec < 90) return `${Math.round(sec)} s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  return `${(sec / 3600).toFixed(1)} h`;
};

// The time this download may reasonably take.
const budgetSec = (type, sizeBytes, cfg) => {
  const flat = (type === "show" ? cfg.episodeBudgetMin : cfg.filmBudgetMin) * 60;
  const bySize = cfg.budgetRateBps > 0 ? (sizeBytes || 0) / cfg.budgetRateBps : 0;
  return Math.max(flat, bySize);
};

// ---------- 1. slow? ----------
// `a` is one attempt as plain data:
//   { type, sizeBytes, startedAt, metaAt, connectedAt, speed, fraction, remainingBytes }
// (times in ms, 0 = not yet; speed = the smoothed one). Returns a sentence, or
// null when the attempt is fine or still inside its grace.
const slowReason = (a, now, cfg) => {
  if (!a || !a.startedAt) return null;
  const age = (now - a.startedAt) / 1000;
  if (!a.metaAt) {
    return age >= cfg.noMetaSec ? `no torrent details after ${fmtDur(age)}` : null;
  }
  if (!a.connectedAt) {
    return age >= cfg.noPeersSec ? `no seeders or peers after ${fmtDur(age)}` : null;
  }
  if (age < cfg.slowGraceSec || (now - a.connectedAt) / 1000 < cfg.settleSec) return null;
  const eta = etaSec(a.remainingBytes, a.speed);
  const budget = budgetSec(a.type, a.sizeBytes, cfg);
  if (eta <= budget) return null;
  return Number.isFinite(eta)
    ? `projected to take ${fmtDur(eta)} more (a download this size should take under ${fmtDur(budget)})`
    : "connected, but no bytes are arriving";
};

// ---------- 3. nearly done ----------
const nearlyDone = (a, cfg) =>
  (a.fraction || 0) >= cfg.nearlyDoneFraction || etaSec(a.remainingBytes, a.speed) <= cfg.nearlyDoneEtaSec;

// ---------- 2. whose fault ----------
// The admin's cap is what limits the downloads.
const capBound = ({ capBps, totalBps }, cfg) => capBps > 0 && totalBps >= capBps * cfg.capNear;

// The decaying high-water mark of total download speed: { bps, at }.
const updatePeak = (prev, totalBps, now, cfg) => {
  const half = cfg.lineHalfLifeMin * 60 * 1000;
  let bps = 0;
  if (prev && prev.bps > 0) {
    const dt = Math.max(0, now - (prev.at || now));
    bps = half > 0 ? prev.bps * Math.pow(0.5, dt / half) : 0;
  }
  return { bps: Math.max(bps, totalBps || 0), at: now };
};

// The line is the bottleneck: everything together is near the best the line
// has done lately, and it is the OTHER downloads that are using it. A
// download running alone is never line-bound by this rule — its own speed is
// the whole total, which says nothing about the line.
const lineBound = ({ ownBps, totalBps, peakBps }, cfg) => {
  if (!(peakBps >= cfg.lineMinBps) || !(totalBps > 0)) return false;
  if (totalBps < peakBps * cfg.lineNear) return false;
  return totalBps - (ownBps || 0) >= totalBps * cfg.lineOthersShare;
};

// Can other sources be looked up for this job the way its own was found?
const searchable = (job) =>
  !!(job && /^tt\d+$/i.test(String(job.imdbId || "")) &&
    (job.type !== "show" || (Number(job.season) > 0 && Number(job.episode) > 0)));

// The verdict for one running job.
//   a    the attempt (see slowReason) plus { searchable, challengersStarted, retryAt, racing }
//   env  { torrentsOn, engineHealthy, watching, streamActive, capBps, totalBps, peakBps, racesRunning }
// → { race, slow, blocked } — `slow` is why it is a candidate (null: it is
//   not), `blocked` is { code, text } for the first rule that says no.
const shouldRace = (a, env, cfg, now) => {
  const no = (slow, code, text) => ({ race: false, slow, blocked: code ? { code, text } : null });
  if (!cfg.enabled) return no(null, "off", "second-source races are switched off");
  if (a.racing) return no(null);
  const slow = slowReason(a, now, cfg);
  if (!slow) return no(null);
  if (!env.torrentsOn) return no(slow, "torrents-off", "torrents are switched off");
  if (!env.engineHealthy) return no(slow, "engine", "the download engine is not healthy");
  if (!a.searchable) return no(slow, "unsearchable", "this request does not carry enough to look up other sources");
  if ((a.challengersStarted || 0) >= cfg.maxChallengersPerJob) return no(slow, "limit", "other sources were already tried");
  if (nearlyDone(a, cfg)) return no(slow, "nearly-done", "it is nearly done");
  if (a.retryAt && now < a.retryAt) return no(slow, "cooldown", "another source was looked for a moment ago");
  if (env.watching > 0) return no(slow, "watching", "someone is watching");
  if (env.streamActive) return no(slow, "stream", "a torrent stream is playing");
  if (capBound({ capBps: env.capBps, totalBps: env.totalBps }, cfg)) return no(slow, "cap", "downloads are running at the speed cap");
  if (lineBound({ ownBps: a.speed, totalBps: env.totalBps, peakBps: env.peakBps }, cfg)) return no(slow, "line", "the other downloads are using the whole line");
  if ((env.racesRunning || 0) >= cfg.maxRaces) return no(slow, "busy", "another race is running");
  return { race: true, slow, blocked: null };
};

// Several jobs qualify and only one race may start: a request someone made
// by hand comes before an automatic (smart / followed) download; the one
// that started first comes first among equals.
const pickJobToRace = (cands) =>
  (cands || []).slice().sort((x, y) => (x.smart ? 1 : 0) - (y.smart ? 1 : 0) || (x.startedAt || 0) - (y.startedAt || 0))[0] || null;

// ---------- 9. memory ----------
// What is remembered per title: { [infoHash]: { o: outcome, at: ms } }.
const OUTCOMES = ["stalled", "lost", "probe", "failed", "won"];
const BAD_OUTCOMES = new Set(["stalled", "lost", "probe", "failed"]);
// The nudge getSources' ranking gives a source with a history here — small
// beside the quality tiers (100 / 70 / 62): it reorders near-equals, and a
// source that let this title down can slip under a very well seeded one of
// the next resolution — never the other way round for a healthy source.
const SCORE = { stalled: -15, probe: -20, failed: -20, lost: -8, won: 6 };

const lc = (h) => String(h || "").toLowerCase();

// The key a title's outcomes are filed under — the same id getSources asks
// the provider for.
const titleKey = (job) => {
  if (!searchable(job)) return null;
  const id = String(job.imdbId).toLowerCase();
  return job.type === "show" ? `${id}:${Number(job.season)}:${Number(job.episode)}` : id;
};

const fresh = (entry, now, cfg) => !!entry && now - (entry.at || 0) < cfg.memoryDays * 86400e3;

const badSources = (history, now, cfg) => {
  const out = new Set();
  for (const [hash, e] of Object.entries(history || {})) {
    if (fresh(e, now, cfg) && BAD_OUTCOMES.has(e.o)) out.add(lc(hash));
  }
  return out;
};

// 0 for a source with no (fresh) history: the ranking of everything that has
// never been tried here is exactly what it was.
const scoreAdjust = (history, infoHash, now, cfg) => {
  const e = history && history[lc(infoHash)];
  return fresh(e, now, cfg) ? SCORE[e.o] || 0 : 0;
};

// Drop what expired; keep the store small (the most recently touched titles).
const pruneMemory = (data, now, cfg, maxTitles = 400) => {
  const titles = [];
  for (const [key, hist] of Object.entries(data || {})) {
    const kept = {};
    let last = 0;
    for (const [hash, e] of Object.entries(hist || {})) {
      if (!fresh(e, now, cfg) || !OUTCOMES.includes(e.o)) continue;
      kept[hash] = e;
      last = Math.max(last, e.at || 0);
    }
    if (last) titles.push([key, kept, last]);
  }
  titles.sort((a, b) => b[2] - a[2]);
  return Object.fromEntries(titles.slice(0, maxTitles).map(([k, v]) => [k, v]));
};

// ---------- 4. the challenger ----------
const resolutionOf = (q) => {
  const s = String(q || "").toLowerCase();
  if (/2160|4k|uhd/.test(s)) return "2160p";
  if (/1080/.test(s)) return "1080p";
  if (/720/.test(s)) return "720p";
  if (/480/.test(s)) return "480p";
  return null;
};

// Pick the source to run against `job`.
//   streams  getSources' list, best value first (its order IS the ranking)
//   history  this title's remembered outcomes
//   live     every source some OTHER live download is fetching:
//            [{ infoHash, fileIdx, running }] (running: false = only queued)
// → { source, warm, resolution } or { source: null, reason, exhausted }.
//   `exhausted` means nothing at this resolution is usable — the "no healthy
//   source at that quality" ending.
const chooseChallenger = ({ job, streams, history, live, cfg, now }) => {
  const list = streams || [];
  const own = lc(job.infoHash);
  const me = list.find((s) => lc(s.infoHash) === own);
  const want = resolutionOf((me && me.quality) || job.quality);
  if (!want) return { source: null, exhausted: false, reason: "the original's resolution is not known, so nothing can be matched to it" };
  const bad = badSources(history, now, cfg);
  const size = job.sizeBytes || (me && me.sizeBytes) || 0;
  const liveFiles = new Set((live || []).map((l) => `${lc(l.infoHash)}|${l.fileIdx || 0}`));
  const liveHashes = new Set((live || []).filter((l) => l.running !== false).map((l) => lc(l.infoHash)));
  const skipped = { history: 0, size: 0, busy: 0, other: 0 };
  const ok = [];
  for (const s of list) {
    const hash = lc(s.infoHash);
    if (!/^[a-z0-9]{32,40}$/.test(hash) || hash === own) continue;   // a different torrent
    if (resolutionOf(s.quality) !== want) continue;                  // same resolution only
    // Never a cinema recording; never a dub unless the original was one;
    // never a film buried in a collection (see isPack in media/torrent.js).
    if (s.cam || (s.dubbed && !(me && me.dubbed)) || (job.type !== "show" && s.pack)) { skipped.other++; continue; }
    if (bad.has(hash)) { skipped.history++; continue; }              // failed / stalled / lost here before
    if (!(s.sizeBytes > 0)) { skipped.size++; continue; }            // unknown size: the disk gate could not count it
    if (size > 0 && (s.sizeBytes < size * cfg.sizeBandLow || s.sizeBytes > size * cfg.sizeBandHigh)) { skipped.size++; continue; }
    if (liveFiles.has(`${hash}|${s.fileIdx || 0}`)) { skipped.busy++; continue; } // that exact file is another download
    ok.push(s);
  }
  if (!ok.length) {
    const n = skipped.history + skipped.size + skipped.busy + skipped.other;
    const bits = [
      skipped.history && `${skipped.history} let this title down before`,
      skipped.size && `${skipped.size} the wrong size`,
      skipped.busy && `${skipped.busy} already downloading`,
      skipped.other && `${skipped.other} unsuitable`,
    ].filter(Boolean).join(", ");
    return {
      source: null,
      exhausted: true,
      resolution: want,
      reason: n ? `no healthy second source at ${want} (${bits})` : `there is no other source at ${want}`,
    };
  }
  // A season pack that is ALREADY downloading for a sibling episode is nearly
  // free: its details are in, its peers are connected, only one more file is
  // selected. It goes first.
  const warm = ok.find((s) => liveHashes.has(lc(s.infoHash)));
  return { source: warm || ok[0], warm: !!warm, resolution: want };
};

// ---------- 5. the probe ----------
// `ch`: { startedAt, metaAt, seededAt } — seededAt is the first moment a real
// seeder was connected or a byte arrived. → "pass" | "fail" | "wait".
const probeVerdict = (ch, now, cfg) => {
  if (ch.metaAt && ch.seededAt) return "pass";
  return (now - ch.startedAt) / 1000 >= cfg.probeSec ? "fail" : "wait";
};

// ---------- 8. early knockout ----------
// Compared on time REMAINING, so the original is credited for what it has.
//   prev  the last call's `state` ({ lead, since } or null)
// → { state, drop } — drop is "main" | "ch" | null.
const knockout = ({ etaMain, etaCh, prev, now }, cfg) => {
  let lead = null;
  if (etaCh < etaMain * cfg.knockoutRatio) lead = "ch";
  else if (etaMain < etaCh * cfg.knockoutRatio) lead = "main";
  if (!lead) return { state: null, drop: null };
  const since = prev && prev.lead === lead ? prev.since : now;
  const held = (now - since) / 1000 >= cfg.knockoutHoldSec;
  return { state: { lead, since }, drop: held ? (lead === "ch" ? "main" : "ch") : null };
};

// The race is not helping: the two together are no faster than the original
// was alone, and the challenger will not even beat the original running
// alone at its old speed. (A dead original — preRaceBps 0 — never trips it.)
const noGain = ({ preRaceBps, mainBps, chBps, racingMs, remainingMain, etaCh }, cfg) => {
  if (!(preRaceBps > 0) || racingMs / 1000 < cfg.gainCheckSec) return false;
  if ((mainBps || 0) + (chBps || 0) >= preRaceBps * cfg.gainMin) return false;
  return etaCh >= etaSec(remainingMain, preRaceBps);
};

// ---------- 6. one card ----------
// Whose progress the viewer sees: the attempt with less time remaining. The
// lead only changes hands on a clear difference, so the card does not flicker
// between two percentages.
const leader = ({ etaMain, etaCh, fracMain, fracCh }, prev) => {
  const cur = prev === "ch" ? "ch" : "main";
  const other = cur === "ch" ? "main" : "ch";
  const [mine, theirs] = cur === "ch" ? [etaCh, etaMain] : [etaMain, etaCh];
  if (Number.isFinite(theirs)) return theirs < mine * 0.8 ? other : cur;
  if (Number.isFinite(mine)) return cur;
  // neither is moving: whoever has more of the file
  const [fm, ft] = cur === "ch" ? [fracCh, fracMain] : [fracMain, fracCh];
  return (ft || 0) > (fm || 0) + 0.02 ? other : cur;
};

// A server restart in the middle of a race: the attempt with more bytes on
// disk carries on, the other is dropped. A tie keeps the original.
const settleOnRestart = (attempts) => {
  const a = attempts || [];
  if (a.length < 2) return 0;
  return (a[1].bytes || 0) > (a[0].bytes || 0) ? 1 : 0;
};

// ---------- 10 / 11. what the card says when racing is over ----------
const exhaustedNote = (resolution) =>
  `No healthy source was found at ${resolution || "that quality"} — still trying the original.`;
const limitNote = (n, resolution) =>
  `${n === 1 ? "Another source was" : `${n} other sources were`} tried at ${resolution || "that quality"} — this is the fastest one found.`;

module.exports = {
  DEFAULTS, resolveConfig,
  ewma, etaSec, parseRate, fmtDur, budgetSec,
  slowReason, nearlyDone, capBound, updatePeak, lineBound, searchable, shouldRace, pickJobToRace,
  OUTCOMES, titleKey, badSources, scoreAdjust, pruneMemory,
  resolutionOf, chooseChallenger, probeVerdict, knockout, noGain, leader, settleOnRestart,
  exhaustedNote, limitNote,
};
