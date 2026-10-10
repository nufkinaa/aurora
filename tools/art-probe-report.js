#!/usr/bin/env node
// LAB — reads the AuroraArt logcat lines of the two arms of the art-format experiment
// (docs/qa/native-bench/ART-FORMAT-PLAN.md) and prints them side by side, with the plan's
// pass/fail verdict.
//
//   node tools/art-probe-report.js <dir>            # <dir>/jpeg-*.log and <dir>/webp-*.log
//   node tools/art-probe-report.js <dir> --images   # + one line per picture per run
//
// A log whose name has "warm" in it is a warm-disk-cache pass: its numbers are kept apart
// (no network in them), its bytes come from the disk cache's own count.
//
// The lines come from tv-native/android/.../ui/art/ArtProbe.kt:
//   AuroraArt: done kind=hero-b1 fmt=WEBP_SIMPLE bytes=38112 fetchMs=41 decodeMs=23 decodeCpuMs=20.1 bitmap=1280x720 totalMs=71 prefetch=0 id=17 url=…
//   AuroraArt: stage kind=backdrop p=ResizeAndRotateProducer ms=88 … id=17
//   AuroraArt: stage kind=hero-b1 p=DiskCacheProducer ms=3 encodedImageSize=138792 cached_value_found=true id=41
"use strict";
const fs = require("fs");
const path = require("path");

// The plan's limits (§5): hero — the decode alone; backdrop — "work" = the decode plus the
// on-box re-encode before it (ResizeAndRotateProducer). The experiment's median may be at
// most `ms` more than the baseline's (hero p90: twice that); bytes at least `saved` smaller;
// the backdrop's median total (request → bitmap) not higher.
const LIMITS = {
  "hero-b1": { ms: 15, saved: 0.5, on: "decode" },
  "hero-b2": { ms: 15, saved: 0.5, on: "decode" },
  backdrop: { ms: 25, saved: 0.4, on: "work" },
};
const sorted = (a) => a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
const median = (a) => {
  const s = sorted(a);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};
const p90 = (a) => {
  const s = sorted(a);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.9))] : NaN;
};
const titleOf = (url) => (decodeURIComponent(url).match(/tt\d+/) || ["?"])[0];

// one record per "done" line
const parse = (files) => {
  const out = [];
  let flags = "";
  for (const f of files) {
    const run = path.basename(f, ".log");
    const warm = /warm/.test(run);
    const resize = {}; // request id -> ms in ResizeAndRotateProducer
    const disk = {}; // request id -> bytes the disk cache handed over
    let first = true; // the launch's first picture decodes while the app is still starting
    for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
      const at = line.indexOf("AuroraArt");
      if (at < 0) continue;
      const body = line.slice(at);
      const kv = {};
      for (const m of body.matchAll(/(\w+)=(\S+)/g)) if (!(m[1] in kv)) kv[m[1]] = m[2];
      // the request id is the line's LAST id= (the re-encode's extras carry "Transcoder id=…" before it)
      const rid = body.match(/ id=(\S+)\s*$/) || body.match(/ id=(\S+) url=/);
      if (rid) kv.id = rid[1];
      if (/\bflags\b/.test(body)) flags = "webp=" + kv.webp + " probe=" + kv.probe;
      else if (/\bstage\b/.test(body)) {
        if (kv.p === "ResizeAndRotateProducer") resize[kv.id] = (resize[kv.id] || 0) + Number(kv.ms);
        if (kv.p === "DiskCacheProducer" && kv.encodedImageSize) disk[kv.id] = Number(kv.encodedImageSize);
      } else if (/\bdone\b/.test(body) && kv.kind) {
        const d = Number(kv.decodeMs);
        const net = Number(kv.bytes);
        out.push({
          run, warm, kind: kv.kind, title: titleOf(kv.url || ""), fmt: kv.fmt, bitmap: kv.bitmap, startup: first,
          bytes: net > 0 ? net : disk[kv.id] || NaN,
          fetch: Number(kv.fetchMs) >= 0 ? Number(kv.fetchMs) : NaN,
          decode: d >= 0 ? d : NaN,
          cpu: Number(kv.decodeCpuMs) >= 0 ? Number(kv.decodeCpuMs) : NaN,
          resize: resize[kv.id] || 0,
          work: d >= 0 ? d + (resize[kv.id] || 0) : NaN,
          total: Number(kv.totalMs),
        });
        first = false;
      }
    }
  }
  return { recs: out, flags };
};

const args = process.argv.slice(2);
const images = args.includes("--images");
const dir = args.find((a) => !a.startsWith("--"));
if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
  console.error("usage: art-probe-report.js <dir with jpeg-*.log and webp-*.log> [--images]");
  process.exit(2);
}
const all = fs.readdirSync(dir).filter((f) => f.endsWith(".log")).sort().map((f) => path.join(dir, f));
const base = all.filter((f) => path.basename(f).startsWith("jpeg"));
const exp = all.filter((f) => path.basename(f).startsWith("webp"));
if (!base.length || !exp.length) {
  console.error("need jpeg-*.log and webp-*.log in " + dir);
  process.exit(2);
}
const A = parse(base);
const B = parse(exp);
console.log("baseline   (" + base.length + " logs): " + (A.flags || "no flags line"));
console.log("experiment (" + exp.length + " logs): " + (B.flags || "no flags line"));
if (/webp=1/.test(A.flags) || !/webp=1/.test(B.flags)) console.log("WARNING: the flags lines do not say baseline webp=0 / experiment webp=1 — check the arms");

const fmt = (x, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : "-");
const table = (cols, rows) => {
  const w = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => "| " + r.map((v, i) => String(v).padEnd(w[i])).join(" | ") + " |";
  console.log("\n" + line(cols) + "\n| " + w.map((n) => "-".repeat(n)).join(" | ") + " |");
  rows.forEach((r) => console.log(line(r)));
};

if (images) {
  const rows = [];
  for (const P of [A, B])
    for (const r of P.recs)
      rows.push([r.kind, r.title, r.run, r.fmt, r.bitmap, fmt(r.bytes / 1024, 1), fmt(r.fetch), fmt(r.resize), fmt(r.decode), fmt(r.cpu, 1), fmt(r.work), fmt(r.total), r.startup ? "startup" : ""]);
  rows.sort((a, b) => (a[0] + a[1] + a[2] < b[0] + b[1] + b[2] ? -1 : 1));
  table(["kind", "title", "run", "format", "bitmap", "KB", "fetch ms", "re-encode ms", "decode ms", "decode cpu ms", "work ms", "total ms", ""], rows);
}

// The launch's first hero picture is left out of the timing medians (it decodes while the
// app is starting: 100–300 ms of wall time for ~20 ms of CPU, in both arms); its bytes count.
const timing = (rs) => rs.filter((r) => !r.startup);
let fail = 0;
const rows = [];
const verdicts = [];
for (const kind of ["hero-b1", "hero-b2", "backdrop"]) {
  const lim = LIMITS[kind];
  const stat = {};
  for (const [arm, P] of [["jpeg", A], ["webp", B]]) {
    for (const warm of [false, true]) {
      const rs = P.recs.filter((r) => r.kind === kind && r.warm === warm);
      if (!rs.length) continue;
      const t = timing(rs);
      const s = {
        n: rs.length, kb: median(rs.map((r) => r.bytes)) / 1024, decode: median(t.map((r) => r.decode)), dp90: p90(t.map((r) => r.decode)),
        cpu: median(t.map((r) => r.cpu)), resize: median(t.map((r) => r.resize)), work: median(t.map((r) => r.work)), wp90: p90(t.map((r) => r.work)),
        fetch: median(t.map((r) => r.fetch)), total: median(t.map((r) => r.total)),
      };
      stat[arm + (warm ? "W" : "C")] = s;
      rows.push([kind, arm, warm ? "warm disk" : "cold", s.n, [...new Set(rs.map((r) => r.bitmap))].join("/"), fmt(s.kb, 1), fmt(s.fetch), fmt(s.resize), fmt(s.decode), fmt(s.dp90), fmt(s.cpu, 1), fmt(s.work), fmt(s.wp90), fmt(s.total)]);
    }
  }
  const a = stat.jpegC;
  const b = stat.webpC;
  if (a && b) {
    const saved = 1 - b.kb / a.kb;
    const d = b[lim.on] - a[lim.on];
    const dp = lim.on === "work" ? b.wp90 - a.wp90 : b.dp90 - a.dp90;
    const ok1 = saved >= lim.saved;
    const ok2 = d <= lim.ms;
    const ok3 = kind === "backdrop" ? b.total <= a.total : dp <= 2 * lim.ms;
    if (!ok1 || !ok2 || !ok3) fail++;
    const sign = (x) => (x >= 0 ? "+" : "") + x.toFixed(0);
    verdicts.push(
      kind + ": bytes " + (saved * 100).toFixed(0) + "% saved (>= " + lim.saved * 100 + "%) " + (ok1 ? "pass" : "FAIL") +
        "; median " + lim.on + " " + sign(d) + " ms (<= +" + lim.ms + ") " + (ok2 ? "pass" : "FAIL") + "; " +
        (kind === "backdrop"
          ? "median total " + fmt(b.total) + " vs " + fmt(a.total) + " ms (not higher) " + (ok3 ? "pass" : "FAIL")
          : "p90 decode " + sign(dp) + " ms (<= +" + 2 * lim.ms + ") " + (ok3 ? "pass" : "FAIL")),
    );
  }
}
table(["kind", "arm", "cache", "n", "bitmap", "KB med", "fetch ms", "re-encode ms", "decode ms", "decode p90", "decode cpu ms", "work ms", "work p90", "total ms"], rows);
console.log("\n(medians; timings without each launch's first picture; work = re-encode + decode; total = request -> bitmap, network included)\n");
verdicts.forEach((v) => console.log(v));
console.log(fail ? "\n" + fail + " kind(s) FAIL the plan's limits" : "\nno kind fails the plan's numeric limits (the screenshots still decide \"no visible difference\")");
process.exit(fail ? 1 : 0);
