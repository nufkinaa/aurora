// The swipe picker's deck: which title to ask about next (2026-10-17).
//
// "Do you love it?" is only a useful question about a title the person is
// likely to have SEEN, and each answer should teach Home something it did not
// know yet. So the deck is
//
//   WELL-KNOWN   the catalogue's most popular films and series (wellknown.js,
//                the first 1,500 films and 1,000 series of its list) and the
//                library itself (a familiar face now and then); the first few
//                cards are the very best known, where "seen it" is likeliest;
//   VARIED       every pick is weighed against what was already shown: a
//                genre, a decade or a kind (film / series) not met yet scores
//                higher, so twenty cards cover the map instead of one corner;
//   ADAPTIVE     the answers so far move the next cards — a genre that keeps
//                getting "Not for me" (three or more, and three times as many
//                as loves) is not shown again; loved genres come back a
//                little more often; many "Haven't seen"s lean the deck harder
//                towards the famous; a kind (series) never loved after
//                several answers fades;
//   NEW          nothing watched, rated, on My List, followed or already
//                answered is asked about.
//
// Pure: the pool, the answers and the exclusions are handed in; the route
// (routes/profiles.js) gathers them. Deterministic for a given seed.
const tax = require("./recs/taxonomy");
const { plainText } = require("../lib/htmltext");

const DEPTH = { movie: 1500, show: 1000 }; // how far down the catalogue's list "well-known" reaches
const EARLY = 6; // the first cards: only the very famous
const EARLY_RANK = 250;
const GOAL = 24; // one sitting; "Keep going" asks for another round
const MORE = 12;

// ---------- the pool ----------
// known:    wellknown.all() records { imdbId, type, title, year, poster, rating, genres, cast, director, k }
// library:  [{ id, imdbId, type, title, year, cover, genres, synopsis, rating }]  (films and shows)
// describe: imdbId -> a short line, or null (the title index's synopsis)
// Returns [{ imdbId, id, type, title, year, poster, genres, rating, pop, lib, line }]
const firstSentence = (text, max = 140) => {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const m = /^(.{20,}?[.!?])(\s|$)/.exec(t);
  let s = m ? m[1] : t;
  if (s.length > max) {
    s = s.slice(0, max);
    const cut = s.lastIndexOf(" ");
    s = (cut > 60 ? s.slice(0, cut) : s).replace(/[,;:.\s]+$/, "") + "…";
  }
  return s;
};
const lineOf = (r, describe) => plainText(rawLineOf(r, describe));
const rawLineOf = (r, describe) => {
  const told = describe ? firstSentence(describe(r.imdbId)) : "";
  if (told) return told;
  if (r.synopsis) return firstSentence(r.synopsis);
  const by = (r.director || []).filter(Boolean)[0];
  const cast = (r.cast || []).filter(Boolean).slice(0, 2);
  if (by && cast.length) return `${by}, with ${cast.join(" and ")}`;
  if (by) return `Directed by ${by}`;
  if (cast.length) return `With ${cast.join(" and ")}`;
  return "";
};

const buildPool = ({ known = [], library = [], describe = null } = {}) => {
  const out = new Map();
  for (const r of known) {
    if (!r || !/^tt\d{4,12}$/.test(r.imdbId || "") || !r.title || !r.poster) continue;
    const type = r.type === "show" || r.type === "series" ? "show" : "movie";
    const k = Number.isFinite(r.k) ? r.k : 9999;
    if (k >= DEPTH[type] || out.has(r.imdbId)) continue;
    out.set(r.imdbId, {
      imdbId: r.imdbId, id: null, type, title: r.title, year: r.year || null, poster: r.poster,
      genres: tax.canonGenres(r.genres).slice(0, 3), rating: r.rating || null,
      pop: 1 - k / DEPTH[type], rank: k, lib: false, src: r,
    });
  }
  for (const it of library) {
    if (!it || !/^tt\d{4,12}$/.test(it.imdbId || "") || !it.title) continue;
    const hit = out.get(it.imdbId);
    if (hit) {
      // the library's own copy: its id (so Love lands on the playable title)
      // and its own picture when the catalogue's is missing
      hit.id = it.id || null;
      hit.lib = true;
      continue;
    }
    if (!it.cover) continue;
    out.set(it.imdbId, {
      imdbId: it.imdbId, id: it.id || null, type: it.type === "show" ? "show" : "movie", title: it.title,
      year: it.year || null, poster: it.cover, genres: tax.canonGenres(it.genres).slice(0, 3),
      rating: it.rating || null, pop: 0.45, rank: 9999, lib: true, src: it,
    });
  }
  // the line is worked out lazily (pick() asks for the few cards it hands out)
  const pool = [...out.values()];
  for (const c of pool) {
    let line;
    Object.defineProperty(c, "line", {
      enumerable: true,
      get: () => (line === undefined ? (line = lineOf({ ...c.src, imdbId: c.imdbId }, describe)) : line),
    });
  }
  return pool;
};

// ---------- what the answers so far say ----------
// answers: [{ imdbId, verdict: "love"|"nope"|"skip" }] (any order)
// byId:    imdbId -> pool entry (or anything with genres/type/year), for the genres of an answer
const decadeOf = (year) => (year ? Math.floor(year / 10) * 10 : null);
const readAnswers = (answers, byId) => {
  const g = new Map(); // genre -> { L, N, S }
  const d = new Map(); // decade -> { L, N, S }
  const k = { movie: { L: 0, N: 0, S: 0 }, show: { L: 0, N: 0, S: 0 } };
  let L = 0, N = 0, S = 0;
  const bump = (m, key, field) => {
    if (key == null) return;
    let e = m.get(key);
    if (!e) m.set(key, (e = { L: 0, N: 0, S: 0 }));
    e[field]++;
  };
  for (const a of answers || []) {
    const field = a.verdict === "love" ? "L" : a.verdict === "nope" ? "N" : a.verdict === "skip" ? "S" : null;
    if (!field) continue;
    if (field === "L") L++; else if (field === "N") N++; else S++;
    const c = byId(a.imdbId);
    if (!c) continue;
    for (const genre of c.genres || []) bump(g, genre, field);
    bump(d, decadeOf(c.year), field);
    if (k[c.type]) k[c.type][field]++;
  }
  const banned = new Set();
  const strong = new Set();
  for (const [genre, e] of g) {
    if (e.N >= 3 && e.N >= 3 * e.L) banned.add(genre);
    if (e.L >= 3 && e.L > e.N) strong.add(genre);
  }
  return { g, d, k, L, N, S, total: L + N + S, banned, strong };
};

// ---------- picking ----------
// FNV-1a + a mulberry step: a stable 0..1 per (seed, id)
const rand01 = (seed, id) => {
  let h = 2166136261;
  const str = `${seed}|${id}`;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  let t = (h + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// Is this candidate out because of what the answers said?
const shut = (c, read) => {
  if (!read.banned.size) return false;
  const gs = c.genres || [];
  if (!gs.some((x) => read.banned.has(x))) return false;
  // a genre they keep loving can carry it back in (a horror-comedy for
  // someone who said no to horror and yes to every comedy)
  return !gs.some((x) => read.strong.has(x));
};

// pool      buildPool()
// answers   every answer this profile gave (see readAnswers)
// exclude   Set of ids never to show (watched, rated, listed, followed: imdbIds or library ids)
// queued    imdbIds the client holds already (shown, or about to be): not again, and they count as shown
// n         how many to hand out
// allow     optional predicate (a kids profile: only what it may see)
// seed      a string; same seed + same inputs = same cards
// Returns pool entries, best first.
const pick = ({ pool, answers = [], exclude = new Set(), queued = [], n = 6, allow = null, seed = "" } = {}) => {
  const byId = new Map(pool.map((c) => [c.imdbId, c]));
  const read = readAnswers(answers, (id) => byId.get(id));
  const shownG = new Map();
  const shownD = new Map();
  const shown = { movie: 0, show: 0, lib: 0, all: 0 };
  const note = (c) => {
    for (const x of c.genres || []) shownG.set(x, (shownG.get(x) || 0) + 1);
    const dec = decadeOf(c.year);
    if (dec != null) shownD.set(dec, (shownD.get(dec) || 0) + 1);
    shown[c.type]++;
    if (c.lib) shown.lib++;
    shown.all++;
  };
  // what was already put in front of them counts as shown
  const answered = new Set();
  for (const a of answers) { const c = byId.get(a.imdbId); answered.add(a.imdbId); if (c) note(c); }
  const queuedSet = new Set(queued);
  for (const id of queuedSet) { const c = byId.get(id); if (c && !answered.has(id)) note(c); }

  // the series share the deck aims for: about a third, more for someone who
  // loves series, less for someone who never does
  const ks = read.k.show;
  const km = read.k.movie;
  let showTarget = 0.35;
  if (ks.L + ks.N + ks.S >= 4) {
    const showLove = ks.L / (ks.L + ks.N + ks.S);
    const filmLove = km.L + km.N + km.S ? km.L / (km.L + km.N + km.S) : 0.3;
    showTarget = Math.max(0.12, Math.min(0.55, 0.35 + 0.5 * (showLove - filmLove)));
  }
  const skipRate = read.total ? read.S / read.total : 0;
  const learnt = Math.min(1, read.total / 12); // 0 → 1 over the first dozen answers

  const cands = [];
  for (const c of pool) {
    if (exclude.has(c.imdbId) || (c.id && exclude.has(c.id)) || answered.has(c.imdbId) || queuedSet.has(c.imdbId)) continue;
    if (shut(c, read)) continue;
    if (allow && !allow(c)) continue;
    cands.push(c);
  }
  const out = [];
  const taken = new Set();
  let earlyOff = false;
  while (out.length < n) {
    const early = !earlyOff && read.total + out.length < EARLY;
    let best = null;
    let bestVal = -Infinity;
    for (const c of cands) {
      if (taken.has(c.imdbId)) continue;
      if (early && !c.lib && c.rank >= EARLY_RANK) continue;
      // famous first; harder still when they keep saying "haven't seen"
      let v = (1.0 + 1.4 * skipRate) * c.pop + (c.rating ? 0.25 * Math.max(0, Math.min(1, (c.rating - 5) / 4)) : 0.08);
      // variety: genres and decades not met yet
      const gs = c.genres && c.genres.length ? c.genres : ["?"];
      let nov = 0;
      for (const x of gs) nov += 1 / (1 + (shownG.get(x) || 0));
      v += (0.9 - 0.35 * learnt) * (nov / gs.length);
      const dec = decadeOf(c.year);
      v += 0.25 / (1 + 0.5 * (dec != null ? shownD.get(dec) || 0 : 2));
      // what the answers said about its genres and its decade
      if (read.total) {
        let aff = 0;
        for (const x of gs) {
          const e = read.g.get(x);
          if (e) aff += (e.L + 0.5) / (e.L + e.N + 0.3 * e.S + 1) - 0.5;
        }
        v += 0.7 * learnt * (aff / gs.length);
        const de = dec != null ? read.d.get(dec) : null;
        if (de) v += 0.25 * learnt * ((de.L + 0.5) / (de.L + de.N + 0.3 * de.S + 1) - 0.5);
      }
      // the film / series balance
      const share = shown.all ? shown.show / shown.all : 0;
      v += c.type === "show" ? 0.5 * (showTarget - share) : 0.5 * (share - showTarget);
      // the library: a familiar face now and then, never most of the deck
      if (c.lib) v += shown.all && shown.lib / shown.all > 0.3 ? -0.3 : 0.12;
      v += 0.3 * rand01(seed, c.imdbId);
      if (v > bestVal) { bestVal = v; best = c; }
    }
    if (!best) {
      if (early) { earlyOff = true; continue; } // nothing famous left: drop the early rule
      break;
    }
    taken.add(best.imdbId);
    out.push(best);
    note(best);
  }
  return out;
};

// The card as the clients draw it.
const cardOf = (c) => ({
  imdbId: c.imdbId,
  ...(c.id ? { id: c.id } : {}),
  type: c.type,
  title: c.title,
  year: c.year,
  poster: c.poster,
  genres: c.genres,
  line: c.line || "",
});

module.exports = { buildPool, pick, cardOf, readAnswers, GOAL, MORE, DEPTH, _internals: { firstSentence, lineOf, shut, rand01 } };
