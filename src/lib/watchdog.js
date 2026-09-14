// Watchdog + self-heal. Every 20s it looks at the process — resident memory,
// heap, event-loop lag, how many ffmpeg children are alive — keeps a short
// history, and acts in two stages:
//
//   soft heal  (memory high, or the loop sluggish for a while): drop the
//              in-memory caches that can be rebuilt, reap idle transcoders
//              now rather than at their next sweep, ask V8 for a GC when the
//              process was started with --expose-gc. Logged, and reported to
//              the admin's Health card.
//   hard heal  (memory still climbing after a soft heal, or the loop stuck):
//              a clean exit — pm2 restarts the process on the same code in
//              ~3s, every JsonStore flushed on the way out. Only under pm2
//              (PM2_HOME / pm_id in the env); bare `node server.js` logs the
//              verdict and keeps running, since nothing would bring it back.
//
// Thresholds sit under pm2's max_memory_restart (1500M) so the process is
// recycled tidily instead of being killed mid-write.
const os = require("os");

const EVERY_MS = 20000;
const HISTORY = 180; // an hour at 20s
const SOFT_RSS = 1000 * 1024 * 1024;
const HARD_RSS = 1300 * 1024 * 1024;
const SOFT_LAG_MS = 1500;
const HARD_LAG_MS = 6000;
const SOFT_COOLDOWN_MS = 5 * 60 * 1000;

const history = []; // {at, rss, heapUsed, heapTotal, lagMs, ffmpeg}
const events = []; // {at, kind, detail}
let lastSoftAt = 0;
let hardStrikes = 0;
let lagStrikes = 0;
let softHooks = []; // () => string | void — registered by modules with caches
let timer = null;

const underPm2 = () => !!(process.env.pm_id || process.env.PM2_HOME);

const note = (kind, detail) => {
  events.push({ at: Date.now(), kind, detail });
  if (events.length > 60) events.shift();
  console.log(`[watchdog] ${kind}${detail ? ` — ${detail}` : ""}`);
};

// Modules hand in what they can drop under pressure (jit tables, remux
// jobs idle for a while, similar-titles rows…). Each returns a short note.
const onSoftHeal = (fn) => softHooks.push(fn);

// What the spawners say they're running — true on every platform — plus
// whatever /proc can add on Linux (probes, offline prepares).
const ffmpegCount = () => {
  let n = 0;
  try { n += require("../media/jit").liveCount(); } catch {}
  try { n += require("../media/remux").liveCount(); } catch {}
  if (process.platform !== "linux") return n;
  let procN = 0;
  try {
    // cheap and portable enough: count children by command name on Linux
    const fs = require("fs");
    if (process.platform === "linux") {
      for (const pid of fs.readdirSync("/proc")) {
        if (!/^\d+$/.test(pid)) continue;
        try {
          const st = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
          const m = st.match(/^\d+ \((.*?)\) \S \d+ /);
          if (m && /ffmpeg/i.test(m[1]) && st.split(") ")[1].split(" ")[1] === String(process.pid)) procN++;
        } catch {}
      }
    }
  } catch {}
  return Math.max(n, procN);
};

// The server is legitimately busy while it enriches (synchronous probes) or
// fingerprints intros — lag then is work, not a fault.
const busyWithWork = () => {
  try { if (require("../media/scanner").isEnriching()) return true; } catch {}
  try { if (require("../media/introdetect").busy()) return true; } catch {}
  return false;
};

// One self-restart per quarter hour: a fault that comes straight back after
// a restart (a hung mount, a baseline over the line) must not become a loop.
const RESTART_GAP_MS = 15 * 60 * 1000;
const restartStore = () => {
  try {
    const path = require("path");
    const config = require("../config");
    const { JsonStore } = require("./jsonstore");
    return new JsonStore(path.join(config.DATA_DIR, "watchdog.json"), { lastRestartAt: 0 });
  } catch {
    return null;
  }
};
let rstore = null;

const softHeal = (why) => {
  lastSoftAt = Date.now();
  const notes = [];
  for (const fn of softHooks) {
    try {
      const r = fn();
      if (r) notes.push(String(r));
    } catch (e) {
      notes.push(`hook failed: ${e.message}`);
    }
  }
  if (typeof global.gc === "function") {
    try { global.gc(); notes.push("gc"); } catch {}
  }
  const after = process.memoryUsage();
  note("soft heal", `${why} · ${notes.join(", ") || "nothing to drop"} · rss now ${(after.rss / 1048576).toFixed(0)} MB`);
};

const hardHeal = (why) => {
  hardStrikes = 0;
  lagStrikes = 0;
  if (!underPm2()) {
    note("hard heal skipped", `${why} — not under pm2, nothing would restart the server`);
    return;
  }
  rstore = rstore || restartStore();
  const last = rstore ? rstore.data.lastRestartAt || 0 : 0;
  if (Date.now() - last < RESTART_GAP_MS) {
    note("restart loop suspected", `${why} — restarted ${Math.round((Date.now() - last) / 60000)} min ago, not again yet`);
    return;
  }
  if (rstore) { rstore.data.lastRestartAt = Date.now(); rstore.flush(); }
  note("restarting", why);
  try {
    require("../realtime").broadcastAll({ type: "server_notice", message: "Aurora is restarting itself for a moment — back in a few seconds." });
  } catch {}
  // flush now, and again at the very end for anything saved in between
  try { require("./jsonstore").flushAll(); } catch {}
  setTimeout(() => {
    try { require("./jsonstore").flushAll(); } catch {}
    process.exit(3);
  }, 800);
};

let lagProbeAt = 0;
let lagMs = 0;
const probeLag = () => {
  lagProbeAt = Date.now();
  setTimeout(() => { lagMs = Math.max(0, Date.now() - lagProbeAt - 500); }, 500);
};

const tick = () => {
  const m = process.memoryUsage();
  const sample = { at: Date.now(), rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, lagMs, ffmpeg: ffmpegCount() };
  history.push(sample);
  if (history.length > HISTORY) history.shift();
  const lagNow = lagMs;
  lagMs = 0; // each strike must come from its own probe
  probeLag();

  // busy with real work (probes, fingerprints): note the lag, judge nothing
  if (busyWithWork()) { lagStrikes = 0; return; }
  if (lagNow > HARD_LAG_MS) lagStrikes++; else lagStrikes = 0;
  if (lagStrikes >= 3) { hardHeal(`event loop stuck (${lagMs} ms lag, 3 checks)`); lagStrikes = 0; return; }

  const soft = m.rss > SOFT_RSS || lagNow > SOFT_LAG_MS;
  if (soft && Date.now() - lastSoftAt > SOFT_COOLDOWN_MS) {
    softHeal(m.rss > SOFT_RSS ? `rss ${(m.rss / 1048576).toFixed(0)} MB` : `loop lag ${lagNow} ms`);
  }
  if (m.rss > HARD_RSS) hardStrikes++; else hardStrikes = 0;
  if (hardStrikes >= 3) { hardHeal(`rss ${(m.rss / 1048576).toFixed(0)} MB for 3 checks after a soft heal`); hardStrikes = 0; }
};

const start = () => {
  if (timer) return;
  probeLag();
  timer = setInterval(tick, EVERY_MS);
  timer.unref?.();
  note("armed", `soft at ${SOFT_RSS / 1048576} MB / ${SOFT_LAG_MS} ms lag, restart at ${HARD_RSS / 1048576} MB${underPm2() ? " (pm2)" : " (no pm2: log only)"}`);
};

const status = () => {
  const m = process.memoryUsage();
  return {
    now: { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, lagMs, ffmpeg: ffmpegCount(), uptimeSec: Math.floor(process.uptime()), load: os.loadavg() },
    thresholds: { softRss: SOFT_RSS, hardRss: HARD_RSS, softLagMs: SOFT_LAG_MS, hardLagMs: HARD_LAG_MS },
    pm2: underPm2(),
    lastSoftAt: lastSoftAt || null,
    history: history.slice(-90),
    events: events.slice(-20),
  };
};

module.exports = { start, status, softHeal, hardHeal, onSoftHeal, _internals: { tick, history, events } };
