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

test("which lighter stream fits: 720p needs room for it, a slow line gets 480p", async () => {
  const { capFor, SLOW_KBPS } = await load();
  assert.equal(capFor(SLOW_KBPS - 1), 480, "a line classed slow cannot carry the 720p stream");
  assert.equal(capFor(800), 480);
  assert.equal(capFor(4000), 720);
  assert.equal(capFor(null), 720, "Data saver on an unmeasured line");
  assert.equal(capFor(50000, "2g"), 480);
});

test("a video element's own download is never a measurement", async () => {
  const { sampleFrom } = await load();
  const e = { name: "http://x/stream/video/abc", requestStart: 10, responseStart: 110, responseEnd: 60110, transferSize: 7500000 };
  assert.equal(sampleFrom(e), null);
  assert.equal(sampleFrom({ ...e, name: "http://x/img/a", initiatorType: "video" }), null);
});

// ---------- 2026-10-26: "almost always says I have a slow connection when I get in" ----------
test("responses that arrived together are one reading: thirty posters at once are the line, not thirty slow lines", async () => {
  const { bursts, BURST_MIN_BYTES } = await load();
  // 30 posters of 40 kB, all in flight together over 960 ms on a 10 Mbit/s line:
  // one at a time each reads 333 kbit/s — "slow" thirty times over
  const posters = Array.from({ length: 30 }, (_, i) => ({ start: 100 + i * 2, end: 1000 + i * 2, bytes: 40000 }));
  const one = (40000 * 8) / 900;
  assert.ok(one < 400, "one poster alone reads as a very slow line");
  const b = bursts(posters);
  assert.equal(b.length, 1);
  assert.equal(b[0].n, 30);
  assert.ok(b[0].kbps > 9000 && b[0].kbps < 11000, String(b[0].kbps));
  // two bursts apart are two readings
  const later = posters.map((p) => ({ ...p, start: p.start + 5000, end: p.end + 5000 }));
  assert.equal(bursts([...posters, ...later]).length, 2);
  // too little to say anything about the line: no reading
  assert.deepEqual(bursts([{ start: 0, end: 150, bytes: BURST_MIN_BYTES - 1 }]), []);
  assert.deepEqual(bursts([{ start: 5, end: 5, bytes: 500000 }, null]), [], "nothing measurable");
});

test("the round trip leaves out the server's own time (Server-Timing)", async () => {
  const { sampleFrom } = await load();
  const e = { name: "http://x/img/ext?u=a", requestStart: 10, responseStart: 1410, responseEnd: 1420, transferSize: 3000, serverTiming: [{ name: "app", duration: 1350 }] };
  assert.equal(sampleFrom(e).rtt, 50, "1.4 s of which 1.35 s the server fetching a poster from far away");
  assert.equal(sampleFrom({ ...e, serverTiming: [] }).rtt, 1400, "no header: as measured");
  assert.ok(sampleFrom({ ...e, serverTiming: [{ name: "app", duration: 5000 }] }).rtt >= 1, "never below a millisecond");
});

test("a measured slow line has to last: 20 s and three fresh readings, before Aurora goes lighter by itself", async () => {
  const { sustain, SUSTAIN_MS, SUSTAIN_READINGS } = await load();
  const slow = { tier: "slow", source: "measured", strong: true };
  let st = { since: 0, seen: 0 };
  let g = sustain(st, slow, "ok", 1000);
  assert.equal(g.apply, false, "the first slow reading at page entry changes nothing");
  st = g.st;
  for (let i = 1; i < SUSTAIN_READINGS + 3; i++) {
    g = sustain(st, slow, "ok", 1000 + i * 100);
    st = g.st;
  }
  assert.equal(g.apply, false, "many readings within seconds are not 20 s of evidence");
  g = sustain(st, slow, "ok", 1000 + SUSTAIN_MS, null);
  assert.equal(g.apply, false, "time alone is not evidence: a fresh reading has to agree");
  g = sustain(g.st, slow, "ok", 1000 + SUSTAIN_MS + 50, "kbps");
  assert.equal(g.apply, true, "slow for 20 s, over several readings: now it is acted on");
  // round trips are evidence for a latency verdict only
  let lat = sustain({ since: 1, seen: 0 }, { tier: "slow", source: "latency", strong: false }, "ok", 1 + SUSTAIN_MS, "rtt");
  assert.equal(lat.st.seen, 1);
  lat = sustain({ since: 1, seen: 0 }, slow, "ok", 1 + SUSTAIN_MS, "rtt");
  assert.equal(lat.st.seen, 0, "an API answer's round trip is not a throughput reading");
  // a reading that is not slow starts it over
  g = sustain({ since: 1000, seen: 2 }, { tier: "ok", source: "measured", strong: false }, "ok", 5000);
  assert.deepEqual(g, { apply: true, st: { since: 0, seen: 0 } });
});

test("Data Saver, 2G, the person's own choice — and leaving slow — still count at once", async () => {
  const { sustain } = await load();
  const st = { since: 0, seen: 0 };
  assert.equal(sustain(st, { tier: "slow", source: "data-saver", strong: true }, "ok", 1).apply, true);
  assert.equal(sustain(st, { tier: "slow", source: "2g", strong: true }, "ok", 1).apply, true);
  assert.equal(sustain(st, { tier: "slow", source: "preference", strong: true }, "fast", 1).apply, true);
  assert.equal(sustain(st, { tier: "ok", source: "measured", strong: false }, "slow", 1).apply, true);
  assert.equal(sustain(st, { tier: "slow", source: "measured", strong: true }, "slow", 1).apply, true, "already slow: nothing to wait for");
});

test("the viewer is told at most once a session, and not for a day after OK", async () => {
  const { slowNoteAllowed, SLOW_NOTE_QUIET_MS } = await load();
  const now = 1_000_000;
  assert.equal(slowNoteAllowed(false, 0, now), true);
  assert.equal(slowNoteAllowed(true, 0, now), false, "once a session");
  assert.equal(slowNoteAllowed(false, now + SLOW_NOTE_QUIET_MS, now + 1000), false, "OK pressed: quiet for the day");
  assert.equal(slowNoteAllowed(false, now + SLOW_NOTE_QUIET_MS, now + SLOW_NOTE_QUIET_MS + 1), true, "…and after it, again");
  assert.equal(SLOW_NOTE_QUIET_MS, 24 * 3600 * 1000);
});
