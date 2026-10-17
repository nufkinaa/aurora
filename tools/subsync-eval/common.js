// Shared bits of the subtitle-sync evaluation (docs/qa/subtitle-sync/REPORT.md).
// Works on a scratch folder (SUBSYNC_EVAL_DIR, default
// %TEMP%/aurora-agents/feat-audio-subsync) holding
//   pcm/<name>.s16    the item's audio, 8 kHz mono s16le (prep.js)
//   ref/<name>.srt    its own embedded English text track (known right)
//   ref2/<name>.srt   a second embedded English track (SDH/CC), when there is one
//   real/<name>/…     sidecars copied from the library (the real cases)
//   rows/<key>.f32    the VAD's raw rows, cached here
//   items.json        what prep.js found (kind, length, audio layout)
// Nothing here writes outside that folder; the library is only read (prep.js).
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const vad = require("../../src/media/vad");
const subsync = require("../../src/media/subsync");

const DIR = process.env.SUBSYNC_EVAL_DIR || path.join(os.tmpdir(), "aurora-agents", "feat-audio-subsync");
const p = (...a) => path.join(DIR, ...a);

const items = () => { try { return JSON.parse(fs.readFileSync(p("items.json"), "utf8")); } catch { return {}; } };
const names = () => fs.readdirSync(p("pcm")).filter((f) => f.endsWith(".s16")).map((f) => f.slice(0, -4)).sort();

const readPcm = (name) => {
  const b = fs.readFileSync(p("pcm", `${name}.s16`));
  return new Int16Array(b.buffer, b.byteOffset, Math.floor(b.length / 2));
};

const extract = (pcm) => {
  const x = vad.createExtractor();
  for (let i = 0; i < pcm.length; i += 8000 * 30) x.push(pcm.subarray(i, Math.min(pcm.length, i + 8000 * 30)));
  return x.end();
};

const readRows = (f) => {
  const b = fs.readFileSync(f);
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
};
const writeRows = (f, rows) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, Buffer.from(rows.buffer, rows.byteOffset, rows.byteLength));
};

// raw VAD rows of an item's audio (cached per vad.ROWS_V: the extractor's
// version; remade when the PCM is newer)
const rowsOf = (name) => {
  const f = p("rows", `${name}.v${vad.ROWS_V}.f32`);
  const pcmF = p("pcm", `${name}.s16`);
  try {
    if (fs.statSync(f).mtimeMs >= fs.statSync(pcmF).mtimeMs) return readRows(f);
  } catch {}
  const t0 = Date.now();
  const rows = extract(readPcm(name));
  writeRows(f, rows);
  console.error(`[rows] ${name}: ${rows.length / vad.RAW} frames in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return rows;
};

// AUDIO-side edits: the item's PCM spliced the way another release differs.
//   { kind: "cut", at, len }            this release lacks [at, at+len)
//   { kind: "insert", at, len, from }   this release has len s more at `at`
//                                       (copied from `from` s of the same audio:
//                                       a recap / a logo's music)
// Times are on the 10 ms grid. -> rows (cached under a key)
const editKey = (name, e) => `${name}~${e.kind}${e.at}_${e.len}${e.from != null ? "_" + e.from : ""}`;
const editedRows = (name, e) => {
  const key = editKey(name, e);
  const f = p("rows", "edits", `${key}.v${vad.ROWS_V}.f32`);
  try {
    if (fs.statSync(f).mtimeMs >= fs.statSync(p("pcm", `${name}.s16`)).mtimeMs) return readRows(f);
  } catch {}
  const pcm = readPcm(name);
  const R = vad.RATE;
  const a = Math.round(e.at * 100) * (R / 100);
  const L = Math.round(e.len * 100) * (R / 100);
  let out;
  if (e.kind === "cut") {
    out = new Int16Array(pcm.length - L);
    out.set(pcm.subarray(0, a), 0);
    out.set(pcm.subarray(a + L), a);
  } else {
    const s = Math.round(e.from * 100) * (R / 100);
    out = new Int16Array(pcm.length + L);
    out.set(pcm.subarray(0, a), 0);
    out.set(pcm.subarray(s, s + L), a);
    out.set(pcm.subarray(a), a + L);
  }
  const rows = extract(out);
  writeRows(f, rows);
  return rows;
};
// a time of the ORIGINAL audio -> its time in the edited audio (null: gone)
const mapThrough = (e, t) => {
  if (!e) return t;
  if (e.kind === "cut") return t < e.at ? t : t < e.at + e.len ? null : t - e.len;
  return t < e.at ? t : t + e.len;
};

// speech per VAD variant: "energy" | "band" | "hand" (legacy.js) | "model" (vad.MODEL) | a model object
// ("energy@8": the same, handed out 8 frames later — a variant's own lead
// taken out, as train-vad.js does for a fitted model)
const delayed = (p, d) => {
  if (!d) return p;
  const out = new Uint8Array(p.length);
  for (let i = 0; i < p.length; i++) out[i] = p[Math.min(p.length - 1, Math.max(0, i - d))];
  return out;
};
const speechFrom = (rows, variant = "model") => {
  if (typeof variant === "string" && variant.includes("@")) {
    const [v, d] = variant.split("@");
    return delayed(speechFrom(rows, v), +d);
  }
  if (variant === "energy") return vad.energyProb(rows);
  if (variant === "band") return vad.bandProb(rows);
  if (variant === "model") return vad.probabilities(rows);
  if (variant === "hand") return require("./legacy").probabilities(rows);
  return vad.probabilities(rows, variant);
};

const readSubs = (file) => subsync.parse(require("../../src/media/subtitles").decodeSubtitle(fs.readFileSync(file)));
const subsAt = (dir, name) => { try { const s = readSubs(p(dir, `${name}.srt`)); return s && s.length ? s : null; } catch { return null; } };
const refOf = (name) => subsAt("ref", name);
const ref2Of = (name) => subsAt("ref2", name);

// 0/1 label per 10 ms frame: a reference line is on screen
const labels = (cues, n) => {
  const y = new Uint8Array(n);
  for (const c of cues) for (let i = Math.max(0, Math.round(c.start * 100)); i < Math.min(n, Math.round(c.end * 100)); i++) y[i] = 1;
  return y;
};

// area under the ROC curve of scores (any numbers) against 0/1 labels
const auc = (score, y) => {
  const idx = Array.from(score.keys()).sort((a, b) => score[a] - score[b]);
  let pos = 0, neg = 0, rankSum = 0;
  // ties share their mean rank
  for (let r = 0; r < idx.length;) {
    let q = r;
    while (q + 1 < idx.length && score[idx[q + 1]] === score[idx[r]]) q++;
    const mid = (r + q) / 2 + 1;
    for (let k = r; k <= q; k++) if (y[idx[k]]) { pos++; rankSum += mid; } else neg++;
    r = q + 1;
  }
  return pos && neg ? (rankSum - (pos * (pos + 1)) / 2) / (pos * neg) : NaN;
};

// where a right subtitle lands against a speech timeline: the offset (s) of
// the correlation peak within ±0.6 s, its width (within 90 % of the peak), r
// — on the lines as the aligner sees them (their first LINE_CAP seconds)
const peakOf = (speech, allCues) => {
  const as = require("../../src/media/audiosync");
  const cues = as.capLines(allCues);
  const x = Float64Array.from(speech, (q) => q / 255);
  let m = 0;
  for (const q of x) m += q;
  m /= x.length;
  let nn = 0;
  for (let i = 0; i < x.length; i++) { x[i] -= m; nn += x[i] * x[i]; }
  nn = Math.sqrt(nn);
  const curve = [];
  for (let d = -60; d <= 60; d++) curve.push(as.corrAt(x, nn, cues, 1, d * 0.01));
  let best = 0;
  for (let i = 1; i < curve.length; i++) if (curve[i] > curve[best]) best = i;
  let lo = best;
  let hi = best;
  while (lo > 0 && curve[lo - 1] >= 0.9 * curve[best]) lo--;
  while (hi < curve.length - 1 && curve[hi + 1] >= 0.9 * curve[best]) hi++;
  return { off: Math.round((best - 60)) / 100, width: (hi - lo) / 100, r: curve[best] };
};

const quant = (arr, q) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN; };

module.exports = { peakOf, DIR, p, items, names, readPcm, extract, rowsOf, editedRows, editKey, mapThrough, speechFrom, readSubs, refOf, ref2Of, labels, auc, quant };
