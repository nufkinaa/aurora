// The intro fingerprint and matcher (media/introprint.js), on synthetic
// sound (tools/intro-eval/synth.js): no ffmpeg, no files.
const test = require("node:test");
const assert = require("node:assert");

const P = require("../src/media/introprint");
const synth = require("../tools/intro-eval/synth");
const { SR } = synth;

const toInt16 = (f) => Int16Array.from(f, (v) => Math.max(-32768, Math.min(32767, Math.round(v))));
const join = (...parts) => {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Float64Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const hiss = (seconds, seed, level = 30) => {
  const r = synth.rng(seed);
  return Float64Array.from({ length: Math.round(seconds * SR) }, () => (r() * 2 - 1) * level);
};
const episode = (before, theme, after, seed) => synth.encode(join(before, theme, after), seed).pcm;

test("the band-energy bits are the DFT's, frame for frame", () => {
  const N = P.N;
  const r = synth.rng(5);
  const pcm = Int16Array.from({ length: N * 3 }, () => Math.round((r() * 2 - 1) * 8000));
  const hann = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  const edges = Array.from({ length: P.NB + 1 }, (_, b) => Math.round((250 * Math.pow(3000 / 250, b / P.NB) * N) / SR));
  const bandsAt = (base) => {
    const e = [];
    for (let b = 0; b < P.NB; b++) {
      let acc = 0;
      for (let k = edges[b]; k < edges[b + 1]; k++) {
        let re = 0, im = 0;
        for (let n = 0; n < N; n++) { const x = pcm[base + n] * hann[n]; re += x * Math.cos((2 * Math.PI * k * n) / N); im -= x * Math.sin((2 * Math.PI * k * n) / N); }
        acc += re * re + im * im;
      }
      e.push(acc);
    }
    return e;
  };
  const e0 = bandsAt(0), e1 = bandsAt(P.HOP);
  let code = 0;
  for (let b = 0; b < P.NB - 1; b++) if ((e1[b] - e1[b + 1]) - (e0[b] - e0[b + 1]) > 0) code |= 1 << b;
  assert.equal(P.fingerprint(pcm).codes[1], code >>> 0);
});

test("the cooperative fingerprint is the synchronous one", async () => {
  const pcm = toInt16(synth.music(20, 3));
  const a = P.fingerprint(pcm);
  const b = await P.fingerprintAsync(pcm);
  assert.deepEqual(Array.from(b.codes), Array.from(a.codes));
  assert.deepEqual(Array.from(b.valid), Array.from(a.valid));
});

test("one theme, 280 s apart in two episodes (past the old ±3 min), found to a fraction of a second", () => {
  const theme = synth.music(45, 7);
  const a = episode(synth.programme(20, 1), theme, synth.programme(60, 2), 11);
  const b = episode(synth.programme(300, 3), theme, synth.programme(40, 4), 12);
  const m = P.match(P.fingerprint(a), P.fingerprint(b))[0];
  assert.ok(m, "a shared stretch");
  assert.ok(Math.abs(m.start - 20) < 0.3, `starts at ${m.start.toFixed(2)}, the theme at 20`);
  assert.ok(Math.abs(m.end - 65) < 0.5, `ends at ${m.end.toFixed(2)}, the theme at 65`);
});

test("unrelated programmes share nothing; hiss and near-silence never match", () => {
  const a = P.fingerprint(toInt16(join(synth.programme(60, 21), hiss(30, 1))));
  const b = P.fingerprint(toInt16(join(synth.programme(60, 22), hiss(30, 2))));
  assert.deepEqual(P.match(a, b, { minS: 5 }), []);
  const q = P.fingerprint(toInt16(hiss(60, 3, 2)));
  assert.ok(q.valid.every((v) => v === 0), "near-silence is invalid");
});

test("a pause of hiss inside the theme does not cut it in two", () => {
  const t = synth.music(40, 9);
  for (let i = 15 * SR; i < 16.5 * SR; i++) t[i] = (i % 7) - 3; // a beat of dead air
  const a = episode(synth.programme(10, 5), t, synth.programme(30, 6), 13);
  const b = episode(synth.programme(50, 7), t, synth.programme(30, 8), 14);
  const m = P.match(P.fingerprint(a), P.fingerprint(b));
  assert.equal(m.length, 1, `one stretch (${JSON.stringify(m.map((x) => [x.start, x.end]))})`);
  assert.ok(m[0].end - m[0].start > 38);
});

test("agree: two comparisons, a lone long one, a known intro alone — never a lone short one, never disagreement", () => {
  const c = (start, end) => ({ start, end });
  // two agree: the earliest start, the latest end (each is a lower bound)
  assert.deepEqual(P.agree([{ found: [c(20, 60)] }, { found: [c(21, 58)] }, { found: [c(90, 130)] }]), { start: 20, end: 60, support: 2, trusted: false, others: 2 });
  // one comparison in all: believed from 15 s
  assert.ok(P.agree([{ found: [c(20, 40)] }]));
  assert.equal(P.agree([{ found: [c(20, 30)] }]), null, "10 s from a single comparison");
  // a known intro is enough on its own, a title card included
  assert.equal(P.agree([{ found: [c(5, 15)], trusted: true }, { found: [] }]).trusted, true);
  // two comparisons that disagree: nothing
  assert.equal(P.agree([{ found: [c(20, 60)] }, { found: [c(90, 130)] }]), null);
  // an intro starting past where one is looked for: nothing
  assert.equal(P.agree([{ found: [c(700, 760)] }, { found: [c(700, 760)] }], { limitS: 600 }), null);
});

test("a kept intro survives encoding; a cut is the stretch asked for", () => {
  const fp = P.fingerprint(toInt16(synth.music(60, 4)));
  const t = P.cut(fp, 10, 40);
  assert.ok(Math.abs(t.codes.length - 30 * P.FPS) <= 2);
  const back = P.decode(JSON.parse(JSON.stringify(P.encode(t))));
  assert.deepEqual(Array.from(back.codes), Array.from(t.codes));
  assert.deepEqual(Array.from(back.valid), Array.from(t.valid));
  assert.equal(P.decode({ ...P.encode(t), hop: 1024 }), null, "another fingerprint's: not used");
});

test("credits: a scene in the middle does not move the start; a scene after them is heard", () => {
  const theme = synth.music(60, 31);
  const scene = (seed) => synth.programme(21, seed).subarray(0, 20 * SR);
  const tail = (k, mid, after) => toInt16(join(synth.programme(80, 40 + k).subarray(0, (70 + k * 7) * SR), mid ? join(theme.subarray(0, 15 * SR), scene(50 + k), theme.subarray(15 * SR)) : theme, after ? synth.programme(26, 60 + k).subarray(0, 25 * SR) : new Float64Array(0), hiss(20, k, 1)));
  const a = P.fingerprint(tail(1, true, true));
  const b = P.fingerprint(tail(2, false, false));
  const c = P.creditsCandidates(a, b);
  assert.ok(c.length, "the end theme is found");
  const first = c.sort((x, y) => x.start - y.start)[0];
  assert.ok(Math.abs(first.start - 77) < 0.5, `credits at ${first.start.toFixed(2)}, the theme at 77`);
  const ref = (x, c) => P.loudness(x, c.start, c.end) - 12;
  assert.ok(P.audibleAfter(a, first.end, ref(a, first)) >= 15, "a scene after them");
  const cb = P.creditsCandidates(b, a)[0];
  assert.ok(P.audibleAfter(b, cb.end, ref(b, cb)) < 5, "nothing but quiet after them");
});

test("a recap is the episode before heard again; the cold open is not", () => {
  const prev = synth.programme(300, 77);
  const clips = join(prev.subarray(60 * SR, 66 * SR), prev.subarray(110 * SR, 116 * SR), prev.subarray(170 * SR, 176 * SR));
  const me = P.fingerprint(toInt16(join(clips, synth.programme(60, 78))));
  const before = P.fingerprint(toInt16(prev));
  assert.ok(P.reheard(me, before, 0, 18).covered >= 12, "the three clips");
  assert.ok(P.reheard(me, before, 20, 50).covered < 2, "the episode's own sound");
});
