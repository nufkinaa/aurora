#!/usr/bin/env node
// A spot check by eye: for a few lines of a subtitle that start after a
// pause, the speech-band loudness of the audio around the line's start
// (from the raw rows: not the model's opinion), with where the line starts
// as it was ("o") and as the sync puts it ("a"), and the nearest line start
// of the item's own English track ("e").
//   node tools/subsync-eval/spot.js <item> <subtitle file under real/<item>/> [lines=8]
// One character = 50 ms, from 1.5 s before to 1.5 s after the aligned start.
"use strict";
const path = require("path");
const c = require("./common");
const vad = require("../../src/media/vad");
const as = require("../../src/media/audiosync");

const [item, file, nArg] = process.argv.slice(2);
const N = +(nArg || 8);
const rows = c.rowsOf(item);
const n = rows.length / vad.RAW;
// speech band level (200-2500 Hz), dB-ish, per 10 ms
const S = new Float32Array(n);
for (let i = 0; i < n; i++) {
  const o = i * vad.RAW;
  S[i] = 10 * Math.log10(Math.pow(10, rows[o + 2]) + Math.pow(10, rows[o + 3]) + Math.pow(10, rows[o + 4]) + Math.pow(10, rows[o + 5]) + 1e-3);
}
const cues = c.readSubs(path.join(c.p("real", item), file)).sort((x, y) => x.start - y.start);
const res = as.align(c.speechFrom(rows), cues);
const moved = res.apply ? as.applyPlan(cues, res.plan) : cues;
const eng = c.refOf(item).map((q) => q.start).sort((x, y) => x - y);
const nearestEng = (t) => eng.reduce((b, x) => (Math.abs(x - t) < Math.abs(b - t) ? x : b), Infinity);
console.log(`${item} / ${file}: ${as.describe(res)} (z ${res.z}, confidence ${res.confidence})`);
// lines after a pause of 1.5 s (in the moved list), spread over the film
const map = new Map(moved.map((q) => [q, q]));
void map;
const isolated = [];
for (let i = 1; i < moved.length; i++) if (moved[i].start - moved[i - 1].end >= 1.5) isolated.push(i);
const pick = Array.from({ length: Math.min(N, isolated.length) }, (_, k) => isolated[Math.floor(((k + 0.5) * isolated.length) / N)]);
const glyph = " .:-=+*#%@";
for (const i of pick) {
  const a = moved[i].start;
  // the same line as it was (by text, else by index)
  const orig = cues.find((q) => q.text === moved[i].text && Math.abs(q.start - a) < 120) || cues[i];
  const lo = Math.round((a - 1.5) * 100);
  const strip = [];
  let mn = Infinity;
  let mx = -Infinity;
  for (let k = lo; k < lo + 300; k += 5) { let v = -Infinity; for (let j = k; j < k + 5; j++) v = Math.max(v, S[j] || -30); strip.push(v); mn = Math.min(mn, v); mx = Math.max(mx, v); }
  const bar = strip.map((v) => glyph[Math.max(0, Math.min(9, Math.floor(((v - mn) / Math.max(1, mx - mn)) * 9.99)))]).join("");
  const mark = new Array(60).fill(" ");
  const put = (t, ch) => { const k = Math.round((t - (a - 1.5)) * 20); if (k >= 0 && k < 60) mark[k] = mark[k] === " " ? ch : "*"; };
  put(orig.start, "o");
  put(nearestEng(a), "e");
  put(a, "a");
  const text = String(moved[i].text || "").replace(/\s+/g, " ").slice(0, 40);
  console.log(`\n${a.toFixed(2).padStart(8)} s  ${text}`);
  console.log(`  |${bar}|`);
  console.log(`  |${mark.join("")}|  o ${(orig.start - a >= 0 ? "+" : "") + (orig.start - a).toFixed(2)}  e ${(nearestEng(a) - a >= 0 ? "+" : "") + (nearestEng(a) - a).toFixed(2)}`);
}
