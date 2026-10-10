#!/usr/bin/env node
// Offline evaluation of the recommender: the OLD taste model (genre tally,
// src/media/taste.js) against the NEW one (src/media/recs), on
//
//   1. the household's real history, replayed: for each profile with enough
//      of it, hide the most recent K liked titles, build the model from what
//      came before (as of that moment), and see where the hidden titles land.
//      ONLY aggregate numbers are printed, per "Profile A/B/…" — never a name,
//      never a title.
//   2. synthetic personas (personas.js): the same leave-some-out measure over
//      several random splits, plus old-vs-new top-10s with titles — these are
//      made-up people, so their lists can be shown.
//
//   node tools/recs-eval/eval.js [--profiles <profiles.json>] [--k 5] [--splits 6] [--examples] [--ablate]
//
// Needs the index built by build-index.js (data/cache/recs-titles.json).
// Honest limits are printed with the numbers: a handful of profiles is an
// anecdote, and the personas were written by the person who wrote the ranker.
const fs = require("fs");
const path = require("path");
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const flag = (name) => process.argv.includes(`--${name}`);

const titleindex = require("../../src/media/recs/titleindex");
const features = require("../../src/media/recs/features");
const person = require("../../src/media/recs/person");
const rank = require("../../src/media/recs/rank");
const oldTaste = require("../../src/media/taste")._internals;
const discover = require("../../src/media/discover");
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

// the pool the OLD recommender actually had: the cached trending catalogue + the library
const oldPoolIds = new Set();
{
  const t = discover.trendingCached() || { movies: [], shows: [] };
  for (const i of [...t.movies, ...t.shows]) if (i.imdbId) oldPoolIds.add(i.imdbId);
  try {
    const lib = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "data", "recs-eval-library.json"), "utf8"));
    for (const i of lib) if (i.imdbId) oldPoolIds.add(i.imdbId);
  } catch {}
}
const narrow = wide.filter((c) => oldPoolIds.has(c.id));

// The same titles as the server knows them with NO TMDB at all (no key, or
// it cannot be reached): lite records — the catalogue card's genres, year,
// rating and synopsis, nothing else. What the recommender degrades to.
const { fromCard } = titleindex._internals;
const liteRecs = all.map((r) => fromCard({
  imdbId: r.id, type: r.k === "tv" ? "show" : "movie", title: r.title, year: r.year, genres: r.g,
  rating: r.va || null, poster: r.poster, synopsis: (r.ov || "").slice(0, 400),
}));
const liteStats = features.buildStats(liteRecs);
const liteVec = new Map(liteRecs.map((r) => [r.id, features.vectorOf(r, liteStats)]));
const liteWide = liteRecs.map((r) => ({ id: r.id, v: liteVec.get(r.id), rec: r }));

// ---------- the two recommenders, as functions of (events) -> ranked ids ----------
const NOW = Date.now();
const DAY = 86400000;

// OLD: genre/type/era vector from the same evidence, its own weights
const oldRank = (events, pool, n, now) => {
  const signals = [];
  for (const t of events.titles.values()) {
    const r = recOf.get(t.id);
    if (!r) continue;
    const k = t.kinds;
    let w = 0;
    if (k.has("rated5")) w += oldTaste.W.rate5;
    if (k.has("rated4")) w += oldTaste.W.rate4;
    if (k.has("rated2")) w += oldTaste.W.rate2;
    if (k.has("rated1")) w += oldTaste.W.rate1;
    if (k.has("loved")) w += oldTaste.W.loved;
    if (k.has("listed")) w += oldTaste.W.listed;
    // the old model read episode rows one by one: each finished episode was a signal
    if (k.has("finished") || k.has("rewatch")) w += oldTaste.W.finished;
    else if (k.has("devoted") || k.has("regular") || k.has("started")) w += oldTaste.W.finished * Math.max(1, t.n || 1);
    else if (k.has("mostly")) w += oldTaste.W.deep;
    else if (k.has("abandoned")) w += oldTaste.W.abandoned;
    if (!w) continue;
    signals.push({ genres: r.g, type: r.k === "tv" ? "show" : "movie", year: r.year, weight: w, why: "", at: t.at });
  }
  for (const g of events.likedGenres || []) signals.push({ genres: [g], type: null, year: null, weight: oldTaste.W.likedGenre, why: "", at: null });
  const vector = oldTaste.buildVector(signals, now);
  const cands = pool.map((c) => ({ imdbId: c.id, title: c.rec.title, genres: c.rec.g, type: c.rec.k === "tv" ? "show" : "movie", year: c.rec.year, rating: c.rec.va || null }));
  return oldTaste.recommend(vector, cands, { seen: events.seen, max: n, maxPerGenre: Math.max(3, Math.ceil((n * 3) / 16)) }).map((i) => i.imdbId);
};

const modelOf = (events, now) => person.buildModel(events, { vectorFor: (id) => vec.get(id) || null, titleFor: (id) => (recOf.get(id) || {}).title, now });

// NEW: score order (pure ranking) and the re-ranked row
const newRank = (events, pool, n, now, opts = {}) => {
  const model = modelOf(events, now);
  const fresh = pool.filter((c) => !events.seen.has(c.id));
  const scored = rank.scoreAll(model, fresh, { seed: "eval", ...opts });
  if (opts.raw) return scored.slice(0, n).map((s) => s.id);
  return rank.rerank(scored, { size: n, pool: Math.max(120, n * 4), target: model.genreShare }).map((s) => s.id);
};
const liteRank = (events, n, now) => {
  const model = person.buildModel(events, { vectorFor: (id) => liteVec.get(id) || null, titleFor: (id) => (recOf.get(id) || {}).title, now });
  const scored = rank.scoreAll(model, liteWide.filter((c) => !events.seen.has(c.id)), { seed: "eval" });
  return rank.rerank(scored, { size: n, pool: Math.max(120, n * 4), target: model.genreShare }).map((s) => s.id);
};
const popRank = (events, pool, n) =>
  pool.filter((c) => !events.seen.has(c.id)).sort((a, b) => (b.rec.vc || 0) - (a.rec.vc || 0)).slice(0, n).map((c) => c.id);

// ---------- metrics ----------
const jaccardDist = (a, b) => {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size && !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return 1 - inter / (A.size + B.size - inter);
};
const ild = (ids) => {
  let s = 0;
  let n = 0;
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) { s += jaccardDist(recOf.get(ids[i]).g, recOf.get(ids[j]).g); n++; }
  return n ? s / n : 0;
};
const ildRich = (ids) => {
  let s = 0;
  let n = 0;
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) { s += 1 - features.similarity(vec.get(ids[i]), vec.get(ids[j])); n++; }
  return n ? s / n : 0;
};
const novelty = (ids) => (ids.length ? ids.reduce((n, id) => n + (1 - features.popularityOf(recOf.get(id))), 0) / ids.length : 0);
const calibrationKL = (ids, target) => rank.klDivergence(target, rank.genreMix(ids.map((id) => ({ c: { v: vec.get(id) } }))));

const NS = [10, 20, 50];
const blank = () => ({ cases: 0, held: 0, hit: { 10: 0, 20: 0, 50: 0 }, rr: 0, ild: 0, ildRich: 0, nov: 0, kl: 0, lists: 0, seenIds: new Set(), poolSize: 0 });
const measure = (acc, ranked, held, target, poolSize) => {
  acc.cases++;
  acc.held += held.length;
  acc.poolSize = poolSize;
  for (const n of NS) {
    const top = new Set(ranked.slice(0, n));
    acc.hit[n] += held.filter((h) => top.has(h)).length;
  }
  for (const h of held) {
    const at = ranked.indexOf(h);
    if (at > -1) acc.rr += 1 / (at + 1);
  }
  const top10 = ranked.slice(0, 10);
  if (top10.length >= 2) {
    acc.ild += ild(top10);
    acc.ildRich += ildRich(top10);
    acc.nov += novelty(top10);
    acc.kl += target && Object.keys(target).length ? calibrationKL(top10, target) : 0;
    acc.lists++;
  }
  for (const id of top10) acc.seenIds.add(id);
};
const row = (name, a) => {
  const pct = (x) => (a.held ? ((100 * x) / a.held).toFixed(1).padStart(5) : "    -");
  const avg = (x) => (a.lists ? (x / a.lists).toFixed(2) : "-");
  return `${name.padEnd(34)} recall@10 ${pct(a.hit[10])}%  @20 ${pct(a.hit[20])}%  @50 ${pct(a.hit[50])}%  MRR ${(a.held ? a.rr / a.held : 0).toFixed(3)}  ` +
    `ILD-genre ${avg(a.ild)}  ILD-rich ${avg(a.ildRich)}  novelty ${avg(a.nov)}  calib-KL ${avg(a.kl)}  coverage ${a.seenIds.size}/${a.poolSize}`;
};

const CONFIGS = [
  ["OLD (its own pool)", (ev, now) => oldRank(ev, narrow, 50, now), narrow.length],
  ["OLD ranker, wide pool", (ev, now) => oldRank(ev, wide, 50, now), wide.length],
  ["Most popular (baseline)", (ev) => popRank(ev, wide, 50), wide.length],
  ["NEW score order (wide pool)", (ev, now) => newRank(ev, wide, 50, now, { raw: true }), wide.length],
  ["NEW re-ranked (wide pool)", (ev, now) => newRank(ev, wide, 50, now), wide.length],
  ["NEW re-ranked (old pool)", (ev, now) => newRank(ev, narrow, 50, now), narrow.length],
  ["NEW, no TMDB (lite records)", (ev, now) => liteRank(ev, 50, now), wide.length],
];
if (flag("ablate")) {
  const off = (k) => ({ ...features.W_SIM, [k]: 0 });
  const offT = (k) => ({ ...rank.W_TASTE, [k]: 0 });
  CONFIGS.push(
    ["  ablation: taste vector only", (ev, now) => newRank(ev, wide, 50, now, { raw: true, mix: { ...rank.MIX, nearest: 0, taste: 1 } }), wide.length],
    ["  ablation: nearest-liked only", (ev, now) => newRank(ev, wide, 50, now, { raw: true, mix: { ...rank.MIX, nearest: 1, taste: 0 } }), wide.length],
    ["  ablation: no link graph", (ev, now) => newRank(ev, wide, 50, now, { raw: true, simWeights: off("link"), tasteWeights: offT("link") }), wide.length],
    ["  ablation: no themes", (ev, now) => newRank(ev, wide, 50, now, { raw: true, simWeights: off("theme"), tasteWeights: offT("theme") }), wide.length],
    ["  ablation: no keywords", (ev, now) => newRank(ev, wide, 50, now, { raw: true, simWeights: off("kw"), tasteWeights: offT("kw") }), wide.length],
    ["  ablation: no people", (ev, now) => newRank(ev, wide, 50, now, { raw: true, simWeights: off("people"), tasteWeights: offT("people") }), wide.length],
    ["  ablation: no plot words", (ev, now) => newRank(ev, wide, 50, now, { raw: true, simWeights: off("plot"), tasteWeights: offT("plot") }), wide.length],
    ["  ablation: genre only", (ev, now) => newRank(ev, wide, 50, now, { raw: true, simWeights: { genre: 1, meta: 0.3 }, tasteWeights: { genre: 1, meta: 0.3 } }), wide.length],
    ["  ablation: no quality prior", (ev, now) => newRank(ev, wide, 50, now, { raw: true, mix: { ...rank.MIX, quality: 0 } }), wide.length],
  );
}

// ---------- 1. the household, replayed ----------
const K = parseInt(arg("k", "5"), 10);
const profPath = arg("profiles", null);
if (profPath) {
  const P = JSON.parse(fs.readFileSync(profPath, "utf8"));
  const accs = CONFIGS.map(() => blank());
  const perProfile = [];
  let letter = 0;
  for (const p of P.profiles || []) {
    const state = (P.state || {})[p.id];
    if (!state) continue;
    const epsOf = (id) => (recOf.get(id) || {}).eps || null;
    const full = person.collectEvents(state, { follows: p.follows || [], now: NOW, episodesOf: epsOf });
    // liked, dated, and known to the index — the titles worth predicting
    const liked = [...full.titles.values()].filter((t) => t.w >= 1 && t.at && recOf.has(t.id)).sort((a, b) => a.at - b.at);
    const label = `Profile ${String.fromCharCode(65 + letter++)}`;
    if (liked.length < 4) { perProfile.push(`${label}: ${liked.length} liked+dated titles — too little history, skipped`); continue; }
    const k = Math.min(K, Math.floor(liked.length / 3) || 1);
    const heldTitles = liked.slice(-k);
    const cutoff = heldTitles[0].at - 1;
    const held = heldTitles.map((t) => t.id);
    // the state as it stood at the cutoff: later rows gone, later-only titles gone
    const past = {
      ...state,
      titles: Object.fromEntries(Object.entries(state.titles || {}).filter(([, r]) => (r.updatedAt || 0) <= cutoff)),
      ratings: Object.fromEntries(Object.entries(state.ratings || {}).filter(([key]) => !held.includes(key))),
      watchlist: (state.watchlist || []).filter((e) => !held.includes(typeof e === "string" ? e : e && e.imdbId)),
      likedTitles: (state.likedTitles || []).filter((t) => !held.includes(t.imdbId)),
      dismissed: {},
    };
    const ev = person.collectEvents(past, { follows: (p.follows || []).filter((f) => (f.at || 0) <= cutoff && !held.includes(f.imdbId)), now: cutoff, episodesOf: epsOf });
    for (const h of held) ev.seen.delete(h);
    const model = modelOf(ev, cutoff);
    const line = [`${label}: ${ev.titles.size} titles of evidence (mass ${model.mass.toFixed(1)}), ${held.length} hidden —`];
    CONFIGS.forEach(([name, fn, poolSize], i) => {
      const ranked = fn(ev, cutoff);
      measure(accs[i], ranked, held, model.genreShare, poolSize);
      if (i === 0 || i === 1 || i === 4) line.push(`${name.split(" (")[0].split(",")[0]} ${held.filter((h) => ranked.slice(0, 20).includes(h)).length}/${held.length} in top 20`);
    });
    perProfile.push(line.join("  "));
  }
  console.log(`\n== Household replay, temporal (hide each profile's ${K} most recent liked titles; pool ${wide.length} titles) ==`);
  console.log(perProfile.join("\n"));
  CONFIGS.forEach(([name], i) => console.log(row(name, accs[i])));

  // The same history, squeezed for every case it holds: hide ONE liked title
  // at a time (dated or not), keep everything else, ask where it lands. Not a
  // temporal test — the model sees what came after the hidden title — so it
  // flatters everyone equally; it is here because the temporal split leaves
  // a handful of cases.
  const loo = CONFIGS.map(() => blank());
  const looLines = [];
  letter = 0;
  for (const p of P.profiles || []) {
    const state = (P.state || {})[p.id];
    if (!state) continue;
    const label = `Profile ${String.fromCharCode(65 + letter++)}`;
    const epsOf = (id) => (recOf.get(id) || {}).eps || null;
    const full = person.collectEvents(state, { follows: p.follows || [], now: NOW, episodesOf: epsOf });
    const liked = [...full.titles.values()].filter((t) => t.w >= 1 && recOf.has(t.id)).map((t) => t.id);
    if (liked.length < 3) { looLines.push(`${label}: ${liked.length} liked titles — skipped`); continue; }
    const hits = CONFIGS.map(() => 0);
    for (const h of liked) {
      const without = {
        ...state,
        titles: Object.fromEntries(Object.entries(state.titles || {}).filter(([key]) => key.split(":")[0] !== h)),
        ratings: Object.fromEntries(Object.entries(state.ratings || {}).filter(([key]) => key !== h)),
        watchlist: (state.watchlist || []).filter((e) => (typeof e === "string" ? e : e && e.imdbId) !== h),
        likedTitles: (state.likedTitles || []).filter((t) => t.imdbId !== h),
        dismissed: {},
      };
      const ev = person.collectEvents(without, { follows: (p.follows || []).filter((f) => f.imdbId !== h), now: NOW, episodesOf: epsOf });
      ev.seen.delete(h);
      const model = modelOf(ev, NOW);
      CONFIGS.forEach(([, fn, poolSize], i) => {
        const ranked = fn(ev, NOW);
        measure(loo[i], ranked, [h], model.genreShare, poolSize);
        if (ranked.slice(0, 20).includes(h)) hits[i]++;
      });
    }
    looLines.push(`${label}: ${liked.length} liked titles, each hidden in turn — in the top 20: OLD ${hits[0]}, OLD/wide ${hits[1]}, NEW ${hits[4]}`);
  }
  console.log(`\n== Household replay, leave-one-out (every liked title hidden in turn) ==`);
  console.log(looLines.join("\n"));
  CONFIGS.forEach(([name], i) => console.log(row(name, loo[i])));
}

// ---------- 2. personas ----------
const resolved = JSON.parse(fs.readFileSync(path.join(__dirname, "personas.resolved.json"), "utf8"));
const personaIds = (p) => {
  if (p.mix) return p.mix.flatMap((id) => personaIds(personas.find((x) => x.id === id)));
  return p.titles.map(([title, year, kind]) => (resolved[`${kind}|${title}|${year}`] || {}).imdbId).filter((id) => id && recOf.has(id));
};
// a persona's history as stored state: films finished, series eight episodes in
const stateOf = (ids, now) => {
  const titles = {};
  ids.forEach((id, i) => {
    const at = now - (ids.length - i) * 9 * DAY; // one every nine days, oldest first
    const r = recOf.get(id);
    if (r.k === "tv") for (let e = 1; e <= 8; e++) titles[`${id}:1:${e}`] = { position: 3000, duration: 3000, finished: true, updatedAt: at - (8 - e) * 2 * DAY };
    else titles[id] = { position: 6000, duration: 6000, finished: true, updatedAt: at };
  });
  return { titles };
};
const shuffle = (list, seed) => list.map((x) => [rank.rand01(seed, x), x]).sort((a, b) => a[0] - b[0]).map((e) => e[1]);

const SPLITS = parseInt(arg("splits", "6"), 10);
const accs = CONFIGS.map(() => blank());
for (const p of personas) {
  const ids = personaIds(p);
  for (let s = 0; s < SPLITS; s++) {
    const order = shuffle(ids, `${p.id}|${s}`);
    const holdN = Math.max(3, Math.round(order.length * 0.3));
    const held = order.slice(0, holdN);
    const train = order.slice(holdN);
    const ev = person.collectEvents(stateOf(train, NOW), { now: NOW, episodesOf: (id) => (recOf.get(id) || {}).eps || null });
    const model = modelOf(ev, NOW);
    CONFIGS.forEach(([, fn, poolSize], i) => measure(accs[i], fn(ev, NOW), held, model.genreShare, poolSize));
  }
}
console.log(`\n== Personas (${personas.length} personas x ${SPLITS} random splits, 30% of each history hidden; pool ${wide.length} titles) ==`);
CONFIGS.forEach(([name], i) => console.log(row(name, accs[i])));

// per persona: where the hidden titles land, and whether the row is ON THEME.
// "On theme" = share of the top 10 carrying one of the themes the persona is
// defined by — not an accuracy measure (the new ranker reads themes, so it is
// partly marking its own homework); it answers "does a heist fan get heists,
// or just well-rated crime films?".
const THEMES_OF = {
  "scifi-slowburn": ["space", "ai-robots", "aliens", "time-travel", "dystopia", "slow-burn", "mind-bending", "science", "multiverse"],
  "family-animation": ["kids-adventure", "animal-tales", "fairy-tale", "found-family", "feel-good", "coming-of-age"],
  "true-crime-docs": ["true-crime", "documentary-real", "serial-killer", "courtroom", "con-artist", "detective"],
  "nineties-action": ["action-spectacle", "terrorism", "cop-drama", "buddy", "espionage", "martial-arts", "undercover", "retro-20c"],
  "heists-cons": ["heist", "con-artist"],
  "feelgood-romcom": ["romcom", "feel-good", "hangout", "workplace", "love-story", "witty-comedy"],
  "elevated-horror": ["ghosts-hauntings", "possession-occult", "folk-horror", "supernatural", "creepy", "psychological", "grief"],
  "crime-drama-tv": ["organized-crime", "drug-trade", "antihero", "cop-drama", "neo-noir", "dark-gritty"],
  "epic-fantasy": ["high-fantasy", "magic", "fairy-tale", "medieval-ancient", "legacy-epic"],
};
{
  const cols = [
    ["OLD", (ev) => oldRank(ev, wide, 20, NOW)],
    ["genre+quality", (ev) => newRank(ev, wide, 20, NOW, { raw: true, simWeights: { genre: 1, meta: 0.3 }, tasteWeights: { genre: 1, meta: 0.3 } })],
    ["NEW", (ev) => newRank(ev, wide, 20, NOW)],
  ];
  console.log("\n== Per persona: recall@20 of hidden titles | on-theme share of the top 10 (6 splits) ==");
  console.log("persona".padEnd(22) + cols.map((c) => c[0].padStart(22)).join(""));
  const tot = cols.map(() => [0, 0, 0, 0]);
  for (const p of personas) {
    const ids = personaIds(p);
    const themes = p.mix ? p.mix.flatMap((m) => THEMES_OF[m]) : THEMES_OF[p.id];
    const cells = cols.map(() => [0, 0, 0, 0]);
    for (let sp = 0; sp < SPLITS; sp++) {
      const order = shuffle(ids, `${p.id}|${sp}`);
      const holdN = Math.max(3, Math.round(order.length * 0.3));
      const held = order.slice(0, holdN);
      const ev = person.collectEvents(stateOf(order.slice(holdN), NOW), { now: NOW, episodesOf: (id) => (recOf.get(id) || {}).eps || null });
      cols.forEach(([, fn], i) => {
        const ranked = fn(ev);
        cells[i][0] += held.filter((h) => ranked.includes(h)).length;
        cells[i][1] += held.length;
        const top = ranked.slice(0, 10);
        cells[i][2] += top.filter((id) => themes.some((t) => (vec.get(id).themes[t] || 0) >= 0.7)).length;
        cells[i][3] += top.length;
      });
    }
    cells.forEach((c, i) => c.forEach((x, j) => { tot[i][j] += x; }));
    console.log(p.id.padEnd(22) + cells.map((c) => `${((100 * c[0]) / c[1]).toFixed(0).padStart(8)}% | ${((100 * c[2]) / (c[3] || 1)).toFixed(0).padStart(3)}% on`.padStart(22)).join(""));
  }
  console.log("ALL".padEnd(22) + tot.map((c) => `${((100 * c[0]) / c[1]).toFixed(0).padStart(8)}% | ${((100 * c[2]) / (c[3] || 1)).toFixed(0).padStart(3)}% on`.padStart(22)).join(""));
}

// ---------- item-to-item, against a ground truth we did not write ----------
// TMDB's "recommendations" for a title are collaborative ("people who liked
// this also liked") — independent of keywords, themes, people and plot. For a
// few hundred titles: rank every other title by content similarity WITHOUT
// the link graph (which is built from those very lists) and count how many of
// TMDB's recommendations come back in the top 20. Genre-only similarity is
// what "More like this" on the TV and the old home rows amounted to.
{
  const withRecs = all.filter((r) => !r.lite && (r.recs || []).filter((id) => titleindex.byTmdb(r.k, id)).length >= 5);
  const sample = shuffle(withRecs.map((r) => r.id), "item-item").slice(0, parseInt(arg("items", "400"), 10));
  const variants = [
    ["genre only", { genre: 1 }],
    ["genre + era/lang/kind", { genre: 1, meta: 0.4 }],
    ["+ plot words", { genre: 0.17, meta: 0.07, plot: 0.06 }],
    ["+ people", { genre: 0.17, meta: 0.07, plot: 0.06, people: 0.09 }],
    ["+ keywords", { genre: 0.17, meta: 0.07, plot: 0.06, people: 0.09, kw: 0.24 }],
    ["+ themes (all but link)", { ...features.W_SIM, link: 0 }],
    ["themes without keywords", { ...features.W_SIM, link: 0, kw: 0 }],
  ];
  console.log(`\n== Item-to-item vs TMDB's collaborative lists (${sample.length} titles, top 20 of ${all.length}) ==`);
  for (const [name, weights] of variants) {
    let hit = 0;
    let total = 0;
    let rr = 0;
    for (const id of sample) {
      const r = recOf.get(id);
      const truth = new Set(r.recs.map((t) => titleindex.byTmdb(r.k, t)).filter(Boolean).map((x) => x.id));
      const v = vec.get(id);
      const ranked = wide.filter((c) => c.id !== id && c.rec.k === r.k).map((c) => [features.similarity(v, c.v, weights), c.id]).sort((a, b) => b[0] - a[0]).slice(0, 20);
      const got = ranked.filter((e) => truth.has(e[1])).length;
      hit += got;
      total += Math.min(20, truth.size);
      const first = ranked.findIndex((e) => truth.has(e[1]));
      if (first > -1) rr += 1 / (first + 1);
    }
    console.log(`${name.padEnd(28)} recall@20 ${((100 * hit) / total).toFixed(1).padStart(5)}%   MRR ${(rr / sample.length).toFixed(3)}`);
  }
}

// ---------- 3. examples ----------
if (flag("examples")) {
  const name = (id) => { const r = recOf.get(id); return `${r.title} (${r.year || "?"})`; };
  for (const p of personas) {
    const ids = personaIds(p);
    const ev = person.collectEvents(stateOf(ids, NOW), { now: NOW, episodesOf: (id) => (recOf.get(id) || {}).eps || null });
    const model = modelOf(ev, NOW);
    console.log(`\n--- ${p.name} ---`);
    console.log(`history: ${ids.map((id) => recOf.get(id).title).join(", ")}`);
    console.log(`OLD top 10 (its own pool): ${oldRank(ev, narrow, 10, NOW).map(name).join(" | ")}`);
    console.log(`OLD top 10 (wide pool):    ${oldRank(ev, wide, 10, NOW).map(name).join(" | ")}`);
    const built = rank.buildRows(model, wide, { seed: `eval|${p.id}` });
    for (const r of built.rows) {
      console.log(`NEW row "${r.title}": ${r.items.slice(0, 10).map((s) => name(s.id)).join(" | ")}`);
      if (r.id === "recommended") console.log(`   why (first 4): ${r.items.slice(0, 4).map((s) => `${recOf.get(s.id).title} ← ${s.why}`).join("; ")}`);
    }
  }
}
process.exit(0);
