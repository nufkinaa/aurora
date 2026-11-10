// Code the apps' first requests load, read at a quiet moment after the start
// instead (perf-server 2026-11-10).
//
// Once the server is warm by every other measure (library, recommender,
// search index), the FIRST request of several kinds still loaded a module on
// the spot — each one a synchronous read and compile of its files, holding the
// event loop for every other client meanwhile. Measured on this Windows PC
// (tools/backend-perf/firstuse.js, the household of tools/backend-perf/
// dataset.js; the disk is slow under a virus scanner): /api/me 64 ms
// (untouched), the first Home 22-277 ms (stills), the first Calendar 181 ms,
// the first More like this ~100 ms (similar + its cache), the first title
// page 25 ms (playprep), the TV's tuning 30 ms, the server's own picture
// reads 23 ms (internalpass). A Linux box with a warm page cache pays a
// fraction of that.
//
// These modules do nothing when loaded but define things (similar.js opens
// its cache file, as its first request would): loading them early changes
// nothing but WHEN the cost is paid. One per step, `gapMs` apart, so each is
// one short pause at a time nobody is waiting on it — never a burst.
"use strict";

const MODULES = [
  "../media/untouched", // GET /api/me
  "./internalpass", // the server reading its own pictures (blur-up)
  "../media/stills", // the first Home
  "./playprep", // the first title page
  "./tvtuning", // the TV's /api/tv/tuning
  "../media/similar", // More like this
  "../media/calendar", // the Calendar
];

const warm = ({ delayMs = 30 * 1000, gapMs = 250, modules = MODULES, load = require, onDone = null } = {}) => {
  let i = 0;
  const step = () => {
    if (i >= modules.length) { if (onDone) onDone(); return; }
    try { load(modules[i]); } catch {}
    i++;
    const t = setTimeout(step, gapMs);
    t.unref?.();
  };
  const t = setTimeout(step, delayMs);
  t.unref?.();
  return t;
};

module.exports = { warm, MODULES };
