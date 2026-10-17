#!/usr/bin/env node
// Fits the VAD's model (src/media/vad.js MODEL) on library items whose own
// subtitle track is right, and checks it on OTHER items.
//   node tools/subsync-eval/train-vad.js --train A,B,C [--test D,E] [--kind logistic|mlp] [--hidden 12]
//        [--save name] [--write]
// Labels: "a reference line is on screen" per 10 ms (noisy — lines stay up
// longer than the words, and some speech has no line — but the same noise
// for every candidate, and it is exactly what the alignment matches against).
// Prints per-item AUCs: the fitted model vs the energy gate vs the band
// energy vs the previous hand-written model (legacy.js).
// --save writes the model to <scratch>/models/<name>.json (run.js --vad that file);
// --write puts it into vad.js between MODEL-BEGIN / MODEL-END.
"use strict";
const fs = require("fs");
const path = require("path");
const c = require("./common");
const vad = require("../../src/media/vad");
const legacy = require("./legacy");

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const list = (k) => (opt(k) ? opt(k).split(",") : null);
const all = c.names().filter((n) => c.refOf(n));
const train = list("--train") || all.slice(0, Math.ceil(all.length / 2));
const test = list("--test") || all.filter((n) => !train.includes(n));
const kind = opt("--kind", "logistic");
const HID = +opt("--hidden", 12);
const F = vad.FEATS;
const STRIDE = 5;
// features left out (indices or names' prefixes): their weights stay 0
const dropped = new Set((opt("--drop") || "").split(",").filter(Boolean).flatMap((d) => (/^\d+$/.test(d) ? [+d] : vad.FEATURE_NAMES.map((nm, i) => (nm.includes(d) ? i : -1)).filter((i) => i >= 0))));

const load = (name) => {
  const rows = c.rowsOf(name);
  const n = rows.length / vad.RAW;
  return { name, rows, X: vad.features(rows), y: c.labels(c.refOf(name), n), n };
};

// ---------- the training matrix (every STRIDE-th frame) ----------
const Xs = [];
const ys = [];
for (const name of train) {
  const d = load(name);
  for (let i = 0; i < d.n; i += STRIDE) { Xs.push(Float64Array.from(d.X.subarray(i * F, i * F + F))); ys.push(d.y[i]); }
}
const N = Xs.length;
const mean = new Array(F).fill(0);
const std = new Array(F).fill(0);
for (const x of Xs) for (let f = 0; f < F; f++) mean[f] += x[f] / N;
for (const x of Xs) for (let f = 0; f < F; f++) std[f] += (x[f] - mean[f]) ** 2 / N;
for (let f = 0; f < F; f++) std[f] = Math.sqrt(std[f]) || 1;
for (const x of Xs) for (let f = 0; f < F; f++) x[f] = dropped.has(f) ? 0 : (x[f] - mean[f]) / std[f];
const pos = ys.reduce((a, b) => a + b, 0);
const wPos = N / (2 * pos);
const wNeg = N / (2 * (N - pos));
const sig = (z) => 1 / (1 + Math.exp(-z));
const r4 = (x) => Math.round(x * 10000) / 10000;

const logistic = () => {
  // Newton / IRLS with a little L2, classes balanced
  const w = new Array(F + 1).fill(0);
  const lambda = 1;
  for (let it = 0; it < 15; it++) {
    const g = new Float64Array(F + 1);
    const H = Array.from({ length: F + 1 }, () => new Float64Array(F + 1));
    for (let i = 0; i < N; i++) {
      const z = Xs[i];
      let s = w[F];
      for (let f = 0; f < F; f++) s += w[f] * z[f];
      const p = sig(s);
      const sw = ys[i] ? wPos : wNeg;
      const e = (p - ys[i]) * sw;
      const h = p * (1 - p) * sw;
      for (let a = 0; a <= F; a++) {
        const za = a < F ? z[a] : 1;
        g[a] += e * za;
        const hz = h * za;
        const Ha = H[a];
        for (let b = a; b < F; b++) Ha[b] += hz * z[b];
        Ha[F] += hz;
      }
    }
    for (let a = 0; a <= F; a++) { for (let b = 0; b < a; b++) H[a][b] = H[b][a]; if (a < F) { H[a][a] += lambda; g[a] += lambda * w[a]; } }
    const K = F + 1;
    const M = H.map((r, i) => [...r, g[i]]);
    for (let i = 0; i < K; i++) {
      let piv = i;
      for (let r = i + 1; r < K; r++) if (Math.abs(M[r][i]) > Math.abs(M[piv][i])) piv = r;
      [M[i], M[piv]] = [M[piv], M[i]];
      for (let r = 0; r < K; r++) if (r !== i) { const k = M[r][i] / M[i][i]; for (let cc = i; cc <= K; cc++) M[r][cc] -= k * M[i][cc]; }
    }
    let step = 0;
    for (let a = 0; a <= F; a++) { const d = M[a][K] / M[a][a]; w[a] -= d; step = Math.max(step, Math.abs(d)); }
    if (step < 1e-5) break;
  }
  return { mean: mean.map(r4), std: std.map(r4), w: w.slice(0, F).map(r4), b: r4(w[F]) };
};

const mlp = () => {
  // one hidden layer (tanh), Adam on minibatches, classes balanced, weight decay
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const W1 = Array.from({ length: HID }, () => Float64Array.from({ length: F }, () => (rnd() - 0.5) * 2 / Math.sqrt(F)));
  const b1 = new Float64Array(HID);
  const w2 = Float64Array.from({ length: HID }, () => (rnd() - 0.5) * 2 / Math.sqrt(HID));
  let b2 = 0;
  const P = [...W1, b1, w2];
  const mom = P.map((a) => new Float64Array(a.length));
  const vel = P.map((a) => new Float64Array(a.length));
  let mb2 = 0, vb2 = 0;
  const gr = P.map((a) => new Float64Array(a.length));
  const lr = 0.003, B1 = 0.9, B2 = 0.999, decay = 1e-4, BATCH = 512;
  const idx = Array.from({ length: N }, (_, i) => i);
  const a = new Float64Array(HID);
  let t = 0;
  for (let ep = 0; ep < 6; ep++) {
    for (let i = N - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    let loss = 0;
    for (let s0 = 0; s0 < N; s0 += BATCH) {
      for (const g of gr) g.fill(0);
      let gb2 = 0;
      const s1 = Math.min(N, s0 + BATCH);
      for (let q = s0; q < s1; q++) {
        const i = idx[q];
        const z = Xs[i];
        let o = b2;
        for (let h = 0; h < HID; h++) { let v = b1[h]; const r = W1[h]; for (let f = 0; f < F; f++) v += r[f] * z[f]; a[h] = Math.tanh(v); o += w2[h] * a[h]; }
        const p = sig(o);
        const sw = ys[i] ? wPos : wNeg;
        loss += -sw * (ys[i] ? Math.log(p + 1e-9) : Math.log(1 - p + 1e-9));
        const e = (p - ys[i]) * sw;
        gb2 += e;
        for (let h = 0; h < HID; h++) {
          gr[HID + 1][h] += e * a[h];
          const d = e * w2[h] * (1 - a[h] * a[h]);
          gr[HID][h] += d;
          const g = gr[h];
          for (let f = 0; f < F; f++) g[f] += d * z[f];
        }
      }
      t++;
      const m = s1 - s0;
      for (let k = 0; k < P.length; k++) {
        const p = P[k], g = gr[k], mo = mom[k], ve = vel[k];
        for (let j = 0; j < p.length; j++) {
          const gg = g[j] / m + decay * p[j];
          mo[j] = B1 * mo[j] + (1 - B1) * gg;
          ve[j] = B2 * ve[j] + (1 - B2) * gg * gg;
          p[j] -= (lr * (mo[j] / (1 - B1 ** t))) / (Math.sqrt(ve[j] / (1 - B2 ** t)) + 1e-8);
        }
      }
      const gg = gb2 / m;
      mb2 = B1 * mb2 + (1 - B1) * gg; vb2 = B2 * vb2 + (1 - B2) * gg * gg;
      b2 -= (lr * (mb2 / (1 - B1 ** t))) / (Math.sqrt(vb2 / (1 - B2 ** t)) + 1e-8);
    }
    console.error(`epoch ${ep} loss ${(loss / N).toFixed(4)}`);
  }
  return { mean: mean.map(r4), std: std.map(r4), W1: W1.map((r) => Array.from(r, r4)), b1: Array.from(b1, r4), w2: Array.from(w2, r4), b2: r4(b2) };
};

const t0 = Date.now();
const model = kind === "mlp" ? mlp() : logistic();
// dropped features: no weight (and a neutral standardisation)
for (const f of dropped) { model.mean[f] = 0; model.std[f] = 1; if (model.w) model.w[f] = 0; if (model.W1) for (const r of model.W1) r[f] = 0; }
// the model's lead: where the TRAINING items' own subtitles peak against it
if (!argv.includes("--no-delay")) {
  const peaks = train.map((name) => c.peakOf(vad.probabilities(c.rowsOf(name), model), c.refOf(name)).off).sort((a, b) => a - b);
  model.delay = Math.round(-peaks[Math.floor(peaks.length / 2)] * 100);
  console.error("train peaks", peaks.join(" "), "-> delay", model.delay, "frames");
}
model.fitted = { on: train, frames: N, kind, at: new Date().toISOString().slice(0, 10) };
console.error(`fitted (${kind}) on ${train.length} items, ${N} frames, in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (kind !== "mlp") for (let f = 0; f < F; f++) console.log("  ", vad.FEATURE_NAMES[f].padEnd(40), model.w[f]);

const sub = (a) => Array.from({ length: Math.floor(a.length / 7) }, (_, i) => a[i * 7]);
const report = [];
console.log("\nitem".padEnd(42), "set   ", "fitted", "hand  ", "energy", "band");
for (const name of [...train, ...test]) {
  const d = load(name);
  const yy = sub(d.y);
  const row = {
    item: name, set: train.includes(name) ? "train" : "test",
    fitted: c.auc(sub(vad.probabilities(d.rows, model)), yy), hand: c.auc(sub(legacy.probabilities(d.rows)), yy),
    energy: c.auc(sub(vad.energyProb(d.rows)), yy), band: c.auc(sub(vad.bandProb(d.rows)), yy),
  };
  report.push(row);
  console.log(name.padEnd(42), row.set.padEnd(6), row.fitted.toFixed(3), row.hand.toFixed(3), row.energy.toFixed(3), row.band.toFixed(3));
}
const avg = (set, k) => { const r = report.filter((x) => x.set === set); return r.length ? r.reduce((s, x) => s + x[k], 0) / r.length : NaN; };
for (const set of ["train", "test"]) console.log(`mean ${set}`.padEnd(49), ["fitted", "hand", "energy", "band"].map((k) => avg(set, k).toFixed(3)).join(" "));

const save = opt("--save");
if (save) {
  fs.mkdirSync(c.p("models"), { recursive: true });
  fs.writeFileSync(c.p("models", `${save}.json`), JSON.stringify(model));
  fs.writeFileSync(c.p("models", `${save}.auc.json`), JSON.stringify(report, null, 1));
  console.error("saved", c.p("models", `${save}.json`));
}
if (argv.includes("--write")) {
  const f = path.join(__dirname, "../../src/media/vad.js");
  const s = fs.readFileSync(f, "utf8");
  const a = s.indexOf("// MODEL-BEGIN");
  const b = s.indexOf("// MODEL-END");
  const { fitted, ...m } = model;
  const block = `// MODEL-BEGIN (train-vad.js --write replaces this block)\n// fitted ${fitted.at}, ${fitted.kind}, on ${fitted.on.join(", ")} (${fitted.frames} frames)\nconst MODEL = ${JSON.stringify(m)};\n`;
  fs.writeFileSync(f, s.slice(0, a) + block + s.slice(b));
  console.error("wrote the model into", f);
}
