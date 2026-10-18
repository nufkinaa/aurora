// lib/caches.js: bounded maps (least recently used goes; an expiry when
// asked) and the size report the admin's health page shows — and the caches
// that only grew are bounded now (server round, 2026-10-18).
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { BoundedMap, register, report } = require("../src/lib/caches");

test("BoundedMap: never more than max; the least recently USED goes", () => {
  const m = new BoundedMap({ max: 3 });
  m.set("a", 1).set("b", 2).set("c", 3);
  assert.equal(m.get("a"), 1); // a is now the youngest
  m.set("d", 4);
  assert.equal(m.size, 3);
  assert.equal(m.has("b"), false, "b was the least recently used");
  assert.deepEqual([...m.keys()], ["c", "a", "d"]);
  assert.deepEqual([...m.entries()], [["c", 3], ["a", 1], ["d", 4]]);
  assert.equal(m.dropped, 1);
  m.delete("a");
  assert.equal(m.size, 2);
  m.clear();
  assert.equal(m.size, 0);
});

test("BoundedMap with ttlMs: an old entry is no answer", async () => {
  const m = new BoundedMap({ max: 10, ttlMs: 30 });
  m.set("x", 1);
  assert.equal(m.get("x"), 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(m.get("x"), undefined);
  assert.equal(m.has("x"), false);
  assert.equal(m.size, 0, "dropped when seen");
});

test("the size report lists every named cache, the biggest first, and says when one is at its bound", () => {
  const a = new BoundedMap({ max: 2, name: "test: small" });
  a.set(1, 1).set(2, 2).set(3, 3);
  register("test: plain", () => ({ entries: 5 }));
  const r = report();
  const small = r.find((x) => x.name === "test: small");
  assert.deepEqual([small.entries, small.max, small.full], [2, 2, true]);
  assert.equal(r.find((x) => x.name === "test: plain").entries, 5);
  for (let i = 1; i < r.length; i++) assert.ok(r[i - 1].entries >= r[i].entries);
});

test("the usage aggregate keeps at most MAX_KEYS keys per table, whatever clients send", () => {
  const usage = require("../src/lib/usage");
  usage._reset && usage._reset();
  const apply = usage._internals.apply;
  for (let i = 0; i < usage.MAX_KEYS + 200; i++) {
    apply({ profile: "p1", sid: `s${i}`, device: "desktop", look: "glass", events: [{ n: "route", t: Date.now(), p: { r: `/junk/${i}`, ms: 5 } }, { n: "feat", t: Date.now(), p: { f: `f${i}` } }] });
  }
  const agg = usage._internals.agg();
  assert.equal(Object.keys(agg.routes).length, usage.MAX_KEYS);
  assert.equal(Object.keys(agg.features).length, usage.MAX_KEYS);
  // a key already there is still counted
  apply({ profile: "p1", sid: "s0", device: "desktop", look: "glass", events: [{ n: "route", t: Date.now(), p: { r: "/junk/0", ms: 5 } }] });
  assert.equal(agg.routes["/junk/0"].n, 2);
  usage._reset && usage._reset();
});

test("the blur-up placeholders in memory are bounded", () => {
  const blur = require("../src/lib/blurup");
  const mem = blur._internals.mem;
  assert.ok(mem instanceof BoundedMap);
  assert.ok(mem.max >= 1000 && mem.max <= 100000);
});
