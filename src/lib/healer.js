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
const fs = require("fs");
const path = require("path");
const os = require("os");

const CHECK_MS = 60 * 1000;
const UPSTREAM_MS = 5 * 60 * 1000; // outside reachability, less often
const HISTORY_MAX = 240; // four hours of rounds
const EVENTS_MAX = 80;
const NOTIFY_COOLDOWN_MS = 30 * 60 * 1000;

// Download stall rules (see the `downloads` check).
const FINDING_STALL_MS = 12 * 60 * 1000; // no torrent details / no first byte
const PROGRESS_STALL_MS = 15 * 60 * 1000; // no progress and no speed
const QUEUE_STUCK_MS = 5 * 60 * 1000; // approved, a slot free, still waiting
const ERROR_WINDOW_MS = 15 * 60 * 1000;
const STAGING_ORPHAN_AGE_MS = 60 * 60 * 1000;

const state = {
  last: null, // { at, overall, checks: [...] }
  history: [], // { at, overall, fail, warn }
  events: [], // { at, kind, detail }
  notified: new Map(), // check id -> { status, at }
  upstream: null, // cached result of the slow check
  upstreamAt: 0,
  running: false,
  timer: null,
};

const note = (kind, detail) => {
  state.events.push({ at: Date.now(), kind, detail });
  if (state.events.length > EVENTS_MAX) state.events.shift();
  console.log(`[healer] ${kind}${detail ? ` — ${detail}` : ""}`);
};

const fmtBytes = (b) => {
  if (!b && b !== 0) return "?";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
};
const fmtAge = (ms) => {
  const m = Math.round(ms / 60000);
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
};

const withTimeout = (p, ms, fallback) =>
  Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);

// ---------- pure helpers (tested) ----------

// Collapse the variable parts of a log line so repeats group: ids, hashes,
// numbers, paths. "[download] a1b2c3 re-queued: …" and its siblings become
// one bucket with a count — the shape the "what keeps failing" line needs.
const normalizeMessage = (msg) =>
  String(msg || "")
    .replace(/\b[0-9a-f]{6,40}\b/gi, "#")
    .replace(/\d+(\.\d+)?/g, "N")
    .replace(/(["'“”]).*?\1/g, "…")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);

// Top repeated messages in a set of log rows.
const topMessages = (rows, n = 3) => {
  const tally = new Map();
  for (const r of rows) {
    const k = normalizeMessage(r.msg);
    const cur = tally.get(k) || { key: k, n: 0, sample: r.msg.slice(0, 200) };
    cur.n++;
    tally.set(k, cur);
  }
  return [...tally.values()].sort((a, b) => b.n - a.n).slice(0, n);
};

// Is a running download stalled? `rec` is the queue's live record for it.
const stallReason = (job, rec, now = Date.now()) => {
  if (!job || job.status !== "downloading" || !rec) return null;
  if (rec.copying) return null; // copying into the library has its own clock
  const started = rec.startedAt || 0;
  const lastMove = rec.lastProgressAt || started;
  if ((job.phase === "finding" || job.phase === "starting" || !(job.progress > 0)) && started && now - started > FINDING_STALL_MS) {
    return `no ${job.phase === "finding" ? "torrent details" : "bytes"} after ${fmtAge(now - started)}`;
  }
  if (job.progress > 0 && job.progress < 1 && !(job.downloadSpeed > 0) && lastMove && now - lastMove > PROGRESS_STALL_MS) {
    return `stuck at ${Math.round(job.progress * 100)}% for ${fmtAge(now - lastMove)}`;
  }
  return null;
};

const worst = (statuses) =>
  statuses.includes("fail") ? "fail" : statuses.includes("warn") ? "warn" : "ok";

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

const checkErrors = async () => {
  const logbuffer = require("./logbuffer");
  const since = Date.now() - ERROR_WINDOW_MS;
  const errors = logbuffer.read({ level: "error", limit: 1500 }).filter((r) => r.t >= since);
  const warns = logbuffer.read({ level: "warn", limit: 1500 }).filter((r) => r.t >= since && r.level === "warn");
  const crashes = errors.filter((r) => /\[uncaughtException\]|\[unhandledRejection\]/.test(r.msg));
  const top = topMessages([...errors, ...warns], 3);
  let status = "ok";
  if (crashes.length) status = "fail";
  else if (errors.length >= 5 || warns.length >= 40) status = "warn";
  const summary = `${errors.length} error${errors.length === 1 ? "" : "s"}, ${warns.length} warning${warns.length === 1 ? "" : "s"} in the last 15 min` +
    (crashes.length ? ` · ${crashes.length} uncaught` : "");
  const detail = top.length ? "Most repeated: " + top.map((t) => `${t.n}× ${t.sample}`).join(" ‖ ") : null;
  return { status, summary, detail };
};

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
  }
  return { status, summary: lines.join(" · ") || "no library folders configured", detail: null };
};

const checkAria2 = async () => {
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
  const summary = `${q.activeCount} downloading · ${q.approvedWaiting} queued · ${q.pending} waiting for approval · ${q.doneLastDay} finished in 24 h`;
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
  const results = await Promise.all(
    UPSTREAMS.map(async ([name, url]) => {
      const t0 = Date.now();
      try {
        const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(6000), headers: { "User-Agent": "Aurora healer" } });
        return { name, ok: res.ok, ms: Date.now() - t0, code: res.status };
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

const CHECKS = [
  ["process", "Process", checkProcess],
  ["errors", "Errors in the log", checkErrors],
  ["downloads", "Download queue", checkDownloads],
  ["aria2", "Download engine", checkAria2],
  ["disk", "Disk", checkDisk],
  ["staging", "Staging", checkStaging],
  ["upstream", "Upstream providers", checkUpstream],
  ["scanner", "Library scan", checkScanner],
  ["streaming", "Streaming client", checkStreaming],
  ["realtime", "Devices", checkRealtime],
];

// A check flipping to fail (or recovering from one) goes out once, with a
// cooldown so a flapping check can't page anyone every minute.
const maybeNotify = (id, name, result) => {
  const prev = state.notified.get(id) || { status: "ok", at: 0 };
  const now = Date.now();
  if (result.status === "fail" && prev.status !== "fail") {
    if (now - prev.at > NOTIFY_COOLDOWN_MS) {
      try { require("./notify").send(`Aurora healer: ${name}`, `${result.summary}${result.healed ? `\nDid: ${result.healed}` : ""}`); } catch {}
      state.notified.set(id, { status: "fail", at: now });
    }
  } else if (result.status !== "fail" && prev.status === "fail") {
    try { require("./notify").send(`Aurora healer: ${name} recovered`, result.summary); } catch {}
    state.notified.set(id, { status: result.status, at: now });
  }
};

const run = async () => {
  if (state.running) return state.last;
  state.running = true;
  const t0 = Date.now();
  const checks = [];
  for (const [id, name, fn] of CHECKS) {
    let r;
    try {
      r = await withTimeout(fn(), 20000, { status: "warn", summary: "the check itself took more than 20 s" });
    } catch (e) {
      r = { status: "warn", summary: `the check threw: ${(e && e.message) || e}` };
    }
    checks.push({ id, name, ...r });
    maybeNotify(id, name, r);
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

const status = () => ({
  last: state.last,
  history: state.history.slice(-HISTORY_MAX),
  events: state.events.slice(-EVENTS_MAX),
  everyMs: CHECK_MS,
});

const start = () => {
  if (state.timer) return;
  state.timer = setInterval(() => { run().catch((e) => console.error("[healer] round failed:", e && e.message)); }, CHECK_MS);
  state.timer.unref?.();
  // first round once boot has settled and the queue has resumed
  setTimeout(() => { run().catch(() => {}); }, 15000).unref?.();
  note("armed", `every ${CHECK_MS / 1000}s: ${CHECKS.map((c) => c[0]).join(", ")}`);
};

module.exports = {
  start,
  run,
  status,
  _internals: { normalizeMessage, topMessages, stallReason, worst, FINDING_STALL_MS, PROGRESS_STALL_MS, state },
};
