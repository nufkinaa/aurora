// The tone-map speed of this machine is remembered between starts
// (media/tonemap.js, cache/tonemap-speed.json): the same answer the timing at
// boot gave, without running ffmpeg eight times at every start.
//
// ffmpeg and the file are stood in for through the module's own seams (io):
// what is pinned here is WHEN a timing runs, what is kept, and that the
// answer the rest of the server reads (probeSupport / supportNow -> decide)
// is the measured one.
const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert");

const tonemap = require("../src/media/tonemap");
const config = require("../src/config");
const { io, restart, SETTLED_AFTER, CAL_SHORT, CAL_LONG, CAL_W, CAL_H } = tonemap._internals;

const real = { ...io, FFMPEG: config.FFMPEG };
after(() => { Object.assign(io, real); config.FFMPEG = real.FFMPEG; restart(); });

const FILTERS = " T.. zscale            V->V       Apply resizing, colorspace and bit depth conversion.\n .S. tonemap           V->V       Conversion to/from different dynamic ranges.\n";
// megapixels/second -> the milliseconds a long run takes on top of a short one
const longMsFor = (mpps) => 100 + (((CAL_LONG - CAL_SHORT) * CAL_W * CAL_H) / 1e6 / mpps) * 1000;

let disk, runs, filterCalls, speeds, filtersText, hostKey;
const silent = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };
beforeEach(() => {
  disk = new Map();
  runs = [];
  filterCalls = 0;
  speeds = [200];
  filtersText = FILTERS;
  hostKey = "ffmpeg-A|cpu-A";
  config.FFMPEG = real.FFMPEG || "ffmpeg";
  io.key = () => hostKey;
  io.file = () => "tonemap-speed.json";
  io.read = async (f) => { if (!disk.has(f)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return disk.get(f); };
  io.write = async (f, text) => { disk.set(f, text); };
  io.filters = async () => { filterCalls++; return filtersText; };
  // each "pq" run takes the next speed in `speeds` (the last one repeats); null = the chain failed
  io.runChain = async (kind, frames) => {
    runs.push(`${kind}:${frames}`);
    if (kind === "hlg") return 100;
    const mpps = speeds.length > 1 ? speeds.shift() : speeds[0];
    return mpps === null ? null : longMsFor(mpps);
  };
  restart();
});
const kept = () => (disk.has("tonemap-speed.json") ? JSON.parse(disk.get("tonemap-speed.json")) : null);
const settle = () => new Promise((r) => setImmediate(r));

test("first start: timed as always (one short run, two long, the faster kept) and written down", async () => {
  speeds = [180, 220];
  const s = await silent(() => tonemap.probeSupport());
  assert.deepEqual(runs, [`hlg:${CAL_SHORT}`, `pq:${CAL_LONG}`, `pq:${CAL_LONG}`]);
  assert.equal(filterCalls, 1);
  assert.deepEqual({ ok: s.ok, zscale: s.zscale, tonemap: s.tonemap, mpps: s.mpps }, { ok: true, zscale: true, tonemap: true, mpps: 220 });
  assert.equal(tonemap.supportNow(), s);
  await settle();
  const k = kept();
  assert.deepEqual([k.v, k.key, k.ok, k.mpps, k.timings], [1, "ffmpeg-A|cpu-A", true, 220, 1]);
  // asked again in the same start: the same promise, nothing runs twice
  assert.equal(await tonemap.probeSupport(), s);
  assert.equal(runs.length, 3);
});

test("next start, same ffmpeg and CPU: the kept answer, and no ffmpeg at all", async () => {
  speeds = [220];
  await silent(() => tonemap.probeSupport());
  await settle();
  restart();
  runs = []; filterCalls = 0;
  const s = await silent(() => tonemap.probeSupport());
  assert.deepEqual(runs, []);
  assert.equal(filterCalls, 0);
  assert.deepEqual({ ok: s.ok, zscale: s.zscale, tonemap: s.tonemap, mpps: s.mpps }, { ok: true, zscale: true, tonemap: true, mpps: 220 });
  // what decide() is handed is the same decision input as on the first start
  const hdr = { transfer: "smpte2084", primaries: "bt2020", matrix: "bt2020nc", width: 3840, height: 2160, fps: 24, pixFmt: "yuv420p10le" };
  assert.equal(tonemap.decide({ ...hdr, outHeight: 720, available: s, env: {} }).why, "ok");
  assert.equal(tonemap.decide({ ...hdr, outHeight: 720, available: { ok: true, mpps: 220 }, env: {} }).vf, tonemap.decide({ ...hdr, outHeight: 720, available: s, env: {} }).vf);
});

test("re-timing: the fastest answer ever is kept, across starts — and it stops once enough timings are in", async () => {
  speeds = [200];
  await silent(() => tonemap.probeSupport()); // timing 1
  speeds = [150];
  await silent(() => tonemap.recalibrate()); // 2: slower -> the answer stays
  assert.equal(tonemap.supportNow().mpps, 200);
  speeds = [240];
  await silent(() => tonemap.recalibrate()); // 3: faster -> raised
  assert.equal(tonemap.supportNow().mpps, 240);
  await settle();
  assert.deepEqual([kept().mpps, kept().timings], [240, 3]);

  // second start: nothing at +15 s, the two re-timings still run and fold in
  restart(); runs = [];
  await silent(() => tonemap.probeSupport());
  assert.deepEqual(runs, []);
  speeds = [260];
  await silent(() => tonemap.recalibrate()); // 4
  speeds = [100];
  await silent(() => tonemap.recalibrate()); // 5
  assert.equal(tonemap.supportNow().mpps, 260, "a slow minute on a later start never lowers it");
  assert.equal(runs.length, 4);
  await settle();
  assert.deepEqual([kept().mpps, kept().timings], [260, 5]);

  // third start: one more makes it settled; after that nothing is ever run
  restart(); runs = [];
  await silent(() => tonemap.probeSupport());
  await silent(() => tonemap.recalibrate()); // 6 = SETTLED_AFTER
  assert.equal(runs.length, 2);
  await silent(() => tonemap.recalibrate());
  assert.equal(runs.length, 2, "settled: the second re-timing of this start does not run");
  await settle();
  assert.equal(kept().timings, SETTLED_AFTER);
  restart(); runs = []; filterCalls = 0;
  await silent(() => tonemap.probeSupport());
  await silent(() => tonemap.recalibrate());
  await silent(() => tonemap.recalibrate());
  assert.deepEqual([runs.length, filterCalls], [0, 0], "a settled machine starts without one ffmpeg run");
  assert.equal(tonemap.supportNow().mpps, 260);
});

test("another ffmpeg or another CPU is another question: timed afresh", async () => {
  speeds = [220];
  await silent(() => tonemap.probeSupport());
  await settle();
  restart(); runs = [];
  hostKey = "ffmpeg-B|cpu-A";
  speeds = [90];
  const s = await silent(() => tonemap.probeSupport());
  assert.equal(runs.length, 3);
  assert.equal(s.mpps, 90, "the old machine's speed is not this one's");
  await settle();
  assert.deepEqual([kept().key, kept().mpps, kept().timings], ["ffmpeg-B|cpu-A", 90, 1]);
});

test("what is never remembered: a chain that failed, an ffmpeg that did not answer", async () => {
  speeds = [null];
  let s = await silent(() => tonemap.probeSupport());
  assert.deepEqual([s.ok, s.why], [false, "chain failed"]);
  await settle();
  assert.equal(kept(), null);
  // next start: tried again, and it works now
  restart(); runs = []; speeds = [210];
  s = await silent(() => tonemap.probeSupport());
  assert.deepEqual([s.ok, s.mpps, runs.length], [true, 210, 3]);

  disk.clear(); restart();
  filtersText = null; // ffmpeg -filters timed out
  s = await silent(() => tonemap.probeSupport());
  assert.deepEqual([s.ok, s.why], [false, "filters missing"]);
  await settle();
  assert.equal(kept(), null, "a non-answer is not a property of the binary");
});

test("a build without the filters is remembered as such — and asked again when the binary changes", async () => {
  filtersText = " T.. scale             V->V       Scale the input video size.\n";
  let s = await silent(() => tonemap.probeSupport());
  assert.deepEqual([s.ok, s.why, s.zscale, s.tonemap], [false, "filters missing", false, false]);
  assert.deepEqual(runs, []);
  await settle();
  assert.equal(kept().ok, false);
  restart(); filterCalls = 0;
  s = await silent(() => tonemap.probeSupport());
  assert.deepEqual([s.ok, s.why, filterCalls], [false, "filters missing", 0]);
  assert.equal(tonemap.decide({ transfer: "smpte2084", primaries: "bt2020", matrix: "bt2020nc", width: 1920, height: 1080, fps: 24, available: s, env: {} }).why, "unsupported");
  // a new ffmpeg, with the filters
  restart(); hostKey = "ffmpeg-C|cpu-A"; filtersText = FILTERS; speeds = [230];
  s = await silent(() => tonemap.probeSupport());
  assert.deepEqual([s.ok, s.mpps], [true, 230]);
});

test("a kept file that is damaged, from another version, or without a speed is ignored", async () => {
  for (const bad of ["not json", JSON.stringify({ v: 2, key: "ffmpeg-A|cpu-A", ok: true, mpps: 500 }), JSON.stringify({ v: 1, key: "ffmpeg-A|cpu-A", ok: true, mpps: 0 }), JSON.stringify({ v: 1, key: "ffmpeg-A|cpu-A" })]) {
    disk.set("tonemap-speed.json", bad);
    restart(); runs = []; speeds = [205];
    const s = await silent(() => tonemap.probeSupport());
    assert.deepEqual([s.ok, s.mpps, runs.length], [true, 205, 3], bad.slice(0, 30));
  }
});
