// The TV app's `perf` usage events (tv-native/src/perfTier.ts) aggregated for
// the admin: a row per screen × app version × impl, the boxes that reported,
// the memory warnings — and the same numbers in the text form the Copy
// button hands out.
const test = require("node:test");
const assert = require("node:assert");
const usage = require("../src/lib/usage");

const batch = (events, extra = {}) => ({ profile: "p1", sid: "abcd1234", device: "tv", look: "tv", events, ...extra });
const screen = (p, t = Date.now()) => ({ n: "perf", t, p: { screen: "home", p50: 29, p90: 41, jank: 3.4, frames: 1200, low: false, lite: false, ...p } });

test("a perf batch lands under screen|v|impl; a build without v/impl gets the defaults", () => {
  usage._reset();
  usage.record(batch([
    screen({ v: 92, impl: "-" }),
    screen({ v: 92, impl: "-", p50: 31, p90: 45, jank: 4, frames: 800, low: true, lite: true }),
    screen({ v: 93, impl: "F", p50: 24, p90: 33, jank: 1.1, frames: 500 }),
    screen({}), // an older build: no v, no impl
  ]), { persist: false });
  const rows = usage.summary().perf.screens;
  assert.strictEqual(rows.length, 3);
  const r92 = rows.find((r) => r.v === "92" && r.impl === "-");
  assert.deepStrictEqual(r92, { screen: "home", v: "92", impl: "-", n: 2, frames: 2000, p50: 31, p90: 45, p90hi: 45, jank: 4, low: 1, lite: 1 });
  const r93 = rows.find((r) => r.v === "93");
  assert.strictEqual(r93.impl, "F");
  assert.strictEqual(r93.n, 1);
  assert.strictEqual(r93.p90, 33);
  const old = rows.find((r) => r.v === "?");
  assert.ok(old, "missing v reads as ?");
  assert.strictEqual(old.impl, "-");
});

test("out-of-range timings are not sampled, a bad screen name is ignored, frames still count", () => {
  usage._reset();
  usage.record(batch([
    screen({ v: 92, impl: "-", p50: 1000, p90: -1, jank: 101, frames: 300 }),
    screen({ v: 92, impl: "-", p50: 0, p90: 999, jank: 100, frames: 100 }),
    { n: "perf", t: Date.now(), p: { screen: "Home Screen", p50: 20, p90: 30, jank: 1, frames: 100 } },
    { n: "perf", t: Date.now(), p: { screen: "a-very-long-screen-name-over-24", p50: 20, p90: 30, jank: 1, frames: 100 } },
    { n: "perf", t: Date.now(), p: { p50: 20, p90: 30, jank: 1, frames: 100 } },
  ]), { persist: false });
  const s = usage.summary();
  assert.strictEqual(s.events, 5, "the events are still counted as events");
  assert.strictEqual(s.perf.screens.length, 1);
  const r = s.perf.screens[0];
  assert.strictEqual(r.n, 2);
  assert.strictEqual(r.frames, 400);
  assert.strictEqual(r.p50, null, "1000 and 0 are out of (0, 1000)");
  assert.strictEqual(r.p90, 999, "-1 dropped, 999 kept");
  assert.strictEqual(r.jank, 100, "101 dropped, 100 kept");
});

test("device and trim events: boxes by model with sdk counts, the latest memory numbers, low reasons; trims by level", () => {
  usage._reset();
  const now = Date.now();
  const device = (p) => ({ n: "perf", t: now, p: { screen: "device", mem_mb: 2048, heap_mb: 256, lowram: false, sdk: 34, model: "MiTV-AFMU0", gpu: "Mali-G31", low: "frames", ...p } });
  usage.record(batch([
    device({}),
    device({ sdk: 30, mem_mb: 1900, heap_mb: 192, lowram: true, low: "android", gpu: "" }),
    device({ model: "", low: "no", sdk: 28 }),
    device({ model: "Other", low: "bogus", sdk: 0, mem_mb: -5 }),
    { n: "perf", t: now, p: { screen: "trim", level: 15 } },
    { n: "perf", t: now, p: { screen: "trim", level: 15 } },
    { n: "perf", t: now, p: { screen: "trim", level: 80 } },
    { n: "perf", t: now, p: { screen: "trim", level: 1000 } },
  ]), { persist: false });
  const { devices, trims } = usage.summary().perf;
  assert.strictEqual(devices.length, 3);
  assert.strictEqual(devices[0].model, "MiTV-AFMU0", "sorted by sessions");
  assert.deepStrictEqual(devices[0], {
    model: "MiTV-AFMU0", n: 2, sdk: { 34: 1, 30: 1 }, mem_mb: 1900, heap_mb: 192, gpu: "Mali-G31", lowram: 1,
    low: { no: 0, android: 1, mem: 0, heap: 0, frames: 1, trim: 0 },
  });
  assert.ok(devices.some((d) => d.model === "?"), "a blank model files under ?");
  const other = devices.find((d) => d.model === "Other");
  assert.deepStrictEqual(other.sdk, {}, "sdk 0 is not a level");
  assert.strictEqual(other.mem_mb, null, "a negative RAM figure is ignored");
  assert.strictEqual(other.low.no, 0, "an unknown reason is not counted");
  assert.deepStrictEqual(trims, { 15: 2, 80: 1 });
});

test("summary rows are sorted (screens by frames, devices by sessions) and capped at 40 each", () => {
  usage._reset();
  const now = Date.now();
  // 45 distinct keys for one screen: one per version code
  const keys = [];
  for (let i = 0; i < 45; i++) keys.push({ n: "perf", t: now, p: { screen: "browse", p50: 20, p90: 30, jank: 1, frames: 10 * (i + 1), v: 100 + i, impl: "-" } });
  usage.record(batch(keys), { persist: false });
  for (let i = 0; i < 3; i++) usage.record(batch([{ n: "perf", t: now, p: { screen: "device", model: "Box" + i, sdk: 34, mem_mb: 1024, heap_mb: 128, low: "no" } }].concat(i === 0 ? [{ n: "perf", t: now, p: { screen: "device", model: "Box0", sdk: 34, mem_mb: 1024, heap_mb: 128, low: "no" } }] : [])), { persist: false });
  const { screens, devices } = usage.summary().perf;
  assert.strictEqual(screens.length, 40);
  assert.strictEqual(screens[0].frames, 450, "the most frames first");
  assert.ok(screens.every((r, i) => i === 0 || r.frames <= screens[i - 1].frames));
  assert.strictEqual(devices[0].model, "Box0");
  assert.strictEqual(devices[0].n, 2);
});

test("text() carries the TV frames and TV boxes sections once there is perf data, and not before", () => {
  usage._reset();
  const now = Date.now();
  usage.record(batch([{ n: "route", t: now, p: { r: "/", ms: 300 } }], { device: "phone", look: "glass" }), { persist: false });
  let t = usage.text();
  assert.ok(!/TV frames/.test(t));
  assert.ok(!/TV boxes/.test(t));
  const perf = usage.summary().perf;
  assert.deepStrictEqual(perf, { screens: [], devices: [], trims: {} });

  usage.record(batch([
    screen({ v: 92, impl: "-", low: true }, now),
    screen({ v: 92, impl: "-", p50: 27, p90: 39, jank: 2, frames: 900 }, now),
    screen({ v: 93, impl: "FCR", p50: 24, p90: 33, jank: 1.1, frames: 500, lite: true }, now),
    { n: "perf", t: now, p: { screen: "device", mem_mb: 2048, heap_mb: 256, lowram: false, sdk: 34, model: "MiTV-AFMU0", gpu: "Mali-G31", low: "frames" } },
    { n: "perf", t: now, p: { screen: "trim", level: 15 } },
  ]), { persist: false });
  t = usage.text();
  assert.match(t, /TV frames \(screen · v · impl/);
  assert.match(t, /home {2}v92 - {2}2 sess · 2100 frames · 29 \/ 41 ms · p90s 41 ms · 3\.4% {3}low 50%/);
  assert.match(t, /home {2}v93 FCR {2}1 sess · 500 frames · 24 \/ 33 ms · p90s 33 ms · 1\.1% {2}lite 100%/);
  assert.match(t, /TV boxes/);
  assert.match(t, /MiTV-AFMU0 {2}1 sess · sdk34 {2}2048MB heap256 {2}Mali-G31 {2}lowram 0 {2}low: frames 1/);
  assert.match(t, /memory warnings \(trim level · times\): 15 1/);
  assert.ok(t.indexOf("TV frames") < t.indexOf("TV boxes") && t.indexOf("TV boxes") < t.indexOf("Active per day"));
});
