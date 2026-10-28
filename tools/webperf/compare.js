#!/usr/bin/env node
// Before / after, as Markdown tables, from two run.js results.
//
//   node tools/webperf/compare.js <before results.json|label> <after results.json|label> [--full]
//
// A label means tools/webperf/out/<label>/results.json; a path is read as is
// (the committed baseline: tools/webperf/baseline/<name>.json).
//
// Prints, per scenario, the medians across cells (each cell's own median
// first), before → after with the change in %, then — with --full — every
// cell. Numbers are milliseconds unless named otherwise. Lower is better
// everywhere.
"use strict";
const fs = require("fs");
const path = require("path");
const { OUT, median } = require("./lib");

const load = (x) => JSON.parse(fs.readFileSync(fs.existsSync(x) ? x : path.join(OUT, x, "results.json"), "utf-8"));

const COLS = {
  "load-cold": ["fcp", "lcp", "rows", "tbt", "longTasks", "worstTask"],
  "load-warm": ["fcp", "lcp", "rows", "tbt", "longTasks", "worstTask"],
  "scroll-home": ["lateFrames", "worstFrame", "longTasks", "blocked", "task", "script", "style"],
  hold: ["holdToSheet", "inp", "lateFrames", "worstFrame", "blocked", "task"],
  "open-title": ["toPaint", "inp", "lateFrames", "worstFrame", "blocked", "task"],
  back: ["toPaint", "lateFrames", "worstFrame", "blocked", "task", "script"],
  "tab-movies": ["toPaint", "inp", "lateFrames", "worstFrame", "blocked", "task"],
  "scroll-movies": ["lateFrames", "worstFrame", "blocked", "task", "script", "style"],
  "tab-shows": ["toPaint", "inp", "lateFrames", "worstFrame", "blocked", "task"],
  "scroll-shows": ["lateFrames", "worstFrame", "blocked", "task", "script", "style"],
  "search-type": ["inp", "lateFrames", "worstFrame", "blocked", "task", "script"],
  player: ["ttff", "toPlaying", "inp", "lateFrames", "blocked", "task"],
  seek: ["seekToFrame", "seeked", "lateFrames", "blocked", "task"],
  heap: ["heapMB", "nodes", "listeners", "growHeapMB", "growNodes", "growListeners"],
};

const key = (c) => `${c.device} · ${c.look} · ×${c.cpu} · ${c.net}`;
const val = (c, s, k) => (c.metrics[s] && c.metrics[s][k] && typeof c.metrics[s][k] === "object" ? c.metrics[s][k].median : null);
const fmt = (v) => (v == null ? "–" : Math.abs(v) >= 100 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(2));
const pct = (a, b) => (a == null || b == null || a === 0 ? "" : ` (${b - a > 0 ? "+" : ""}${Math.round(((b - a) / Math.abs(a)) * 100)}%)`);

const main = () => {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const full = process.argv.includes("--full");
  const A = load(args[0]);
  const B = load(args[1]);
  const bByKey = new Map(B.cells.map((c) => [key(c), c]));
  const pairs = A.cells.map((a) => [a, bByKey.get(key(a))]).filter(([, b]) => b);
  console.log(`**Before** ${A.meta.label} (${A.meta.commit || "?"}, ${A.meta.at}) · **after** ${B.meta.label} (${B.meta.commit || "?"}, ${B.meta.at}) · ${pairs.length} cells in common, ${A.meta.runs}/${B.meta.runs} runs per cell (medians).\n`);
  for (const [s, cols] of Object.entries(COLS)) {
    const have = pairs.filter(([a, b]) => a.metrics[s] && b.metrics[s]);
    if (!have.length) continue;
    console.log(`#### ${s} — median over ${have.length} cells\n`);
    console.log(`| ${cols.join(" | ")} |`);
    console.log(`|${cols.map(() => "---:").join("|")}|`);
    console.log(`| ${cols.map((k) => {
      const a = median(have.map(([x]) => val(x, s, k)));
      const b = median(have.map(([, y]) => val(y, s, k)));
      return `${fmt(a)} → ${fmt(b)}${pct(a, b)}`;
    }).join(" | ")} |\n`);
    if (full) {
      console.log(`| cell | ${cols.join(" | ")} |`);
      console.log(`|---|${cols.map(() => "---:").join("|")}|`);
      for (const [a, b] of have) console.log(`| ${key(a)} | ${cols.map((k) => `${fmt(val(a, s, k))} → ${fmt(val(b, s, k))}`).join(" | ")} |`);
      console.log("");
    }
  }
  const errs = [...A.cells, ...B.cells].flatMap((c) => (c.errors || []).map((e) => `${key(c)}: ${e}`));
  if (errs.length) console.log(`Errors:\n- ${errs.join("\n- ")}`);
};

main();
