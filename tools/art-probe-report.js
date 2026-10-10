#!/usr/bin/env node
// LAB — reads the AuroraArt logcat lines of the two arms of the art-format
// experiment (docs/qa/native-bench/ART-FORMAT-PLAN.md) and prints them side by
// side, with the plan's pass/fail verdict.
//
//   node tools/art-probe-report.js <dir>            # <dir>/jpeg-*.log and <dir>/webp-*.log
//   node tools/art-probe-report.js a.log b.log      # explicit: baseline, experiment
//
// The lines come from tv-native/android/.../ui/art/ArtProbe.kt:
//   AuroraArt: done kind=hero-b1 fmt=WEBP_SIMPLE bytes=38112 fetchMs=41 decodeMs=23 bitmap=1280x720 totalMs=71 prefetch=0 id=17 url=…
//   AuroraArt: stage kind=backdrop p=ResizeAndRotateProducer ms=88 … id=17
"use strict";
const fs = require("fs");
const path = require("path");

// The plan's limits (§5). Decode: the experiment's median CPU work per picture
// ("work" = the decode plus any on-box re-encode before it) may be at most this
// many ms more than the baseline's; bytes: it must save at least this share.
const LIMITS = {
  "hero-b1": { decodeMs: 15, saved: 0.5 },
  "hero-b2": { decodeMs: 15, saved: 0.5 },
  backdrop: { decodeMs: 25, saved: 0.4 },
};

const median = (a) => {
  const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};
const p90 = (a) => {
  const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.9))] : NaN;
};

const parse = (files) => {
  const kinds = {};
  const stages = {}; // request id -> ms spent re-encoding on the box (ResizeAndRotateProducer)
  let flags = "";
  for (const f of files) {
    const run = {}; // per file: request ids restart with the process
    for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
      const at = line.indexOf("AuroraArt");
      if (at < 0) continue;
      const body = line.slice(at);
      const kv = {};
      for (const m of body.matchAll(/(\w+)=(\S+)/g)) if (!(m[1] in kv)) kv[m[1]] = m[2];
      if (/\bflags\b/.test(body)) flags = `webp=${kv.webp} probe=${kv.probe} server=${kv.server}`;
      else if (/\bstage\b/.test(body) && kv.p === "ResizeAndRotateProducer") run[kv.id] = (run[kv.id] || 0) + Number(kv.ms);
      else if (/\bdone\b/.test(body) && kv.kind) {
        const k = (kinds[kv.kind] = kinds[kv.kind] || { n: 0, cached: 0, decode: [], work: [], bytes: [], total: [], fetch: [], fmt: new Set(), bitmap: new Set() });
        k.n++;
        const d = Number(kv.decodeMs);
        if (d >= 0) {
          k.decode.push(d);
          k.work.push(d + (run[kv.id] || 0));
        }
        else k.cached++; // straight from the decoded-bitmap cache: nothing to time
        if (Number(kv.bytes) > 0) k.bytes.push(Number(kv.bytes));
        if (Number(kv.fetchMs) >= 0) k.fetch.push(Number(kv.fetchMs));
        k.total.push(Number(kv.totalMs));
        if (kv.fmt && kv.fmt !== "-") k.fmt.add(kv.fmt);
        if (kv.bitmap && kv.bitmap !== "-") k.bitmap.add(kv.bitmap);
      }
    }
    for (const id of Object.keys(run)) stages[`${f}#${id}`] = run[id];
  }
  return { kinds, resize: Object.values(stages), flags };
};

const args = process.argv.slice(2);
let base = [];
let exp = [];
if (args.length === 1 && fs.existsSync(args[0]) && fs.statSync(args[0]).isDirectory()) {
  const all = fs.readdirSync(args[0]).filter((f) => f.endsWith(".log")).map((f) => path.join(args[0], f));
  base = all.filter((f) => path.basename(f).startsWith("jpeg"));
  exp = all.filter((f) => path.basename(f).startsWith("webp"));
} else if (args.length === 2) {
  base = [args[0]];
  exp = [args[1]];
}
if (!base.length || !exp.length) {
  console.error("usage: art-probe-report.js <dir with jpeg-*.log and webp-*.log> | <baseline.log> <experiment.log>");
  process.exit(2);
}
const A = parse(base);
const B = parse(exp);
console.log(`baseline   (${base.length} log${base.length > 1 ? "s" : ""}): ${A.flags || "no flags line"}`);
console.log(`experiment (${exp.length} log${exp.length > 1 ? "s" : ""}): ${B.flags || "no flags line"}`);
if (/webp=1/.test(A.flags) || !/webp=1/.test(B.flags)) console.log("WARNING: the flags lines do not say baseline webp=0 / experiment webp=1 — check the arms");

const fmt = (x, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : "-");
const rows = [];
let fail = 0;
for (const kind of [...new Set([...Object.keys(A.kinds), ...Object.keys(B.kinds)])].sort()) {
  const a = A.kinds[kind];
  const b = B.kinds[kind];
  const one = (name, k) =>
    k && [
      `${kind} ${name}`,
      k.n,
      k.cached,
      [...k.fmt].join("/") || "-",
      [...k.bitmap].slice(0, 2).join("/") || "-",
      fmt(median(k.bytes) / 1024, 1),
      fmt(median(k.decode)),
      fmt(p90(k.decode)),
      fmt(median(k.work)),
      fmt(median(k.fetch)),
      fmt(median(k.total)),
    ];
  if (a) rows.push(one("baseline", a));
  if (b) rows.push(one("experiment", b));
  if (a && b) {
    const lim = LIMITS[kind] || { decodeMs: 15, saved: 0.5 };
    const dDec = median(b.work) - median(a.work);
    const saved = 1 - median(b.bytes) / median(a.bytes);
    const decOk = Number.isFinite(dDec) ? dDec <= lim.decodeMs : null;
    const bytesOk = Number.isFinite(saved) ? saved >= lim.saved : null;
    if (decOk === false || bytesOk === false) fail++;
    const say = (ok) => (ok === null ? "NO DATA" : ok ? "pass" : "FAIL");
    rows.push([
      `${kind} verdict`,
      "",
      "",
      "",
      "",
      Number.isFinite(saved) ? `${(saved * 100).toFixed(0)}% saved: ${say(bytesOk)} (>= ${lim.saved * 100}%)` : "bytes: NO DATA (disk cache? clear it)",
      "",
      "",
      Number.isFinite(dDec) ? `${dDec >= 0 ? "+" : ""}${dDec.toFixed(0)} ms: ${say(decOk)} (<= +${lim.decodeMs})` : "work: NO DATA",
      "",
      "",
    ]);
  }
}
const cols = ["kind / arm", "n", "mem-cached", "format", "bitmap", "KB med", "decode ms med", "decode p90", "work ms med", "fetch ms med", "total ms med"];
const w = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => String(r[i]).length)));
const line = (r) => r.map((v, i) => String(v).padEnd(w[i])).join("  ");
console.log(`\n${line(cols)}\n${w.map((n) => "-".repeat(n)).join("  ")}`);
rows.forEach((r) => console.log(line(r)));
// The title page's original JPEG is re-encoded on the box before it is decoded
// (resizeMethod="resize" → Fresco's ResizeAndRotateProducer); a WebP skips that.
console.log(
  `\non-box re-encode (ResizeAndRotateProducer), ms per picture — baseline: median ${fmt(median(A.resize))} over ${A.resize.length}; experiment: median ${fmt(median(B.resize))} over ${B.resize.length}`,
);
console.log(fail ? `\n${fail} kind(s) FAIL the plan's limits` : "\nno kind fails the plan's numeric limits (the screenshots still decide \"no visible difference\")");
process.exit(fail ? 1 : 0);
