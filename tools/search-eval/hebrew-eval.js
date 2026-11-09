#!/usr/bin/env node
// The Hebrew + typo search table, scored (the per-keystroke latency: hebrew-bench.js).
//
//   node tools/search-eval/hebrew-eval.js                 the table over the fixture corpus
//   node tools/search-eval/hebrew-eval.js --corpus c.json  …over another corpus (same shape:
//                                                          test/fixtures/search-hebrew-sources.js)
//   node tools/search-eval/hebrew-eval.js --engine src/media/search.base.js
//                                                          …with another copy of the engine
//                                                          (an older one: `git show <rev>:src/media/search.js`
//                                                          saved next to the real one)
//   --fails            list the cases that missed
//   --json             one JSON line instead of the table
//
// A case is a HIT when the first card is one it wants (top-1), or one of the
// first three (top-3). The "sound" cases run as if no official Hebrew name
// were known: they must be found from the letters alone. Everything else
// runs with the corpus's Hebrew names.
const path = require("path");
const fs = require("fs");

const args = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = args.indexOf(name);
  return i === -1 ? dflt : args[i + 1];
};
const flag = (name) => args.includes(name);
const ROOT = path.join(__dirname, "..", "..");
const corpusPath = opt("--corpus", path.join(ROOT, "test", "fixtures", "search-hebrew-corpus.json"));
const enginePath = path.resolve(opt("--engine", path.join(ROOT, "src", "media", "search.js")));

const engine = require(enginePath);
const { sourcesFor, wanted } = require(path.join(ROOT, "test", "fixtures", "search-hebrew-sources.js"));
const CASES = require(path.join(ROOT, "test", "fixtures", "search-hebrew-cases.js"));
const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));

const use = (c, hebrewNames) => engine._internals._setSources(sourcesFor(c, { hebrewNames }));

// A library card carries the folder's name ("Avatar Movie"): judged by the
// catalogue's name for the same id. A case no corpus title can answer is
// left out (and counted as such).
const catalogName = (c) => {
  const out = new Map();
  for (const m of [...(c.known || []), ...(c.recs || []), ...((c.trending && c.trending.movies) || []), ...((c.trending && c.trending.shows) || [])]) if (m.imdbId && !out.has(m.imdbId)) out.set(m.imdbId, m.title);
  return out;
};
const answerable = (c, k) => {
  const titles = [...(c.library || []), ...(c.known || []), ...(c.recs || []), ...((c.trending && c.trending.movies) || []), ...((c.trending && c.trending.shows) || [])].map((m) => m.title);
  return titles.some((t) => wanted(k.want, t));
};
const run = async (c) => {
  const rows = [];
  const names = catalogName(c);
  const nameOf = (x) => (x.imdbId && names.get(x.imdbId)) || x.title;
  for (const hebrewNames of [true, false]) {
    use(c, hebrewNames);
    for (const k of CASES) {
      if ((k.kind === "sound") === hebrewNames) continue;
      if (!answerable(c, k)) { rows.push({ ...k, skipped: true }); continue; }
      const r = await engine.search(k.q, { localOnly: true, commit: true });
      const titles = (r.results || []).map(nameOf);
      const sug = engine.suggest(k.q, { limit: 8 }).filter((s) => s.kind === "title").map(nameOf);
      rows.push({
        ...k,
        top1: !!titles[0] && wanted(k.want, titles[0]),
        top3: titles.slice(0, 3).some((t) => wanted(k.want, t)),
        sug1: !!sug[0] && wanted(k.want, sug[0]),
        got: titles.slice(0, 3),
      });
    }
  }
  return rows;
};

(async () => {
  const all = await run(corpus);
  const rows = all.filter((r) => !r.skipped);
  const skipped = all.filter((r) => r.skipped);
  const kinds = [...new Set(CASES.map((k) => k.kind))];
  const summary = {};
  for (const kind of [...kinds, "all"]) {
    const rs = kind === "all" ? rows : rows.filter((r) => r.kind === kind);
    summary[kind] = { n: rs.length, top1: rs.filter((r) => r.top1).length, top3: rs.filter((r) => r.top3).length, suggest1: rs.filter((r) => r.sug1).length };
  }
  const out = { engine: path.relative(ROOT, enginePath), corpus: path.basename(corpusPath), summary, skipped: skipped.map((r) => r.q) };
  if (flag("--json")) {
    console.log(JSON.stringify(out));
  } else {
    console.log(`engine ${out.engine}, corpus ${out.corpus}`);
    console.log("kind       cases  top-1        top-3        suggest top-1");
    for (const [kind, s] of Object.entries(summary)) {
      const f = (x) => `${String(x).padStart(3)} (${String(Math.round((100 * x) / Math.max(1, s.n))).padStart(3)}%)`;
      console.log(`${kind.padEnd(10)} ${String(s.n).padStart(5)}  ${f(s.top1)}   ${f(s.top3)}   ${f(s.suggest1)}`);
    }
    if (skipped.length) console.log(`(${skipped.length} left out: no title in this corpus answers them — ${skipped.map((r) => r.q).join(", ")})`);
  }
  if (flag("--fails")) for (const r of rows.filter((x) => !x.top1)) console.log(`MISS [${r.kind}] ${r.q} → ${JSON.stringify(r.got)} (want ${r.want.join(" / ")})${r.top3 ? " (top-3 ok)" : ""}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
