#!/usr/bin/env node
// How much of the title index the taxonomy explains, and what it misses.
//   node tools/recs-eval/keywords.js [--top 120]
// Prints: share of titles with at least one theme, themes per title, the
// size of every theme, and the most common keywords no theme claims — the
// list to read when extending src/media/recs/taxonomy.json.
const titleindex = require("../../src/media/recs/titleindex");
const tax = require("../../src/media/recs/taxonomy");
const top = parseInt(process.argv[process.argv.indexOf("--top") + 1], 10) || 120;
const all = titleindex.all().filter((r) => !r.lite);
const unclaimed = new Map();
const sizes = {};
let withTheme = 0;
let total = 0;
let kwTotal = 0;
let kwClaimed = 0;
for (const r of all) {
  const kws = r.kw.map((k) => k[1]);
  const themes = tax.themesOf({ keywords: kws, overview: r.ov, genres: r.g });
  const n = Object.keys(themes).length;
  if (n) withTheme++;
  total += n;
  for (const slug of Object.keys(themes)) sizes[slug] = (sizes[slug] || 0) + 1;
  for (const k of kws) {
    if (tax.STOP.has(k)) continue;
    kwTotal++;
    if (tax._internals.slugsForKeyword(k).length) kwClaimed++;
    else unclaimed.set(k, (unclaimed.get(k) || 0) + 1);
  }
}
console.log(`titles ${all.length}; with >=1 theme ${withTheme} (${((100 * withTheme) / all.length).toFixed(1)}%); themes/title ${(total / all.length).toFixed(1)}`);
console.log(`non-stop keyword occurrences ${kwTotal}; claimed by a theme ${kwClaimed} (${((100 * kwClaimed) / kwTotal).toFixed(1)}%)`);
console.log(`themes ${Object.keys(tax.THEMES).length}:`, Object.entries(sizes).sort((a, b) => b[1] - a[1]).map((e) => e.join(":")).join(" "));
console.log("unused themes:", Object.keys(tax.THEMES).filter((s) => !sizes[s]).join(" ") || "-");
console.log("top unclaimed:", [...unclaimed].sort((a, b) => b[1] - a[1]).slice(0, top).map((e) => e.join(":")).join(" | "));
process.exit(0);
