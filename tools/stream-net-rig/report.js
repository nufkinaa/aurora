#!/usr/bin/env node
// The rig's rows as markdown tables.
//   node tools/stream-net-rig/report.js base                 one table: profile × title
//   node tools/stream-net-rig/report.js base proto1          before → after, cell by cell
//   node tools/stream-net-rig/report.js base --csv           the rows, flat
//   … --data                                                 from docs/qa/streaming-efficiency/data
// Several runs of a cell: medians (stall seconds, ttff) and the worst "end".
"use strict";
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const csv = process.argv.includes("--csv");
// --data: the copies kept with the report (docs/qa/streaming-efficiency/data) instead of .runs
const DIR = process.argv.includes("--data") ? path.join(__dirname, "..", "..", "docs", "qa", "streaming-efficiency", "data") : path.join(__dirname, ".runs");
const load = (label) => fs.readFileSync(path.join(DIR, `${label}.jsonl`), "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const med = (xs) => { const s = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const ORDER = ["25M", "8M", "5M", "3M", "1.5M", "20M-L1", "8M-L1", "3M-L1", "8M-L2", "drop", "drop-L1"];
const cells = (rows) => {
  const m = new Map();
  for (const r of rows) { const k = `${r.profile}|${r.title}`; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  const out = [];
  for (const [k, rs] of m) {
    const ok = rs.filter((r) => r.ok);
    const [profile, title] = k.split("|");
    out.push({
      profile, title, n: rs.length, ok: ok.length,
      ttff: med(ok.map((r) => r.ttff / 1000)),
      stalls: med(ok.map((r) => r.stalls)),
      stallSec: med(ok.map((r) => r.stallMs / 1000)),
      longest: med(ok.map((r) => r.longestStallMs / 1000)),
      avgH: med(ok.map((r) => r.avgHeight)),
      top: med(ok.map((r) => r.shareTop)),
      sw: med(ok.map((r) => r.switches)),
      mbit: med(ok.map((r) => r.mediaMbit)),
      mb: med(ok.map((r) => r.mediaBytes / 1e6)),
      played: med(ok.map((r) => r.playedSec)),
      enc: rs.some((r) => r.encodeStarts != null) ? rs.reduce((n, r) => n + (r.encodeStarts || 0), 0) : null, // every play's encoder starts, summed
      plays: rs.length,
      watch: med(ok.map((r) => r.watchSec)),
      path: [...new Set(ok.map((r) => r.pathMarks || r.path))].join("/"),
      levels: [...new Set(ok.flatMap((r) => r.levelsUsed || []))].join(","),
      end: rs.every((r) => r.ok && r.endPlaying) ? "playing" : `${rs.filter((r) => !(r.ok && r.endPlaying)).length}/${rs.length} stuck`,
    });
  }
  return out.sort((a, b) => (ORDER.indexOf(a.profile) - ORDER.indexOf(b.profile)) || a.title.localeCompare(b.title));
};
const f1 = (x) => (x == null ? "–" : (Math.round(x * 10) / 10).toString());
const pct = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);
if (csv) {
  const rows = load(args[0]);
  const keys = ["label", "profile", "title", "run", "ok", "ttff", "stalls", "stallMs", "longestStallMs", "avgHeight", "shareTop", "share720", "shareLow", "switches", "mediaMbit", "mediaBytes", "playedSec", "watchSec", "path", "endPlaying", "cc", "why"];
  console.log(keys.join(","));
  for (const r of rows) console.log(keys.map((k) => JSON.stringify(r[k] ?? "")).join(","));
} else if (args.length === 1) {
  const c = cells(load(args[0]));
  console.log("| line | film | first frame | stalls | stalled | longest | avg height | at full height | switches | delivered | MB | played / watched | path (rungs) | at the end |");
  console.log("|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|---|---|");
  for (const x of c) console.log(`| ${x.profile} | ${x.title} | ${f1(x.ttff)} s | ${f1(x.stalls)} | ${f1(x.stallSec)} s | ${f1(x.longest)} s | ${x.avgH ?? "–"}p | ${pct(x.top)} | ${f1(x.sw)} | ${f1(x.mbit)} Mbit/s | ${f1(x.mb)} | ${f1(x.played)} / ${f1(x.watch)} s | ${x.path} (${x.levels}) | ${x.end} |`);
} else {
  const a = new Map(cells(load(args[0])).map((x) => [`${x.profile}|${x.title}`, x]));
  const b = cells(load(args[1]));
  const encCol = b.some((y) => y.enc != null);
  console.log(`| line | film | first frame | stalled (count) | avg height | at full height | delivered |${encCol ? " encoder starts (all plays) |" : ""} at the end |`);
  console.log(`|---|---|--:|--:|--:|--:|--:|${encCol ? "--:|" : ""}---|`);
  for (const y of b) {
    const x = a.get(`${y.profile}|${y.title}`);
    if (!x) continue;
    console.log(`| ${y.profile} | ${y.title}${y.plays > 1 ? ` (${y.plays}×)` : ""} | ${f1(x.ttff)} → **${f1(y.ttff)}** s | ${f1(x.stallSec)} s (${f1(x.stalls)}) → **${f1(y.stallSec)} s (${f1(y.stalls)})** | ${x.avgH}p → **${y.avgH}p** | ${pct(x.top)} → **${pct(y.top)}** | ${f1(x.mbit)} → **${f1(y.mbit)}** Mbit/s |${encCol ? ` ${x.enc ?? "–"} → **${y.enc ?? "–"}** |` : ""} ${x.end} → **${y.end}** |`);
  }
}
