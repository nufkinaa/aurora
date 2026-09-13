// Intro/credits detection: the fingerprint comparison and the consensus rule,
// on synthetic signals — no ffmpeg, no files.
const test = require("node:test");
const assert = require("node:assert");

const { fingerprint, longestRun, consensus, fromChapters, similar, INVALID, FRAME, HOP, SR } = require("../src/media/introdetect")._internals;

// A deterministic "song": a sum of tones whose mix changes every 100ms, so the
// spectral hash carries real structure frame to frame.
const song = (seconds, seed) => {
  const n = Math.round(seconds * SR);
  const out = new Int16Array(n);
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const freqs = Array.from({ length: 6 }, () => 120 + rnd() * 3000);
  for (let i = 0; i < n; i++) {
    const seg = Math.floor(i / (SR * 0.1));
    let v = 0;
    for (let k = 0; k < freqs.length; k++) v += Math.sin((2 * Math.PI * freqs[k] * i) / SR) * (((seg * 7 + k * 3) % 5) + 1);
    out[i] = Math.round(v * 800);
  }
  return out;
};
// "Programme": tones whose mix changes every 100ms with a seed of its own —
// structured, unlike white noise, and different for every seed.
const noise = (seconds, seed) => song(seconds, seed * 977 + 13);
// Real quiet: near-silence, which must never count as a match.
const silence = (seconds) => new Int16Array(Math.round(seconds * SR));
const concat = (...parts) => {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

test("the same intro at different offsets in two episodes is found, with the right length", () => {
  const intro = song(40, 7);
  const a = concat(noise(20, 1), intro, noise(60, 2));
  const b = concat(noise(35, 3), intro, noise(40, 4));
  const r = longestRun(fingerprint(a), fingerprint(b), Math.round((60 * SR) / HOP));
  assert.ok(r, "a run was found");
  const start = (r.start * HOP) / SR;
  const len = ((r.end - r.start + 1) * HOP) / SR;
  assert.ok(Math.abs(start - 20) < 1.5, `starts near 20s (got ${start.toFixed(1)})`);
  assert.ok(Math.abs(len - 40) < 3, `lasts ~40s (got ${len.toFixed(1)})`);
  assert.ok(Math.abs(r.offset - Math.round((15 * SR) / HOP)) <= 2, "offset is the 15s difference");
});

test("two unrelated episodes share no run long enough to be an intro", () => {
  const a = concat(noise(30, 11), song(30, 12), noise(30, 13));
  const b = concat(noise(30, 21), song(30, 22), noise(30, 23));
  const r = longestRun(fingerprint(a), fingerprint(b), Math.round((60 * SR) / HOP));
  const len = r ? ((r.end - r.start + 1) * HOP) / SR : 0;
  assert.ok(len < 15, `no 15s match between different songs (got ${len.toFixed(1)}s)`);
});

test("silence never matches silence — quiet passages are not a shared intro", () => {
  const a = concat(silence(30), song(20, 5), silence(30));
  const b = concat(silence(40), song(20, 6), silence(20));
  const fa = fingerprint(a);
  assert.ok(fa.slice(0, 100).every((c) => c === INVALID), "silent frames are marked invalid");
  const r = longestRun(fa, fingerprint(b), Math.round((60 * SR) / HOP));
  const len = r ? ((r.end - r.start + 1) * HOP) / SR : 0;
  assert.ok(len < 15, `no run from silence (got ${len.toFixed(1)}s)`);
});

test("similar() tolerates up to three flipped bits", () => {
  assert.ok(similar(0b101010101010101, 0b101010101010101));
  assert.ok(similar(0b101010101010101, 0b101010101010100));
  assert.ok(!similar(0b101010101010101, 0b010101010101010));
});

test("consensus needs two comparisons to agree, accepts a lone one, rejects disagreement", () => {
  assert.deepEqual(consensus([{ start: 20, end: 60 }, { start: 21, end: 61 }, { start: 90, end: 130 }]), { start: 21, end: 61 });
  assert.deepEqual(consensus([{ start: 20, end: 60 }]), { start: 20, end: 60 });
  assert.equal(consensus([{ start: 20, end: 60 }, { start: 90, end: 130 }]), null);
  assert.equal(consensus([null, null]), null);
});

test("chapters named Intro / Credits are taken as the answer", () => {
  const ch = [
    { start: 0, end: 12, title: "Recap" },
    { start: 12, end: 92, title: "Opening" },
    { start: 92, end: 2500, title: "Episode" },
    { start: 2500, end: 2620, title: "End Credits" },
  ];
  assert.deepEqual(fromChapters(ch, 2620), { intro: { start: 12, end: 92 }, credits: { start: 2500 } });
  assert.deepEqual(fromChapters([{ start: 0, end: 100, title: "Chapter 1" }], 2620), { intro: null, credits: null });
});

test("frame geometry: 128ms hops over a 512ms window", () => {
  assert.equal(HOP / SR, 0.128);
  assert.equal(FRAME / SR, 0.512);
});

test("coverage: counts episodes in seasons of two or more, and what the store says about them", () => {
  const scanner = require("../src/media/scanner");
  const introdetect = require("../src/media/introdetect");
  const saved = scanner.index.shows;
  scanner.index.shows = [
    { id: "s1", seasons: [
      { episodes: [{ id: "e1" }, { id: "e2" }, { id: "e3" }] },
      { episodes: [{ id: "lonely" }] }, // a single-episode season is never analysed
    ] },
  ];
  try {
    const c = introdetect.coverage();
    assert.equal(c.episodes, 3);
    assert.equal(c.analyzed, 0);
    assert.equal(c.intro, 0);
    assert.equal(c.credits, 0);
  } finally {
    scanner.index.shows = saved;
  }
});
