#!/usr/bin/env node
// The capacity tables from tools/loadtest/capacity.js results: each run's
// steps, the knee of each run, and how many streams fit a given upload.
//
//   node tools/loadtest/capacity-report.js docs/qa/capacity-2026-10/results/*.json [--uploads 20,50,100,500,1000] [--headroom 0.8]
//
// Knee = the largest step that was supported, with every smaller step but at
// most one supported too ("one miss" is noted: a single slow start on a shared
// PC). "No torrent TTFF": the same with torrent viewers' start left out of the
// TTFF rule (a torrent's first frame is mostly its swarm's), all else equal.
"use strict";
const fs = require("fs");
const path = require("path");
const { parseArgs, round } = require("./lib");
const { RULE } = require("./capacity");

const a = parseArgs();
const files = a._.filter((f) => f.endsWith(".json"));
const uploads = String(a.uploads || "20,50,100,500,1000").split(",").map(Number);
const headroom = Number(a.headroom) || 0.8;

const runs = files.map((f) => ({ file: path.basename(f, ".json"), ...JSON.parse(fs.readFileSync(f, "utf8")) })).filter((r) => r.steps && r.steps.length);

// the verdict again, with torrent starts left out of the TTFF rule
const noTorrentOk = (s) => {
  const why = s.verdict.why.filter((w) => !/^burst TTFF/.test(w));
  const each = s.burst.each || null;
  let p95;
  if (each) {
    const xs = each.filter((e) => !/torrent|tjit/.test(e.kind)).map((e) => e.ttff);
    if (xs.some((x) => x == null)) p95 = Infinity;
    else { const sx = xs.sort((x, y) => x - y); p95 = sx.length ? sx[Math.min(sx.length - 1, Math.ceil(0.95 * sx.length) - 1)] : 0; }
  } else {
    // (older runs kept only per-kind summaries: the slowest non-torrent kind's max, which is ≥ its p95)
    p95 = Math.max(0, ...Object.entries(s.burst.byKind || {}).filter(([k]) => !/torrent|tjit/.test(k)).map(([, v]) => (v.max == null ? Infinity : v.max)));
  }
  return why.length === 0 && p95 <= RULE.ttffP95Ms;
};
const knee = (steps, ok) => {
  let k = 0, misses = 0, missAt = [];
  for (const s of steps) {
    if (ok(s)) { k = s.n; continue; }
    misses++; missAt.push(s.n);
    if (misses > 1) break;
  }
  // a miss AFTER the last supported step is the end, not a "miss"
  const real = missAt.filter((n) => n < k);
  const firstBad = steps.find((s) => s.n > k && !ok(s));
  return { knee: k, oneMissAt: real[0] || null, firstBad: firstBad ? firstBad.n : null, why: firstBad ? firstBad.verdict.why : [], maxTried: Math.max(...steps.map((s) => s.n)) };
};

const out = [];
out.push("## Knees\n");
out.push("| run | mix | ref | PC busy before | knee | first step not supported (why) | knee, torrent starts not in the TTFF rule | largest step |");
out.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const r of runs) {
  const k = knee(r.steps, (s) => s.verdict.ok);
  const k2 = knee(r.steps, noTorrentOk);
  const pc = r.meta.pcBefore ? `${r.meta.pcBefore.cpuPctMean} %` : "";
  out.push(`| ${r.file} | ${r.meta.mix} | ${r.meta.ref} | ${pc} | **${k.knee}**${k.oneMissAt ? ` (missed once at ${k.oneMissAt})` : ""} | ${k.firstBad == null ? "none" : `${k.firstBad}: ${k.why.join("; ")}`} | ${k2.knee}${k2.oneMissAt ? ` (missed once at ${k2.oneMissAt})` : ""} | ${k.maxTried} |`);
}

out.push("\n## Steps\n");
for (const r of runs) {
  out.push(`### ${r.file} — ${r.meta.mix}, ${r.meta.ref}, threadpool ${r.meta.uvThreadpool || 4}, links ${r.meta.link || "off"}\n`);
  out.push("| viewers | browsing | burst TTFF p50/p95/max ms | slowest start | burst API p99 ms | burst loop lag max ms | burst server + ffmpeg cores | burst disk busy % (write MB/s) | late seg % | stall % | API p95/p99 ms | lag p99 ms | server + ffmpeg cores | encodes (on card) | GPU enc % | RSS MB (+ffmpeg) | egress Mbit/s | Mbit/s per viewer | refused | supported |");
  out.push(`| ${Array(20).fill("---").join(" | ")} |`);
  for (const s of r.steps) {
    const b = s.burst, w = s.window;
    const slow = Object.entries(b.byKind || {}).sort((x, y) => (y[1].max || 0) - (x[1].max || 0))[0];
    const bd = b.disk ? `${b.disk.busyPctMean} (${b.disk.writeMBsMean})` : "";
    out.push(`| ${s.n} | ${s.browsing} | ${b.ttffP50}/${b.ttffP95}/${b.ttffMax} | ${slow ? `${slow[0]} ${slow[1].max}` : ""} | ${b.apiP99} | ${b.lag ? b.lag.max : ""} | ${b.tree ? `${b.tree.serverCores} + ${b.tree.kidsCores}` : ""} | ${bd} | ${w.lateSegPct} | ${w.stallPct} | ${w.apiP95}/${w.apiP99} | ${w.lagP99} | ${w.serverCores} + ${w.ffmpegCores} | ${w.encodes ? `${w.encodes.activeMax} (${w.encodes.hwSessionsMax})` : ""} | ${w.gpu ? w.gpu.encPctMean : ""} | ${w.rssMb} (+${w.ffmpegRssMb}) | ${w.egressMbit} | ${w.mbitPerViewer} | ${b.neverStarted + b.refused + w.refused + w.neverStarted + w.s429 + b.s429} | ${s.verdict.ok ? "yes" : `no: ${s.verdict.why.join("; ")}`} |`);
  }
  out.push("");
}

// bandwidth: what each mix's viewers pull on average once their buffers are full (the files' own bitrates)
out.push("## Bandwidth\n");
const mixes = [...new Set(runs.map((r) => r.meta.mix))];
const fileMbit = {};
for (const m of mixes) {
  const r = runs.find((x) => x.meta.mix === m && x.meta.titles);
  const titles = r ? r.meta.titles : [];
  // the mix's paths decide which titles are played: average over the pools by the cycle's kinds
  const cycle = r ? r.meta.cycle : [];
  const avg = (xs) => (xs.length ? xs.reduce((p, q) => p + q, 0) / xs.length : null);
  const pick = (kind) => {
    const [form, how] = kind.split("-");
    const t = titles.filter((x) => (how === "direct" ? (form === "tv" ? x.tv === "direct" : x.web === "direct") : how === "offset" ? x.tv !== "direct" : how === "jit" ? x.web !== "direct" : how === "transcode" ? !/Heavy/.test(x.title) : /Release Aac/.test(x.title)));
X
    return avg(t.map((x) => x.mbit));
  };
  fileMbit[m] = round(avg(cycle.map(pick).filter((x) => x != null)), 2);
}
const measured = {};
for (const m of mixes) {
  const ws = runs.filter((r) => r.meta.mix === m).flatMap((r) => r.steps.map((s) => s.window)).filter((w) => w.viewers >= 10 && w.egressMbit > 0);
  measured[m] = ws.length ? round(ws.reduce((x, w) => x + w.egressMbit, 0) / ws.reduce((x, w) => x + w.viewers, 0), 2) : null;
}
out.push(`Per viewer: the files' own bitrate averaged over each mix (${mixes.map((m) => `${m} ${fileMbit[m]} Mbit/s`).join(", ")}); measured over the windows, read-ahead included: ${mixes.map((m) => `${m} ${measured[m]}`).join(", ")}. Streams that fit, at ${Math.round(headroom * 100)} % of the upload:\n`);
const cols = [...mixes.map((m) => `${m} (${fileMbit[m]} Mbit/s)`), "house p90 file (4.2)", "Blu-ray-class (8)", "4K remux (25)"];
out.push(`| upload Mbit/s | ${cols.join(" | ")} |`);
out.push(`| --- | ${cols.map(() => "---").join(" | ")} |`);
for (const u of uploads) {
  const vals = [...mixes.map((m) => (fileMbit[m] ? Math.floor((u * headroom) / fileMbit[m]) : "")), ...[4.2, 8, 25].map((x) => Math.floor((u * headroom) / x))];
  out.push(`| ${u} | ${vals.join(" | ")} |`);
}
process.stdout.write(out.join("\n") + "\n");
