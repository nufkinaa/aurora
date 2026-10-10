// The healer: every minute, a round of named checks over the things that
// quietly rot on a server that has been up for days — the download engine,
// the download queue, disk, the upstream catalogues, the error rate in our
// own log, the process itself — each answering ok / warn / fail with one
// plain sentence. Where a fix is safe it is applied on the spot (a stalled
// download is restarted, a stuck queue is pumped, a dead engine respawned,
// orphaned staging purged, an overdue scan run) and written down as an
// event. The admin's Server tab shows the latest round, the history, and
// every action taken; a check flipping to fail (and back) also goes out
// through notify (ntfy / Telegram) so nobody has to be looking.
//
// Everything here is deterministic. It does not need a model: the questions
// have exact answers ("has this job's progress moved in 15 minutes?"), and
// the point is to catch the slow compounding of small faults — a cached
// failed engine start, a poll loop that stopped, a full disk — before they
// turn into "downloads just fail now". The watchdog (watchdog.js) still owns
// memory and event-loop lag; this reads its numbers rather than re-measuring.
//
// Since 2026-10-08 the round is about thirty checks in seven groups, and it
// looks at STATISTICS as well as the log. This file keeps the round, the
// history, the alerts and the original checks; the newer ones live beside it:
//
//   healer-checks/signatures.js  the errors Aurora knows, and what each means
//   healer-checks/logs.js        known problems, never-seen errors (reported
//                                once), repeat-offender files, the hourly trend
//   healer-checks/stats.js       playback, viewers, transcoding, downloads,
//                                memory trend, helper processes left behind
//   healer-checks/system.js      library folders and files, backups, update
//                                state, alert delivery, the clock, data growth
//   healer-checks/repairs.js     the few Actions (lib/adminactions.js) the
//                                healer may press by itself, behind a circuit
//                                breaker — "healer": { "autoRepair": false }
//                                in config.json switches them all off
//   healer-checks/ai.js          optional and advisory: a model's two-sentence
//                                reading of a never-seen error (default OFF)
//
// A check returns { status, summary, detail?, healed?, findings?, quiet? }.
// A finding is one thing a person should know: { level, title, text,
// evidence?, did?, press?: { action, label }, setting?, ai? } — its sentence,
// the numbers behind it, what the healer did about it, and the exact button
// or setting if it needs a human.
const fs = require("fs");
const path = require("path");
const os = require("os");
const util = require("./healer-checks/util");
const repairs = require("./healer-checks/repairs");
const logChecks = require("./healer-checks/logs");
const statChecks = require("./healer-checks/stats");
const sysChecks = require("./healer-checks/system");

const CHECK_MS = 60 * 1000;
const UPSTREAM_MS = 5 * 60 * 1000; // outside reachability, less often
const HISTORY_MAX = 240; // four hours of rounds
const EVENTS_MAX = 80;
const NOTIFY_COOLDOWN_MS = 30 * 60 * 1000;

// Download stall rules (see the `downloads` check).
const FINDING_STALL_MS = 12 * 60 * 1000; // no torrent details / no first byte
const PROGRESS_STALL_MS = 15 * 60 * 1000; // no progress and no speed
const QUEUE_STUCK_MS = 5 * 60 * 1000; // approved, a slot free, still waiting
const STAGING_ORPHAN_AGE_MS = 60 * 60 * 1000;
// Slow-moving things are measured every few minutes, not every round.
const SLOW_CHECK_MS = 5 * 60 * 1000;
const TEMP_WARN_BYTES = 20 * 1024 ** 3; // temporary files worth a look
const TIGHT_FREE_BYTES = 10 * 1024 ** 3; // below this, temporary files are cleared eagerly
const DATA_FILE_WARN_BYTES = 25 * 1024 ** 2; // a JSON store this big makes every save slow
const ENCODE_SATURATED_ROUNDS = 10; // both encode slots busy this many rounds running
const OFFLINE_JOB_STUCK_MS = 3 * 3600 * 1000;
const DISK_TREND_MIN_MS = 3 * 3600 * 1000; // history needed before forecasting
const DISK_FORECAST_MS = 48 * 3600 * 1000; // warn when "full" is this close

const state = {
  last: null, // { at, overall, checks: [...] }
  history: [], // { at, overall, fail, warn }
  events: [], // { at, kind, detail }
  notified: new Map(), // check id -> { status, at }
  upstream: null, // cached result of the slow check
  upstreamAt: 0,
  clock: null, // { skews: [ms], at } — server Date headers against this clock, from the upstream check's answers
  slow: {}, // id -> { at, result } for the every-few-minutes checks
  diskTrend: new Map(), // volume key -> [{ at, free }] (hourly, in memory)
  encodeBusyRounds: 0,
  running: false,
  timer: null,
};

const note = (kind, detail) => {
  state.events.push({ at: Date.now(), kind, detail });
  if (state.events.length > EVENTS_MAX) state.events.shift();
  console.log(`[healer] ${kind}${detail ? ` — ${detail}` : ""}`);
};

const { fmtBytes, fmtAge, normalizeMessage, topMessages, worst } = util; // shared with healer-checks/*

const withTimeout = (p, ms, fallback) =>
  Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);

// ---------- pure helpers (tested) ----------

// (normalizeMessage and topMessages — how log lines group — are in healer-checks/util.js.)

// Is a running download stalled? `rec` is the queue's live record for it.
// A job in the middle of a second-source race (media/dlrace.js) is never
// "stalled": its first attempt being slow is exactly why the race is on, and
// the race is the remedy. Once the queue has used up its other sources
// (job.raceCount), the old rules apply again — and the sentence says so.
const stallReason = (job, rec, now = Date.now()) => {
  if (!job || job.status !== "downloading" || !rec) return null;
  if (rec.copying) return null; // copying into the library has its own clock
  if (rec.ch || rec.raceBusy || job.race) return null; // being raced
  const started = rec.startedAt || 0;
  const lastMove = rec.lastProgressAt || started;
  const tried = job.raceCount > 0 ? `; ${job.raceCount === 1 ? "another source was" : `${job.raceCount} other sources were`} tried and did no better` : "";
  if ((job.phase === "finding" || job.phase === "starting" || !(job.progress > 0)) && started && now - started > FINDING_STALL_MS) {
    return `no ${job.phase === "finding" ? "torrent details" : "bytes"} after ${fmtAge(now - started)}${tried}`;
  }
  if (job.progress > 0 && job.progress < 1 && !(job.downloadSpeed > 0) && lastMove && now - lastMove > PROGRESS_STALL_MS) {
    return `stuck at ${Math.round(job.progress * 100)}% for ${fmtAge(now - lastMove)}${tried}`;
  }
  return null;
};

// ---------- the checks ----------
// Each returns { status: ok|warn|fail|info, summary, detail?, healed? }.
// A throwing check is itself a finding, never a crash of the round.

const checkProcess = async () => {
  const w = require("./watchdog").status();
  const n = w.now;
  const t = w.thresholds;
  const bits = [`${fmtBytes(n.rss)} resident`, `${n.lagMs} ms lag`, `${n.ffmpeg} ffmpeg`, `up ${fmtAge(n.uptimeSec * 1000)}`];
  let status = "ok";
  const notes = [];
  if (n.rss > t.hardRss) { status = "fail"; notes.push("memory over the restart line"); }
  else if (n.rss > t.softRss) { status = "warn"; notes.push("memory high"); }
  if (n.lagMs > t.hardLagMs) { status = "fail"; notes.push("event loop stuck"); }
  else if (n.lagMs > t.softLagMs && status === "ok") { status = "warn"; notes.push("event loop sluggish"); }
  if (n.ffmpeg > 6 && status === "ok") { status = "warn"; notes.push(`${n.ffmpeg} ffmpeg children`); }
  return { status, summary: bits.join(" · "), detail: notes.join("; ") || null };
};

// (The "errors in the log" check used to count lines here. It now reads them:
// healer-checks/logs.js — known problems by name, new ones reported once.)

const checkDisk = async () => {
  const config = require("../config");
  const disk = require("./disk");
  const aria2 = require("../media/aria2");
  const roots = [];
  for (const kind of ["movies", "shows"]) {
    for (const dir of (config.LIBRARIES && config.LIBRARIES[kind]) || []) roots.push([kind, dir]);
  }
  roots.push(["staging", aria2.STAGING_ROOT]);
  const seen = new Set();
  const lines = [];
  const forecast = [];
  let status = "ok";
  for (const [kind, dir] of roots) {
    const sp = await disk.space(dir);
    if (!sp) {
      if (kind !== "staging") { status = "fail"; lines.push(`${kind}: ${dir} is not reachable`); }
      continue;
    }
    const key = `${sp.total}|${sp.free}`;
    if (seen.has(key)) continue; // same volume as one already listed
    seen.add(key);
    let tone = "";
    if (sp.free < 2 * 1024 ** 3) { status = "fail"; tone = " — nearly full"; }
    else if (sp.free < 10 * 1024 ** 3 || (sp.freePct != null && sp.freePct < 5)) { if (status === "ok") status = "warn"; tone = " — getting tight"; }
    lines.push(`${kind}: ${fmtBytes(sp.free)} free of ${fmtBytes(sp.total)}${tone}`);
    // Where is it heading? One sample an hour per volume; once there are a
    // few hours of them, a disk that is filling says when it will be full —
    // while there is still time to delete something calmly.
    const trend = state.diskTrend.get(String(sp.total)) || [];
    const now = Date.now();
    if (!trend.length || now - trend[trend.length - 1].at >= 3600 * 1000) {
      trend.push({ at: now, free: sp.free });
      if (trend.length > 72) trend.shift();
      state.diskTrend.set(String(sp.total), trend);
    }
    const eta = fullIn(trend, sp.free, now);
    if (eta != null && eta < DISK_FORECAST_MS) {
      if (status === "ok") status = "warn";
      forecast.push(`${kind}: filling — full in about ${fmtAge(eta)} at this rate`);
    }
  }
  return { status, summary: lines.join(" · ") || "no library folders configured", detail: forecast.join(" · ") || null };
};

// Milliseconds until the disk is full at the rate the samples show, or null
// when it is not filling (or there is too little history to say).
const fullIn = (trend, freeNow, now = Date.now()) => {
  if (!trend || trend.length < 2) return null;
  const first = trend[0];
  const span = now - first.at;
  if (span < DISK_TREND_MIN_MS) return null;
  const used = first.free - freeNow; // bytes lost over the span
  if (used <= 0) return null;
  return Math.round((freeNow / used) * span);
};

// The size of a folder tree, bounded: a cache with a hundred thousand small
// files is not walked to the end every few minutes.
const dirSize = async (dir, budget = { left: 40000 }) => {
  let total = 0;
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (budget.left-- <= 0) break;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(abs, budget);
    else { try { total += (await fs.promises.stat(abs)).size; } catch {} }
  }
  return total;
};

// Run `fn` at most every `everyMs` (five minutes unless said); between runs
// answer with the last result. forget(id) makes the next round measure again
// (after a repair that should have changed the answer).
const slowly = async (id, fn, everyMs = SLOW_CHECK_MS) => {
  const hit = state.slow[id];
  if (hit && Date.now() - hit.at < everyMs) return hit.result;
  const result = await fn();
  state.slow[id] = { at: Date.now(), result };
  return result;
};
const forget = (id) => { delete state.slow[id]; };

// Temporary files: everything under data/cache is a copy of something the
// server can make again — streams being repackaged, copies prepared for a
// phone, resized posters. Left alone they only grow, on the same small disk
// the library lives on. Expired phone copies and streams untouched for a
// day are cleared every time; when the disk is tight, finished streams
// nobody is watching go too, whatever their age.
const checkTemp = () => slowly("temp", async () => {
  const config = require("../config");
  const disk = require("./disk");
  const offline = require("../media/offline");
  const remux = require("../media/remux");
  const healed = [];
  let freed = 0;
  try { freed += offline.sweep() || 0; } catch {}
  // finished streams nobody has touched for a day (kept before only by count)
  try { freed += remux.sweepStale() || 0; } catch {}
  try { freed += require("../media/torrent-transcode").sweepStale() || 0; } catch {}
  const sp = await disk.space(config.CACHE_DIR);
  const tight = !!sp && sp.free < TIGHT_FREE_BYTES;
  if (tight) {
    try { freed += remux.sweepIdle() || 0; } catch {}
  }
  if (freed > 50 * 1024 ** 2) {
    healed.push(`cleared ${fmtBytes(freed)} of temporary files`);
    note("temp cleared", `${fmtBytes(freed)}${tight ? " (disk is tight)" : ""}`);
  }
  let names = [];
  try { names = (await fs.promises.readdir(config.CACHE_DIR, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); } catch {}
  const sizes = [];
  for (const name of names) sizes.push([name, await dirSize(path.join(config.CACHE_DIR, name))]);
  sizes.sort((a, b) => b[1] - a[1]);
  const total = sizes.reduce((n, s) => n + s[1], 0);
  const top = sizes.filter((s) => s[1] > 0).slice(0, 3).map(([n, b]) => `${n} ${fmtBytes(b)}`).join(", ");
  let status = "ok";
  let detail = null;
  if (total > TEMP_WARN_BYTES || (sp && total > sp.free)) {
    status = "warn";
    detail = "temporary files are taking real room — the biggest folders are listed; they can be deleted with the server stopped, everything in them is rebuilt on demand";
  }
  return { status, summary: `${fmtBytes(total)} of temporary files${top ? ` (${top})` : ""}`, detail, healed: healed.join("; ") || null };
});

// Encoding: how many of the server's encode slots are taken (a device that
// can't play a file, or a lighter stream for a slow line), and whether a
// copy being prepared for a phone has been running implausibly long. Both
// slots busy round after round means people are being refused.
const checkEncoding = async () => {
  const remux = require("../media/remux");
  const offline = require("../media/offline");
  const config = require("../config");
  if (!config.ffmpegAvailable) return { status: "info", summary: "no ffmpeg — nothing is ever converted" };
  const e = remux.encodeLoad();
  const o = offline.load();
  state.encodeBusyRounds = e.active >= e.max ? state.encodeBusyRounds + 1 : 0;
  const bits = [`${e.active} of ${e.max} encode slots in use`];
  if (o.running) bits.push(`preparing a phone copy (${Math.round(o.progress * 100)}%${o.queued ? `, ${o.queued} waiting` : ""})`);
  let status = "ok";
  const notes = [];
  if (state.encodeBusyRounds >= ENCODE_SATURATED_ROUNDS) {
    status = "warn";
    notes.push(`every encode slot has been busy for ${state.encodeBusyRounds} minutes — new viewers who need one are being refused`);
  }
  if (o.running && o.since && Date.now() - o.since > OFFLINE_JOB_STUCK_MS && o.progress < 0.99) {
    status = "warn";
    notes.push(`a phone copy has been converting for ${fmtAge(Date.now() - o.since)}`);
  }
  return { status, summary: bits.join(" · "), detail: notes.join("; ") || null };
};

// The server's own records (profiles, watch state, downloads, sessions) are
// JSON files rewritten whole on every save. One that no longer parses is the
// worst thing that can happen quietly; one that has grown huge makes every
// save slow. Looked at every few minutes; nothing is changed from here.
const checkData = () => slowly("data", async () => {
  const config = require("../config");
  let files = [];
  try { files = (await fs.promises.readdir(config.DATA_DIR)).filter((f) => f.endsWith(".json")); } catch {}
  const broken = [];
  const big = [];
  let total = 0;
  for (const f of files) {
    const abs = path.join(config.DATA_DIR, f);
    let size = 0;
    try { size = (await fs.promises.stat(abs)).size; } catch { continue; }
    total += size;
    if (size > DATA_FILE_WARN_BYTES) big.push(`${f} ${fmtBytes(size)}`);
    if (size > 0 && size <= 8 * 1024 ** 2) {
      try { JSON.parse(await fs.promises.readFile(abs, "utf8")); }
      catch {
        // a file caught mid-write reads as broken: only believe it twice
        await new Promise((r) => setTimeout(r, 400));
        try { JSON.parse(await fs.promises.readFile(abs, "utf8")); } catch { broken.push(f); }
      }
    }
  }
  if (broken.length) return { status: "fail", summary: `${broken.join(", ")} can't be read`, detail: "the file is not valid JSON — restore it from a backup before the server next saves over it" };
  if (big.length) return { status: "warn", summary: `${files.length} data files, ${fmtBytes(total)}`, detail: `large: ${big.join(", ")} — every save rewrites the whole file` };
  return { status: "ok", summary: `${files.length} data files, ${fmtBytes(total)}, all readable` };
});

// The TV app: is the APK the server hands out the version the TVs are told
// about, and the one the source says it should be? Read from the file itself.
const checkTvApp = () => slowly("tvapp", async () => {
  const s = require("./tvapp").status();
  if (s.apk.error) {
    const none = /no APK/.test(s.apk.error);
    return { status: none ? "info" : "fail", summary: s.apk.error };
  }
  const worstP = s.problems.find((p) => p.level === "fail") || s.problems.find((p) => p.level === "warn");
  return {
    status: s.level,
    summary: `APK is ${s.apk.versionName} (build ${s.apk.versionCode}, ${fmtBytes(s.apk.sizeBytes)})${worstP ? " — out of step" : " — announced and built versions agree"}`,
    detail: s.problems.filter((p) => p.level !== "info").map((p) => p.text).join(" ‖ ") || null,
  };
});

// "torrents": false in config.json — the four checks below have nothing to
// watch, and must not "heal" an engine that is off on purpose.
const torrentsOff = () => !require("./torrentgate").enabled();
const offInfo = () => ({ status: "info", summary: "switched off in config.json (torrents: false)" });

const checkAria2 = async () => {
  if (torrentsOff()) return offInfo();
  const aria2 = require("../media/aria2");
  const downloads = require("../media/downloads");
  if (!aria2.available()) return { status: "info", summary: "aria2 is not installed — downloads to the server are off" };
  const q = downloads.queueHealth();
  const wantsEngine = q.activeCount > 0 || q.approvedWaiting > 0;
  if (!aria2.running()) {
    if (!wantsEngine) return { status: "ok", summary: "engine idle (starts with the next download)" };
    // jobs want it and it isn't up: the pump brings it back through ensure()
    downloads.pumpNow();
    note("engine respawn", `aria2 was down with ${q.activeCount + q.approvedWaiting} job(s) wanting it — pumped the queue`);
    return { status: "warn", summary: "engine was down while jobs were waiting", healed: "restarted it through the queue" };
  }
  const ok = await withTimeout(aria2.ping().then(() => true).catch(() => false), 6000, false);
  if (ok) return { status: "ok", summary: `engine answering · ${q.activeCount} of ${q.maxActive} slots busy` };
  // running but deaf: a hung daemon fails every poll, every add, forever
  aria2.shutdown();
  downloads.pumpNow();
  note("engine respawn", "aria2 stopped answering its RPC — killed and restarted");
  return { status: "fail", summary: "engine stopped answering", healed: "killed and restarted it" };
};

const checkDownloads = async () => {
  if (torrentsOff()) return offInfo();
  const downloads = require("../media/downloads");
  const q = downloads.queueHealth();
  const now = Date.now();
  const healed = [];
  let status = "ok";
  const notes = [];
  for (const a of q.active) {
    const why = stallReason(a.job, a.rec, now);
    if (!why) continue;
    if (downloads.restartJob(a.job.id, why)) {
      healed.push(`restarted “${a.job.label || a.job.title}” (${why})`);
      note("download restarted", `“${a.job.label || a.job.title}” — ${why}`);
    }
    status = "warn";
  }
  if (q.approvedWaiting > 0 && q.activeCount < q.maxActive && q.oldestApprovedAgeMs > QUEUE_STUCK_MS) {
    downloads.pumpNow();
    healed.push(`pumped a queue with ${q.approvedWaiting} waiting and a free slot`);
    note("queue pumped", `${q.approvedWaiting} approved job(s) waited ${fmtAge(q.oldestApprovedAgeMs)} with a free slot`);
    status = "warn";
  }
  if (q.errorsLastHour >= 3) {
    status = "warn";
    notes.push(`${q.errorsLastHour} downloads failed in the last hour${q.lastError ? ` (last: ${q.lastError})` : ""}`);
  }
  if (q.pollerExpected && !q.pollerRunning) {
    downloads.pumpNow();
    healed.push("restarted the progress poller");
    note("poller restarted", `${q.activeCount} active job(s) had no progress poll running`);
    status = "warn";
  }
  // A second source being tried is not a fault — it is said, not warned about.
  const racing = q.active.filter((a) => a.racing);
  for (const a of racing) {
    notes.push(`“${a.job.label || a.job.title}” is trying a second source (${a.raceState === "racing" ? "both running" : "checking that it connects"}${a.job.race && a.job.race.why ? `: ${a.job.race.why}` : ""})`);
  }
  const summary =
    `${q.activeCount} downloading · ${q.approvedWaiting} queued · ${q.pending} waiting for approval · ${q.doneLastDay} finished in 24 h` +
    (racing.length ? ` · ${racing.length} trying a second source` : "") +
    // On hold or waiting its turn on purpose (My List downloads give way to
    // every other kind — media/dlslots.js): said, never a finding.
    (q.yielding > 0 ? ` · ${q.yielding} from My List waiting for the others${q.held > 0 ? ` (${q.held} on hold)` : ""}` : "") +
    (q.holding && q.approvedWaiting > 0 ? ` · holding at ${q.maxActive} while someone is watching` : "");
  return { status, summary, detail: notes.join("; ") || null, healed: healed.join("; ") || null };
};

const checkStaging = async () => {
  const aria2 = require("../media/aria2");
  const downloads = require("../media/downloads");
  if (!aria2.available()) return { status: "info", summary: "no staging (aria2 not installed)" };
  let dirs = [];
  try { dirs = fs.readdirSync(aria2.STAGING_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return { status: "ok", summary: "staging folder empty" }; }
  const live = downloads.liveInfoHashes();
  const now = Date.now();
  const orphans = [];
  for (const name of dirs) {
    if (live.has(name.toLowerCase())) continue;
    try {
      const st = fs.statSync(path.join(aria2.STAGING_ROOT, name));
      if (now - st.mtimeMs > STAGING_ORPHAN_AGE_MS) orphans.push(name);
    } catch {}
  }
  for (const h of orphans) aria2.purge(h).catch(() => {});
  if (orphans.length) note("staging purged", `${orphans.length} folder(s) no job wanted`);
  return {
    status: "ok",
    summary: `${dirs.length} staging folder${dirs.length === 1 ? "" : "s"}${orphans.length ? `, ${orphans.length} orphaned` : ""}`,
    healed: orphans.length ? `purged ${orphans.length} orphaned folder(s)` : null,
  };
};

const UPSTREAMS = [
  ["catalogue (Cinemeta)", "https://v3-cinemeta.strem.io/meta/movie/tt0816692.json"],
  ["sources (Torrentio)", "https://torrentio.strem.fun/manifest.json"],
  ["artwork (metahub)", "https://images.metahub.space/poster/small/tt0816692/img"],
];
const checkUpstream = async () => {
  if (state.upstream && Date.now() - state.upstreamAt < UPSTREAM_MS) return state.upstream;
  // "torrents": false — the source provider is not this server's business.
  const asked = torrentsOff() ? UPSTREAMS.filter(([, url]) => !/torrentio/.test(url)) : UPSTREAMS;
  const results = await Promise.all(
    asked.map(async ([name, url]) => {
      const t0 = Date.now();
      try {
        const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(6000), headers: { "User-Agent": "Aurora healer" } });
        // the answer's Date header against this machine's clock, for the Clock
        // check: no request is made for it — this one was being made anyway
        const t1 = Date.now();
        const theirs = Date.parse(res.headers.get("date") || "");
        const skew = Number.isFinite(theirs) && t1 - t0 < 4000 ? theirs + 500 - (t0 + t1) / 2 : null; // +500: the header is truncated to the second
        return { name, ok: res.ok, ms: t1 - t0, code: res.status, skew };
      } catch (e) {
        return { name, ok: false, ms: Date.now() - t0, code: (e && e.name) || "error" };
      }
    }),
  );
  const down = results.filter((r) => !r.ok);
  const out = {
    status: down.length === results.length ? "fail" : down.length ? "warn" : "ok",
    summary: down.length
      ? `${down.map((d) => `${d.name} not answering (${d.code})`).join(", ")} — ${down.length === results.length ? "the internet is out, or every provider is" : "search, sources or posters will suffer"}`
      : `all answering (${results.map((r) => `${r.name.split(" ")[0]} ${r.ms} ms`).join(", ")})`,
  };
  const skews = results.map((r) => r.skew).filter((v) => v != null);
  if (skews.length) state.clock = { skews, at: Date.now() };
  state.upstream = out;
  state.upstreamAt = Date.now();
  return out;
};

const checkScanner = async () => {
  const scanner = require("../media/scanner");
  const config = require("../config");
  const at = scanner.index.scannedAt;
  if (!at) return { status: "warn", summary: "the library has never been scanned" };
  const age = Date.now() - at;
  const every = config.SCAN_INTERVAL_MS || 10 * 60 * 1000;
  if (age > every * 2 + 60 * 1000) {
    try { scanner.scan(); } catch {}
    note("scan run", `last scan was ${fmtAge(age)} ago (every ${fmtAge(every)})`);
    return { status: "warn", summary: `library scan was ${fmtAge(age)} overdue`, healed: "ran a scan" };
  }
  return { status: "ok", summary: `library scanned ${fmtAge(age)} ago · ${scanner.index.movies.length} films, ${scanner.index.shows.length} series` };
};

const checkStreaming = async () => {
  if (torrentsOff()) return offInfo();
  const torrent = require("../media/torrent");
  const cl = torrent.clientIfLoaded && torrent.clientIfLoaded();
  if (!cl) return { status: "ok", summary: "streaming client idle" };
  const n = (cl.torrents || []).length;
  const stalled = (cl.torrents || []).filter((t) => !t.done && (t.numPeers || 0) === 0 && !t._auroraQuiesced).length;
  return {
    status: n >= 12 ? "warn" : "ok",
    summary: `${n} torrent${n === 1 ? "" : "s"} loaded${stalled ? `, ${stalled} with no peers` : ""}`,
    detail: n >= 12 ? "at the client's cap — the least-recently-used gets evicted" : null,
  };
};

const checkRealtime = async () => {
  const realtime = require("../realtime");
  const n = realtime.clientCount ? realtime.clientCount() : null;
  return { status: "info", summary: n == null ? "live connections unknown" : `${n} device${n === 1 ? "" : "s"} connected` };
};

// What a check is handed (the newer ones use it; the original ones ignore
// it): the healer's hand for repairs, its event list, the slow-check cache,
// and the clock reading the upstream check took.
const context = () => ({
  repair: (name, o) => repairs.attempt(name, o),
  note,
  slowly,
  forget,
  reading: state.clock,
});

// The groups the admin page shows the checks in, in this order.
const GROUPS = ["Process & memory", "Logs", "Playback", "Streaming & transcoding", "Downloads", "Library & data", "Updates & delivery"];

// [id, name, group, fn]
const CHECKS = [
  ["process", "Process", "Process & memory", checkProcess],
  ["memtrend", "Memory and load trend", "Process & memory", statChecks.checkMemTrend],
  ["helpers", "Helper processes", "Process & memory", statChecks.checkHelpers],

  ["errors", "Errors in the log", "Logs", logChecks.checkErrors],
  ["newerrors", "New kinds of error", "Logs", logChecks.checkNewErrors],
  ["offenders", "Repeat offenders", "Logs", logChecks.checkOffenders],
  ["errtrend", "Error rate", "Logs", logChecks.checkErrorTrend],

  ["playback", "Playback health", "Playback", statChecks.checkPlayback],
  ["sessions", "Viewers and sessions", "Playback", statChecks.checkSessions],
  ["realtime", "Devices", "Playback", checkRealtime],
  ["trailers", "TV trailers", "Playback", statChecks.checkTrailers],

  ["encoding", "Encoding", "Streaming & transcoding", checkEncoding],
  ["transcoding", "Transcoding", "Streaming & transcoding", statChecks.checkTranscoding],
  ["streaming", "Streaming client", "Streaming & transcoding", checkStreaming],
  ["upstream", "Upstream providers", "Streaming & transcoding", checkUpstream],

  ["downloads", "Download queue", "Downloads", checkDownloads],
  ["aria2", "Download engine", "Downloads", checkAria2],
  ["staging", "Staging", "Downloads", checkStaging],
  ["dlstats", "Download results", "Downloads", statChecks.checkDownloadStats],

  ["disk", "Disk", "Library & data", checkDisk],
  ["library", "Library folders and files", "Library & data", sysChecks.checkLibrary],
  ["scanner", "Library scan", "Library & data", checkScanner],
  ["temp", "Temporary files", "Library & data", checkTemp],
  ["data", "Data files", "Library & data", checkData],
  ["growth", "Data growth", "Library & data", sysChecks.checkGrowth],
  ["backups", "Backups", "Library & data", sysChecks.checkBackups],

  ["updates", "Update state", "Updates & delivery", sysChecks.checkUpdates],
  ["delivery", "Alert delivery", "Updates & delivery", sysChecks.checkDelivery],
  ["clock", "Clock", "Updates & delivery", sysChecks.checkClock],
  ["tvapp", "TV app", "Updates & delivery", checkTvApp],
];

// A check flipping to fail (or recovering from one) goes out once, with a
// cooldown so a flapping check can't page anyone every minute. This is the
// ONE alert path of the healer — the newer checks use it like the old ones,
// through lib/notify.js, beside (never on top of) the health alerts:
// a check whose subject lib/health.js already announces (an unreachable
// drive, a stale backup) answers `quiet: true` and is not sent from here, so
// nobody is paged twice for one fault.
const firstFinding = (r) => (r.findings || []).find((f) => f.level === "fail") || (r.findings || []).find((f) => f.level === "warn") || null;
const alertBody = (r) => {
  const f = firstFinding(r);
  const lines = [r.summary];
  if (f && f.text) lines.push(f.text);
  const did = (f && f.did) || r.healed;
  if (did) lines.push(`Did: ${did}`);
  if (f && f.press) lines.push(`Press: ${f.press.label}`);
  else if (f && f.setting) lines.push(f.setting);
  return lines.join("\n").slice(0, 900);
};
const sendAlert = (title, body) => { try { require("./notify").send(title, body); } catch {} };
const maybeNotify = (id, name, result, send = sendAlert) => {
  const prev = state.notified.get(id) || { status: "ok", at: 0 };
  const now = Date.now();
  if (result.status === "fail" && prev.status !== "fail") {
    if (result.quiet) return;
    if (now - prev.at > NOTIFY_COOLDOWN_MS) {
      send(`Aurora healer: ${name}`, alertBody(result));
      state.notified.set(id, { status: "fail", at: now });
    }
  } else if (result.status !== "fail" && prev.status === "fail") {
    send(`Aurora healer: ${name} recovered`, result.summary);
    state.notified.set(id, { status: result.status, at: now });
  }
};

// One round. `o` is for tests: { checks: [[id, name, group, fn]…], send }.
const run = async (o = {}) => {
  if (state.running) return state.last;
  state.running = true;
  const t0 = Date.now();
  const checks = [];
  const ctx = context();
  for (const [id, name, group, fn] of o.checks || CHECKS) {
    let r;
    const c0 = Date.now();
    try {
      r = await withTimeout(fn(ctx), 20000, { status: "warn", summary: "the check itself took more than 20 s" });
    } catch (e) {
      r = { status: "warn", summary: `the check threw: ${(e && e.message) || e}` };
    }
    checks.push({ id, name, group, ms: Date.now() - c0, ...r });
    maybeNotify(id, name, r, o.send);
  }
  const overall = worst(checks.map((c) => c.status));
  const report = { at: Date.now(), tookMs: Date.now() - t0, overall, checks };
  state.last = report;
  state.history.push({ at: report.at, overall, fail: checks.filter((c) => c.status === "fail").length, warn: checks.filter((c) => c.status === "warn").length });
  if (state.history.length > HISTORY_MAX) state.history.shift();
  state.running = false;
  try { require("../realtime").broadcastAdmins({ type: "healer_update", report: status() }); } catch {}
  return report;
};

const status = () => {
  let auto = { auto: true, off: [] };
  let ai = false;
  try {
    const config = require("../config");
    const s = repairs.settings(config);
    auto = { auto: s.auto, off: [...s.off] };
    ai = require("./healer-checks/ai").enabled(config);
  } catch {}
  return {
    last: state.last,
    history: state.history.slice(-HISTORY_MAX),
    events: state.events.slice(-EVENTS_MAX),
    everyMs: CHECK_MS,
    groups: GROUPS,
    // the automatic repairs: the last twenty with their outcome, what may run, and whether it is switched off
    repairs: repairs.recent(),
    autoRepair: { on: auto.auto, off: auto.off, may: Object.keys(repairs.REPAIRS) },
    ai,
  };
};

const start = () => {
  if (state.timer) return;
  repairs._setDeps({ note }); // an automatic repair is written into the event list like every other action
  state.timer = setInterval(() => { run().catch((e) => console.error("[healer] round failed:", e && e.message)); }, CHECK_MS);
  state.timer.unref?.();
  // first round once boot has settled and the queue has resumed
  setTimeout(() => { run().catch(() => {}); }, 15000).unref?.();
  note("armed", `every ${CHECK_MS / 1000}s, ${CHECKS.length} checks: ${CHECKS.map((c) => c[0]).join(", ")}`);
};

module.exports = {
  start,
  run,
  status,
  _internals: { checkAria2, checkDownloads, checkStreaming, checkUpstream, normalizeMessage, topMessages, stallReason, worst, fullIn, dirSize, FINDING_STALL_MS, PROGRESS_STALL_MS, state, CHECKS, GROUPS, maybeNotify, alertBody, slowly, forget, context },
};
