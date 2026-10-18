// The load harness's own arithmetic (tools/loadtest): the simulated player
// buffer, the latency recorder, the A/B comparison. Pure functions, no
// server, a few milliseconds.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { PlayBuffer } = require("../tools/loadtest/buffer");
const { Rec, Stats, parseArgs } = require("../tools/loadtest/lib");

const clock = () => { let t = 0; const f = () => t; f.add = (ms) => { t += ms; }; return f; };

test("buffer: starts once startSec is buffered and records the time to first frame", () => {
  const now = clock();
  const b = new PlayBuffer({ startSec: 2, rebufferSec: 4, durationSec: 100, now });
  now.add(500); b.fed(1); b.tick();
  assert.strictEqual(b.state, "starting");
  now.add(700); b.fed(2.5); b.tick();
  assert.strictEqual(b.state, "playing");
  assert.strictEqual(b.report().ttffMs, 1200);
});

test("buffer: a playhead that catches up stalls, and resumes after rebufferSec", () => {
  const now = clock();
  const b = new PlayBuffer({ startSec: 2, rebufferSec: 4, durationSec: 100, now });
  b.fed(3); b.tick(); // playing at once
  for (let i = 0; i < 40; i++) { now.add(100); b.tick(); } // 4 s of play, 3 s buffered
  assert.strictEqual(b.state, "stalled");
  assert.strictEqual(b.report().stalls, 1);
  now.add(1000); b.fed(5); b.tick();
  assert.strictEqual(b.state, "stalled", "2 s ahead is not yet the 4 s rebuffer goal");
  now.add(1000); b.fed(7.5); b.tick();
  assert.strictEqual(b.state, "playing");
  const r = b.report();
  assert.strictEqual(r.stalls, 1);
  assert.ok(r.stallMs >= 1900 && r.stallMs <= 3100, `stall ${r.stallMs} ms`);
});

test("buffer: the end of the title is not a stall; a seek is timed", () => {
  const now = clock();
  const b = new PlayBuffer({ startSec: 2, rebufferSec: 4, durationSec: 5, now });
  b.fed(5); b.tick();
  for (let i = 0; i < 60; i++) { now.add(100); b.tick(); }
  assert.strictEqual(b.state, "ended");
  assert.strictEqual(b.report().stalls, 0);

  const s = new PlayBuffer({ startSec: 2, rebufferSec: 4, durationSec: 100, now });
  s.fed(10); s.tick();
  s.seek(50);
  now.add(300); s.fed(51); s.tick();
  now.add(300); s.fed(53); s.tick();
  assert.strictEqual(s.state, "playing");
  assert.deepStrictEqual(s.report().seekMs, [600]);
  assert.strictEqual(s.report().stalls, 0);
});

test("recorder: percentiles are exact under the cap and bounded above it", () => {
  const r = new Rec(1000);
  for (let i = 1; i <= 100; i++) r.add(i);
  const s = r.summary();
  assert.strictEqual(s.p50, 50);
  assert.strictEqual(s.p99, 99);
  assert.strictEqual(s.max, 100);
  const big = new Rec(500);
  for (let i = 0; i < 20000; i++) big.add(i % 100);
  assert.strictEqual(big.v.length, 500);
  assert.ok(Math.abs(big.summary().p50 - 50) < 10);
});

test("stats: errors are split by kind", () => {
  const st = new Stats();
  st.add("home", { status: 200, ms: 10 });
  st.add("home", { status: 429, ms: 1 });
  st.add("home", { status: 503, ms: 1 });
  st.add("home", { status: 0, ms: 1 });
  const [row] = st.rows(1);
  assert.strictEqual(row.n, 4);
  assert.strictEqual(row.err, 3);
  assert.strictEqual(row.s429, 1);
  assert.strictEqual(row.s503, 1);
  assert.strictEqual(row.net, 1);
});

test("args: flags, values and key=value", () => {
  const a = parseArgs(["run", "--profile", "evening", "--n=4", "--fast"]);
  assert.deepStrictEqual(a, { _: ["run"], profile: "evening", n: "4", fast: true });
});

test("machine profiles: affinity masks and limits combine", () => {
  const { machineProfile } = require("../tools/loadtest/instance");
  const m = machineProfile("2core,lowmem");
  assert.strictEqual(m.mask, 5);
  assert.strictEqual(m.cpuList, "0,2");
  assert.strictEqual(m.heapMb, 256);
  assert.ok(m.wsMb > 0);
  assert.strictEqual(machineProfile("4core").mask, 0x55);
  assert.throws(() => machineProfile("8core"), /unknown machine profile/);
});

test("devices: pictures are asked for the way the clients rewrite them", () => {
  const { artUrl, parseMedia } = require("../tools/loadtest/devices");
  assert.strictEqual(artUrl("/img/abc", 360), "/img/abc?w=360");
  assert.strictEqual(artUrl("/img/still/abc", 360), "/img/still/abc");
  assert.strictEqual(artUrl("https://images.metahub.space/poster/small/tt1/img", 256), `/img/ext?u=${encodeURIComponent("https://images.metahub.space/poster/small/tt1/img")}&w=256`);
  assert.strictEqual(artUrl("https://example.com/x.jpg", 256), null);
  const segs = parseMedia("#EXTM3U\n#EXTINF:6.0,\nseg00000.ts?v=copy\n#EXTINF:4.5,\nseg00001.ts?v=copy\n#EXT-X-ENDLIST\n", "/stream/transcode/x/jit/index.m3u8?v=copy");
  assert.deepStrictEqual(segs.map((s) => [s.uri, s.start]), [["/stream/transcode/x/jit/seg00000.ts?v=copy", 0], ["/stream/transcode/x/jit/seg00001.ts?v=copy", 6]]);
});
