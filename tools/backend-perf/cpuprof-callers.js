#!/usr/bin/env node
// Who calls it: for a V8 .cpuprofile (probe.js /cpu/stop?file=, or node
// --cpu-prof), the self time of every function whose name matches, split by
// the chain of callers above it (the first --depth frames from src/).
//
//   node tools/backend-perf/cpuprof-callers.js <file.cpuprofile> <name regex> [--depth 4] [--top 15]
const fs = require("fs");
const { arg } = require("./lib");

const file = process.argv[2];
const re = new RegExp(process.argv[3] || ".");
const depth = +arg("depth", 4);
const top = +arg("top", 15);
const prof = JSON.parse(fs.readFileSync(file, "utf8"));
const byId = new Map(prof.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of prof.nodes) for (const c of n.children || []) parent.set(c, n.id);
// self time per node from samples
const dt = prof.timeDeltas || [];
const self = new Map();
(prof.samples || []).forEach((id, i) => self.set(id, (self.get(id) || 0) + (dt[i] || 0)));
const frame = (n) => {
  const cf = n.callFrame;
  const url = String(cf.url || "").replace(/^.*?[\\/](src|node_modules)[\\/]/, "$1/").replace(/\\/g, "/");
  return `${cf.functionName || "(anonymous)"} ${url ? `${url}:${cf.lineNumber + 1}` : ""}`.trim();
};
const chains = new Map();
let total = 0;
for (const [id, us] of self) {
  const n = byId.get(id);
  if (!n || !re.test(n.callFrame.functionName || "")) continue;
  total += us;
  const parts = [];
  let p = parent.get(id);
  while (p != null && parts.length < depth) {
    const pn = byId.get(p);
    const f = frame(pn);
    if (/src\//.test(f) || /node_modules/.test(f)) parts.push(f);
    p = parent.get(p);
  }
  const key = parts.join("  <-  ") || "(no src frame)";
  chains.set(key, (chains.get(key) || 0) + us);
}
console.log(`${re}: ${Math.round(total / 1000)} ms self time`);
for (const [k, us] of [...chains].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${String(Math.round(us / 1000)).padStart(7)} ms  ${k}`);
