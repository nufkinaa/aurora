// Usage stats: what the server keeps from a batch, what it throws away, and
// that the summary and its text form say the same thing.
const test = require("node:test");
const assert = require("node:assert");
const usage = require("../src/lib/usage");

const batch = (events, extra = {}) => ({ profile: "p1", sid: "abcd1234", device: "phone", look: "glass", events, ...extra });

test("a batch is cleaned: bad names, keys and values drop, times are re-stamped", () => {
  const now = Date.now();
  const v = usage.validate(
    batch([
      { n: "route", t: now, p: { r: "/movie/:id", ms: 812.4, junk: { a: 1 }, "Bad Key": 1 } },
      { n: "Nope!", t: now, p: {} },
      { n: "feat", t: 5, p: { f: "peek" } },
      "garbage",
    ]),
    now,
  );
  assert.ok(v);
  assert.strictEqual(v.events.length, 2);
  assert.deepStrictEqual(v.events[0].p, { r: "/movie/:id", ms: 812.4 });
  assert.strictEqual(v.events[1].t, now, "a 1970 timestamp is re-stamped to now");
  assert.strictEqual(usage.validate(batch([{ n: "route", t: now, p: {} }], { profile: "../x" })), null);
  assert.strictEqual(usage.validate({}), null);
});

test("the aggregate counts routes, features, plays and errors and renders as text", () => {
  usage._reset();
  const now = Date.now();
  usage.record(batch([
    { n: "route", t: now, p: { r: "/", ms: 300 } },
    { n: "route", t: now, p: { r: "/", ms: 900 } },
    { n: "route", t: now, p: { r: "/movie/:id", ms: 1200 } },
    { n: "feat", t: now, p: { f: "peek" } },
    { n: "nav", t: now, p: { to: "#/movies" } },
    { n: "play", t: now, p: { kind: "library", path: "jit", ms: 1500 } },
    { n: "error", t: now, p: { m: "boom" } },
  ]), { persist: false });
  usage.record(batch([{ n: "feat", t: now, p: { f: "peek" } }], { device: "desktop", sid: "zzzz9999" }), { persist: false });
  const s = usage.summary();
  assert.strictEqual(s.events, 8);
  assert.strictEqual(s.routes[0].route, "/");
  assert.strictEqual(s.routes[0].n, 2);
  assert.ok(s.routes[0].p50 >= 300 && s.routes[0].p90 <= 900);
  assert.strictEqual(s.features[0].feature, "peek");
  assert.strictEqual(s.features[0].n, 2);
  assert.deepStrictEqual(s.features[0].byDevice, { phone: 1, desktop: 1 });
  assert.strictEqual(s.plays[0].path, "library/jit");
  assert.strictEqual(s.errors[0].message, "boom");
  assert.strictEqual(s.activeByDay.length, 1);
  assert.strictEqual(s.activeByDay[0].sessions, 2);
  const t = usage.text();
  assert.match(t, /8 events in 2 batches/);
  assert.match(t, /\/movie\/:id  1 · 1\.2s/);
  assert.match(t, /peek  2 · phone 1, desktop 1/);
  assert.match(t, /library\/jit  1 · 1\.5s/);
});

test("an oversized batch is capped at 50 events", () => {
  usage._reset();
  const now = Date.now();
  const many = Array.from({ length: 80 }, () => ({ n: "nav", t: now, p: { to: "#/" } }));
  assert.strictEqual(usage.record(batch(many), { persist: false }), 50);
});
