// A title as the recommender sees it: eight small sparse vectors ("blocks"),
// each unit length, built from the title-index record.
//
//   genre    canonical genres, the first-listed weighing most, common ones
//            (Drama) discounted
//   theme    the taxonomy's themes (taxonomy.json): heist, slow-burn, dystopia…
//   kw       TMDB's own keywords, weighted by rarity across the index — the
//            long tail the taxonomy does not name ("tesseract", "linguist")
//   people   director / creator 1.0, writer 0.5, cast 0.6 falling by billing
//   plot     the synopsis' most telling words (TF-IDF) — the only "aboutness"
//            a title with no keywords has
//   meta     era (neighbouring decades count a little), language, film/series,
//            runtime band, age band, country
//   col      the franchise
//   link     TMDB's "people who liked this also liked" lists, as a graph: a
//            title points at itself and at its recommended neighbours, so two
//            titles are close when one recommends the other or they are
//            recommended alongside the same things. The one collaborative
//            signal available without any users of our own — and the only
//            thing that sees STYLE (keywords never say "Wes Anderson").
//
// A block is stored as { k: Int32Array (sorted feature ids), w: Float32Array }
// — feature names are interned to integers once — so a dot product is a merge
// of two short sorted arrays: ~1 µs, which is what lets a profile be compared
// against every title in the index on a request.
//
// Two titles are alike by the weighted sum of their per-block cosines
// (similarity()); a person's taste is a signed sum of the same blocks
// (person.js). Everything is plain objects and arithmetic: no model file, no
// native dependency, and every score can be broken down and read.
//
// Pure. `stats` (document frequencies) comes from buildStats() over whatever
// records exist; tests pass their own.
const tax = require("./taxonomy");

const W_SIM = { kw: 0.24, theme: 0.22, genre: 0.17, link: 0.12, people: 0.09, plot: 0.06, meta: 0.07, col: 0.03 };
const BLOCKS = Object.keys(W_SIM);

const PLOT_STOP = new Set((
  "about after again against also among another around away back because become becomes been before begin begins being between " +
  "both came come comes could does down during each even ever every find finds first from gets give goes have having help helps " +
  "her here hers herself him himself his home however into itself just know known last later leave life like live lives long " +
  "look make makes many more most much must named near never new next nothing only other over own part past people place " +
  "same seems series set several she should show since some something soon still story such take takes than that the their them " +
  "themselves then there these they thing this those three through time together too turn turns two under until upon very want " +
  "wants was way well were what when where which while who whose will with within without world would year years young your film movie " +
  "follows following based true events season episode episodes documentary man woman men women group one named called tells tale"
).split(/\s+/));

const tokens = (text) => {
  const out = [];
  for (const w of String(text || "").toLowerCase().split(/[^a-z']+/)) {
    const t = w.replace(/'s$|'$/g, "").replace(/^'/, "");
    if (t.length >= 4 && !PLOT_STOP.has(t)) out.push(t);
  }
  return out;
};

// Document frequencies over the index. Rebuilt occasionally, not per record:
// an IDF that is a few hundred titles out of date ranks the same.
const buildStats = (records) => {
  const kw = new Map();
  const term = new Map();
  const genre = new Map();
  const theme = new Map();
  let n = 0;
  for (const r of records) {
    n++;
    for (const k of new Set((r.kw || []).map((x) => x[1]))) kw.set(k, (kw.get(k) || 0) + 1);
    for (const t of new Set(tokens(r.ov))) term.set(t, (term.get(t) || 0) + 1);
    for (const g of r.g || []) genre.set(g, (genre.get(g) || 0) + 1);
    for (const s of Object.keys(themesFor(r))) theme.set(s, (theme.get(s) || 0) + 1);
  }
  return { n: Math.max(1, n), kw, term, genre, theme };
};

const themeCache = new WeakMap();
const themesFor = (rec) => {
  let t = themeCache.get(rec);
  if (!t) {
    t = tax.themesOf({ keywords: (rec.kw || []).map((k) => k[1]), overview: rec.ov, genres: rec.g || [] });
    themeCache.set(rec, t);
  }
  return t;
};

// feature name -> small integer, per process ("theme:heist" -> 4711)
const ids = new Map();
const names = [];
const intern = (name) => {
  let id = ids.get(name);
  if (id === undefined) {
    id = names.length;
    ids.set(name, id);
    names.push(name);
  }
  return id;
};
const nameOf = (id) => names[id];
// "theme|heist" -> "heist"
const bare = (name) => name.slice(name.indexOf("|") + 1);

// {name: weight} -> a unit-length packed block, or null when empty
const pack = (prefix, v) => {
  const entries = [];
  let sq = 0;
  for (const key in v) {
    const w = v[key];
    if (!w) continue;
    entries.push([intern(prefix + key), w]);
    sq += w * w;
  }
  if (!sq) return null;
  entries.sort((a, b) => a[0] - b[0]);
  const norm = Math.sqrt(sq);
  const k = new Int32Array(entries.length);
  const w = new Float32Array(entries.length);
  for (let i = 0; i < entries.length; i++) {
    k[i] = entries[i][0];
    w[i] = entries[i][1] / norm;
  }
  return { k, w };
};
// a packed block back to {name: weight} (names without their block prefix)
const unpack = (blk) => {
  const out = {};
  if (blk) for (let i = 0; i < blk.k.length; i++) out[bare(names[blk.k[i]])] = blk.w[i];
  return out;
};

const eraOf = (year) => (year ? Math.floor(year / 10) * 10 : null);
const runtimeBand = (rec) => {
  if (!rec.rt) return null;
  if (rec.k === "tv") return rec.rt <= 32 ? "half-hour" : "hour";
  return rec.rt < 95 ? "short" : rec.rt <= 130 ? "mid" : "long";
};
const ageBand = (age) => (age == null ? null : age <= 7 ? "kids" : age <= 12 ? "family" : age <= 15 ? "teen" : "adult");

// The record -> its blocks. A block the record has nothing for is null.
const vectorOf = (rec, stats) => {
  const N = stats.n;
  const idf = (map, key, floor = 2) => {
    const df = map.get(key) || 0;
    return df < floor ? 0 : Math.log(1 + N / df);
  };

  // genre: order matters (a title's first genre is what it IS); Drama on a
  // third of the index says less than Western on 2%
  const genre = {};
  const soft = !rec.cg && (rec.gid || []).includes(10765); // TMDB's lumped "Sci-Fi & Fantasy"
  const themes = themesFor(rec);
  (rec.g || []).forEach((g, i) => {
    let w = Math.max(0.5, 1 - 0.15 * i) * Math.sqrt(Math.log(1 + N / Math.max(1, stats.genre.get(g) || 1)));
    if (soft && (g === "Sci-Fi" || g === "Fantasy")) w *= softGenreShare(g, themes);
    if (w > 0) genre[g] = w;
  });

  const theme = {};
  for (const [slug, w] of Object.entries(themes)) {
    theme[slug] = w * Math.sqrt(Math.log(1 + N / Math.max(1, stats.theme.get(slug) || 1)));
  }

  const kw = {};
  const scoredKw = [];
  for (const [, name] of rec.kw || []) {
    if (tax.STOP.has(name)) continue;
    const w = idf(stats.kw, name);
    if (w > 0) scoredKw.push([name, w]);
  }
  scoredKw.sort((a, b) => b[1] - a[1]);
  for (const [name, w] of scoredKw.slice(0, 24)) kw[name] = w;

  const people = {};
  for (const [id] of rec.dir || []) people[`d${id}`] = 1;
  for (const [id] of rec.cre || []) people[`d${id}`] = 1; // a creator is a series' director-equivalent
  for (const [id] of rec.wr || []) if (!people[`d${id}`]) people[`w${id}`] = 0.5;
  (rec.cast || []).slice(0, 6).forEach(([id], i) => { people[`a${id}`] = 0.6 * Math.pow(0.85, i); });

  const plot = {};
  const tf = new Map();
  for (const t of tokens(rec.ov)) tf.set(t, (tf.get(t) || 0) + 1);
  const scoredTerms = [];
  for (const [t, n] of tf) {
    const df = stats.term.get(t) || 0;
    if (df < 2 || df > N * 0.12) continue;
    scoredTerms.push([t, (1 + Math.log(n)) * Math.log(1 + N / df)]);
  }
  scoredTerms.sort((a, b) => b[1] - a[1]);
  for (const [t, w] of scoredTerms.slice(0, 12)) plot[t] = w;

  const meta = {};
  const era = eraOf(rec.year);
  if (era) {
    meta[`era${era}`] = 1;
    meta[`era${era - 10}`] = 0.4;
    meta[`era${era + 10}`] = 0.4;
  }
  if (rec.lang) meta[`lang:${rec.lang}`] = 0.8;
  meta[`kind:${rec.k}`] = 0.6;
  const rt = runtimeBand(rec);
  if (rt) meta[`rt:${rt}`] = 0.3;
  const ab = ageBand(rec.age);
  if (ab) meta[`age:${ab}`] = 0.5;
  for (const c of (rec.cc || []).slice(0, 1)) meta[`cc:${c}`] = 0.3;

  const col = rec.col ? { [`c${rec.col[0]}`]: 1 } : {};

  // the recommendation graph: itself, then what TMDB recommends beside it
  // (its order is its confidence), then its plain "similar" list, weakly
  const link = {};
  if (rec.tm) {
    const key = (id) => `${rec.k}${id}`;
    link[key(rec.tm)] = 1;
    (rec.recs || []).forEach((id, i) => { link[key(id)] = Math.max(link[key(id)] || 0, 0.8 * (1 - i / 30)); });
    (rec.sim || []).forEach((id) => { if (!link[key(id)]) link[key(id)] = 0.25; });
  }

  return {
    id: rec.id,
    genre: pack("genre|", genre), theme: pack("theme|", theme), kw: pack("kw|", kw), people: pack("people|", people),
    plot: pack("plot|", plot), meta: pack("meta|", meta), col: pack("col|", col), link: pack("link|", link),
    themes, // raw theme weights, for rows and reasons
    genres: rec.g || [],
    lite: !!rec.lite,
  };
};

// TMDB files a series under "Sci-Fi & Fantasy" whichever it is. The themes
// know: space / A.I. / dystopia say sci-fi; magic / dragons / hauntings say
// fantasy. Returns this genre's share (1 when the evidence is all its way,
// 0.25 when it is all the other's, 0.7 when there is none).
const SCIFI_THEMES = ["space", "space-opera", "aliens", "ai-robots", "dystopia", "post-apocalypse", "cyberpunk", "time-travel", "multiverse", "science"];
const FANTASY_THEMES = ["magic", "high-fantasy", "fairy-tale", "supernatural", "ghosts-hauntings", "possession-occult", "vampires-werewolves", "medieval-ancient", "teen-supernatural"];
const softGenreShare = (genre, themes) => {
  const sf = SCIFI_THEMES.reduce((n, s) => n + (themes[s] || 0), 0);
  const fa = FANTASY_THEMES.reduce((n, s) => n + (themes[s] || 0), 0);
  if (!sf && !fa) return 0.7;
  const mine = genre === "Sci-Fi" ? sf : fa;
  return 0.25 + 0.75 * (mine / (sf + fa));
};

// merge two sorted packed blocks
const dot = (a, b) => {
  if (!a || !b) return 0;
  const ak = a.k;
  const bk = b.k;
  let i = 0;
  let j = 0;
  let s = 0;
  const n = ak.length;
  const m = bk.length;
  while (i < n && j < m) {
    const x = ak[i];
    const y = bk[j];
    if (x === y) { s += a.w[i] * b.w[j]; i++; j++; }
    else if (x < y) i++;
    else j++;
  }
  return s;
};
// a packed block against a dense-ish Map(featureId -> weight) (a person's taste)
const dotMap = (map, blk) => {
  if (!map || !blk) return 0;
  let s = 0;
  const k = blk.k;
  for (let i = 0; i < k.length; i++) {
    const v = map.get(k[i]);
    if (v !== undefined) s += v * blk.w[i];
  }
  return s;
};

// How alike two titles are, 0..1. Blocks one of them lacks (a lite record
// has no keywords or people) do not count against the pair in full — half
// their weight stays in the denominator, so a match on less evidence scores
// a little lower than the same match on more. A shared franchise is a bonus;
// lacking one is not a shortfall.
const similarity = (a, b, weights = W_SIM) => {
  let num = 0;
  let den = 0;
  for (let n = 0; n < BLOCKS.length; n++) {
    const blk = BLOCKS[n];
    const w = weights[blk];
    if (!w) continue;
    const x = a[blk];
    const y = b[blk];
    if (blk === "col") {
      if (x && y) num += w * dot(x, y);
      continue;
    }
    if (x && y) {
      num += w * dot(x, y);
      den += w;
    } else den += w * 0.5;
  }
  return den ? Math.min(1, num / den) : 0;
};

// Per-block parts of a similarity and what is shared, for the tuning view
// and for reasons ("Same vibe: heist · con artists").
const sharedOf = (x, y) => {
  if (!x || !y) return [];
  const out = [];
  let i = 0;
  let j = 0;
  while (i < x.k.length && j < y.k.length) {
    if (x.k[i] === y.k[j]) { out.push([bare(names[x.k[i]]), x.w[i] * y.w[j]]); i++; j++; }
    else if (x.k[i] < y.k[j]) i++;
    else j++;
  }
  return out.sort((p, q) => q[1] - p[1]).map((e) => e[0]);
};
const explain = (a, b, weights = W_SIM) => {
  const parts = {};
  for (const blk of BLOCKS) parts[blk] = a[blk] && b[blk] ? Math.round(dot(a[blk], b[blk]) * 1000) / 1000 : null;
  return {
    sim: similarity(a, b, weights), parts,
    themes: sharedOf(a.theme, b.theme), keywords: sharedOf(a.kw, b.kw), people: sharedOf(a.people, b.people),
  };
};

// ---------- priors ----------
// Bayesian-shrunk rating on 0..1 (a 9.1 from 12 votes is not a 9.1). A lite
// record's rating is IMDb's with an unknown vote count: trusted as if a few
// hundred people had voted.
const qualityOf = (rec) => {
  const prior = 6.6;
  const weight = 300;
  const votes = rec.lite ? (rec.va ? 400 : 0) : rec.vc || 0;
  const bayes = ((rec.va || 0) * votes + prior * weight) / (votes + weight);
  return Math.max(0, Math.min(1, (bayes - 5.5) / 3));
};
// How well known, 0..1 (log votes). Used for novelty in the evaluation and as
// a very small prior in ranking.
const popularityOf = (rec) => Math.max(0, Math.min(1, Math.log10((rec.vc || 0) + 1) / 4.3));
// Released in the last ~18 months: 1 → 0.
const freshnessOf = (rec, now = Date.now()) => {
  const at = rec.rel ? Date.parse(rec.rel) : rec.year ? Date.UTC(rec.year, 6, 1) : NaN;
  if (!Number.isFinite(at)) return 0;
  const days = (now - at) / 86400000;
  return days < 0 ? 0 : Math.max(0, 1 - days / 550);
};

module.exports = {
  buildStats, vectorOf, similarity, explain, sharedOf, dot, dotMap, pack, unpack, intern, nameOf,
  qualityOf, popularityOf, freshnessOf, themesFor, tokens,
  W_SIM, BLOCKS,
  _internals: { softGenreShare, eraOf, runtimeBand, ageBand },
};
