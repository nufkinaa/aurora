// How long the event loop has been keeping everyone waiting — measured
// continuously (perf_hooks.monitorEventLoopDelay), read in windows.
//
// GET /healthz reports the last finished window, so whoever probes from
// outside (the keeper, an uptime monitor) learns not only "it answered" but
// "it has been blocked for N ms at a time". A loop that is stuck outright
// cannot answer at all; that is the keeper's other signal.
//
// The figures are delays ABOVE the quietest reading of the window: the
// sampling timer itself never fires exactly on time (on Windows a 20 ms
// timer lands on the 15.6 ms clock tick, about 31 ms), and that is the
// machine's clock, not a busy loop.
"use strict";
const { monitorEventLoopDelay } = require("perf_hooks");

const WINDOW_MS = 10 * 1000;
let h = null;
let timer = null;
let last = { maxMs: 0, p99Ms: 0, p50Ms: 0, meanMs: 0, windowMs: 0, at: 0 };

const ms = (ns) => Math.max(0, Math.round((ns / 1e6) * 10) / 10);
const above = (ns, floorNs) => ms(Math.max(0, ns - floorNs));

const roll = () => {
  if (!h) return;
  const floor = h.min > 0 && h.min < 1e15 ? h.min : 0;
  last = { maxMs: above(h.max, floor), p99Ms: above(h.percentile(99), floor), p50Ms: above(h.percentile(50), floor), meanMs: above(h.mean || 0, floor), windowMs: WINDOW_MS, at: Date.now() };
  h.reset();
};

const start = () => {
  if (h) return;
  try {
    h = monitorEventLoopDelay({ resolution: 20 });
    h.enable();
  } catch {
    h = null;
    return;
  }
  timer = setInterval(roll, WINDOW_MS);
  timer.unref?.();
};

const stop = () => {
  if (timer) clearInterval(timer);
  timer = null;
  try { if (h) h.disable(); } catch {}
  h = null;
};

// The last finished window, and the one in progress (whichever is worse is
// what a prober should judge: a long block shows up in "now" first).
const read = () => {
  let now = 0;
  try { if (h && h.max > 0) now = above(h.max, h.min > 0 && h.min < 1e15 ? h.min : 0); } catch {}
  return { maxMs: Math.max(last.maxMs, now), p99Ms: last.p99Ms, meanMs: last.meanMs, windowMs: WINDOW_MS };
};
// …plus the median, for the admin's metrics (/healthz keeps its four numbers:
// the keeper and outside monitors read exactly those).
const detail = () => ({ ...read(), p50Ms: last.p50Ms });

module.exports = { start, stop, read, detail, _roll: roll };
