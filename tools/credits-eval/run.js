#!/usr/bin/env node
// Measures the credits picture (src/media/creditscv.js) against hand labels,
// and — given the server's data/intro-auto.json — what the player used before
// and what it uses now (introdetect chooseCredits). Read-only on the media.
//
//   node tools/credits-eval/run.js --labels labels.json [--store data/intro-auto.json] [--cache <dir>]
//
// labels.json (kept OUT of the repo: it names a household's library):
//   { "<library id>": { "path": "E:/…/Show S01E01.mkv", "t": 2975.0, "name": "Show A S01E01",
//                       "duration": 3046.1, "film": false }, … }
//   t = the hand-labelled credits start: the first frame of the credits, or
//   of the cut / fade to black that opens them (sampled frames, 0.5 s).
//
// The decode of each tail is cached in --cache (default: a temp folder) as the
// detector's own per-row numbers, so re-tuning the rules re-reads nothing.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const config = require("../../src/config");
const cv = require("../../src/media/creditscv");
const { chooseCredits } = require("../../src/media/introdetect")._internals;

const arg = (name, dflt = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const labelsFile = arg("labels");
if (!labelsFile) { console.error("usage: run.js --labels labels.json [--store intro-auto.json] [--cache dir]"); process.exit(2); }
const labels = JSON.parse(fs.readFileSync(labelsFile, "utf-8"));
const store = arg("store") ? JSON.parse(fs.readFileSync(arg("store"), "utf-8")) : {};
const cacheDir = arg("cache", path.join(os.tmpdir(), "aurora-credits-eval"));
fs.mkdirSync(cacheDir, { recursive: true });

const KEYS = ["dark", "edges", "flat", "bright", "left", "right"];
const enc = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64");
const dec = (b, T) => { const B = Buffer.from(b, "base64"); return new T(B.buffer.slice(B.byteOffset, B.byteOffset + B.byteLength)); };

const samplesFor = async (id, l) => {
  const file = path.join(cacheDir, `${id}.json`);
  if (fs.existsSync(file)) {
    const j = JSON.parse(fs.readFileSync(file, "utf-8"));
    return j.samples.map((s) => ({ t: s.t, ...Object.fromEntries(KEYS.map((k) => [k, dec(s[k], Uint16Array)])), coarse: dec(s.coarse, Uint8Array) }));
  }
  const win = cv.tailWindow(l.duration);
  const started = Date.now();
  const r = await cv.sample(l.path, win.from, win.length, { ffmpeg: config.FFMPEG, lower: (c) => { try { os.setPriority(c.pid, os.constants.priority.PRIORITY_LOW); } catch {} } });
  if (!r.complete) throw new Error(`${l.name}: the decode did not finish`);
  fs.writeFileSync(file, JSON.stringify({ id, window: win, wallMs: Date.now() - started, samples: r.samples.map((s) => ({ t: s.t, ...Object.fromEntries(KEYS.map((k) => [k, enc(s[k])])), coarse: enc(s.coarse) })) }));
  return r.samples;
};

const upNextWindow = (d) => Math.max(30, Math.min(90, d * 0.05)); // the player's guess without a credits time
const err = (x, t) => (x == null ? null : Math.round((x - t) * 10) / 10);
const stats = (xs) => {
  const a = xs.filter((x) => x != null).map(Math.abs).sort((p, q) => p - q);
  if (!a.length) return null;
  return { n: a.length, median: a[a.length >> 1], p90: a[Math.min(a.length - 1, Math.ceil(0.9 * a.length) - 1)], max: a[a.length - 1], within2: a.filter((x) => x <= 2).length };
};

(async () => {
  const rows = [];
  for (const [id, l] of Object.entries(labels)) {
    const samples = await samplesFor(id, l);
    const est = cv.estimate(cv.features(samples), l.duration);
    const r = store[id] || null;
    const own = r && r.credits ? r.credits.start : null;
    const db = r && r.db && r.db.credits ? r.db.credits.start : null;
    const before = l.film ? null : (own != null ? own : db != null ? db : l.duration - upNextWindow(l.duration));
    const rec = { ...(r || { credits: null, source: null }), cv: est ? { start: est.start, confidence: est.confidence } : null };
    const pick = l.film ? null : chooseCredits(rec);
    const after = l.film ? null : (pick ? pick.start : l.duration - upNextWindow(l.duration));
    rows.push({ name: l.name, film: !!l.film, label: l.t, cv: est && est.start, conf: est && est.confidence, cvErr: err(est && est.start, l.t), before, beforeErr: err(before, l.t), after, afterErr: err(after, l.t), afterSource: pick ? pick.source : l.film ? "-" : "guess" });
  }
  console.table(rows);
  const eps = rows.filter((r) => !r.film);
  console.log(JSON.stringify({
    "cv, all": stats(rows.map((r) => r.cvErr)),
    "cv, episodes": stats(eps.map((r) => r.cvErr)),
    "player before, episodes": stats(eps.map((r) => r.beforeErr)),
    "player after, episodes": stats(eps.map((r) => r.afterErr)),
  }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
