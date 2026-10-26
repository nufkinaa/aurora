"use strict";
const test = require("node:test");
const assert = require("node:assert");

// lib/disk.js freeBytesCached: the stream routes' "disk nearly full" guard reads
// the free space off the event loop after the first ask (capacity-2026-10: a
// statfsSync per playlist waited 12–22 s on a busy system disk).
test("freeBytesCached: one blocking ask per folder, then the last value, refreshed in the background", async () => {
  const fs = require("fs");
  const disk = require("../src/lib/disk");
  const dir = require("os").tmpdir();
  disk._internals.free.clear();
  const real = { sync: fs.statfsSync, async: fs.promises.statfs };
  let syncN = 0, asyncN = 0;
  fs.statfsSync = (...a) => { syncN++; return real.sync(...a); };
  fs.promises.statfs = (...a) => { asyncN++; return real.async(...a); };
  try {
    const t0 = 1e12;
    const first = disk.freeBytesCached(dir, 5000, t0);
    assert.ok(first > 0 && Number.isFinite(first));
    assert.strictEqual(disk.freeBytesCached(dir, 5000, t0 + 1000), first); // fresh: no ask at all
    assert.deepStrictEqual([syncN, asyncN], [1, 0]);
    disk.freeBytesCached(dir, 5000, t0 + 6000); // stale: answered at once, refreshed in the background
    disk.freeBytesCached(dir, 5000, t0 + 6001); // (one refresh at a time)
    assert.deepStrictEqual([syncN, asyncN], [1, 1]);
    await new Promise((r) => setTimeout(r, 50));
  } finally { fs.statfsSync = real.sync; fs.promises.statfs = real.async; disk._internals.free.clear(); }
});
