// Aurora's share of a drive is counted again shortly after something lands on,
// moves to or is removed from it — not only at the six-hour round (elia,
// 2026-11-09: a film that had just landed showed as "Other").
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const base = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-recount-"));
const other = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-recount-b-"));
process.env.AURORA_DRIVES_EXTRA = JSON.stringify([{ path: base }, { path: other }]);
const drives = require("../src/lib/drives");
const { _internals: I } = drives;

test("changes close together are counted once, 30 s after the last, per drive; a path on no drive is ignored", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const counted = [];
  const real = I.measureUsage;
  I.measureUsage = async (d) => { counted.push(d.id); };
  t.after(() => { I.measureUsage = real; });
  I.live.drives = [base, other].map((p) => ({ id: path.resolve(p), mount: path.resolve(p), source: p, fstype: "folder", network: false, options: [] }));
  assert.equal(drives.recountSoon(path.join(base, "Aurora", "Movies", "A (2020)", "a.mkv")), true);
  t.mock.timers.tick(10000);
  assert.equal(drives.recountSoon(path.join(base, "Aurora", "Movies", "B (2021)", "b.mkv")), true);
  assert.equal(drives.recountSoon(path.join(other, "Aurora", "Shows", "S", "e1.mkv")), true);
  t.mock.timers.tick(29000);
  assert.deepEqual(counted, [], "not before 30 s after the last change");
  t.mock.timers.tick(1500);
  assert.deepEqual(counted.sort(), [path.resolve(base), path.resolve(other)].sort(), "each drive counted once");
  assert.equal(drives.recountSoon(null), false);
});
