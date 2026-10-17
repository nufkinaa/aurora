// Lining subtitles up with what is said (src/media/audiosync.js), on
// generated data: a cue list with the irregular rhythm of real dialogue, and
// a "speech timeline" made from it the way the detector sees a film — talk
// a little after a line appears and ending before it goes, some talk with no
// line, effects that look like talk, noise everywhere. Every case knows the
// truth, so the checks are exact.
const test = require("node:test");
const assert = require("node:assert/strict");
const as = require("../src/media/audiosync");

const mkRand = (s) => () => (s = (s * 16807) % 2147483647) / 2147483647;

// ~17 minutes of dialogue: lines of 0.8-4 s, gaps of 0.1-3 s, now and then a
// long pause (a scene without words)
const makeCues = (seed, dur = 1000) => {
  const rnd = mkRand(seed);
  const cues = [];
  let t = 20 + rnd() * 10;
  while (t < dur - 30) {
    const len = 0.8 + rnd() * 3.2;
    cues.push({ start: t, end: t + len });
    t += len + 0.1 + rnd() * 2.9;
    if (rnd() < 0.05) t += 10 + rnd() * 40;
  }
  return cues;
};
// the speech the detector would report for the film those cues belong to
const makeSpeech = (cues, seed, dur = 1000, { noise = 0.25 } = {}) => {
  const rnd = mkRand(seed);
  const n = Math.round(dur * 100);
  const p = new Float64Array(n);
  for (let i = 0; i < n; i++) p[i] = 0.12;
  for (const c of cues) {
    const a = Math.round((c.start + rnd() * 0.1) * 100);
    const b = Math.round((c.end - rnd() * 0.1) * 100);
    for (let i = a; i < b && i < n; i++) p[i] = 0.8;
  }
  // effects and unsubtitled talk: bursts with no line
  for (let k = 0; k < dur / 20; k++) {
    const a = Math.floor(rnd() * n);
    const len = Math.floor(50 + rnd() * 250);
    for (let i = a; i < Math.min(n, a + len); i++) p[i] = Math.max(p[i], 0.6);
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.max(0, Math.min(255, Math.round((p[i] + (rnd() - 0.5) * 2 * noise) * 255)));
  return out;
};

const TRUTH = makeCues(1);
const SPEECH = makeSpeech(TRUTH, 2);
const err = (moved, truth) => {
  // per line (same index: the cue lists below keep their order)
  const e = moved.map((c, i) => Math.abs(c.start - truth[i].start)).sort((a, b) => a - b);
  return { med: e[Math.floor(e.length / 2)], max: e[e.length - 1] };
};

test("xcorr matches the direct sum, every lag", () => {
  const rnd = mkRand(3);
  const a = Array.from({ length: 300 }, () => rnd() - 0.5);
  const b = Array.from({ length: 420 }, () => rnd() - 0.5);
  const maxLag = 50;
  const { c } = as.xcorr(a, b, maxLag);
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let t = 0; t < a.length; t++) if (t + lag >= 0 && t + lag < b.length) s += a[t] * b[t + lag];
    assert.ok(Math.abs(c[lag + maxLag] - s) < 1e-9, `lag ${lag}`);
  }
});

test("the right subtitle is in time and left alone", () => {
  const res = as.align(SPEECH, TRUTH);
  assert.equal(res.verdict, "in-time", res.why);
  assert.equal(res.apply, false);
  assert.ok(res.confidence >= 0.5, `confidence ${res.confidence}`);
  assert.equal(as.describe(res), "Already in time — nothing to move");
});

test("a constant offset is found to the frame, both ways", () => {
  for (const d of [7.3, -12, 55.7]) {
    const cues = TRUTH.map((c) => ({ start: c.start + d, end: c.end + d }));
    const res = as.align(SPEECH, cues);
    assert.equal(res.verdict, "moved", `${d}: ${res.why}`);
    assert.ok(res.apply);
    const e = err(as.applyPlan(cues, res.plan), TRUTH);
    assert.ok(e.med <= 0.1 && e.max <= 0.2, `${d}: median ${e.med} max ${e.max}`);
    assert.match(as.describe(res), d > 0 ? /^Moved \d+(\.\d)? s earlier$/ : /^Moved \d+(\.\d)? s later$/);
  }
});

test("every frame-rate ratio is found", () => {
  for (const k of as.SCALES.slice(1)) {
    const cues = TRUTH.map((c) => ({ start: c.start * k + 1.5, end: c.end * k + 1.5 }));
    const res = as.align(SPEECH, cues);
    assert.equal(res.verdict, "moved", `x${k}: ${res.why}`);
    assert.ok(Math.abs(res.scale - 1 / k) < 1e-9, `x${k}: found ${res.scale}`);
    const e = err(as.applyPlan(cues, res.plan), TRUTH);
    assert.ok(e.med <= 0.1 && e.max <= 0.25, `x${k}: median ${e.med} max ${e.max}`);
    assert.match(as.describe(res), /^Matched the frame rate/);
  }
});

test("another cut: two parts, the extra scene's lines left out", () => {
  // the subtitle's release has 45 s more after line 40 %: lines of its own
  // there (taken from elsewhere), every later line 45 s late
  const k = Math.floor(TRUTH.length * 0.4);
  const t = TRUTH[k].start - 0.5;
  const fakes = TRUTH.filter((c) => c.start > t + 300 && c.end < t + 300 + 44).map((c) => ({ start: c.start - 300 + 0.5, end: c.end - 300 + 0.5, fake: true }));
  const cues = [...TRUTH.slice(0, k).map((c, i) => ({ ...c, i })), ...fakes, ...TRUTH.slice(k).map((c, i) => ({ start: c.start + 45, end: c.end + 45, i: k + i }))].sort((a, b) => a.start - b.start);
  const res = as.align(SPEECH, cues);
  assert.equal(res.verdict, "parts", res.why);
  assert.equal(res.parts, 2);
  const offs = res.plan.parts.map((p) => p.offset);
  assert.ok(Math.abs(offs[0]) < 0.1 && Math.abs(offs[1] + 45) < 0.1, JSON.stringify(offs));
  const moved = as.applyPlan(cues, res.plan);
  const real = moved.filter((c) => !c.fake);
  const lost = TRUTH.length - real.length;
  assert.ok(lost <= 2, `${lost} real lines lost`);
  assert.ok(moved.filter((c) => c.fake).length <= 2, "the extra scene's lines are left out");
  for (const c of real) assert.ok(Math.abs(c.start - TRUTH[c.i].start) < 0.15, `line ${c.i}`);
  assert.equal(as.describe(res), "Matched to this release in 2 parts");
});

// this audio, made from the truth by edits: `insert` s more before line
// fraction `at`, or `cut` s less from there -> where each kept line is now
const edited = (edits) => {
  let lines = TRUTH.map((c, i) => ({ ...c, i }));
  for (const e of edits) {
    const t = TRUTH[Math.floor(TRUTH.length * e.at)].start - 0.3;
    if (e.insert) lines = lines.map((c) => (c.start >= t ? { ...c, start: c.start + e.insert, end: c.end + e.insert } : c));
    else lines = lines.filter((c) => c.start < t || c.start >= t + e.cut).map((c) => (c.start >= t ? { ...c, start: c.start - e.cut, end: c.end - e.cut } : c));
  }
  return lines;
};

test("another cut: a logo more at the start, a scene less later — two parts, that scene's lines left out", () => {
  const audioTruth = edited([{ at: 0, insert: 30 }, { at: 0.6, cut: 40 }]);
  const speech = makeSpeech(audioTruth, 5, 1020);
  // the subtitle is the original release's, timed 2 s late as well
  const cues = TRUTH.map((c, i) => ({ start: c.start + 2, end: c.end + 2, i }));
  const res = as.align(speech, cues);
  assert.equal(res.verdict, "parts", res.why);
  assert.equal(res.parts, 2, JSON.stringify(res.plan));
  const offs = res.plan.parts.map((p) => p.offset);
  assert.ok(Math.abs(offs[0] - 28) < 0.15 && Math.abs(offs[1] + 12) < 0.15, JSON.stringify(offs));
  assert.equal(res.plan.drop.length, 1, "the 40 s this audio lacks: its lines left out");
  const moved = as.applyPlan(cues, res.plan);
  const where = new Map(audioTruth.map((c) => [c.i, c.start]));
  const wrong = moved.filter((c) => !where.has(c.i) || Math.abs(c.start - where.get(c.i)) > 0.2);
  assert.ok(wrong.length <= 3, `${wrong.length} lines kept that this audio does not have, or misplaced`);
  assert.ok(audioTruth.length - (moved.length - wrong.length) <= 2, "real lines kept");
  // and with a frame-rate change on top: the same plan, at the other rate
  const k = 25 / 24;
  const res2 = as.align(speech, cues.map((c) => ({ start: c.start * k, end: c.end * k })));
  assert.equal(res2.verdict, "parts", res2.why);
  assert.ok(Math.abs(res2.scale - 24 / 25) < 1e-9);
});

test("three parts: 20 s more at 30 %, 35 s less at 70 %", () => {
  const audioTruth = edited([{ at: 0.3, insert: 20 }, { at: 0.7, cut: 35 }]);
  const speech = makeSpeech(audioTruth, 6, 1000);
  const res = as.align(speech, TRUTH);
  assert.equal(res.verdict, "parts", res.why);
  assert.equal(res.parts, 3, JSON.stringify(res.plan));
  assert.deepEqual(res.plan.parts.map((p) => Math.round(p.offset)), [0, 20, -15]);
  assert.equal(res.plan.drop.length, 1);
  assert.equal(as.describe(res), "Matched to this release in 3 parts");
});

test("the price of a split: noise alone never splits a right subtitle", () => {
  for (const seed of [21, 22, 23]) {
    const speech = makeSpeech(TRUTH, seed, 1000, { noise: 0.45 });
    const res = as.align(speech, TRUTH.map((c) => ({ start: c.start + 3, end: c.end + 3 })));
    assert.equal(res.verdict, "moved", `seed ${seed}: ${res.verdict} ${res.why}`);
    assert.equal(res.parts, 1);
    assert.equal(res.plan.drop.length, 0);
  }
  // (the offsets a part may take come from windows that agree: on a right
  // subtitle, only its own)
  const pw = as.piecewise(makeSpeech(TRUTH, 21, 1000, { noise: 0.45 }), TRUTH);
  assert.deepEqual(pw.candidates, [0]);
  assert.ok(pw.pen > 4 * pw.sigma - 1e-9, "a split costs at least four sigmas of one line's evidence");
});

test("refused: another film's subtitle, and speech that is noise", () => {
  const other = makeCues(99);
  const res = as.align(SPEECH, other);
  assert.equal(res.verdict, "unmatched", `z ${res.z} c ${res.confidence}`);
  assert.equal(res.apply, false);
  assert.ok(res.confidence < as.MIN_CONFIDENCE);
  assert.equal(as.describe(res), "Couldn't match — kept as it was");
  const rnd = mkRand(5);
  const random = Uint8Array.from({ length: 100000 }, () => Math.floor(rnd() * 256));
  const res2 = as.align(random, TRUTH);
  assert.equal(res2.verdict, "unmatched", `z ${res2.z}`);
  // too little to judge
  assert.equal(as.align(SPEECH, TRUTH.slice(0, 10)).verdict, "unmatched");
  assert.equal(as.align(SPEECH.subarray(0, 5000), TRUTH).verdict, "unmatched");
});

test("applyPlan: parts by subtitle time, drops by start, other fields kept", () => {
  const cues = [
    { start: 1, end: 2, text: "a" },
    { start: 10, end: 11, text: "b" },
    { start: 20, end: 21, text: "c" },
    { start: 30, end: 31, text: "d" },
  ];
  const plan = { parts: [{ from: 0, scale: 1, offset: 0.5 }, { from: 15, scale: 1, offset: -5 }], drop: [[10, 10]] };
  const out = as.applyPlan(cues, plan);
  assert.deepEqual(out.map((c) => [c.text, c.start, c.end]), [["a", 1.5, 2.5], ["c", 15, 16], ["d", 25, 26]]);
  assert.deepEqual(as.applyPlan(cues, { parts: [{ from: 0, scale: 24 / 25, offset: 0 }] }).map((c) => Math.round(c.start * 1000) / 1000), [0.96, 9.6, 19.2, 28.8]);
  // a line moved before the start is cut at 0, one wholly before it is gone
  assert.deepEqual(as.applyPlan(cues, { parts: [{ from: 0, scale: 1, offset: -1.5 }] }).map((c) => c.start), [0, 8.5, 18.5, 28.5]);
  assert.equal(as.applyPlan(cues, { parts: [{ from: 0, scale: 1, offset: -2.5 }] }).length, 3);
  assert.equal(as.applyPlan(cues, null).length, 4);
});

test("describe: the words the player shows", () => {
  assert.equal(as.describe(null), "Couldn't match — kept as it was");
  assert.equal(as.describe({ verdict: "unmatched" }), "Couldn't match — kept as it was");
  assert.equal(as.describe({ verdict: "in-time" }), "Already in time — nothing to move");
  assert.equal(as.describe({ verdict: "parts", parts: 3 }), "Matched to this release in 3 parts");
  assert.equal(as.describe({ verdict: "moved", scale: 1, plan: { parts: [{ offset: 1.84 }] } }), "Moved 1.8 s later");
  assert.equal(as.describe({ verdict: "moved", scale: 1, plan: { parts: [{ offset: -28.8 }] } }), "Moved 29 s earlier");
  assert.equal(as.describe({ verdict: "moved", scale: 24 / 25, plan: { parts: [{ offset: -55.7 }] } }), "Matched the frame rate and moved 56 s earlier");
  assert.equal(as.describe({ verdict: "moved", scale: 24 / 25, plan: { parts: [{ offset: 0.01 }] } }), "Matched the frame rate");
});

test("confidence: the weakest of the three numbers, 0..1", () => {
  assert.equal(as.confidenceOf(40, 40, null), 1);
  assert.equal(as.confidenceOf(2, 40, null), 0);
  assert.ok(as.confidenceOf(40, 40, [3]) < as.MIN_CONFIDENCE, "a weak part pulls it down");
  assert.ok(as.confidenceOf(6, 40, null) >= as.MIN_CONFIDENCE, "z 6 is enough");
  assert.ok(as.confidenceOf(5, 40, null) < as.MIN_CONFIDENCE, "z 5 is not");
});
