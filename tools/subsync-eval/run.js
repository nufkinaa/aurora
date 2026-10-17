#!/usr/bin/env node
// The subtitle-sync test set (docs/qa/subtitle-sync/REPORT.md).
//
//   node tools/subsync-eval/run.js synthetic [--items a,b] [--vad energy|band|model|<model.json>] [--jobs 8] [--out name]
//   node tools/subsync-eval/run.js real [--items a,b] [--vad …]
//
// SYNTHETIC (cases.js). Each item's reference (its own embedded English
// track) is made wrong the ways a subtitle of another release is wrong —
// shifted, timed for another frame rate, with a scene more or less — and
// the reference is also aligned, untouched, to the item's audio EDITED the
// way another cut differs (40 s missing, a 30 s logo or recap more). Every
// line knows its true time, so the error is exact: per line,
// |aligned start - true start|. Controls: the reference itself and a second
// English track (must stay as they are); another film's subtitle and another
// episode's (must be refused).
//
// REAL. Sidecars copied from the library (real/<item>/<file>) against the
// item's audio. No exact truth: each line's distance to the nearest line
// START of the item's own embedded track (saturating at 10 s), and the
// systematic offset left (the median signed distance of the lines within
// 1.5 s of an English start).
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const c = require("./common");
const { casesFor } = require("./cases");
const as = require("../../src/media/audiosync");

const argv = process.argv.slice(2);
const mode = argv[0] && !argv[0].startsWith("--") ? argv[0] : "synthetic";
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const vadArg = opt("--vad", "model");
const variant = /\.json$/.test(vadArg) ? JSON.parse(fs.readFileSync(vadArg, "utf8")) : vadArg;
const jobs = +opt("--jobs", 1);
const outName = opt("--out", `${mode}-${path.basename(vadArg).replace(/\.json$/, "")}`);
const alignOpts = opt("--opts", null) ? JSON.parse(opt("--opts")) : {};
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : x);

const meta = c.items();
const all = c.names().filter((n) => c.refOf(n));
const show = (n) => (meta[n] && meta[n].kind === "ep" ? path.basename(path.dirname(path.dirname(meta[n].v))) : null); // the show folder
const pick = opt("--items", null);
const chosen = pick ? all.filter((n) => pick.split(",").some((x) => n === x || n.includes(x))) : all;

// ---------- scoring ----------
const errorsOf = (aligned, src) => {
  const e = [];
  for (const q of aligned) if (q.truth != null) e.push(Math.abs(q.start - q.truth));
  const real = src.filter((q) => q.truth != null).length;
  return {
    med: c.quant(e, 0.5), p90: c.quant(e, 0.9), within05: e.filter((x) => x <= 0.5).length / Math.max(1, e.length),
    keptFake: aligned.filter((q) => q.truth == null).length, fakes: src.filter((q) => q.truth == null).length,
    lost: real - e.length, real,
  };
};
// -> "fixed" | "mostly" | "WRONG" | "missed" | "refused" | "kept" | "touched" | "MOVED-RIGHT-FILE" | "said-unmatched" | "refused-ok" | "said-in-time" | "FALSE-ACCEPT"
const classify = (expect, res, before, after) => {
  if (expect === "refuse") return res.apply ? "FALSE-ACCEPT" : res.verdict === "unmatched" ? "refused-ok" : "said-in-time";
  if (expect === "keep") {
    if (!res.apply) return res.verdict === "unmatched" ? "said-unmatched" : "kept";
    return after.p90 <= 0.3 && after.lost <= 0.02 * after.real ? "touched" : "MOVED-RIGHT-FILE";
  }
  if (!res.apply) return res.verdict === "unmatched" ? "refused" : before.p90 <= 0.31 ? "kept" : "missed";
  const lostOk = after.lost <= Math.max(3, 0.03 * after.real);
  if (after.med <= 0.2 && after.p90 <= 0.5 && lostOk) return "fixed";
  if (after.med <= 0.5 && after.p90 <= 3 && after.lost <= 0.1 * after.real) return "mostly";
  return "WRONG";
};

const speechCache = new Map();
const speechOf = (name, edit) => {
  const k = edit ? c.editKey(name, edit) : name;
  if (!speechCache.has(k)) {
    speechCache.clear();
    speechCache.set(k, c.speechFrom(edit ? c.editedRows(name, edit) : c.rowsOf(name), variant));
  }
  return speechCache.get(k);
};

const synthetic = (names) => {
  const rows = [];
  for (const name of names) {
    const ref = c.refOf(name);
    if (!ref || ref.length < 50) continue;
    const dur = (meta[name] && meta[name].dur) || c.readPcm(name).length / 8000;
    const sh = show(name);
    // another film: the next one in the list that is not this show
    const films = all.filter((n) => n !== name && show(n) == null);
    const o = films[(all.indexOf(name) + 1) % films.length];
    const siblings = sh ? all.filter((n) => n !== name && show(n) === sh).slice(0, 2).map((n) => ({ name: n, ref: c.refOf(n) })) : [];
    const cases = casesFor({ name, ref, ref2: c.ref2Of(name), dur, other: o ? { name: o, ref: c.refOf(o) } : null, siblings, mapThrough: c.mapThrough });
    // edits grouped so each edited audio is made once
    cases.sort((a, b) => String(a.edit && c.editKey(name, a.edit)).localeCompare(String(b.edit && c.editKey(name, b.edit))));
    for (const k of cases) {
      const speech = speechOf(name, k.edit);
      const t0 = Date.now();
      const res = as.align(speech, k.cues.map((q) => ({ start: q.start, end: q.end })), alignOpts);
      const ms = Date.now() - t0;
      const applied = res.apply ? as.applyPlan(k.cues, res.plan) : k.cues;
      const before = errorsOf(k.cues, k.cues);
      const after = errorsOf(applied, k.cues);
      const cls = classify(k.expect, res, before, after);
      const row = {
        item: name, kind: (meta[name] && meta[name].kind) || "film", case: k.label, group: k.group, expect: k.expect, verdict: res.verdict, apply: !!res.apply, cls,
        parts: res.parts || 0, words: as.describe(res), r: res.r, z: res.z, conf: res.confidence, rAfter: res.rAfter, zAfter: res.zAfter, partZ: res.partZ, identityR: res.identityR,
        before: [r2(before.med), r2(before.p90)], after: [r2(after.med), r2(after.p90)], within05: r2(after.within05),
        fakesKept: `${after.keptFake}/${after.fakes}`, lost: after.lost, real: after.real, ms, why: res.why,
      };
      rows.push(row);
      console.log([name.slice(0, 22).padEnd(22), k.label.slice(0, 44).padEnd(44), String(res.verdict).padEnd(9), cls.padEnd(16), String(res.parts || "").padEnd(2), `z ${res.z} r ${res.r} c ${res.confidence}`.padEnd(26), `before ${r2(before.med)}/${r2(before.p90)}`.padEnd(20), `after ${r2(after.med)}/${r2(after.p90)}`.padEnd(20), `fake ${after.keptFake}/${after.fakes} lost ${after.lost}`, `${ms} ms`].join(" "));
    }
  }
  return rows;
};

// ---------- real ----------
const nearestSigned = (sorted, x) => {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < x) lo = m + 1; else hi = m; }
  const a = sorted[lo] - x;
  const b = lo > 0 ? sorted[lo - 1] - x : Infinity;
  return Math.abs(a) <= Math.abs(b) ? -a : -b; // positive: the line is late
};
const nearStats = (cues, refStarts) => {
  const d = cues.map((q) => nearestSigned(refStarts, q.start));
  const ad = d.map((x) => Math.min(10, Math.abs(x)));
  const close = d.filter((x) => Math.abs(x) <= 1.5);
  return { med: c.quant(ad, 0.5), p90: c.quant(ad, 0.9), within05: ad.filter((x) => x <= 0.5).length / Math.max(1, ad.length), bias: close.length > 0.2 * d.length ? c.quant(close, 0.5) : NaN };
};
const real = (names) => {
  const rows = [];
  for (const name of names) {
    const dir = c.p("real", name);
    if (!fs.existsSync(dir)) continue;
    const ref = c.refOf(name);
    const refStarts = ref.map((q) => q.start).sort((a, b) => a - b);
    const speech = speechOf(name, null);
    for (const f of fs.readdirSync(dir).sort()) {
      let cues;
      try { cues = c.readSubs(path.join(dir, f)); } catch (e) { console.log(name, f, "unreadable", e.message); continue; }
      const t0 = Date.now();
      const res = as.align(speech, cues, alignOpts);
      const ms = Date.now() - t0;
      const applied = res.apply ? as.applyPlan(cues, res.plan) : cues;
      const b = nearStats(cues, refStarts);
      const a = nearStats(applied, refStarts);
      // a sidecar of ANOTHER episode in the same folder: must be refused
      const own = meta[name] ? path.basename(meta[name].v).replace(/\.[^.]+$/, "") : name;
      const expect = f.startsWith(own) || meta[name].kind !== "ep" ? "own" : "refuse";
      rows.push({
        item: name, file: f, expect, verdict: res.verdict, apply: !!res.apply, words: as.describe(res), r: res.r, z: res.z, conf: res.confidence, rAfter: res.rAfter, zAfter: res.zAfter, partZ: res.partZ, identityR: res.identityR,
        scale: res.scale, offset: res.offset, parts: res.parts, plan: res.plan, dropped: res.dropped, total: res.total,
        before: [r2(b.med), r2(b.p90), r2(b.within05), r2(b.bias)], after: [r2(a.med), r2(a.p90), r2(a.within05), r2(a.bias)], ms,
      });
      console.log([name.slice(0, 16).padEnd(16), f.slice(-34).padEnd(34), expect.padEnd(6), String(res.verdict).padEnd(9), as.describe(res).slice(0, 44).padEnd(44), `z ${res.z} c ${res.confidence} r ${res.identityR}/${res.r}->${res.rAfter}`.padEnd(34), `near ${r2(b.med)}/${r2(b.p90)} bias ${r2(b.bias)}`.padEnd(26), `-> ${r2(a.med)}/${r2(a.p90)} bias ${r2(a.bias)}`.padEnd(26), `${ms} ms`].join(" "));
    }
  }
  return rows;
};

const runChildren = async (names) => {
  const todo = [...names];
  const rows = [];
  const one = (n) => new Promise((resolve) => {
    const args = [__filename, mode, "--items", n, "--vad", vadArg, "--out", `${outName}.part.${n}`];
    if (opt("--opts")) args.push("--opts", opt("--opts"));
    const ch = spawn(process.execPath, args, { stdio: ["ignore", "inherit", "inherit"] });
    ch.on("close", () => {
      try { rows.push(...JSON.parse(fs.readFileSync(c.p("results", `${outName}.part.${n}.json`), "utf8"))); fs.unlinkSync(c.p("results", `${outName}.part.${n}.json`)); } catch {}
      resolve();
    });
  });
  await Promise.all(Array.from({ length: Math.min(jobs, names.length) }, async () => { while (todo.length) await one(todo.shift()); }));
  return rows;
};

(async () => {
  const rows = jobs > 1 && chosen.length > 1 ? await runChildren(chosen) : mode === "real" ? real(chosen) : synthetic(chosen);
  fs.mkdirSync(c.p("results"), { recursive: true });
  fs.writeFileSync(c.p("results", `${outName}.json`), JSON.stringify(rows, null, 1));
  if (jobs > 1 || mode === "synthetic") {
    const tally = {};
    for (const r of rows) tally[r.cls || r.verdict] = (tally[r.cls || r.verdict] || 0) + 1;
    console.log(`\n${rows.length} cases:`, JSON.stringify(tally));
  }
})();
