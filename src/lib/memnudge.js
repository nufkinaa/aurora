// A full garbage collection when Buffers nobody holds any more pile up.
//
// Torrent streaming moves pieces of 2–16 MB through Buffers at tens of MB a
// second. The JavaScript heap stays small (20–30 MB), so V8 may see no
// reason for a full collection, and the pieces' memory — already garbage —
// is not given back. Measured with a private two-client swarm on this PC
// (tools/streamload/torrentmem.js: 1.2 GB streamed at 24–30 MB/s, 8 MB
// pieces): without this, 9 runs peaked at 235–1,291 MB RSS, four of them
// over 1.1 GB (the watchdog's soft line is 1 GB); with it, 6 runs peaked at
// 336–509 MB. When the memory held by ArrayBuffers passes LIMIT_MB: one full
// collection (a few ms on a heap this size), at most once per MIN_GAP_MS.
// `global.gc` is not there unless node was started with --expose-gc; the V8
// flag is set at run time for that, and if that is refused nothing happens.
"use strict";
const v8 = require("v8");
const vm = require("vm");

const LIMIT_MB = 384;
const MIN_GAP_MS = 5000;
let gc = null;
let tried = false;
let last = 0;
let runs = 0;
let lastMs = 0;
const getGc = () => {
  if (gc || tried) return gc;
  tried = true;
  if (typeof global.gc === "function") return (gc = global.gc);
  try {
    v8.setFlagsFromString("--expose-gc");
    gc = vm.runInNewContext("gc");
  } catch { gc = null; }
  return gc;
};
// → true when a collection ran
const check = (now = Date.now(), limitMb = LIMIT_MB) => {
  if (now - last < MIN_GAP_MS) return false;
  const ab = process.memoryUsage().arrayBuffers / 1048576;
  if (ab < limitMb) return false;
  const fn = getGc();
  if (!fn) return false;
  last = now;
  const t0 = Date.now();
  try { fn(); } catch { return false; }
  lastMs = Date.now() - t0;
  runs++;
  return true;
};
const stats = () => ({ runs, lastMs, available: !!getGc() });
module.exports = { check, stats, LIMIT_MB };
