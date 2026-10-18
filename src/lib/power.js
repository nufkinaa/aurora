// How much machine this is: the LOW-POWER profile for small boxes (server
// round, 2026-10-18 — docs/qa/server-round/EVENTLOOP.md).
//
// A Raspberry-Pi-class box, an old two-core laptop or a small VPS runs the
// same server as an eight-core desktop. On a small one the background work
// that only makes things a little better (a wider recommender, a longer
// list of well-known titles for the search to suggest, a health round every
// minute, a rescan every ten) takes the memory and CPU the viewers need. The
// profile is chosen from what is DETECTED, and config.json can say otherwise:
//
//   "powerProfile": "auto"     (the default) low when any of these holds:
//                                - 4 CPU threads or fewer (the threads this
//                                  process may use: os.availableParallelism,
//                                  which on Linux follows the CPU affinity /
//                                  container limit)
//                                - 6 GB of memory or less (the machine's, or
//                                  the container's limit when there is one:
//                                  process.constrainedMemory)
//                                - a JavaScript heap limit under 1 GB (the
//                                  server was started with a small
//                                  --max-old-space-size, or the machine is so
//                                  small that Node chose one)
//                   "low"      always low
//                   "normal"   never low
//
// What "low" changes (each module asks pick(normal, low)):
//   - the background budget runs ONE heavy decode at a time (media/cpuwork.js;
//     it does on any machine of 8 threads or fewer, too)
//   - the recommender scores at most 2,000 titles (+ the household's own)
//     instead of every title it knows (media/recs/index.js)
//   - the search suggests from 2,000 well-known titles, not 5,000
//     (media/search.js — the list on disk is not touched)
//   - the healer's round every 3 minutes instead of every minute (lib/healer.js)
//   - the library rescan every 20 minutes instead of 10 — only when
//     config.json does not set "scanIntervalMinutes" (src/config.js)
// Nothing a person sees changes otherwise; nothing stored is changed.
// status() says which and why, for the admin's health page.
"use strict";
const os = require("os");
const v8 = require("v8");

const LOW_MAX_THREADS = 4;
const LOW_MAX_MEMORY = 6 * 1024 * 1024 * 1024;
const LOW_MAX_HEAP = 1024 * 1024 * 1024;
const GB = 1024 * 1024 * 1024;

const threads = () => {
  try { return typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length; } catch { return 1; }
};
// the machine's memory, or the container's limit when that is lower
const memory = () => {
  let m = os.totalmem();
  try {
    const c = typeof process.constrainedMemory === "function" ? process.constrainedMemory() : 0;
    if (c > 0 && c < m) m = c;
  } catch {}
  return m;
};
const heapLimit = () => {
  try { return v8.getHeapStatistics().heap_size_limit; } catch { return Infinity; }
};
const machine = () => ({ threads: threads(), memory: memory(), heap: heapLimit() });

const gb = (b) => Math.round((b / GB) * 10) / 10;

// "low" | "normal", and why — from the setting and the machine
const decide = (setting = "auto", m = machine()) => {
  const s = String(setting || "auto").toLowerCase();
  if (s === "low") return { profile: "low", why: 'set to "low" in config.json' };
  if (s === "normal") return { profile: "normal", why: 'set to "normal" in config.json' };
  const small = [];
  if (m.threads <= LOW_MAX_THREADS) small.push(`${m.threads} CPU thread${m.threads === 1 ? "" : "s"}`);
  if (m.memory <= LOW_MAX_MEMORY) small.push(`${gb(m.memory)} GB of memory`);
  if (m.heap != null && m.heap < LOW_MAX_HEAP) small.push(`a ${Math.round(m.heap / 1048576)} MB JavaScript heap`);
  if (small.length) return { profile: "low", why: `automatic: ${small.join(", ")}` };
  return { profile: "normal", why: `automatic: ${m.threads} CPU threads, ${gb(m.memory)} GB of memory` };
};

let decided = null;
const current = () => {
  if (!decided) {
    let setting = "auto";
    try { setting = require("../config").POWER_PROFILE || "auto"; } catch {}
    const m = machine();
    decided = { ...decide(setting, m), setting, threads: m.threads, memoryGb: gb(m.memory), heapMb: Number.isFinite(m.heap) ? Math.round(m.heap / 1048576) : null, platform: process.platform, node: process.version };
  }
  return decided;
};
const low = () => current().profile === "low";
const pick = (normal, lowValue) => (low() ? lowValue : normal);
const status = () => ({ ...current() });

module.exports = { low, pick, status, decide, machine, LOW_MAX_THREADS, LOW_MAX_MEMORY, LOW_MAX_HEAP, _reset: () => { decided = null; } };
