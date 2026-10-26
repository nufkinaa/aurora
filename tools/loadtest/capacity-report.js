#!/usr/bin/env node
// The capacity tables from tools/loadtest/capacity.js results: the knee of
// each run, rounds side by side, and how many streams fit a given upload.
//
//   node tools/loadtest/capacity-report.js docs/qa/capacity-2026-10/results/*.json [--uploads 20,50,100,500,1000] [--headroom 0.8]
"use strict";
const fs = require("fs");
const path = require("path");
const { parseArgs, round } = require("./lib");

const a = parseArgs();
const files = a._.filter((f) => f.endsWith(".json"));
const uploads = String(a.uploads || "20,50,100,500,1000").split(",").map(Number);
const headroom = Number(a.headroom) || 0.8; // the share of an uplink streams may use (browsing, pictures, TCP, other traffic)

const runs = files.map((f) => ({ file: path.basename(f), ...JSON.parse(fs.readFileSync(f, "utf8")) })).filter((r) => r.steps && r.steps.length);
// the knee: the largest n supported with every smaller step supported too
const knee = (r) => {
  let k = 0;
  for (const s of r.steps) { if (s.verdict.ok) k = s.n; else break; }
  const firstBad = r.steps.find((s) => !s.verdict.ok);
  return { knee: k, firstBad: firstBad ? firstBad.n : null, why: firstBad ? firstBad.verdict.why : [], maxTried: Math.max(...r.steps.map((s) => s.n)) };
};
const out = [];
out.push("## Knees\n");
out.push("| run | mix | knee (viewers) | browsing at the knee | first step not supported | why | largest step tried |");
out.push("| --- | --- | --- | --- | --- | --- | --- |");
for (const r of runs) {
  const k = knee(r);
  const at = r.steps.find((s) => s.n === k.knee);
  out.push(`| ${r.file} | ${r.meta.mix} | ${k.knee} | ${at ? at.browsing : ""} | ${k.firstBad == null ? "none" : k.firstBad} | ${k.why.join("; ")} | ${k.maxTried} |`);
}
// per-viewer bitrate per mix: the windows' egress over their viewers
out.push("\n## Bandwidth\n");
const mixes = [...new Set(runs.map((r) => r.meta.mix))];
const perViewer = {};
for (const m of mixes) {
  const ws = runs.filter((r) => r.meta.mix === m).flatMap((r) => r.steps.map((s) => s.window)).filter((w) => w.viewers > 0 && w.egressMbit > 0);
  perViewer[m] = ws.length ? round(ws.reduce((x, w) => x + w.egressMbit, 0) / ws.reduce((x, w) => x + w.viewers, 0), 2) : null;
}
out.push(`Streams that fit an upload, at ${Math.round(headroom * 100)} % of it, at the measured mean bitrate per viewer of each mix (and at the house library's p90 file, 4.2 Mbit/s, and an 8 Mbit/s Blu-ray-class file for comparison):\n`);
const cols = [...mixes.map((m) => `${m} (${perViewer[m]} Mbit/s)`), "4.2 Mbit/s", "8 Mbit/s"];
out.push(`| upload Mbit/s | ${cols.join(" | ")} |`);
out.push(`| --- | ${cols.map(() => "---").join(" | ")} |`);
for (const u of uploads) {
  const vals = [...mixes.map((m) => (perViewer[m] ? Math.floor((u * headroom) / perViewer[m]) : "")), Math.floor((u * headroom) / 4.2), Math.floor((u * headroom) / 8)];
  out.push(`| ${u} | ${vals.join(" | ")} |`);
}
process.stdout.write(out.join("\n") + "\n");
