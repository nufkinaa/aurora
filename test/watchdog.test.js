// The watchdog's two stages, driven by hand: soft heal calls every registered
// hook once (with a cooldown), and a hard heal outside pm2 only logs.
const test = require("node:test");
const assert = require("node:assert");

const wd = require("../src/lib/watchdog");

test("soft heal runs the hooks and records an event", () => {
  let calls = 0;
  wd.onSoftHeal(() => { calls++; return "test cache dropped"; });
  wd.softHeal("unit test");
  assert.equal(calls, 1);
  const ev = wd._internals.events;
  assert.ok(ev.some((e) => e.kind === "soft heal" && /test cache dropped/.test(e.detail)));
});

test("hard heal without pm2 is a log line, not an exit", () => {
  const savedPm = process.env.pm_id, savedHome = process.env.PM2_HOME;
  delete process.env.pm_id; delete process.env.PM2_HOME;
  try {
    wd.hardHeal("unit test");
    const ev = wd._internals.events;
    assert.ok(ev.some((e) => e.kind === "hard heal skipped"));
  } finally {
    if (savedPm != null) process.env.pm_id = savedPm;
    if (savedHome != null) process.env.PM2_HOME = savedHome;
  }
});

test("status reports the shape the admin card reads", () => {
  wd._internals.tick();
  const s = wd.status();
  assert.ok(s.now.rss > 0 && s.thresholds.hardRss > s.thresholds.softRss);
  assert.ok(Array.isArray(s.history) && s.history.length >= 1);
  assert.equal(typeof s.pm2, "boolean");
});
