// The detector as the previous agent left it (2026-10-17, uncommitted): its
// 14 features and HAND-WRITTEN weights (the comment claimed a fit; nothing
// fitted them). Kept only so the evaluation can compare against it.
"use strict";
const vad = require("../../src/media/vad");
const { smooth, RAW } = vad;
const { floorCeil, col } = vad._internals;
const EPS = 1e-3;
// The model's inputs for every frame: Float32Array, FEATS per frame.
const FEATS = 14;
const FEATURE_NAMES = [
  "level over floor", "level over floor (±50 ms)", "level under ceiling", "syllable modulation",
  "voicing", "voicing (±100 ms)", "flatness (±100 ms)", "bass vs speech band",
  "200-400 shape", "400-800 shape", "800-1500 shape", "1500-2500 shape", "2500-3800 shape", "flux (±50 ms)",
];
const features = (rows) => {
  const n = rows.length / RAW;
  const E = col(rows, 0);
  const { F, C } = floorCeil(E);
  const B = [1, 2, 3, 4, 5, 6].map((c) => col(rows, c));
  // speech-band level
  const S = new Float32Array(n);
  for (let i = 0; i < n; i++) S[i] = Math.log10(Math.pow(10, B[1][i]) + Math.pow(10, B[2][i]) + Math.pow(10, B[3][i]) + Math.pow(10, B[4][i]) + EPS);
  const E5 = smooth(E, 5);
  // syllabic modulation: |short envelope - long envelope| averaged over +-250 ms
  const s3 = smooth(S, 2);
  const s25 = smooth(S, 15);
  const dev = new Float32Array(n);
  for (let i = 0; i < n; i++) dev[i] = Math.abs(s3[i] - s25[i]);
  const mod = smooth(dev, 25);
  const V = col(rows, 8);
  const V10 = smooth(V, 10);
  const FL10 = smooth(col(rows, 7), 10);
  const FX5 = smooth(col(rows, 9), 5);
  const out = new Float32Array(n * FEATS);
  for (let i = 0; i < n; i++) {
    const o = i * FEATS;
    out[o] = E[i] - F[i];
    out[o + 1] = E5[i] - F[i];
    out[o + 2] = C[i] - E[i];
    out[o + 3] = mod[i];
    out[o + 4] = V[i];
    out[o + 5] = V10[i];
    out[o + 6] = FL10[i];
    out[o + 7] = B[0][i] - S[i];
    for (let b = 1; b < 6; b++) out[o + 7 + b] = B[b][i] - E[i];
    out[o + 13] = FX5[i];
  }
  return out;
};

const MODEL = {
  mean: [1.2, 1.2, 0.8, 0.12, 0.35, 0.35, -1.5, -0.3, -0.8, -0.6, -0.8, -1.2, -1.6, 0.6],
  std: [0.8, 0.75, 0.7, 0.06, 0.2, 0.15, 0.5, 0.6, 0.5, 0.5, 0.5, 0.6, 0.7, 0.4],
  w: [0.6, 0.6, 0, 0.5, 0.4, 0.6, 0.3, -0.4, 0, 0, 0, 0, 0, 0],
  b: -0.3,
};

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

// probability per frame, 0..255 (Uint8Array)
const probabilities = (rows, model = MODEL) => {
  const X = features(rows);
  const n = X.length / FEATS;
  const out = new Uint8Array(n);
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let z = model.b;
    for (let f = 0; f < FEATS; f++) z += model.w[f] * ((X[i * FEATS + f] - model.mean[f]) / model.std[f]);
    raw[i] = sigmoid(z);
  }
  const sm = smooth(raw, 3);
  for (let i = 0; i < n; i++) out[i] = Math.round(sm[i] * 255);
  return out;
};


module.exports = { FEATS, FEATURE_NAMES, MODEL, features, probabilities };
