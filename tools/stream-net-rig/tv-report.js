#!/usr/bin/env node
// tv-play.js's rows as a table: per (label, line, resume point, start buffer),
// the median first frame and the median stalls in the first minute / in all.
//   node tools/stream-net-rig/tv-report.js tv-start tv-start-8m tv-start-lan [--data]
"use strict";
const fs = require("fs");
const path = require("path");
const DIR = process.argv.includes("--data") ? path.join(__dirname, "..", "..", "docs", "qa", "streaming-efficiency", "data") : path.join(__dirname, ".runs");
const labels = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const med = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const rows = labels.flatMap((l) => fs.readFileSync(path.join(DIR, `${l}.jsonl`), "utf8").split("\n").filter(Boolean).map((x) => JSON.parse(x)));
const cells = new Map();
for (const r of rows) {
  const k = `${r.title}|${r.down}|${r.resumeAt}|${r.startBufferMs}`;
  if (!cells.has(k)) cells.set(k, []);
  cells.get(k).push(r);
}
console.log("| film | line | from | start buffer | plays | first frame | stalls in the first minute | stalled in the first minute | stalls (all) | stalled (all) |");
console.log("|---|---|--:|--:|--:|--:|--:|--:|--:|--:|");
for (const [k, rs] of [...cells].sort()) {
  const [title, down, at, sb] = k.split("|");
  const line = Number(down) === 0 ? "pass-through" : `${Number(down) / 1000} Mbit/s, ${rs[0].rttMs} ms`;
  console.log(`| ${title} | ${line} | ${at} s | ${sb} ms | ${rs.length} | ${(med(rs.map((r) => r.firstFrameMs)) / 1000).toFixed(1)} s | ${med(rs.map((r) => r.stallsFirstMinute))} | ${(med(rs.map((r) => r.stallMsFirstMinute)) / 1000).toFixed(1)} s | ${med(rs.map((r) => r.stalls))} | ${(med(rs.map((r) => r.stallMs)) / 1000).toFixed(1)} s |`);
}
