// Where people talk (src/media/vad.js): generated audio only — speech-like
// voiced syllables, a held music chord, rumbling noise — never a real film.
// The detector must put speech above music and noise even where those are
// LOUDER (what a plain energy gate gets wrong), and its streaming extractor
// must not care how the PCM is cut into chunks.
const test = require("node:test");
const assert = require("node:assert/strict");
const vad = require("../src/media/vad");

const R = vad.RATE;
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return s - 3; };

// voiced syllables (a gliding pitch of 100-220 Hz, harmonics shaped by two
// formants), four to six a second, with pauses between phrases
const speech = (x, a, b, gain = 0.08) => {
  let t = a;
  while (t < b) {
    const syl = 0.12 + rnd() * 0.18;
    const f0 = 100 + rnd() * 120;
    const F1 = 400 + rnd() * 500;
    const F2 = 1100 + rnd() * 1300;
    const s0 = Math.floor(t * R);
    const s1 = Math.min(Math.floor((t + syl) * R), Math.floor(b * R));
    let ph = 0;
    for (let i = s0; i < s1; i++) {
      const u = (i - s0) / (s1 - s0);
      const f = f0 * (1 + 0.1 * (u - 0.5));
      ph += (2 * Math.PI * f) / R;
      let v = 0;
      for (let h = 1; h * f < 3400; h++) {
        const hf = h * f;
        const g = Math.exp(-(((hf - F1) / 250) ** 2)) + 0.6 * Math.exp(-(((hf - F2) / 350) ** 2)) + 0.05;
        v += (g * Math.sin(h * ph)) / h ** 0.3;
      }
      x[i] += gain * Math.sin(Math.PI * u) * v;
    }
    t += syl + 0.02 + rnd() * 0.08;
    if (rnd() < 0.15) t += 0.3 + rnd() * 0.6;
  }
};
// a held A-major chord with harmonics (score)
const chord = (x, a, b) => {
  for (let i = Math.floor(a * R); i < b * R; i++) {
    const t = i / R;
    let v = 0;
    for (const f of [220, 277.2, 329.6, 440]) for (let h = 1; h <= 4; h++) v += Math.sin(2 * Math.PI * f * h * t) / h;
    x[i] += 0.05 * v;
  }
};
// low-passed noise (rumble, rain, a crowd far off)
const noise = (x, a, b) => {
  let p = 0;
  for (let i = Math.floor(a * R); i < b * R; i++) { p = 0.9 * p + gauss(); x[i] += 0.03 * p; }
};
const toPcm = (x) => Int16Array.from(x, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767))));

// 80 s: speech 2-18, chord 20-38, noise 40-58, speech 60-78, a quiet floor under all
const scene = () => {
  seed = 7;
  const x = new Float64Array(R * 80);
  for (let i = 0; i < x.length; i++) x[i] = 0.003 * gauss();
  speech(x, 2, 18);
  chord(x, 20, 38);
  noise(x, 40, 58);
  speech(x, 60, 78);
  return toPcm(x);
};
const mean = (p, a, b) => { let s = 0; for (let i = a * 100; i < b * 100; i++) s += p[i]; return s / ((b - a) * 100) / 255; };

test("speech scores high, a held chord and noise score low — even when they are louder", () => {
  const pcm = scene();
  const p = vad.analyse(pcm);
  assert.equal(p.length, 8000, "one value per 10 ms");
  const sp1 = mean(p, 3, 17);
  const sp2 = mean(p, 61, 77);
  const ch = mean(p, 21, 37);
  const nz = mean(p, 41, 57);
  assert.ok(sp1 > 0.6 && sp2 > 0.6, `speech ${sp1.toFixed(2)} ${sp2.toFixed(2)}`);
  assert.ok(ch < 0.35, `chord ${ch.toFixed(2)}`);
  assert.ok(nz < 0.35, `noise ${nz.toFixed(2)}`);
  assert.ok(Math.min(sp1, sp2) - Math.max(ch, nz) > 0.4, "a clear margin");
  // the plain energy gate (the baseline it was measured against) rates the chord above the speech
  const e = vad.analyse(pcm, { baseline: true });
  assert.ok(mean(e, 21, 37) > mean(e, 3, 17), "the energy baseline is fooled by the chord");
});

test("the probability follows speech in time: on within a syllable or two, off in the pauses", () => {
  seed = 11;
  const x = new Float64Array(R * 60);
  for (let i = 0; i < x.length; i++) x[i] = 0.003 * gauss();
  for (const [a, b] of [[5, 9], [20, 23], [40, 47]]) speech(x, a, b);
  const p = vad.analyse(toPcm(x));
  for (const [a, b] of [[5, 9], [20, 23], [40, 47]]) {
    assert.ok(mean(p, a + 0.5, b - 0.5) > 0.6, `inside ${a}-${b}`);
    assert.ok(mean(p, b + 2, b + 4) < 0.3, `after ${b}`);
  }
  assert.ok(mean(p, 0.5, 4) < 0.3, "before the first words");
});

test("streaming: odd chunk sizes give exactly the rows of one push", () => {
  const pcm = scene().subarray(0, R * 30);
  const one = vad.createExtractor();
  one.push(pcm);
  const a = one.end();
  const sizes = [1, 79, 80, 81, 255, 256, 257, 4000, 12345];
  const many = vad.createExtractor();
  for (let i = 0, k = 0; i < pcm.length; k++) {
    const n = sizes[k % sizes.length];
    many.push(pcm.subarray(i, Math.min(pcm.length, i + n)));
    i += n;
  }
  const b = many.end();
  assert.equal(a.length, b.length);
  assert.equal(a.length / vad.RAW, 3000, "one row per 10 ms");
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]));
  assert.equal(diff, 0);
});

test("silence and an empty end are handled", () => {
  const p = vad.analyse(new Int16Array(R * 25));
  assert.equal(p.length, 2500);
  assert.ok(mean(p, 1, 24) < 0.3);
  const x = vad.createExtractor();
  assert.equal(x.end().length, 0, "no audio, no rows");
});

test("the model is the fitted one, and its shape matches the features", () => {
  const m = vad.MODEL;
  assert.equal(m.mean.length, vad.FEATS);
  assert.equal(m.std.length, vad.FEATS);
  assert.equal(m.w.length, vad.FEATS);
  assert.equal(vad.FEATURE_NAMES.length, vad.FEATS);
  assert.ok(m.std.every((s) => s > 0));
  assert.ok(Number.isInteger(m.delay) && Math.abs(m.delay) < 50, "a lead of under half a second");
});
