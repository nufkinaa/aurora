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

test("the cooperative fingerprint equals the synchronous one, frame for frame", async () => {
  const { fingerprintAsync } = require("../src/media/introdetect")._internals;
  const pcm = new Int16Array(SR * 30);
  let phase = 0;
  for (let i = 0; i < pcm.length; i++) {
    phase += (2 * Math.PI * (220 + 40 * Math.sin(i / 9000))) / SR;
    pcm[i] = Math.round(9000 * Math.sin(phase) + 3000 * Math.sin(phase * 3.1));
  }
  const a = fingerprint(pcm);
  const b = await fingerprintAsync(pcm);
  assert.equal(b.length, a.length);
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  assert.ok(same / a.length > 0.97, `only ${same}/${a.length} frames agree`);
});

// ---------- credits start: dense agreement, and the picture's last word ----------
{
  const { tightenStart, parseBlackdetect, snapToBlack, longestRun: lr } = require("../src/media/introdetect")._internals;
  const rnd = (seed) => { let x = seed; return () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) & 0x7fff); };

  test("a run's early, scattered lead-in is trimmed to where the audio really agrees", () => {
    // 400 frames each: unrelated audio, then 60 frames that agree only now
    // and then (the score swelling under the last scene), then 200 identical
    // frames (the credits, the same recording in both files)
    const ra = rnd(1), rb = rnd(2);
    const A = new Uint16Array(400), B = new Uint16Array(400);
    for (let i = 0; i < 400; i++) { A[i] = ra(); B[i] = rb(); }
    for (let i = 140; i < 200; i += 5) B[i] = A[i]; // sparse hits: one in five
    for (let i = 200; i < 400; i++) B[i] = A[i];
    const run = lr(A, B, 0);
    assert.ok(run.start <= 145, `the loose run starts in the lead-in (${run.start})`);
    const tight = tightenStart(A, B, run);
    // within ~1.5s (12 frames) of the true edge at 200 — the window's own resolution
    assert.ok(tight.start >= 188 && tight.start <= 203, `tightened to the dense part (${tight.start})`);
    assert.ok(tight.start - run.start >= 40, "and well clear of the loose start");
    assert.equal(tight.end, run.end);
  });

  test("a run that is dense from its first frame is left alone", () => {
    const ra = rnd(3), rb = rnd(4);
    const A = new Uint16Array(300), B = new Uint16Array(300);
    for (let i = 0; i < 300; i++) { A[i] = ra(); B[i] = rb(); }
    for (let i = 100; i < 300; i++) B[i] = A[i];
    const run = lr(A, B, 0);
    assert.equal(tightenStart(A, B, run).start, run.start);
  });

  test("blackdetect lines parse, and the credits snap LATER onto the cut to black", () => {
    const log = "[blackdetect @ 0x1] black_start:13.4 black_end:14.2 black_duration:0.8\n[blackdetect @ 0x1] black_start:20 black_end:33.9 black_duration:13.9\n";
    const segs = parseBlackdetect(log);
    assert.deepEqual(segs, [{ start: 13.4, end: 14.2 }, { start: 20, end: 33.9 }]);
    assert.equal(snapToBlack(segs, 2), 13.4, "audio said 2s into the window; the picture goes dark at 13.4");
    assert.equal(snapToBlack(segs, 13.6), null, "already in black: the audio was right");
    assert.equal(snapToBlack([{ start: 60, end: 70 }], 2), null, "a black a minute later is not this episode's credits");
    assert.equal(snapToBlack([], 2), null, "credits over the picture: no opinion");
  });
}
