#!/usr/bin/env node
// The longest stretches a CPU profile (loop-prof.js --out) spent off idle, and the
// app's own frames under each: where the event loop was held up.
//   node tools/stream-net-rig/loop-blocks.js <file.cpuprofile>
"use strict";
const fs = require("fs"); const path = require("path");
const p = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const parent = new Map(); for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
const name = (id) => { const f = byId.get(id).callFrame; return `${f.functionName || "(anon)"} ${path.basename(f.url || "")}:${f.lineNumber + 1}`; };
const stack = (id) => { const out = []; let x = id; while (x != null && out.length < 40) { out.push(name(x)); x = parent.get(x); } return out; };
let t = p.startTime; const runs = []; let cur = null;
for (let i = 0; i < p.samples.length; i++) {
  t += p.timeDeltas[i]; const id = p.samples[i]; const nm = name(id);
  const idle = /^\(idle\)/.test(nm);
  if (!idle) { if (!cur) cur = { from: t, ids: new Map() }; cur.to = t; cur.ids.set(id, (cur.ids.get(id) || 0) + 1); }
  else if (cur) { runs.push(cur); cur = null; }
}
const long = runs.map((r) => ({ ...r, ms: (r.to - r.from) / 1000 })).filter((r) => r.ms > 40).sort((a, b) => b.ms - a.ms).slice(0, 12);
for (const r of long) {
  // the frames under which most of it ran (app frames only)
  const agg = new Map();
  for (const [id, c] of r.ids) for (const fr of stack(id).filter((s) => /\.js:/.test(s) && !/node:|loader|internal/.test(s)).slice(0, 3)) agg.set(fr, (agg.get(fr) || 0) + c);
  console.log(`${r.ms.toFixed(0)} ms at +${((r.from - p.startTime) / 1e6).toFixed(1)} s:`, [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, c]) => `${k}(${c})`).join(" | "));
}
