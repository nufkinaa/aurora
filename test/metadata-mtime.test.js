// media/metadata.js needsProbe: a file REPLACED under the same name (a new
// date) needs a new probe — the old one (length, tracks, codecs) was kept for
// ever, because only the probe version was compared (server round, 2026-10-18).
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const metadata = require("../src/media/metadata");

test("needsProbe: no entry, an old probe version, or another date", () => {
  const p = "Z:/nowhere/needsprobe-test.mkv";
  const store = metadata._store.data;
  try {
    assert.equal(metadata.needsProbe(p), true, "never probed");
    store[p] = { v: 0, mtime: 100 };
    assert.equal(metadata.needsProbe(p, 100), true, "an old probe version");
    // the probe version in force
    store[p] = { ...store[p], v: currentVersion() };
    assert.equal(metadata.needsProbe(p), false, "no date given: as before");
    assert.equal(metadata.needsProbe(p, 100), false, "the same date");
    assert.equal(metadata.needsProbe(p, 200), true, "replaced: another date");
  } finally {
    delete store[p];
  }
});

// The probe version in force, from the module's own source (it is not exported).
function currentVersion() {
  const src = require("fs").readFileSync(require.resolve("../src/media/metadata"), "utf8");
  return Number(/const PROBE_VERSION = (\d+);/.exec(src)[1]);
}
