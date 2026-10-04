// Connection quality (public/js/net.js): the tier decision as a pure
// function, and what counts as a measurement.
const test = require("node:test");
const assert = require("node:assert");

const load = () => import("../public/js/net.js");
const none = { saveData: false, type: null, downKbps: null, rtt: null };
const unmeasured = { kbps: null, rtt: null, samples: 0 };

test("Data Saver and a 2G line are slow at once, and strong enough to cap the stream", async () => {
  const { classify } = await load();
  assert.deepEqual(classify({ ...none, saveData: true }, unmeasured), { tier: "slow", source: "data-saver", strong: true });
  assert.equal(classify({ ...none, type: "2g" }, unmeasured).tier, "slow");
  assert.equal(classify({ ...none, type: "slow-2g" }, unmeasured).strong, true);
});

test("a 3G or low-downlink guess from the browser is not acted on until something is measured", async () => {
  const { classify } = await load();
  assert.equal(classify({ ...none, type: "3g" }, unmeasured).tier, "ok");
  assert.equal(classify({ ...none, type: "3g", downKbps: 700 }, unmeasured).tier, "ok");
  assert.equal(classify({ ...none, type: "3g" }, unmeasured, "auto", "slow").tier, "slow", "a line that was slow stays slow until measured");
});

test("a real measurement beats the hints: 4G that delivers 800 kbit/s from this server is slow", async () => {
  const { classify } = await load();
  const r = classify({ ...none, type: "4g", downKbps: 10000 }, { kbps: 800, rtt: 120, samples: 6 });
  assert.deepEqual(r, { tier: "slow", source: "measured", strong: true });
});

test("leaving slow takes more than entering it", async () => {
  const { classify, SLOW_KBPS, RECOVER_KBPS } = await load();
  const edge = { kbps: SLOW_KBPS + 300, rtt: 100, samples: 6 };
  assert.equal(classify(none, edge, "auto", "ok").tier, "ok");
  assert.equal(classify(none, edge, "auto", "slow").tier, "slow", "still under the recovery line");
  assert.equal(classify(none, { ...edge, kbps: RECOVER_KBPS + 1 }, "auto", "slow").tier, "ok");
});

test("a fast line is fast; long round trips alone make it slow without capping the stream", async () => {
  const { classify } = await load();
  assert.equal(classify(none, { kbps: 40000, rtt: 20, samples: 8 }).tier, "fast");
  const laggy = classify(none, { kbps: 9000, rtt: 1400, samples: 8 });
  assert.equal(laggy.tier, "slow");
  assert.equal(laggy.strong, false);
});

test("the preference wins either way", async () => {
  const { classify } = await load();
  assert.equal(classify(none, { kbps: 90000, rtt: 5, samples: 9 }, "saver").tier, "slow");
  assert.equal(classify({ ...none, saveData: true }, { kbps: 300, rtt: 2000, samples: 9 }, "full").tier, "fast");
});

test("nothing known: stay where we are, never invent a slow line", async () => {
  const { classify } = await load();
  assert.equal(classify(none, unmeasured, "auto", "ok").tier, "ok");
  assert.equal(classify(none, unmeasured, "auto", "fast").tier, "fast");
  assert.equal(classify(none, unmeasured, "auto", "slow").tier, "slow");
});

test("samples: cached and tiny responses say nothing about the line", async () => {
  const { sampleFrom } = await load();
  const base = { name: "http://x/img/a", requestStart: 10, responseStart: 110, responseEnd: 610 };
  assert.equal(sampleFrom({ ...base, transferSize: 0 }), null, "from cache");
  const small = sampleFrom({ ...base, transferSize: 2000 });
  assert.ok(small && small.rtt === 100 && !small.kbps, "a small answer measures the round trip only");
  const big = sampleFrom({ ...base, transferSize: 125000 });
  assert.equal(Math.round(big.kbps), 2000, "125 kB in 500 ms is 2 Mbit/s");
  assert.ok(sampleFrom({ ...base, transferSize: 125000, responseEnd: 110.4 }).kbps > 100000, "a body that lands at once is a fast line (a LAN)");
});

test("the probe: the first chunk is left out, and a download too fast to time reads as a fast line", async () => {
  const { timeProbe, FAST_KBPS, SLOW_KBPS } = await load();
  // 48 kB over a 1 Mbit/s line: 8 kB up front, 40 kB over the next 320 ms
  const slow = timeProbe({ t0: 0, tHeaders: 200, chunks: [{ t: 201, bytes: 8192 }, { t: 360, bytes: 20480 }, { t: 521, bytes: 20480 }] });
  assert.ok(slow.kbps > 900 && slow.kbps < 1100, String(slow.kbps));
  assert.ok(slow.kbps < SLOW_KBPS);
  assert.equal(slow.rtt, 200);
  const lan = timeProbe({ t0: 0, tHeaders: 2, chunks: [{ t: 2.4, bytes: 49152 }] });
  assert.ok(lan.kbps > FAST_KBPS);
  assert.equal(timeProbe({ t0: 0, tHeaders: 1, chunks: [] }), null);
});
