#!/usr/bin/env node
// Summaries of run.js results (docs/qa/subtitle-sync/REPORT.md tables).
//   node tools/subsync-eval/score.js synthetic-energy synthetic-model … [--by group|item|case] [--items a,b] [--md]
"use strict";
const fs = require("fs");
const c = require("./common");

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const files = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const by = opt("--by", null);
const only = opt("--items", null);
const md = argv.includes("--md");

const HARM = new Set(["WRONG", "FALSE-ACCEPT", "MOVED-RIGHT-FILE"]);
const REFUSE = new Set(["refused", "missed", "said-unmatched"]);
const GOOD = new Set(["fixed", "kept", "refused-ok", "touched"]);
const tallyOf = (rows) => {
  const fix = rows.filter((r) => r.expect === "fix");
  const t = {
    cases: rows.length,
    fixed: fix.filter((r) => r.cls === "fixed").length,
    mostly: fix.filter((r) => r.cls === "mostly").length,
    of: fix.length,
    falseRefuse: rows.filter((r) => REFUSE.has(r.cls)).length,
    falseAccept: rows.filter((r) => HARM.has(r.cls)).length,
    controlsOk: rows.filter((r) => r.expect !== "fix" && GOOD.has(r.cls)).length,
    controls: rows.filter((r) => r.expect !== "fix").length,
    saidInTime: rows.filter((r) => r.cls === "said-in-time").length,
    lost: rows.reduce((s, r) => s + (r.apply && r.expect === "fix" ? r.lost : 0), 0),
    fakesKept: rows.reduce((s, r) => s + (r.apply && r.expect === "fix" ? +r.fakesKept.split("/")[0] : 0), 0),
    fakes: rows.reduce((s, r) => s + (r.expect === "fix" ? +r.fakesKept.split("/")[1] : 0), 0),
  };
  const med = rows.filter((r) => r.apply && r.expect === "fix" && r.cls !== "WRONG").map((r) => r.after[0]);
  const p90 = rows.filter((r) => r.apply && r.expect === "fix" && r.cls !== "WRONG").map((r) => r.after[1]);
  t.medAfter = c.quant(med, 0.5);
  t.p90After = c.quant(p90, 0.9);
  return t;
};
const line = (label, t) => {
  const cells = [label, `${t.fixed}/${t.of}`, t.mostly, t.falseRefuse, t.falseAccept, `${t.controlsOk}/${t.controls}`, t.saidInTime, t.lost, `${t.fakesKept}/${t.fakes}`, t.medAfter, t.p90After];
  return md ? `| ${cells.join(" | ")} |` : cells.map((x, i) => String(x).padEnd(i ? 10 : 34)).join("");
};
const head = ["", "fixed", "mostly", "false refuse", "false accept", "controls ok", "said in-time", "lines lost", "fake kept", "median err", "p90 err"];
console.log(md ? `| ${head.join(" | ")} |\n|${head.map(() => "---").join("|")}|` : head.map((x, i) => x.padEnd(i ? 10 : 34)).join(""));
for (const f of files) {
  let rows = JSON.parse(fs.readFileSync(c.p("results", f.endsWith(".json") ? f : `${f}.json`), "utf8"));
  if (only) rows = rows.filter((r) => only.split(",").includes(r.item));
  if (!by) { console.log(line(f, tallyOf(rows))); continue; }
  const keys = [...new Set(rows.map((r) => r[by]))];
  for (const k of keys) console.log(line(`${f.replace(/^synthetic-/, "")}:${String(k).slice(0, 24)}`, tallyOf(rows.filter((r) => r[by] === k))));
}
if (argv.includes("--bad")) {
  for (const f of files) {
    const rows = JSON.parse(fs.readFileSync(c.p("results", f.endsWith(".json") ? f : `${f}.json`), "utf8"));
    for (const r of rows) if (!GOOD.has(r.cls)) console.log(f, r.item.padEnd(30), r.case.slice(0, 44).padEnd(44), r.verdict.padEnd(9), r.cls.padEnd(16), `z ${r.z} r ${r.r} c ${r.conf}`, `before ${r.before} after ${r.after} lost ${r.lost} fake ${r.fakesKept}`);
  }
}
