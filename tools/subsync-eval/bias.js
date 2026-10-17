#!/usr/bin/env node
// Where each item's OWN reference lands against its speech, per VAD variant:
// the offset of the correlation peak (10 ms) and its sharpness. A detector
// whose probability lags or leads speech shows as the same offset on every
// item (a bias to take out); one that blurs shows as a wide peak.
//   node tools/subsync-eval/bias.js energy band hand model <model.json> …
"use strict";
const fs = require("fs");
const c = require("./common");

const variants = process.argv.slice(2);
const items = c.names().filter((n) => c.refOf(n));
const out = {};
for (const v of variants) {
  const variant = /\.json$/.test(v) ? JSON.parse(fs.readFileSync(v, "utf8")) : v;
  const offs = [];
  for (const name of items) {
    const sp = c.speechFrom(c.rowsOf(name), variant);
    const ref = c.refOf(name);
    const pk = c.peakOf(sp, ref); // the lines as the aligner sees them (their first LINE_CAP s)
    offs.push({ name, off: pk.off, width: pk.width, r: pk.r });
  }
  out[v] = offs;
  console.log(`\n${v}`);
  for (const o of offs) console.log(" ", o.name.padEnd(40), `peak at ${o.off.toFixed(2)} s`, `width ${o.width.toFixed(2)} s`, `r ${o.r.toFixed(3)}`);
  const s = offs.map((o) => o.off).sort((a, b) => a - b);
  console.log("  median peak", s[Math.floor(s.length / 2)].toFixed(2), "mean width", (offs.reduce((a, o) => a + o.width, 0) / offs.length).toFixed(2));
}
fs.mkdirSync(c.p("results"), { recursive: true });
fs.writeFileSync(c.p("results", "bias.json"), JSON.stringify(out, null, 1));
