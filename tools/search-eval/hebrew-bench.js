#!/usr/bin/env node
// Per-keystroke latency of the search, one engine against another, in ONE
// process and interleaved keystroke by keystroke — so a machine busy with
// something else slows both the same.
//
//   node tools/search-eval/hebrew-bench.js --corpus c.json [--base old-search.js] [--pad 10000] [--rounds 3]
//
// Every query of the table (test/fixtures/search-hebrew-cases.js) is typed a
// letter at a time; each prefix is one suggest() and one local search() (what
// the Search screen asks per keystroke before the catalogue answers). Reported
// per script (Hebrew letters / Latin letters): p50, p95, max in ms.
// --pad N: the catalogue is padded with synthetic titles (made from the
// corpus's own words) until the index holds N documents.
const path = require("path");
const fs = require("fs");

const args = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = args.indexOf(name);
  return i === -1 ? dflt : args[i + 1];
};
const ROOT = path.join(__dirname, "..", "..");
const { sourcesFor } = require(path.join(ROOT, "test", "fixtures", "search-hebrew-sources.js"));
const CASES = require(path.join(ROOT, "test", "fixtures", "search-hebrew-cases.js"));
const corpus = JSON.parse(fs.readFileSync(opt("--corpus", path.join(ROOT, "test", "fixtures", "search-hebrew-corpus.json")), "utf8"));
const engines = [["after", path.join(ROOT, "src", "media", "search.js")]];
if (opt("--base")) engines.unshift(["before", path.resolve(opt("--base"))]);
const rounds = Number(opt("--rounds", 3)) || 3;

const pad = (c, n) => {
  if (!n) return c;
  const words = [];
  for (const m of [...(c.known || []), ...(c.recs || [])]) for (const w of String(m.title).split(/\s+/)) if (/^[A-Za-z]{3,}$/.test(w)) words.push(w);
  const ids = new Set();
  for (const m of [...(c.library || []), ...(c.known || []), ...(c.recs || []), ...((c.trending && c.trending.movies) || []), ...((c.trending && c.trending.shows) || [])]) ids.add(m.imdbId || m.id);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const extra = [];
  for (let i = 0; ids.size + extra.length < n; i++) {
    const len = 1 + Math.floor(rnd() * 4);
    const t = Array.from({ length: len }, () => words[Math.floor(rnd() * words.length)]).join(" ");
    extra.push({ imdbId: `tt9${String(i).padStart(8, "0")}`, type: rnd() < 0.7 ? "movie" : "show", title: t, year: 1950 + Math.floor(rnd() * 76), poster: `https://p/x${i}.jpg`, rating: 5 + Math.round(rnd() * 40) / 10, genres: [], votes: Math.floor(rnd() * 3000) });
  }
  return { ...c, recs: [...(c.recs || []), ...extra] };
};
const pct = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0);
  return { n: s.length, p50: +at(0.5).toFixed(2), p95: +at(0.95).toFixed(2), max: +(s[s.length - 1] || 0).toFixed(2) };
};

(async () => {
  const c = pad(corpus, Number(opt("--pad", 0)) || 0);
  const loaded = engines.map(([name, file]) => {
    const e = require(file);
    e._internals._setSources(sourcesFor(c, { hebrewNames: true }));
    e._internals.ensureIndex();
    return { name, e, t: { suggest: { he: [], en: [] }, search: { he: [], en: [] } } };
  });
  const queries = [...new Set(CASES.map((k) => k.q))];
  const keystrokes = [];
  for (const q of queries) {
    const chars = [...q];
    for (let i = 1; i <= chars.length; i++) {
      const typed = chars.slice(0, i).join("");
      if (typed.trim()) keystrokes.push(typed);
    }
  }
  const time = async (fn) => {
    const t0 = process.hrtime.bigint();
    await fn();
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  // warm-up: hot paths compiled, caches filled
  for (const L of loaded) for (const k of keystrokes) { L.e.suggest(k); await L.e.search(k, { localOnly: true }); }
  for (let r = 0; r < rounds; r++) {
    for (const k of keystrokes) {
      const script = /[א-ת]/.test(k) ? "he" : "en";
      for (const L of loaded) {
        L.t.suggest[script].push(await time(() => L.e.suggest(k, { limit: 8 })));
        L.t.search[script].push(await time(() => L.e.search(k, { localOnly: true })));
      }
    }
  }
  const out = {};
  for (const L of loaded) {
    out[L.name] = { docs: L.e.stats().docs };
    for (const what of ["suggest", "search"]) for (const script of ["he", "en"]) out[L.name][`${what}.${script}`] = pct(L.t[what][script]);
  }
  if (args.includes("--json")) return console.log(JSON.stringify(out));
  for (const [name, o] of Object.entries(out)) {
    console.log(`${name}: ${o.docs} documents — ms per keystroke`);
    for (const [k, v] of Object.entries(o)) if (k !== "docs") console.log(`  ${k.padEnd(11)} p50 ${String(v.p50).padStart(6)}  p95 ${String(v.p95).padStart(6)}  max ${String(v.max).padStart(7)}  (${v.n})`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
