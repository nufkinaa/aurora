// Where people are TALKING in a film's audio: a voice-activity detector in
// plain JavaScript, for lining subtitles up with what is said (media/subsync
// audio alignment, docs/qa/subtitle-sync/REPORT.md).
//
// Input: mono 16-bit PCM at 8 kHz (ffmpeg decodes the film's centre channel
// where the layout has one — that is where dialogue is mixed — else the
// down-mix). Output: one speech probability per 10 ms, 0..255.
//
// WHY NOT A PLAIN ENERGY GATE. In a film, loud is not talk: score, explosions
// and crowd noise are louder than most dialogue, and a quiet two-hander is
// quieter than the end credits' song. What sets speech apart here:
//   - its energy sits in 300-3400 Hz and comes and goes four or five times a
//     second (syllables) — music holds notes, noise holds level;
//   - it is voiced: a pitch between 80 and 400 Hz shows as a strong peak in
//     the autocorrelation, while effects and noise are flat (spectral
//     flatness high);
//   - it is quiet below 200 Hz compared with score and effects.
// Each 10 ms frame gets those numbers (32 ms Hann window, 256-point FFT),
// they are set against the film's own levels around it (the floor and
// ceiling of the surrounding 20 s) at several spans of context (one frame,
// ±50 ms … ±1 s), and a logistic regression over those 25 features turns
// them into a probability.
//
// WHAT IT WAS FITTED ON (tools/subsync-eval/train-vad.js, 2026-10-17): the
// label is "a line of the item's own embedded English subtitle is on
// screen", every 5th frame of SIX library items — Avatar: Fire and Ash,
// Eternity, Project Hail Mary (stereo), Regretting You, The Thursday Murder
// Club, Spider-Noir S01E01 (901 288 frames). It was checked on ELEVEN
// others it never saw — Caught Stealing, Inception, Knives Out, The Ministry
// of Ungentlemanly Warfare, The Roses, Silo S03E01/E02/E05, Ted 1x1/1x2
// (stereo)/S02E06: area under the ROC curve against their own subtitles
// 0.900 on average (0.827-0.963), where the plain energy gate (`energyProb`,
// kept as the baseline) gets 0.669, the speech-band energy (`bandProb`)
// 0.678, and the hand-written weights this file had before 0.835. The same
// fit the other way round (on the eleven, checked on the six) gets 0.894:
// the numbers do not depend on which films it saw. What matters more — how
// well subtitles are lined up with it — is in docs/qa/subtitle-sync/REPORT.md
// ("Speech detection"): of the five detectors it lines up the most and
// refuses nothing it should match.
// `delay`: the probability leads the subtitles it was fitted to by 0.08 s
// (the median over the six, lines taken as the aligner takes them: their
// first 2.5 s), so it is handed out that much later — a right subtitle then
// peaks at 0 (-0.27..+0.16 s over all seventeen items).
//
// Cost: about 7 s of one core for the rows of a two-hour film and 1-1.5 s
// for the probabilities; it runs in worker threads (media/speech.js), never
// on the server's event loop.
"use strict";

const RATE = 8000;
const HOP = 80; // 10 ms
const WIN = 256; // 32 ms
const NB = WIN / 2 + 1;
const HZ = RATE / WIN; // 31.25 Hz a bin

// ---------- FFT (radix 2, in place, N = 256) ----------
const LOG2 = 8;
const REV = new Uint16Array(WIN);
for (let i = 0; i < WIN; i++) {
  let r = 0;
  for (let b = 0; b < LOG2; b++) if (i & (1 << b)) r |= 1 << (LOG2 - 1 - b);
  REV[i] = r;
}
const COS = new Float64Array(WIN / 2);
const SIN = new Float64Array(WIN / 2);
for (let i = 0; i < WIN / 2; i++) {
  COS[i] = Math.cos((2 * Math.PI * i) / WIN);
  SIN[i] = -Math.sin((2 * Math.PI * i) / WIN);
}
const fft = (re, im) => {
  for (let i = 0; i < WIN; i++) {
    const j = REV[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= WIN; size <<= 1) {
    const half = size >> 1;
    const step = WIN / size;
    for (let start = 0; start < WIN; start += size) {
      for (let k = 0; k < half; k++) {
        const c = COS[k * step];
        const s = SIN[k * step];
        const a = start + k;
        const b = a + half;
        const tr = re[b] * c - im[b] * s;
        const ti = re[b] * s + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
};

const HANN = new Float64Array(WIN);
for (let i = 0; i < WIN; i++) HANN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / WIN);

// bands, in bins
const bin = (hz) => Math.round(hz / HZ);
const BANDS = [[60, 200], [200, 400], [400, 800], [800, 1500], [1500, 2500], [2500, 3800]].map(([a, b]) => [bin(a), bin(b)]);
const SPEECH = [bin(300), bin(3400)];
// pitch lags (samples): 400 Hz .. 80 Hz
const LAG_MIN = Math.floor(RATE / 400);
const LAG_MAX = Math.ceil(RATE / 80);

// Raw per-frame numbers.
const RAW = 10; // [logE, band0..5, flatness, voicing, flux]
const ROWS_V = 1; // the raw rows' version: bump when the extractor changes (eval caches)
const EPS = 1e-3;

// One frame pair's spectra -> raw rows. `w1`/`w2`: windowed frames.
const re = new Float64Array(WIN);
const im = new Float64Array(WIN);
const p1 = new Float64Array(NB);
const p2 = new Float64Array(NB);
const are = new Float64Array(WIN);
const aim = new Float64Array(WIN);

const rowFromPower = (P, out, o, prevBands, voicing) => {
  let tot = 0;
  for (let k = BANDS[0][0]; k < BANDS[5][1]; k++) tot += P[k];
  out[o] = Math.log10(tot + EPS);
  let flux = 0;
  for (let b = 0; b < 6; b++) {
    let s = 0;
    for (let k = BANDS[b][0]; k < BANDS[b][1]; k++) s += P[k];
    const l = Math.log10(s + EPS);
    out[o + 1 + b] = l;
    const d = l - prevBands[b];
    if (d > 0) flux += d;
    prevBands[b] = l;
  }
  // spectral flatness in the speech band: log(geo mean) - log(arith mean), <= 0
  let lg = 0;
  let ar = 0;
  const n = SPEECH[1] - SPEECH[0];
  for (let k = SPEECH[0]; k < SPEECH[1]; k++) {
    lg += Math.log(P[k] + EPS);
    ar += P[k];
  }
  out[o + 7] = lg / n - Math.log(ar / n + EPS);
  out[o + 8] = voicing;
  out[o + 9] = flux;
};

// A streaming extractor: push() PCM (Int16Array) as it arrives, end() for
// the raw rows (Float32Array, RAW per frame). Frame k is centred on
// k * 10 ms + 5 ms.
const createExtractor = () => {
  let buf = new Float32Array(WIN * 64);
  let len = 0; // samples held
  let base = -(WIN / 2 - HOP / 2); // the sample index buf[0] stands for (frame 0 starts before 0: zero padded)
  len = -base; // the padding, as zeros
  let rows = new Float32Array(RAW * 4096);
  let frames = 0;
  const prev1 = new Float64Array(6).fill(Math.log10(EPS));
  const pending = []; // a frame waiting for its pair: start offset in buf

  const ensureRows = (n) => {
    if ((frames + n) * RAW <= rows.length) return;
    let size = rows.length;
    while ((frames + n) * RAW > size) size *= 2;
    const r = new Float32Array(size);
    r.set(rows.subarray(0, frames * RAW));
    rows = r;
  };

  const voicingOf = (P, ac, scale) => {
    // ac: inverse FFT of the speech-band power -> autocorrelation (real part)
    const r0 = ac[0] * scale;
    if (!(r0 > 1e-6)) return 0;
    let best = 0;
    for (let l = LAG_MIN; l <= LAG_MAX; l++) {
      const v = (ac[l] * scale) / r0;
      if (v > best) best = v;
    }
    return best;
  };

  // two frames at once: one complex FFT for two real signals
  const doPair = (a, b) => {
    for (let i = 0; i < WIN; i++) {
      re[i] = buf[a + i] * HANN[i];
      im[i] = b >= 0 ? buf[b + i] * HANN[i] : 0;
    }
    fft(re, im);
    for (let k = 0; k < NB; k++) {
      const j = (WIN - k) & (WIN - 1);
      const xr = (re[k] + re[j]) / 2;
      const xi = (im[k] - im[j]) / 2;
      const yr = (im[k] + im[j]) / 2;
      const yi = (re[j] - re[k]) / 2;
      p1[k] = (xr * xr + xi * xi) / (WIN * 32768 * 32768 / 64);
      p2[k] = (yr * yr + yi * yi) / (WIN * 32768 * 32768 / 64);
    }
    // autocorrelations of both, from their speech-band power (zero elsewhere)
    for (let i = 0; i < WIN; i++) { are[i] = 0; aim[i] = 0; }
    for (let k = SPEECH[0]; k < SPEECH[1]; k++) {
      are[k] = p1[k]; are[WIN - k] = p1[k];
      aim[k] = p2[k]; aim[WIN - k] = p2[k];
    }
    // the inverse of a real, even spectrum is real: P1 + iP2 -> r1 + i r2
    // (forward FFT of a real even sequence = the inverse up to scale)
    fft(are, aim);
    const v1 = voicingOf(p1, are, 1);
    const v2 = voicingOf(p2, aim, 1);
    ensureRows(2);
    rowFromPower(p1, rows, frames * RAW, prev1, v1);
    frames++;
    if (b >= 0) {
      rowFromPower(p2, rows, frames * RAW, prev1, v2);
      frames++;
    }
  };

  const push = (pcm) => {
    // drop what no frame needs any more (the next frame starts at
    // frames*HOP - (WIN/2 - HOP/2), in samples), then grow if still short
    const nextStart = frames * HOP - (WIN / 2 - HOP / 2); // absolute sample index
    const off = nextStart - base;
    if (off > 0 && len + pcm.length > buf.length) {
      buf.copyWithin(0, off, len);
      len -= off;
      base = nextStart;
    }
    if (len + pcm.length > buf.length) {
      let size = buf.length;
      while (len + pcm.length > size) size *= 2;
      const nb = new Float32Array(size);
      nb.set(buf.subarray(0, len));
      buf = nb;
    }
    buf.set(pcm, len);
    len += pcm.length;
    // every complete pair of frames
    for (;;) {
      const s0 = frames * HOP - (WIN / 2 - HOP / 2) - base;
      const s1 = s0 + HOP;
      if (s1 + WIN > len) break;
      doPair(s0, s1);
    }
  };

  const end = () => {
    // the tail: frames whose centre is inside the audio, zero padded
    const total = len + base; // samples seen (absolute end)
    const want = Math.ceil(total / HOP);
    const padTo = (want + 2) * HOP + WIN;
    if (padTo - base > buf.length) {
      const nb = new Float32Array(padTo - base);
      nb.set(buf.subarray(0, len));
      buf = nb;
    }
    buf.fill(0, len);
    len = padTo - base;
    while (frames < want) {
      const s0 = frames * HOP - (WIN / 2 - HOP / 2) - base;
      doPair(s0, frames + 1 < want ? s0 + HOP : -1);
    }
    return rows.slice(0, want * RAW);
  };

  return { push, end, frames: () => frames };
};

// ---------- from raw rows to a probability ----------

// moving average of `x` (length n, stride 1) over +-r
const smooth = (x, r) => {
  const n = x.length;
  const out = new Float32Array(n);
  let s = 0;
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - r);
    const b = Math.min(n - 1, i + r);
    while (hi < b) s += x[++hi];
    while (lo < a) s -= x[lo++];
    out[i] = s / (hi - lo + 1);
  }
  return out;
};

// A level's local floor and ceiling: the 10th and 90th percentile of each
// 20 s block, interpolated between block centres.
const BLOCK = 2000;
const floorCeil = (x) => {
  const n = x.length;
  const nb = Math.max(1, Math.ceil(n / BLOCK));
  const lo = new Float32Array(nb);
  const hi = new Float32Array(nb);
  for (let b = 0; b < nb; b++) {
    const seg = Array.from(x.subarray(b * BLOCK, Math.min(n, (b + 1) * BLOCK))).sort((p, q) => p - q);
    lo[b] = seg[Math.floor(seg.length * 0.1)];
    hi[b] = seg[Math.floor(seg.length * 0.9)];
  }
  const F = new Float32Array(n);
  const C = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / BLOCK - 0.5;
    const b0 = Math.max(0, Math.min(nb - 1, Math.floor(t)));
    const b1 = Math.min(nb - 1, b0 + 1);
    const f = Math.max(0, Math.min(1, t - b0));
    F[i] = lo[b0] + (lo[b1] - lo[b0]) * f;
    C[i] = hi[b0] + (hi[b1] - hi[b0]) * f;
  }
  return { F, C };
};

const col = (rows, c) => {
  const n = rows.length / RAW;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rows[i * RAW + c];
  return out;
};

// The model's inputs for every frame: Float32Array, FEATS per frame. Each
// is set against the film's own levels around it (floorCeil: the 20 s
// blocks), at several spans of context.
const FEATURE_NAMES = [
  "level over floor", "level over floor (±50 ms)", "level over floor (±250 ms)",
  "speech band over its floor", "speech band over its floor (±250 ms)", "level under ceiling",
  "syllable modulation (±250 ms)", "syllable modulation (±100 ms)", "syllable modulation (±500 ms)",
  "voicing", "voicing (±100 ms)", "voicing (±250 ms)", "voicing over its local range (±100 ms)",
  "flatness (±100 ms)", "flatness (±250 ms)", "bass vs speech band (±100 ms)",
  "200-400 shape", "400-800 shape", "800-1500 shape", "1500-2500 shape", "2500-3800 shape",
  "flux (±50 ms)", "flux (±250 ms)", "level in its local range (±50 ms)", "level over floor (±1 s)",
];
const FEATS = FEATURE_NAMES.length;
const features = (rows) => {
  const n = rows.length / RAW;
  const E = col(rows, 0);
  const { F, C } = floorCeil(E);
  const B = [1, 2, 3, 4, 5, 6].map((c) => col(rows, c));
  // speech-band level (200-2500 Hz)
  const S = new Float32Array(n);
  for (let i = 0; i < n; i++) S[i] = Math.log10(Math.pow(10, B[1][i]) + Math.pow(10, B[2][i]) + Math.pow(10, B[3][i]) + Math.pow(10, B[4][i]) + EPS);
  const fs = floorCeil(S);
  const E5 = smooth(E, 5);
  const E25 = smooth(E, 25);
  const E100 = smooth(E, 100);
  const S25 = smooth(S, 25);
  // syllabic modulation: |short envelope - long envelope|, averaged
  const s3 = smooth(S, 2);
  const s25 = smooth(S, 15);
  const dev = new Float32Array(n);
  for (let i = 0; i < n; i++) dev[i] = Math.abs(s3[i] - s25[i]);
  const mod10 = smooth(dev, 10);
  const mod25 = smooth(dev, 25);
  const mod50 = smooth(dev, 50);
  const V = col(rows, 8);
  const V10 = smooth(V, 10);
  const V25 = smooth(V, 25);
  const fv = floorCeil(V10);
  const FL = col(rows, 7);
  const FL10 = smooth(FL, 10);
  const FL25 = smooth(FL, 25);
  const bass = new Float32Array(n);
  for (let i = 0; i < n; i++) bass[i] = B[0][i] - S[i];
  const bass10 = smooth(bass, 10);
  const FX = col(rows, 9);
  const FX5 = smooth(FX, 5);
  const FX25 = smooth(FX, 25);
  const out = new Float32Array(n * FEATS);
  for (let i = 0; i < n; i++) {
    const o = i * FEATS;
    out[o] = E[i] - F[i];
    out[o + 1] = E5[i] - F[i];
    out[o + 2] = E25[i] - F[i];
    out[o + 3] = S[i] - fs.F[i];
    out[o + 4] = S25[i] - fs.F[i];
    out[o + 5] = C[i] - E[i];
    out[o + 6] = mod25[i];
    out[o + 7] = mod10[i];
    out[o + 8] = mod50[i];
    out[o + 9] = V[i];
    out[o + 10] = V10[i];
    out[o + 11] = V25[i];
    out[o + 12] = (V10[i] - fv.F[i]) / (fv.C[i] - fv.F[i] + 0.05);
    out[o + 13] = FL10[i];
    out[o + 14] = FL25[i];
    out[o + 15] = bass10[i];
    for (let b = 1; b < 6; b++) out[o + 15 + b] = B[b][i] - E[i];
    out[o + 21] = FX5[i];
    out[o + 22] = FX25[i];
    out[o + 23] = (E5[i] - F[i]) / (C[i] - F[i] + 0.1);
    out[o + 24] = E100[i] - F[i];
  }
  return out;
};

// The model: standardisation, then a logistic regression ({ w, b }) — or,
// for the evaluation's sake, one hidden layer ({ W1, b1, w2, b2 }, tanh;
// measured, not better: see the report). Written by
// tools/subsync-eval/train-vad.js — see the top of this file for what it
// was fitted on.
// MODEL-BEGIN (train-vad.js --write replaces this block)
// fitted 2026-10-17, logistic, on Avatar_Fire_and_Ash_2025_, Eternity, Project_Hail_Mary_2026_, Regretting_You, The_Thursday_Murder_Club, Spider_Noir_S01E01 (901288 frames)
const MODEL = {"mean":[1.0954,1.0953,1.0953,1.0172,1.0171,1.2052,0.2474,0.2474,0.2474,0.4671,0.4672,0.4672,0.3853,-0.9405,-0.9405,-0.782,-0.7086,-0.7736,-1.1527,-1.3976,-1.6933,0.4918,0.4918,0.4514,1.0953],"std":[1.0307,0.9737,0.8513,0.9839,0.7923,1.0482,0.2053,0.2326,0.1839,0.2088,0.1676,0.1515,0.3419,0.8892,0.8067,0.821,0.51,0.498,0.6584,0.76,0.854,0.3024,0.1943,0.3519,0.6908],"w":[0.3793,0.3388,-1.153,-0.1843,1.0983,0.1846,-0.1456,0.1481,2.0743,0.0077,0.2353,0.0281,-0.2121,-0.0602,-0.1341,-0.0271,0.088,0.0105,-0.2123,0.1593,0.0725,0.0177,-0.2118,-0.1719,0.1861],"b":0.2142,"delay":8};
// MODEL-END

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

// one frame's probability from its standardised features z (Float64Array)
const score = (model, z) => {
  if (model.W1) {
    const H = model.b1.length;
    let s = model.b2;
    for (let h = 0; h < H; h++) {
      let a = model.b1[h];
      const row = model.W1[h];
      for (let f = 0; f < z.length; f++) a += row[f] * z[f];
      s += model.w2[h] * Math.tanh(a);
    }
    return sigmoid(s);
  }
  let s = model.b;
  for (let f = 0; f < z.length; f++) s += model.w[f] * z[f];
  return sigmoid(s);
};

// probability per frame, 0..255 (Uint8Array)
const probabilities = (rows, model = MODEL) => {
  const X = features(rows);
  const n = X.length / FEATS;
  const out = new Uint8Array(n);
  const raw = new Float32Array(n);
  const z = new Float64Array(FEATS);
  for (let i = 0; i < n; i++) {
    for (let f = 0; f < FEATS; f++) z[f] = (X[i * FEATS + f] - model.mean[f]) / model.std[f];
    raw[i] = score(model, z);
  }
  const sm = smooth(raw, 3);
  // the model's lead over the subtitles it was fitted to (frames; see the top)
  const d = model.delay | 0;
  for (let i = 0; i < n; i++) out[i] = Math.round(sm[Math.min(n - 1, Math.max(0, i - d))] * 255);
  return out;
};

// The baseline: level over the local noise floor, nothing else.
const energyProb = (rows) => {
  const E = col(rows, 0);
  const { F, C } = floorCeil(E);
  const n = E.length;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const span = Math.max(0.3, C[i] - F[i]);
    out[i] = Math.round(sigmoid(((E[i] - F[i]) / span - 0.5) * 8) * 255);
  }
  return out;
};

// The second baseline: the SPEECH BAND's level (200-2500 Hz, where most of
// a voice's energy is) over its own local floor — energy, band-limited.
const bandProb = (rows) => {
  const n = rows.length / RAW;
  const S = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * RAW;
    S[i] = Math.log10(Math.pow(10, rows[o + 2]) + Math.pow(10, rows[o + 3]) + Math.pow(10, rows[o + 4]) + Math.pow(10, rows[o + 5]) + EPS);
  }
  const { F, C } = floorCeil(S);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const span = Math.max(0.3, C[i] - F[i]);
    out[i] = Math.round(sigmoid(((S[i] - F[i]) / span - 0.5) * 8) * 255);
  }
  return out;
};

// Whole PCM in, probabilities out (tests, the eval tools).
const analyse = (pcm, { model = MODEL, baseline = false } = {}) => {
  const x = createExtractor();
  x.push(pcm);
  const rows = x.end();
  return baseline ? energyProb(rows) : probabilities(rows, model);
};

module.exports = { RATE, HOP, WIN, RAW, ROWS_V, FEATS, FEATURE_NAMES, MODEL, createExtractor, features, probabilities, energyProb, bandProb, analyse, smooth, _internals: { fft, floorCeil, col, score } };
