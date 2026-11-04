// The one-off repair of watch time recorded the old way (src/lib/watchfix.js,
// scripts/fix-watch-time.js, and the startup run in src/telemetry.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const watchfix = require("../src/lib/watchfix");

const at = (h) => new Date(Date.parse("2026-10-20T08:00:00.000Z") + h * 3600 * 1000).toISOString();
const v = (o) => ({ id: Math.random().toString(16).slice(2, 14), profile: "Ann", content: "A film", startedAt: at(0), endedAt: at(2), updatedAt: at(2), watchedSec: 7200, duration: 7000, position: 7000, live: false, ...o });

const fixtures = () => [
  // the 71 hours: a 40-minute episode left paused on the TV
  v({ content: "Show S2E10", duration: 2400, position: 2400, startedAt: at(0), endedAt: at(71), updatedAt: at(71), watchedSec: 71 * 3600 }),
  // an honest film: untouched
  v({}),
  // no known length, 9 hours: held to 3 h
  v({ content: "Mystery", duration: null, endedAt: at(9), updatedAt: at(9), watchedSec: 9 * 3600 }),
  // the same episode opened five times in one day, 40 min "watched" each
  ...[0, 1, 2, 3, 4].map((i) => v({ content: "Show S1E1", duration: 2400, startedAt: at(2 + i), endedAt: at(2 + i + 0.66), updatedAt: at(2 + i + 0.66), watchedSec: 2400 })),
  // counted the new way, or still open: never touched
  v({ content: "New way", acct: 2, duration: 600, watchedSec: 5000, endedAt: at(30) }),
  v({ content: "Open", live: true, duration: 600, watchedSec: 5000, endedAt: null }),
];

test("each old viewing is held to its span, the title's length (+10 %), 3 h with no length, and 1.5x a title per person per day", () => {
  const list = fixtures();
  const p = watchfix.plan(list);
  const after = (content) => list.map((s, i) => [s, p.changes.find((c) => c.i === i)]).filter(([s]) => s.content === content).map(([s, c]) => (c ? c.after : s.watchedSec));
  assert.deepEqual(after("Show S2E10"), [2640], "71 h → 44 min");
  assert.deepEqual(after("A film"), [7200], "an honest one stays");
  assert.deepEqual(after("Mystery"), [3 * 3600]);
  const day = after("Show S1E1");
  assert.equal(day.reduce((a, b) => a + b, 0), 3600, "five 40-minute opens in a day: 1.5 x 40 min in all");
  assert.deepEqual(after("New way"), [5000]);
  assert.deepEqual(after("Open"), [5000]);
  assert.match(watchfix.summary(list, p), /The biggest corrections:\n {2}\S+ {2}Ann {2}Show S2E10 \(40 min long\): 71\.0 h → 44 min/);
});

test("applying keeps the value before, and a second run changes nothing", () => {
  const list = fixtures();
  const n = watchfix.apply(list);
  assert.equal(n, 7);
  assert.equal(list[0].watchedSecRaw, 71 * 3600);
  assert.equal(list[0].wtfix, watchfix.VERSION);
  const snapshot = JSON.stringify(list);
  assert.equal(watchfix.plan(list).changes.length, 0);
  assert.equal(watchfix.apply(list), 0);
  assert.equal(JSON.stringify(list), snapshot);
});

test("the script: a dry run writes nothing; --apply backs the file up first; a second --apply has nothing to do", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-wtfix-"));
  try {
    const file = path.join(dir, "watch-sessions.json");
    fs.writeFileSync(file, JSON.stringify(fixtures()));
    const before = fs.readFileSync(file, "utf-8");
    const script = path.join(__dirname, "..", "scripts", "fix-watch-time.js");
    const dry = execFileSync(process.execPath, [script, "--file", file], { encoding: "utf-8" });
    assert.match(dry, /Dry run/);
    assert.match(dry, /7 would change/);
    assert.equal(fs.readFileSync(file, "utf-8"), before);
    const out = execFileSync(process.execPath, [script, "--file", file, "--apply"], { encoding: "utf-8" });
    assert.match(out, /Written/);
    const backups = fs.readdirSync(dir).filter((f) => f.includes("before-watch-fix"));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), "utf-8"), before);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf-8"))[0].watchedSec, 2640);
    const again = execFileSync(process.execPath, [script, "--file", file, "--apply"], { encoding: "utf-8" });
    assert.match(again, /Nothing to change/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
