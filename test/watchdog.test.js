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

const SUP_ENV = ["pm_id", "PM2_HOME", "AURORA_SUPERVISOR", "INVOCATION_ID", "AURORA_SUPERVISED"];
test("hard heal with nothing supervising the server is a log line, not an exit", () => {
  const saved = {};
  for (const k of SUP_ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    wd.hardHeal("unit test");
    const ev = wd._internals.events;
    assert.ok(ev.some((e) => e.kind === "hard heal skipped" && /not supervised/.test(e.detail)));
    assert.equal(wd.status().pm2, false);
    assert.equal(wd.status().supervisor.supervised, false);
  } finally {
    for (const k of SUP_ENV) if (saved[k] != null) process.env[k] = saved[k];
  }
});

test("status reports the shape the admin card reads", () => {
  wd._internals.tick();
  const s = wd.status();
  assert.ok(s.now.rss > 0 && s.thresholds.hardRss > s.thresholds.softRss);
  assert.ok(Array.isArray(s.history) && s.history.length >= 1);
  assert.equal(typeof s.pm2, "boolean");
});
