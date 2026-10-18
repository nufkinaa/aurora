#!/usr/bin/env node
// One in-process measurement (an inproc/*.js script) on two commits, taking
// turns: A B A B … on two private instances started side by side.
//
//   node tools/backend-perf/inprocab.js --before <commit> [--after <commit>] --script inproc/intro-pass.js [--runs 3] [--weak] [--label x]
const path = require("path");
const { start } = require("./instance");
const { saveJson, arg, median } = require("./lib");

(async () => {
  const before = arg("before") === true ? undefined : arg("before");
  const after = arg("after") === true ? undefined : arg("after");
  const script = path.resolve(__dirname, String(arg("script")));
  const runs = +arg("runs", 3);
  const weak = !!arg("weak");
  const label = arg("label") === true ? path.basename(script, ".js") : arg("label");
  const cfg = { weak, probe: "light", loop: false, config: { scanIntervalMinutes: 24 * 60 } };
  const A = await start({ ...cfg, ref: before });
  const B = await start({ ...cfg, ref: after });
  const out = { at: new Date().toISOString(), before, after: after || "working tree", script: path.basename(script), runs: { before: [], after: [] } };
  try {
    for (const s of [A, B]) await s.waitWarm();
    for (const s of [A, B]) await s.waitQuiet();
    for (let r = 0; r < runs; r++) {
      const order = r % 2 ? [["after", B], ["before", A]] : [["before", A], ["after", B]];
      for (const [k, s] of order) { const x = await s.exec(script, {}); out.runs[k].push(x); process.stderr.write(`[inprocab] ${k}: ${JSON.stringify(x)}\n`); }
    }
  } finally { await A.stop(); await B.stop(); }
  const keys = Object.keys(out.runs.before[0] || {});
  out.median = Object.fromEntries(["before", "after"].map((k) => [k, Object.fromEntries(keys.map((f) => [f, median(out.runs[k].map((x) => x[f]))]))]));
  saveJson(`inprocab-${label}.json`, out);
  console.log(JSON.stringify(out.median));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
