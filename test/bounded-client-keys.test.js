// Maps keyed by what a client sends are bounded (perf-server 2026-11-10):
// the sign-in wall's "said once a minute" log throttle (keyed by the start of
// any refused path, reachable with no session), the AI picks' answers (keyed
// by the asker's own words) and the skip databases' remembered failures
// (keyed by the numbers in GET /api/segments).
const test = require("node:test");
const assert = require("node:assert/strict");
const { sayOnce } = require("../src/lib/sayonce");

test("sayOnce: once a window per key, as the wall always said it", () => {
  const due = sayOnce({ max: 500, windowMs: 60000 });
  assert.equal(due("/img/a", 0), true);
  assert.equal(due("/img/a", 30000), false);
  assert.equal(due("/img/a", 60000), false, "within the window (the old test was > 60 s)");
  assert.equal(due("/img/a", 60001), true);
  assert.equal(due("/img/b", 60001), true, "another key is its own");
});

test("sayOnce: a flood of new keys never grows it past its bound, and old keys make room", () => {
  const due = sayOnce({ max: 100, windowMs: 60000 });
  for (let i = 0; i < 10000; i++) due(`/img/${i}`, 1000);
  assert.equal(due.size(), 100);
  assert.equal(due("/img/new", 2000), false, "all fresh: a new prefix is not said this minute");
  assert.equal(due.size(), 100);
  assert.equal(due("/img/new", 62000), true, "the window over: the old keys go, the new one is said");
  assert.ok(due.size() <= 100);
});

test("AI picks' answers: bounded and a day at most", () => {
  const { cache } = require("../src/media/ai")._internals;
  assert.equal(cache.max, 500);
  assert.equal(cache.ttlMs, 24 * 3600 * 1000);
  for (let i = 0; i < 2000; i++) cache.set(`50|any|any|vibe number ${i}`, { at: Date.now(), items: [] });
  assert.equal(cache.size, 500);
  cache.clear();
});

test("skip databases' remembered failures: bounded, and forgotten after the hour they matter", () => {
  const { failures } = require("../src/media/skipsegments")._internals;
  assert.equal(failures.ttlMs, 60 * 60 * 1000);
  for (let i = 0; i < 20000; i++) failures.set(`tt0000001:${i}:1:5`, Date.now());
  assert.ok(failures.size <= 5000);
  failures.clear();
});
