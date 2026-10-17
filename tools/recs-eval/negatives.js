#!/usr/bin/env node
// Does the taste picker's "Not for me" move the ranking SENSIBLY?
// (src/media/recs/person.js W.notForMe, ALGO 2 — 2026-10-17)
//
//   node tools/recs-eval/negatives.js
//
// For every synthetic persona (personas.js — made-up people, so titles can be
// printed), on the index build-index.js made (data/cache/recs-titles.json):
//
//   1. its top 20 ("Recommended for You", re-ranked) as things stand;
//   2. it says "Not for me" to the three best-placed titles of one genre in
//      that row — the genre the persona's own history has least of, i.e. the
//      row's stray;
//   3. the top 20 again.
//
// What "sensible" means, checked per persona and printed as PASS/FAIL:
//   gone      the three are out of the row (a title said no to is never offered back)
//   genre     that genre's share of the row falls
//   nearby    the ten titles most like the three move DOWN the score order on average
//   steady    what in the row is NOT like the three (similarity under 0.3 to
//             each) mostly stays: it is a light signal, aimed (>= 70% kept)
// and a control: three "Not for me"s on titles at the far end of the order (80th percentile)
//   control   leave the top 20 almost as it was (>= 85% kept)
//
// Never reads the household's profiles. Exit code 1 when a check fails.
const path = require("path");
const fs = require("fs");
const titleindex = require("../../src/media/recs/titleindex");
const features = require("../../src/media/recs/features");
const person = require("../../src/media/recs/person");
const rank = require("../../src/media/recs/rank");
const personas = require("./personas");

const all = titleindex.all();
if (all.length < 200) {
  console.error("The title index is empty — run tools/recs-eval/build-index.js first.");
  process.exit(1);
}
const stats = features.buildStats(all);
const vec = new Map(all.map((r) => [r.id, features.vectorOf(r, stats)]));
const recOf = new Map(all.map((r) => [r.id, r]));
const wide = all.map((r) => ({ id: r.id, v: vec.get(r.id), rec: r }));
const NOW = Date.now();
const DAY = 86400000;

const resolved = JSON.parse(fs.readFileSync(path.join(__dirname, "personas.resolved.json"), "utf8"));
const personaIds = (p) => {
  if (p.mix) return p.mix.flatMap((id) => personaIds(personas.find((x) => x.id === id)));
  return p.titles.map(([title, year, kind]) => (resolved[`${kind}|${title}|${year}`] || {}).imdbId).filter((id) => id && recOf.has(id));
};
// the same stored history eval.js gives a persona
const stateOf = (ids, now) => {
  const titles = {};
  ids.forEach((id, i) => {
    const at = now - (ids.length - i) * 9 * DAY;
    const r = recOf.get(id);
    if (r.k === "tv") for (let e = 1; e <= 8; e++) titles[`${id}:1:${e}`] = { position: 3000, duration: 3000, finished: true, updatedAt: at - (8 - e) * 2 * DAY };
    else titles[id] = { position: 6000, duration: 6000, finished: true, updatedAt: at };
  });
  return { titles };
};
const run = (state) => {
  const ev = person.collectEvents(state, { now: NOW, episodesOf: (id) => (recOf.get(id) || {}).eps || null });
  const model = person.buildModel(ev, { vectorFor: (id) => vec.get(id) || null, titleFor: (id) => (recOf.get(id) || {}).title, now: NOW });
  const scored = rank.scoreAll(model, wide.filter((c) => !ev.seen.has(c.id)), { seed: "neg" });
  const row = rank.rerank(scored, { size: 20, pool: 120, target: model.genreShare }).map((s) => s.id);
  const at = new Map(scored.map((s, i) => [s.id, i]));
  return { row, at, scored };
};
const share = (ids, g) => (ids.length ? ids.filter((id) => (recOf.get(id).g || []).includes(g)).length / ids.length : 0);
const kept = (before, after, drop) => {
  const rest = before.filter((id) => !drop.includes(id));
  return rest.length ? rest.filter((id) => after.includes(id)).length / rest.length : 1;
};
const name = (id) => `${recOf.get(id).title} (${recOf.get(id).year || "?"})`;

let failed = 0;
const lines = [];
for (const p of personas) {
  const ids = personaIds(p);
  if (ids.length < 5) continue;
  const base = stateOf(ids, NOW);
  const before = run(base);
  // the row's stray genre: in the row 3+ times, least of the persona's own history
  const histShare = (g) => share(ids, g);
  const counts = new Map();
  for (const id of before.row) for (const g of recOf.get(id).g || []) counts.set(g, (counts.get(g) || 0) + 1);
  const cands = [...counts.entries()].filter(([, n]) => n >= 3).map(([g]) => g).sort((a, b) => histShare(a) - histShare(b));
  if (!cands.length) { lines.push(`${p.id.padEnd(22)} (no genre three times in its row — skipped)`); continue; }
  const G = cands[0];
  const nope = before.row.filter((id) => (recOf.get(id).g || []).includes(G)).slice(0, 3);
  const after = run({ ...base, dislikedTitles: nope.map((id) => ({ imdbId: id, title: recOf.get(id).title, at: NOW })) });

  // the ten titles most like the three, outside the history and the three
  const skip = new Set([...ids, ...nope]);
  const near = wide
    .filter((c) => !skip.has(c.id) && before.at.has(c.id))
    .map((c) => ({ id: c.id, sim: Math.max(...nope.map((n) => features.similarity(c.v, vec.get(n)))) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, 10);
  const meanAt = (r) => near.reduce((n, x) => n + (r.at.has(x.id) ? r.at.get(x.id) : r.scored.length), 0) / near.length;

  // control: three from the far end of the order — unrelated to this person.
  // (Not "rank 400": that is still inside a persona's own neighbourhood — a
  // 90s-action fan's 400th is Batman & Robin — and a "no" there SHOULD move
  // its neighbours, which it does.)
  const fa = Math.floor(before.scored.length * 0.8);
  const far = before.scored.slice(fa, fa + 3).map((s) => s.id);
  const control = run({ ...base, dislikedTitles: far.map((id) => ({ imdbId: id, title: recOf.get(id).title, at: NOW })) });

  // the row's titles that are not like any of the three
  const unlike = before.row.filter((id) => !nope.includes(id) && nope.every((n) => features.similarity(vec.get(id), vec.get(n)) < 0.3));
  const checks = {
    gone: nope.every((id) => !after.row.includes(id)),
    genre: share(after.row, G) < share(before.row, G),
    nearby: meanAt(after) > meanAt(before),
    steady: kept(unlike, after.row, []) >= 0.7,
    control: kept(before.row, control.row, []) >= 0.85,
  };
  const bad = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  failed += bad.length;
  lines.push(
    `${p.id.padEnd(22)} no to ${G.padEnd(12)} share ${(100 * share(before.row, G)).toFixed(0).padStart(3)}% -> ${(100 * share(after.row, G)).toFixed(0).padStart(3)}%  ` +
    `nearby mean rank ${meanAt(before).toFixed(0).padStart(5)} -> ${meanAt(after).toFixed(0).padStart(5)}  ` +
    `unlike kept ${(100 * kept(unlike, after.row, [])).toFixed(0).padStart(3)}% (${unlike.length})  all kept ${(100 * kept(before.row, after.row, nope)).toFixed(0).padStart(3)}%  control kept ${(100 * kept(before.row, control.row, [])).toFixed(0).padStart(3)}%  ` +
    (bad.length ? `FAIL: ${bad.join(", ")}` : "PASS"),
  );
  if (process.argv.includes("--examples")) {
    lines.push(`    said no to: ${nope.map(name).join("; ")}`);
    lines.push(`    new in the row: ${after.row.filter((id) => !before.row.includes(id)).map(name).join("; ")}`);
  }
}
console.log(`== "Not for me" (W.notForMe ${person.W.notForMe}) on ${personas.length} personas, pool ${wide.length} titles ==`);
console.log(lines.join("\n"));
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks pass");
process.exit(failed ? 1 : 0);
