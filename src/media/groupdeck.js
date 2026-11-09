// "What do we watch tonight?" — the deck and the group score (2026-11-09).
//
// A few people in a room swipe yes / maybe / no on their own phones; this is
// the pure part: which titles go in the deck, and how the answers become one
// pick everyone can live with. docs/group-pick.md explains it for people.
//
// THE DECK (buildDeck)
//   FROM          the household's own candidates: the library (always), the
//                 recommender's index and the well-known catalogue (the "Swipe
//                 your taste" pool, media/tastedeck.js) — gathered by the
//                 route (routes/group.js), handed in here.
//   FILTERED      by the starter's choices: films / series / both, a mood
//                 (MOODS: genres, plus the taxonomy's themes when the index
//                 knows them), a length ("under 2 h" — a film's runtime, a
//                 series' episode length), and the strictest kids limit in
//                 the room (the `allow` predicate).
//   SEEN          a title EVERY voter has seen is out; one some have seen
//                 stays, lower down ("Dana has seen it" on the card).
//   FAIR FIT      each voter's own fit for every candidate (the recommender's
//                 person model, routes/group.js) is turned into a PERCENTILE
//                 among the candidates, so a person with a long history (big
//                 raw scores) does not outvote a person with a short one. The
//                 group fit is 0.6 x the average + 0.4 x the lowest: a title
//                 one person would hate does not get in on the others' love.
//   ON THE SERVER a library title scores higher (it plays now, no download):
//                 and at least LIB_SHARE of the deck is the library while the
//                 library has enough that fits.
//   VARIED        a genre already in the deck counts a little less each time,
//                 so twenty cards are not twenty thrillers.
//
// THE GROUP SCORE (groupScore / results)
//   yes = 1, maybe = 0.6, no = 0, not answered = 0.45 (a shrug)
//   score = 0.55 x average + 0.45 x lowest  (+ 0.04 x the deck's group fit, a tie-break)
//   The average says "most of us want it"; the lowest is the least-misery
//   rule — one "no" pulls a title down hard, but is not an absolute veto when
//   nothing else got through. A title needs at least one yes to be picked.
//   Everyone-said-yes titles come first, whatever their score.
//   "Why" is counted, never named: "3 of 3 said yes", "2 of 3 said yes · 1
//   maybe". Who said no is nobody's business at a sofa.
"use strict";

const tax = require("./recs/taxonomy");

const DECK_SIZE = 20;
const LIB_SHARE = 0.5;
const VOTE_VALUE = { yes: 1, maybe: 0.6, no: 0 };
const MISSING = 0.45;
const VERDICTS = ["yes", "maybe", "no"];

// The moods the starter can pick. `genres`: any one of them is a match;
// `themes`: the taxonomy's slugs (taxonomy.json), a match too when the index
// knows the title's themes; `not`: genres that rule a title out of the mood
// (a "feel-good" horror is not).
const MOODS = [
  { id: "any", label: "Anything" },
  { id: "funny", label: "Funny", genres: ["Comedy"], themes: ["light-fun", "witty-comedy", "romcom", "satire"], not: ["Horror"] },
  { id: "thrilling", label: "Edge of the seat", genres: ["Thriller", "Action", "Crime"], themes: ["suspense", "action-spectacle", "heist", "manhunt"] },
  { id: "feelgood", label: "Feel-good", genres: ["Family", "Animation", "Romance"], themes: ["feel-good", "light-fun", "romcom", "underdog"], not: ["Horror", "War"] },
  { id: "mindbending", label: "Mind-bending", genres: ["Sci-Fi", "Mystery"], themes: ["mind-bending", "time-travel", "psychological", "multiverse"] },
  { id: "scary", label: "Scary", genres: ["Horror"], themes: ["creepy", "slasher", "ghosts-hauntings", "possession-occult"] },
  { id: "emotional", label: "A good cry", genres: ["Drama", "Romance"], themes: ["emotional", "love-story", "grief"], not: ["Horror"] },
  { id: "family", label: "Family night", genres: ["Family", "Animation"], themes: ["kids-adventure", "animal-tales", "fairy-tale"], not: ["Horror"] },
  { id: "true", label: "True stories", genres: ["Documentary", "Biography", "History"], themes: ["true-story", "documentary-real", "true-crime"] },
];
const MOOD_BY_ID = new Map(MOODS.map((m) => [m.id, m]));
// Lengths, in minutes (null = any). A film's runtime, a series' episode.
const LENGTHS = [
  { id: "any", label: "Any length", max: null },
  { id: "90", label: "Under 1 h 30", max: 90 },
  { id: "120", label: "Under 2 h", max: 120 },
  { id: "150", label: "Under 2 h 30", max: 150 },
];
const LENGTH_BY_ID = new Map(LENGTHS.map((l) => [l.id, l]));
const KINDS = [
  { id: "movie", label: "Films" },
  { id: "both", label: "Films and series" },
  { id: "show", label: "Series" },
];

// What the starter chose, made safe. Unknown values fall back to the defaults.
const cleanSettings = (raw = {}) => {
  const kind = KINDS.some((k) => k.id === raw.kind) ? raw.kind : "movie";
  const mood = MOOD_BY_ID.has(raw.mood) ? raw.mood : "any";
  const length = LENGTH_BY_ID.has(String(raw.length)) ? String(raw.length) : "any";
  return { kind, mood, length };
};

// ---------- the filters ----------
const moodMatch = (c, moodId) => {
  const m = MOOD_BY_ID.get(moodId);
  if (!m || !m.genres) return true;
  const gs = c.genres || [];
  if (m.not && gs.some((g) => m.not.includes(g))) return false;
  if (gs.some((g) => m.genres.includes(g))) return true;
  const th = c.themes || null;
  return !!(th && m.themes && m.themes.some((s) => (th[s] || 0) > 0));
};
const lengthOk = (c, lengthId) => {
  const l = LENGTH_BY_ID.get(lengthId);
  if (!l || !l.max) return true;
  // an unknown runtime is let through: most library films have one, and a
  // catalogue film without one is better asked about than dropped
  if (!c.runtime) return true;
  return c.runtime <= l.max;
};
const kindOk = (c, kind) => kind === "both" || c.type === kind;

// ---------- small helpers ----------
const percentiles = (values) => {
  // values: [number|null]; null stays null (that voter knows nothing of it)
  const idx = values.map((v, i) => [v, i]).filter(([v]) => v != null && Number.isFinite(v)).sort((a, b) => a[0] - b[0]);
  const out = values.map(() => null);
  const n = idx.length;
  if (!n) return out;
  for (let r = 0; r < n; ) {
    let e = r;
    while (e + 1 < n && idx[e + 1][0] === idx[r][0]) e++;
    const p = n === 1 ? 0.5 : ((r + e) / 2) / (n - 1); // ties share their average rank
    for (let k = r; k <= e; k++) out[idx[k][1]] = p;
    r = e + 1;
  }
  return out;
};
const rand01 = (seed, id) => {
  let h = 2166136261;
  const str = `${seed}|${id}`;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  let t = (h + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const keyOf = (c) => c.key || (c.id ? `lib:${c.id}` : c.imdbId);

// ---------- the deck ----------
// pool      [{ key?, id?, imdbId?, type, title, year, poster, genres, themes?, runtime?, rating?, lib, pop? }]
// voters    [profileId]
// fitOf     (profileId, candidate) -> number | null   (bigger = fits better; null = no idea)
// seenOf    (profileId) -> Set of ids / imdbIds that person has seen
// settings  cleanSettings()
// allow     optional predicate (the strictest kids limit in the room)
// exclude   Set of keys never to show (an earlier round's cards)
// n, seed
// -> [candidate + { key, groupFit, seenBy: [profileId] }], best first
const buildDeck = ({ pool = [], voters = [], fitOf = () => null, seenOf = () => new Set(), settings = {}, allow = null, exclude = new Set(), n = DECK_SIZE, seed = "" } = {}) => {
  const s = cleanSettings(settings);
  const seen = new Map(voters.map((pid) => [pid, seenOf(pid) || new Set()]));
  const seenBy = (c) => voters.filter((pid) => {
    const set = seen.get(pid);
    return set.has(c.imdbId) || (c.id && set.has(c.id));
  });
  const keyed = new Map();
  for (const c of pool) {
    if (!c || !c.title || (!c.id && !c.imdbId)) continue;
    const key = keyOf(c);
    if (keyed.has(key) || exclude.has(key) || (c.imdbId && exclude.has(c.imdbId))) continue;
    if (!kindOk(c, s.kind) || !moodMatch(c, s.mood) || !lengthOk(c, s.length)) continue;
    if (allow && !allow(c)) continue;
    const by = seenBy(c);
    if (voters.length && by.length === voters.length) continue; // everyone has seen it
    keyed.set(key, { ...c, key, seenBy: by });
  }
  // one entry per title: a library copy replaces the catalogue's
  const byImdb = new Map();
  for (const c of keyed.values()) {
    if (!c.imdbId) continue;
    const had = byImdb.get(c.imdbId);
    if (!had || (c.lib && !had.lib)) byImdb.set(c.imdbId, c);
  }
  const cands = [...keyed.values()].filter((c) => !c.imdbId || byImdb.get(c.imdbId) === c);
  if (!cands.length) return [];

  // each voter's fit as a percentile among these candidates
  const per = voters.map((pid) => percentiles(cands.map((c) => {
    const f = fitOf(pid, c);
    return f == null || !Number.isFinite(f) ? null : f;
  })));
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    const ps = per.map((list) => list[i]).filter((p) => p != null);
    // nobody knows anything: quality and fame speak
    const quality = c.rating ? Math.max(0, Math.min(1, (c.rating - 5) / 4)) : 0.35;
    const fame = Number.isFinite(c.pop) ? Math.max(0, Math.min(1, c.pop)) : 0.3;
    let fit;
    if (ps.length) {
      const mean = ps.reduce((a, b) => a + b, 0) / ps.length;
      // a voter with no opinion counts as the middle, so a title is not
      // carried by the one person who happens to know it
      const all = per.map((list) => (list[i] == null ? 0.5 : list[i]));
      const low = Math.min(...all);
      fit = 0.6 * mean + 0.4 * low;
    } else fit = 0.5;
    let v = fit + 0.15 * quality + 0.1 * fame;
    if (c.lib) v += 0.25; // on the server: plays now
    if (voters.length) v -= 0.25 * (c.seenBy.length / voters.length);
    v += 0.06 * rand01(seed, c.key);
    c.groupFit = Math.round(fit * 1000) / 1000;
    c._v = v;
  }
  cands.sort((a, b) => b._v - a._v || (a.key < b.key ? -1 : 1));

  // pick n: varied genres, and a share of the library while it lasts
  const out = [];
  const genreCount = new Map();
  const taken = new Set();
  const libLeft = cands.filter((c) => c.lib).length;
  const libWant = Math.min(libLeft, Math.ceil(n * LIB_SHARE));
  let libTaken = 0;
  while (out.length < n && taken.size < cands.length) {
    const needLib = libTaken < libWant && n - out.length <= libWant - libTaken;
    let best = null;
    let bestVal = -Infinity;
    for (const c of cands) {
      if (taken.has(c.key)) continue;
      if (needLib && !c.lib) continue;
      const gs = c.genres && c.genres.length ? c.genres : ["?"];
      let rep = 0;
      for (const g of gs) rep += genreCount.get(g) || 0;
      const val = c._v - 0.08 * (rep / gs.length);
      if (val > bestVal) { bestVal = val; best = c; }
    }
    if (!best) break;
    taken.add(best.key);
    if (best.lib) libTaken++;
    for (const g of best.genres || []) genreCount.set(g, (genreCount.get(g) || 0) + 1);
    out.push(best);
  }
  // shuffle lightly so the deck does not open with all the library titles,
  // but keep the strongest few near the top (people decide early)
  return out.map((c, i) => ({ c, o: i + 4 * rand01(`${seed}|order`, c.key) }))
    .sort((a, b) => a.o - b.o)
    .map(({ c }) => { const { _v, ...rest } = c; return rest; });
};

// ---------- the group score ----------
// verdicts: one entry per voter: "yes" | "maybe" | "no" | undefined (not answered)
const groupScore = (verdicts, fit = 0) => {
  const n = verdicts.length;
  if (!n) return { score: 0, yes: 0, maybe: 0, no: 0, missing: 0, of: 0, everyone: false };
  let yes = 0, maybe = 0, no = 0, missing = 0, sum = 0, low = Infinity;
  for (const v of verdicts) {
    const val = VOTE_VALUE[v];
    if (val == null) { missing++; sum += MISSING; low = Math.min(low, MISSING); continue; }
    if (v === "yes") yes++; else if (v === "maybe") maybe++; else no++;
    sum += val;
    low = Math.min(low, val);
  }
  const mean = sum / n;
  const score = 0.55 * mean + 0.45 * low + 0.04 * (Number.isFinite(fit) ? fit : 0);
  return { score: Math.round(score * 10000) / 10000, yes, maybe, no, missing, of: n, everyone: yes === n };
};

const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;
// The short "why" under the pick. Counted, never named.
const whyOf = (t) => {
  if (t.of === 1) return t.yes ? "You said yes" : t.maybe ? "You said maybe" : "Nobody said no";
  if (t.everyone) return t.of === 2 ? "Both of you said yes" : `${t.yes} of ${t.of} said yes`;
  const head = `${t.yes} of ${t.of} said yes`;
  const tail = [];
  if (t.maybe) tail.push(plural(t.maybe, "maybe", "maybes"));
  if (t.no) tail.push(plural(t.no, "no", "nos"));
  if (t.missing) tail.push(`${t.missing} didn't get to it`);
  return tail.length ? `${head} · ${tail.join(" · ")}` : head;
};

// The result: every title with at least one yes, best first.
// deck     the cards (with groupFit)
// voters   [profileId]
// ballots  Map profileId -> Map key -> verdict
// -> { picks: [{ key, card, why, score, yes, maybe, no, missing, of, everyone }], method }
//    method "everyone" (someone everyone said yes to), "best" (the fairest), "none" (no yes at all)
const results = ({ deck = [], voters = [], ballots = new Map() } = {}) => {
  const picks = [];
  for (const card of deck) {
    const verdicts = voters.map((pid) => {
      const b = ballots.get(pid);
      return b ? b.get(card.key) : undefined;
    });
    const t = groupScore(verdicts, card.groupFit || 0);
    if (!t.yes) continue;
    picks.push({ key: card.key, card, why: whyOf(t), ...t });
  }
  picks.sort((a, b) =>
    (b.everyone - a.everyone) || (b.score - a.score) || (b.yes - a.yes) || (a.no - b.no) ||
    ((b.card.lib ? 1 : 0) - (a.card.lib ? 1 : 0)) || ((b.card.groupFit || 0) - (a.card.groupFit || 0)) ||
    (a.key < b.key ? -1 : 1));
  const method = !picks.length ? "none" : picks[0].everyone ? "everyone" : "best";
  return { picks, method };
};

module.exports = {
  buildDeck, groupScore, results, whyOf, cleanSettings, moodMatch, lengthOk,
  MOODS, LENGTHS, KINDS, VERDICTS, DECK_SIZE, VOTE_VALUE, MISSING,
  _internals: { percentiles, rand01, keyOf },
};
