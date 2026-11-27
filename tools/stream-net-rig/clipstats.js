#!/usr/bin/env node
// The shape of a file's bitrate, read off its packets (ffprobe): average,
// the busiest window of 2 / 6 / 10 / 30 / 60 s (video + audio bytes), and how
// far apart its keyframes are. A single-bitrate stream stalls when the line is
// below the busiest window it has to cross, not below the average.
//   node tools/stream-net-rig/clipstats.js <file> [<file> ...] [--json] [--limit <seconds>]
"use strict";
const { execFileSync } = require("child_process");
const files = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--limit");
const asJson = process.argv.includes("--json");
const li = process.argv.indexOf("--limit");
const LIMIT = li > 0 ? Number(process.argv[li + 1]) : 0; // read only the first N seconds
const stats = (file) => {
  const out = execFileSync("ffprobe", ["-v", "error", ...(LIMIT ? ["-read_intervals", `%+${LIMIT}`] : []), "-show_entries", "packet=stream_index,pts_time,dts_time,size,flags", "-of", "csv=p=0", file], { encoding: "utf8", maxBuffer: 1 << 30 });
  const vIdx = Number(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=index", "-of", "csv=p=0", file], { encoding: "utf8" }).trim());
  const pk = [];
  const keys = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line) continue;
    const [si, pts, dts, size, flags] = line.split(",");
    const t = parseFloat(dts !== "N/A" && dts ? dts : pts);
    if (!Number.isFinite(t)) continue;
    pk.push({ t, n: Number(size) });
    if (Number(si) === vIdx && /K/.test(flags || "")) keys.push(parseFloat(pts));
  }
  pk.sort((a, b) => a.t - b.t);
  const t0 = pk[0].t, t1 = pk[pk.length - 1].t;
  const total = pk.reduce((s, p) => s + p.n, 0);
  const dur = t1 - t0;
  const peak = (w) => {
    let best = 0, j = 0, sum = 0;
    for (let i = 0; i < pk.length; i++) {
      sum += pk[i].n;
      while (pk[i].t - pk[j].t > w) { sum -= pk[j].n; j++; }
      if (pk[i].t - t0 >= w) best = Math.max(best, sum);
    }
    return Math.round((best * 8) / w / 1000);
  };
  keys.sort((a, b) => a - b);
  const gaps = keys.slice(1).map((k, i) => k - keys[i]);
  gaps.sort((a, b) => a - b);
  const q = (p) => (gaps.length ? +gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))].toFixed(2) : null);
  return { file: file.split(/[\/]/).pop(), durSec: Math.round(dur), avgKbps: Math.round((total * 8) / dur / 1000), peak2s: peak(2), peak6s: peak(6), peak10s: peak(10), peak30s: peak(30), peak60s: peak(60), gopMedian: q(0.5), gopP90: q(0.9), gopMax: gaps.length ? +gaps[gaps.length - 1].toFixed(2) : null };
};
const rows = files.map(stats);
if (asJson) console.log(JSON.stringify(rows, null, 1));
else for (const r of rows) console.log(`${r.file.padEnd(28)} ${String(r.durSec).padStart(5)}s avg ${String(r.avgKbps).padStart(5)} | peak 2s ${r.peak2s} 6s ${r.peak6s} 10s ${r.peak10s} 30s ${r.peak30s} 60s ${r.peak60s} kbit/s | GOP median ${r.gopMedian}s p90 ${r.gopP90}s max ${r.gopMax}s`);
