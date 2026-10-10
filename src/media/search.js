// ONE search for the website and the TV app.
//
// What was wrong before (measured on the real library, 2026-10-10):
// the website glued three lists end to end — every library hit, then the
// cached catalogue, then the live catalogue with ALL films ahead of ALL
// series — so the title you typed exactly sat wherever its SOURCE put it: a
// series you named in full came after a dozen films that merely contained
// the word, and a library film with one matching word came before all of
// them. The TV did a substring filter of its own and never asked the server.
//
// Here every title — library, cached catalogue, live catalogue — is one
// document, scored by HOW WELL IT MATCHES, in one list:
//
//   tier  what matched                                   example ("dune")
//   1000  the title, exactly — case, accents, punctuation, a leading
//         the/a/an, spacing ("walle"), numerals ("part 2", "se7en") and an
//         optional year ("dune 2021") aside               Dune
//    900  the title starts with the query                 Dune: Part Two, Dunkirk ("dun")
//    890  one slip away from a title in the library, or from the catalogue's
//         own first answer for these letters              "tory" → Troy
//    820  the query is a run of whole words inside the title    Children of Dune
//    800  every query word is a whole word of the title, any order
//    760  every query word starts a word of the title    "thursday club"
//    650… the right name, the wrong year ("dune 1984" → Dune 2021: tier − 250)
//    700  the title contains the query mid-word (3+ letters)
//    650  a typo of the whole title (Damerau-Levenshtein 1; 2 from 8 letters)
//    600  every query word is a typo of / is inside a title word
//    580  a typo in a title you are still typing ("incpet")
//    520  an episode is called exactly that          500 starts with / 480 contains the words
//    420  a cast or crew name, exactly               400 part of the name / 380 a typo of it
//    360  a character's name
//    200  every query word is in the synopsis or the genres
//
// An alternate title (the catalogue's name for a library folder called
// "Avatar Movie") scores like the title when it is exact, 20 lower otherwise.
// Inside a tier, in order: the year you typed, the library before the
// catalogue, popularity (the trending position plus half the catalogue's own
// place for this query), the literal spelling, the shorter title, the newer
// one. Nothing from a lower tier can pass a higher one, whatever its
// popularity.
//
// When the title was named exactly, typo and synopsis matches are dropped: a
// page of near-misses under the title you named is noise. What follows the
// matches instead is a RELATED tail, kept apart in the answer so a client
// can put a divider there: the top match's franchise and "more like this"
// row, its cast's other titles and its genre neighbours — or, when the
// query is a person or a genre, their titles. No tail when nothing matched
// with confidence.
const path = require("path");
const config = require("../config");
const scanner = require("./scanner");
const discover = require("./discover");
const { JsonStore } = require("../lib/jsonstore");
const { norm: baseNorm } = require("./searchindex")._internals;

// ---------- normalisation ----------
const norm = (s) => baseNorm(String(s || "").replace(/&/g, " and "));
const ARTICLES = new Set(["the", "a", "an"]);
const ROMAN = { ii: "2", iii: "3", iv: "4", vi: "6", vii: "7", viii: "8", ix: "9" };
const NUMWORD = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10" };
const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "v" };
// "ii" → 2, "two" → 2, "se7en" → seven → 7: applied to the query AND the
// title, so either spelling finds either. A digit only reads as a letter
// INSIDE a word (r2d2, 3d and 10th stay as they are).
const canonWord = (w) => {
  if (ROMAN[w]) return ROMAN[w];
  const x = /^[a-z]+\d[a-z]+$/.test(w) ? w.replace(/\d/, (d) => LEET[d] || d) : w;
  return NUMWORD[x] || x;
};
// One spelling of a title or a query, ready to compare:
//   s the words, w the word list, a without a leading article,
//   q squashed (no spaces), aq squashed without the article
//   m which letters it has (a bit each), wm the same per word, d its digits
// The masks answer "can this even be a typo of that?" without the edit
// distance: an edit adds at most one letter the other side does not have.
const maskOf = (str) => {
  let m = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    m |= c >= 97 && c <= 122 ? 1 << (c - 97) : c >= 48 && c <= 57 ? 1 << (26 + ((c - 48) % 5)) : 1 << 31;
  }
  return m;
};
const bits = (x) => {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};
const mkView = (words) => {
  const aw = words.length > 1 && ARTICLES.has(words[0]) ? words.slice(1) : words;
  const q = words.join("");
  return { s: words.join(" "), w: words, a: aw.join(" "), q, aq: aw.join(""), m: maskOf(q), wm: words.map(maskOf), d: q.replace(/\D+/g, "") };
};
const forms = (text) => {
  const n = norm(text);
  const words = n ? n.split(" ") : [];
  const cw = words.map(canonWord);
  return { raw: mkView(words), canon: cw.some((w, i) => w !== words[i]) ? mkView(cw) : null };
};

const budget = (len) => (len >= 8 ? 2 : len >= 4 ? 1 : 0);

// Damerau-Levenshtein "is the distance ≤ max?" — the same answer as
// searchindex.js's editWithin (swapped letters count once), without
// allocating: this runs for every title on every keystroke.
const ROWS = [new Int16Array(96), new Int16Array(96), new Int16Array(96)];
const editWithin = (a, b, max) => {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (la - lb > max || lb - la > max || lb >= 95 || la >= 95) return false;
  let prev2 = ROWS[0];
  let prev = ROWS[1];
  let cur = ROWS[2];
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const bj = b.charCodeAt(j - 1);
      let v = prev[j - 1] + (ai === bj ? 0 : 1);
      if (prev[j] + 1 < v) v = prev[j] + 1;
      if (cur[j - 1] + 1 < v) v = cur[j - 1] + 1;
      if (i > 1 && j > 1 && ai === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === bj && prev2[j - 2] + 1 < v) v = prev2[j - 2] + 1;
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return false;
    const t = prev2;
    prev2 = prev;
    prev = cur;
    cur = t;
  }
  return prev[lb] <= max;
};
// Does ONE query word land on a word of the title? Starts it, is inside it
// (4+ letters), or is a typo of it — with searchindex.js's limits: a digit
// word only as a prefix ("2016" must not reach 2019), three letters only
// with two neighbours swapped ("teh"), one edit from four letters, two from eight.
const wordHits = (qw, qm, t) => {
  const n = qw.length;
  const digits = /^\d+$/.test(qw);
  const b = digits ? 0 : budget(n);
  for (let i = 0; i < t.w.length; i++) {
    const tw = t.w[i];
    if (tw.startsWith(qw)) return true;
    if (digits) continue;
    if (bits(qm & ~t.wm[i]) > b) continue; // letters the title word does not have: more than the budget
    if (b > 0 && editWithin(qw, tw, b)) return true;
    if (n === 3 && tw.length === 3 &&
      ((qw[0] === tw[1] && qw[1] === tw[0] && qw[2] === tw[2]) || (qw[0] === tw[0] && qw[1] === tw[2] && qw[2] === tw[1]))) return true;
    if (n >= 4 && tw.includes(qw)) return true;
  }
  return false;
};
// How well one spelling of the query matches one spelling of a title.
// `fuzzy: false` stops at the exact tiers (episode and character names).
const tierView = (q, t, fuzzy = true) => {
  if (!q.s || !t.s) return 0;
  if (q.s === t.s || q.a === t.a || (q.q.length >= 3 && q.q === t.q)) return 1000;
  // (the TITLE's article never counts: "sopr" → The Sopranos. The QUERY's is
  // only set aside once three letters follow it — "the o" is the start of
  // "The Office", not of everything beginning with O)
  if (t.s.startsWith(q.s) || t.a.startsWith(q.s) || (q.aq.length >= 3 && (t.a.startsWith(q.a) || t.aq.startsWith(q.aq))) ||
    (q.q.length >= 3 && (t.q.startsWith(q.q) || t.aq.startsWith(q.q)))) return 900;
  const L = q.q.length;
  if (L < 2) return 0; // one letter: what starts with it, nothing looser
  if ((q.m & ~t.m) === 0) {
    // (every letter of the query is in the title: the only way these can hold)
    if (` ${t.s} `.includes(` ${q.s} `)) return 820;
    if (q.w.every((w) => t.w.includes(w))) return 800;
    if (q.w.every((w) => t.w.some((tw) => tw.startsWith(w)))) return 760;
    if (L >= 3 && (t.s.includes(q.s) || (L >= 4 && t.q.includes(q.q)))) return 700;
  }
  if (L < 3 || !fuzzy) return 0;
  const b = budget(L);
  const missing = bits(q.m & ~t.m);
  // (a slip is in the letters: "toy story 2" is not a typo of "Toy Story 3")
  const sameDigits = q.d === t.d;
  if (b && sameDigits && missing <= b && bits(t.m & ~q.m) <= b && (editWithin(q.q, t.q, b) || editWithin(q.aq, t.aq, b))) return 650;
  // every word a typo of (or inside) a title word
  if (q.w.every((w, i) => bits(q.wm[i] & ~t.m) <= budget(w.length) && wordHits(w, q.wm[i], t))) return 600;
  if (L >= 5 && missing <= 1 && t.d.startsWith(q.d)) {
    for (const full of [t.q, t.aq])
      for (const n of [L, L - 1, L + 1])
        if (full.length > n && editWithin(q.q, full.slice(0, n), 1)) return 580;
  }
  return 0;
};

const tierForms = (qf, tf) => {
  let t = tierView(qf.raw, tf.raw);
  // the numeral spellings ("ii", "two", "se7en" → digits) are compared exactly:
  // as digits "one" and "two" are a single edit apart, and they are not a typo
  if (t < 1000 && (qf.canon || tf.canon)) t = Math.max(t, tierView(qf.canon || qf.raw, tf.canon || tf.raw, false));
  return t;
};
const FUZZY_WHOLE = 650; // one slip from the whole title
const LIFTED = 890; // …of a title in the library / the catalogue's first answer

// ---------- the query ----------
const parseQuery = (q) => {
  const text = String(q || "").slice(0, 80).trim();
  const f = forms(text);
  const words = f.raw.w;
  let base = null;
  let yq = null;
  const last = words[words.length - 1];
  // "dune 2021", "dune 20" (still typing the year), "arrival 2"
  if (words.length >= 2 && /^[12]\d{0,3}$/.test(last)) {
    yq = last;
    base = forms(words.slice(0, -1).join(" "));
  }
  return {
    text, f, base, yq, len: f.raw.q.length, words,
    // the name without the year, when a whole year was typed ("her 2013" → "her")
    baseText: base && yq.length === 4 ? words.slice(0, -1).join(" ") : null,
  };
};

// The title tiers for one title, year reading included.
const titleScore = (Q, tf, year) => {
  let tier = tierForms(Q.f, tf);
  let ym = 0;
  if (Q.base && tier < 1000) {
    const b = tierForms(Q.base, tf);
    if (b) {
      const y = year ? String(year) : "";
      let alt = 0;
      let m = 0;
      // the catalogues disagree by a year all the time (festival vs release):
      // one off still counts, behind the exact year
      const near = Q.yq.length === 4 && year && Math.abs(Number(Q.yq) - year) === 1;
      if (y && y.startsWith(Q.yq)) { alt = Q.yq.length === 4 ? b : b - 10; m = y === Q.yq ? 1 : 0; }
      else if (near) { alt = b; m = 0.5; }
      else if (Q.yq.length === 4 && b >= 900) alt = b - 250; // the name, another year
      if (alt > tier) {
        tier = alt;
        ym = m;
      }
    }
  }
  return { tier, ym, lit: Q.f.raw.s === tf.raw.s ? 1 : 0 };
};

const STOP = new Set("the a an of and in on at to for with from by is it as or be this that his her their about into".split(" "));
const GENERIC_EPISODE = /^(episode|chapter|part|ep|pilot)?\s*\d*$/;

// Everything that can match in one document. Returns null for no match.
const scoreDoc = (Q, d, { titlesOnly = false } = {}) => {
  const s = titleScore(Q, d.tf, d.year);
  let best = { tier: s.tier, ym: s.ym, lit: s.lit, kind: "title", label: null };
  for (const aka of d.akas) {
    const a = titleScore(Q, aka.tf, d.year);
    const t = a.tier;
    if (t > best.tier) best = { tier: t, ym: a.ym, lit: 0, kind: "aka", label: aka.title };
  }
  if (titlesOnly) return best.tier > 0 ? best : null;
  const L = Q.len;
  if (L >= 3 && best.tier < 520 && d.eps) {
    for (const ep of d.eps) {
      const e = tierView(Q.f.raw, ep.v, false);
      const t = e >= 1000 ? 520 : L >= 4 && e >= 900 ? 500 : L >= 4 && e >= 800 ? 480 : 0;
      if (t > best.tier) {
        best = { tier: t, ym: 0, lit: 0, kind: "episode", label: `S${ep.s} E${ep.e} · ${ep.title}` };
        if (t === 520) break;
      }
    }
  }
  if (L >= 3 && best.tier < 420) {
    for (const p of d.people) {
      const e = tierView(Q.f.raw, p.v, L >= 6);
      const t = e >= 1000 ? 420 : L >= 4 && e >= 760 ? 400 : L >= 6 && e >= 600 && e < 700 ? 380 : 0;
      if (t > best.tier) best = { tier: t, ym: 0, lit: 0, kind: "person", label: p.name };
    }
    if (L >= 4 && best.tier < 360) {
      for (const r of d.roles) {
        if (tierView(Q.f.raw, r.v, false) >= 820) {
          best = { tier: 360, ym: 0, lit: 0, kind: "role", label: `${r.name} as ${r.role}` };
          break;
        }
      }
    }
  }
  if (L >= 4 && best.tier < 200) {
    const words = Q.f.raw.w.filter((w) => !STOP.has(w));
    if (words.length) {
      if (!d.syn) d.syn = new Set(norm(`${d.synopsis || ""} ${(d.genres || []).join(" ")}`).split(" "));
      if (words.every((w) => d.syn.has(w))) best = { tier: 200, ym: 0, lit: 0, kind: "synopsis", label: null };
    }
  }
  return best.tier > 0 ? best : null;
};

const cmp = (a, b) =>
  b.tier - a.tier ||
  b.ym - a.ym ||
  (b.doc.inLibrary ? 1 : 0) - (a.doc.inLibrary ? 1 : 0) ||
  b.pop - a.pop ||
  b.lit - a.lit ||
  a.doc.title.length - b.doc.title.length ||
  (b.doc.year || 0) - (a.doc.year || 0) ||
  (a.doc.title < b.doc.title ? -1 : a.doc.title > b.doc.title ? 1 : 0) ||
  (a.doc.key < b.doc.key ? -1 : 1);

// ---------- documents ----------
const typeOf = (t) => (t === "show" || t === "series" ? "show" : "movie");
const personOf = (name) => ({ name, v: mkView(norm(name).split(" ").filter(Boolean)) });

const libraryDoc = (item, imdbId) => ({
  key: `lib:${item.id}`,
  libId: item.id,
  imdbId: imdbId || item.imdbId || null,
  type: typeOf(item.type),
  title: String(item.title || ""),
  year: item.year || null,
  cover: item.cover || null,
  rating: item.rating || null,
  genres: item.genres || [],
  synopsis: item.synopsis || "",
  inLibrary: true,
  pop: 0.6 + Math.min(10, item.rating || 0) / 25,
  item,
  tf: forms(item.title),
  akas: [],
  eps: null,
  people: [],
  roles: [],
  syn: null,
});
const catalogDoc = (m, pop) => ({
  key: m.imdbId,
  libId: null,
  imdbId: m.imdbId,
  type: typeOf(m.type),
  title: String(m.title || ""),
  year: m.year || null,
  cover: m.poster || m.cover || null,
  rating: m.rating || null,
  genres: m.genres || [],
  synopsis: m.synopsis || "",
  inLibrary: false,
  pop,
  item: m,
  tf: forms(m.title),
  akas: [],
  eps: null,
  people: [],
  roles: [],
  syn: null,
});

// ---------- what the engine reads (swapped out whole in the tests) ----------
const TMDB_PERSON_TTL = 30 * 24 * 3600 * 1000;
let seenStore = null;
const seen = () =>
  seenStore ||
  (seenStore = new JsonStore(path.join(config.CACHE_DIR, "search-seen.json"), { v: 1, titles: {}, people: {} }));
const SEEN_MAX = 3000;
let seenVersion = 0;

let src = {
  stamp: () => scanner.index.scannedAt,
  libraryItems: () => scanner.allItems(),
  imdbIdFor: (item) => {
    try { return require("./identity").imdbIdFor(item); } catch { return null; }
  },
  markLibrary: (items) => {
    try { return require("./identity").markLibrary(items); } catch { return items; }
  },
  trending: () => discover.trendingCached(),
  // titles the live catalogue named in earlier searches (kept on disk)
  seenTitles: () => Object.values(seen().data.titles || {}),
  seenPeople: () => Object.values(seen().data.people || {}),
  // what the title pages already fetched, by id:
  // [{ imdbId, title, cast: [name], director: [name], genres, synopsis, roles: [{name, role}], episodes: [{s, e, title}] }]
  facts: () => {
    const out = [];
    for (const m of discover.metaAll()) {
      if (!m.imdbId) continue;
      const episodes = [];
      for (const se of m.seasons || []) for (const e of se.episodes || []) if (e.title) episodes.push({ s: e.season || se.number, e: e.episode, title: e.title });
      out.push({
        imdbId: m.imdbId,
        title: m.title,
        cast: m.cast || [],
        director: m.director ? String(m.director).split(/,\s*/) : [],
        genres: m.genres || [],
        synopsis: m.synopsis || "",
        episodes,
      });
    }
    try {
      for (const t of require("./xray").titleCasts()) {
        out.push({
          imdbId: t.imdbId,
          // the first-billed: a search for "tom" is not for every Tom with one line
          cast: t.cast.slice(0, 10).map((p) => p.name).filter(Boolean),
          roles: t.cast.slice(0, 10).filter((p) => p.name && p.role).map((p) => ({ name: p.name, role: p.role })),
        });
      }
    } catch {}
    return out;
  },
  liveCached: (q) => discover.searchCached(q),
  live: (q) => discover.search(q),
  similarCached: (type, imdbId) => require("./similar").similarCached(type === "show" ? "series" : "movie", imdbId),
  collectionCached: (imdbId) => require("./similar").collectionCached(imdbId),
  canFetchSimilar: () => !!config.TMDB_KEY,
  similarFetch: async (type, imdbId) => (await require("./similar").similar(type === "show" ? "series" : "movie", imdbId)).items || [],
  canFetchPeople: () => !!config.TMDB_KEY,
  personFetch: (name) => tmdbPerson(name),
  remember: (items) => rememberSeen(items),
};

const rememberSeen = (items) => {
  const store = seen();
  const titles = store.data.titles || (store.data.titles = {});
  let changed = false;
  items.forEach((m) => {
    if (!m || !m.imdbId || !(m.poster || m.cover) || !m.title) return;
    const had = titles[m.imdbId];
    const r = typeof m._rank === "number" ? m._rank : 13;
    if (had && had.r <= r) return;
    titles[m.imdbId] = {
      imdbId: m.imdbId, type: typeOf(m.type), title: m.title, year: m.year || null,
      poster: m.poster || m.cover, rating: m.rating || (had && had.rating) || null,
      genres: (m.genres && m.genres.length ? m.genres : had && had.genres) || [],
      synopsis: String(m.synopsis || (had && had.synopsis) || "").slice(0, 300), r, at: Date.now(),
    };
    changed = true;
  });
  if (!changed) return;
  const keys = Object.keys(titles);
  if (keys.length > SEEN_MAX) {
    keys.sort((a, b) => (titles[a].at || 0) - (titles[b].at || 0)).slice(0, keys.length - SEEN_MAX + 200).forEach((k) => delete titles[k]);
  }
  seenVersion++;
  store.save();
};

// ---------- the index ----------
let index = null;
const REBUILD_MS = 60000;
const GENRE_ALIASES = {
  "sci fi": "Sci-Fi", scifi: "Sci-Fi", "science fiction": "Sci-Fi", romcom: "Romance", "rom com": "Romance",
  romantic: "Romance", animated: "Animation", cartoon: "Animation", cartoons: "Animation", docs: "Documentary",
  documentaries: "Documentary", scary: "Horror", funny: "Comedy", comedies: "Comedy", thrillers: "Thriller",
  westerns: "Western", musicals: "Musical", kids: "Family",
};

const build = () => {
  const started = process.hrtime.bigint();
  const docs = [];
  const byLib = new Map();
  const byImdb = new Map();
  const byTitle = new Map(); // type|title|year → library doc (the belt under the id match)
  for (const item of src.libraryItems()) {
    const d = libraryDoc(item, src.imdbIdFor(item));
    // the library's own episode names, when they are names ("Episode 3" is not)
    if (d.type === "show" && Array.isArray(item.seasons)) {
      const eps = [];
      for (const se of item.seasons) for (const e of se.episodes || []) {
        const n = norm(e.title);
        if (!n || GENERIC_EPISODE.test(n)) continue;
        eps.push({ s: e.season || se.number, e: e.episode, title: e.title, v: mkView(n.split(" ")) });
      }
      if (eps.length) d.eps = eps;
    }
    docs.push(d);
    byLib.set(d.libId, d);
    if (d.imdbId && !byImdb.has(d.imdbId)) byImdb.set(d.imdbId, d);
    byTitle.set(`${d.type}|${d.tf.raw.s}|${d.year || ""}`, d);
  }
  // a catalogue twin of a library title folds INTO it: one card, the library's
  const absorb = (lib, m, pop) => {
    if (m.title && norm(m.title) !== lib.tf.raw.s && !lib.akas.some((a) => a.tf.raw.s === norm(m.title)))
      lib.akas.push({ title: m.title, tf: forms(m.title) });
    if (!lib.imdbId && m.imdbId) {
      lib.imdbId = m.imdbId;
      if (!byImdb.has(m.imdbId)) byImdb.set(m.imdbId, lib);
    }
    if (!lib.genres.length && m.genres && m.genres.length) lib.genres = m.genres;
    if (!lib.synopsis && m.synopsis) lib.synopsis = m.synopsis;
    lib.pop = Math.max(lib.pop, pop);
  };
  const addCatalog = (m, pop) => {
    if (!m || !m.imdbId || !m.title) return;
    const lib = (m.inLibrary && byLib.get(m.inLibrary)) ||
      (byImdb.get(m.imdbId) && byImdb.get(m.imdbId).inLibrary ? byImdb.get(m.imdbId) : null) ||
      byTitle.get(`${typeOf(m.type)}|${norm(m.title)}|${m.year || ""}`);
    if (lib) return absorb(lib, m, pop);
    const had = byImdb.get(m.imdbId);
    if (had) {
      had.pop = Math.max(had.pop, pop);
      return;
    }
    if (!(m.poster || m.cover)) return;
    const d = catalogDoc(m, pop);
    docs.push(d);
    byImdb.set(d.imdbId, d);
  };
  const trending = src.trending();
  for (const list of trending ? [trending.movies || [], trending.shows || []] : []) {
    list.forEach((m, i) => addCatalog(m, 0.3 + 0.3 * (1 - i / Math.max(1, list.length))));
  }
  let seenList = [];
  try { seenList = src.markLibrary(src.seenTitles().map((m) => ({ ...m }))); } catch {}
  for (const m of seenList) addCatalog(m, 0.28 * (1 - Math.min(13, m.r || 0) / 14));

  // people, characters, episode names and the catalogue's spelling, by id
  const people = new Map(); // normalised name → { name, v, keys:Set }
  const notePerson = (name, d) => {
    const p = personOf(name);
    if (!p.v.s || p.v.s.length < 3) return;
    if (!d.people.some((x) => x.v.s === p.v.s)) d.people.push(p);
    const hit = people.get(p.v.s) || { name, v: p.v, keys: new Set() };
    hit.keys.add(d.key);
    people.set(p.v.s, hit);
  };
  let facts = [];
  try { facts = src.facts(); } catch {}
  for (const f of facts) {
    const d = byImdb.get(f.imdbId);
    if (!d) continue;
    if (f.title && d.inLibrary && norm(f.title) !== d.tf.raw.s && !d.akas.some((a) => a.tf.raw.s === norm(f.title)))
      d.akas.push({ title: f.title, tf: forms(f.title) });
    if (!d.genres.length && f.genres && f.genres.length) d.genres = f.genres;
    if (!d.synopsis && f.synopsis) d.synopsis = f.synopsis;
    for (const name of [...(f.cast || []), ...(f.director || [])]) if (name) notePerson(String(name), d);
    for (const r of f.roles || []) {
      const n = norm(r.role);
      if (n && n.length >= 3 && !d.roles.some((x) => x.v.s === n)) d.roles.push({ name: r.name, role: r.role, v: mkView(n.split(" ")) });
    }
    if (f.episodes && f.episodes.length && d.type === "show") {
      const eps = d.eps || [];
      const have = new Set(eps.map((e) => e.v.s));
      for (const e of f.episodes) {
        const n = norm(e.title);
        if (!n || GENERIC_EPISODE.test(n) || have.has(n)) continue;
        have.add(n);
        eps.push({ s: e.s, e: e.e, title: e.title, v: mkView(n.split(" ")) });
      }
      if (eps.length) d.eps = eps;
    }
  }
  // people TMDB named in earlier searches: their titles are in the seen pool
  try {
    for (const p of src.seenPeople()) {
      if (!p || !p.name) continue;
      for (const id of p.ids || []) {
        const d = byImdb.get(id);
        if (d) notePerson(p.name, d);
      }
    }
  } catch {}
  const genres = new Map(); // normalised → display
  for (const d of docs) for (const g of d.genres) if (g && !genres.has(norm(g))) genres.set(norm(g), g);
  for (const [alias, g] of Object.entries(GENRE_ALIASES)) if (genres.has(norm(g)) && !genres.has(alias)) genres.set(alias, genres.get(norm(g)));

  index = {
    docs, byLib, byImdb, byTitle, people, genres,
    stamp: src.stamp(), seenVersion, at: Date.now(),
    buildMs: Number(process.hrtime.bigint() - started) / 1e6,
  };
  return index;
};

const ensureIndex = () => {
  if (!index || index.stamp !== src.stamp() || index.seenVersion !== seenVersion || Date.now() - index.at > REBUILD_MS) build();
  return index;
};

// ---------- ranking ----------
// The live catalogue's answer for THIS query, as documents: a twin of a
// title already indexed lends it its name and its place in the catalogue's
// order; anything new becomes a document for this one query.
// Popularity is what the index knows (the library, the trending position,
// earlier searches) PLUS half the catalogue's place for this query: the
// catalogue's order alone is not popularity while a word is half typed
// ("interste" → "Interstellar Ella" ahead of Interstellar).
const withLive = (idx, live) => {
  const extra = [];
  const pops = new Map(); // doc.key → popularity for this query
  const akas = new Map(); // doc.key → [{title, tf}]
  if (!live) return { extra, pops, akas };
  const lists = [live.movies || [], live.shows || []];
  const fresh = new Map();
  for (const list of lists) {
    list.forEach((m, i) => {
      if (!m || !m.title) return;
      const pop = 0.9 * (1 - Math.min(i, 17) / 18);
      const lib = (m.inLibrary && idx.byLib.get(m.inLibrary)) ||
        idx.byTitle.get(`${typeOf(m.type)}|${norm(m.title)}|${m.year || ""}`);
      const twin = lib || (m.imdbId && (idx.byImdb.get(m.imdbId) || fresh.get(m.imdbId)));
      if (twin) {
        pops.set(twin.key, Math.max(pops.get(twin.key) || 0, pop));
        if (norm(m.title) !== twin.tf.raw.s) {
          const list2 = akas.get(twin.key) || [];
          list2.push({ title: m.title, tf: forms(m.title) });
          akas.set(twin.key, list2);
        }
        return;
      }
      if (!m.imdbId || !(m.poster || m.cover)) return;
      const d = catalogDoc(m, 0);
      pops.set(d.key, pop);
      fresh.set(d.imdbId, d);
      extra.push(d);
    });
  }
  return { extra, pops, akas };
};

const rank = (Q, idx, { live = null, allow = null, pin = null, limit = 60, type = null, noSynopsis = false } = {}) => {
  const { extra, pops, akas } = withLive(idx, live);
  const cands = [];
  const consider = (d) => {
    if (type && d.type !== type) return;
    let m = scoreDoc(Q, d);
    const more = akas.get(d.key);
    if (more) {
      for (const aka of more) {
        const a = titleScore(Q, aka.tf, d.year);
        const t = a.tier;
        if (!m || t > m.tier) m = { tier: t, ym: a.ym, lit: 0, kind: "aka", label: aka.title };
      }
    }
    if (!m) return;
    const livePop = pops.get(d.key) || 0;
    // one slip from a title the household owns, or from the catalogue's own
    // first answer for these letters: it goes right under "starts with"
    if (m.tier === FUZZY_WHOLE && (m.kind === "title" || m.kind === "aka") && (d.inLibrary || livePop >= 0.9)) m.tier = LIFTED;
    cands.push({ doc: d, ...m, pop: d.pop + 0.5 * livePop });
  };
  for (const d of idx.docs) consider(d);
  for (const d of extra) consider(d);
  cands.sort(cmp);
  // the title was named exactly: no near-misses under it
  const named = cands.length > 0 && cands[0].tier >= 1000;
  const out = [];
  let solid = 0;
  for (const c of cands) {
    const fuzzy = (c.kind === "title" || c.kind === "aka") && c.tier >= 560 && c.tier <= FUZZY_WHOLE;
    if ((named && fuzzy) || (c.kind === "synopsis" && (named || noSynopsis))) continue;
    if (c.kind === "synopsis" && solid >= 12) continue;
    if (allow && !allow(cardItem(c.doc))) continue;
    if (c.kind !== "synopsis") solid++;
    out.push(c);
    if (out.length >= limit) break;
  }
  // The card that was first when the local answer was painted stays first
  // when the catalogue's answer arrives — unless something matches BETTER.
  if (pin && out.length > 1 && out[0].doc.key !== pin) {
    const i = out.findIndex((c) => c.doc.key === pin);
    if (i > 0 && out[i].tier === out[0].tier && out[i].ym === out[0].ym) out.unshift(...out.splice(i, 1));
  }
  return out;
};

// ---------- cards ----------
const listEntry = (i) => {
  if (!i || !i.seasons) return i;
  const { seasons, ...rest } = i;
  return rest;
};
// what the kids gate judges (and what a card is built from)
const cardItem = (d) => (d.inLibrary ? d.item : { imdbId: d.imdbId, type: d.type, title: d.title, year: d.year });
const WHY = {
  episode: (c) => c.label,
  person: (c) => `With ${c.label}`,
  role: (c) => c.label,
  aka: () => null,
};
const card = (d, extra = {}) =>
  d.inLibrary
    ? { ...listEntry(d.item), imdbId: d.imdbId || d.item.imdbId || undefined, inLibrary: d.libId, source: "downloaded", key: d.key, ...extra }
    : {
        imdbId: d.imdbId, type: d.type, title: d.title, year: d.year, poster: d.cover, cover: d.cover,
        rating: d.rating, genres: d.genres, synopsis: d.synopsis, inLibrary: null, source: "stream", key: d.key, ...extra,
      };
const resultCard = (c) => {
  const meta = WHY[c.kind] ? WHY[c.kind](c) : null;
  return card(c.doc, { match: { tier: c.tier, kind: c.kind, ...(c.label ? { label: c.label } : {}) }, ...(meta ? { meta } : {}) });
};

// ---------- the related tail ----------
const RELATED_MAX = 18;
// Is the top match something to build a "More like …" on? An exact title
// always; a looser match only when it is nearly alone (typing "incep" with
// one film left is a decision, typing "th" with forty is not).
const anchorOf = (ranked) => {
  const top = ranked[0];
  if (!top || (top.kind !== "title" && top.kind !== "aka")) return null;
  if (top.tier >= 1000) return top;
  if (top.tier < 580) return null;
  return ranked.filter((c) => (c.kind === "title" || c.kind === "aka") && c.tier >= 580).length <= 3 ? top : null;
};

const neighbours = (anchor, idx) => {
  const ag = new Set(anchor.genres || []);
  const ap = new Set(anchor.people.map((p) => p.v.s));
  const out = [];
  for (const d of idx.docs) {
    if (d === anchor || !d.cover) continue;
    let shared = null;
    for (const p of d.people) if (ap.has(p.v.s)) { shared = shared || p.name; }
    const sharedCount = shared ? d.people.filter((p) => ap.has(p.v.s)).length : 0;
    let g = 0;
    for (const x of d.genres) if (ag.has(x)) g++;
    if (!sharedCount && (g < 2 && !(ag.size === 1 && g === 1))) continue;
    if (!sharedCount && d.type !== anchor.type) continue;
    const union = ag.size + d.genres.length - g;
    const score = 3 * sharedCount + 2 * (union ? g / union : 0) + (d.type === anchor.type ? 0.5 : 0) + (d.rating || 0) / 20 + (d.inLibrary ? 0.3 : 0);
    out.push({ d, score, why: sharedCount ? { kind: "cast", label: `With ${shared}` } : { kind: "genre", label: anchor.genres.filter((x) => d.genres.includes(x)).slice(0, 2).join(" · ") } });
  }
  out.sort((a, b) => b.score - a.score || (a.d.title < b.d.title ? -1 : 1));
  return out;
};

// catalogue-shaped rows (a franchise, a "more like this" row, a person's
// credits) → documents, the library's copy standing in where there is one
const docsFromItems = (items, idx) => {
  let marked = [];
  try { marked = src.markLibrary((items || []).filter((m) => m && m.title).map((m) => ({ ...m }))); } catch { marked = items || []; }
  const out = [];
  for (const m of marked) {
    const d = (m.inLibrary && idx.byLib.get(m.inLibrary)) || (m.imdbId && idx.byImdb.get(m.imdbId)) ||
      idx.byTitle.get(`${typeOf(m.type)}|${norm(m.title)}|${m.year || ""}`) ||
      (m.imdbId && (m.poster || m.cover) ? catalogDoc(m, 0) : null);
    if (d) out.push(d);
  }
  return out;
};

const buildRelated = (idx, { anchor = null, similarItems = null, person = null, genre = null, exclude, allow }) => {
  const out = [];
  const have = new Set(exclude);
  const push = (d, why) => {
    if (out.length >= RELATED_MAX || have.has(d.key)) return;
    if (allow && !allow(cardItem(d))) return;
    have.add(d.key);
    out.push(card(d, { why }));
  };
  if (person) {
    for (const d of docsFromItems(person.items, idx)) push(d, { kind: "person", label: `With ${person.name}` });
    return { label: `With ${person.name}`, kind: "person", items: out };
  }
  if (anchor) {
    const d0 = anchor.doc;
    if (d0.imdbId) {
      let coll = null;
      try { coll = d0.type === "movie" ? src.collectionCached(d0.imdbId) : null; } catch {}
      if (coll && coll.collection && Array.isArray(coll.collection.items)) {
        for (const d of docsFromItems(coll.collection.items, idx)) push(d, { kind: "collection", label: coll.collection.name });
      }
      let sim = similarItems;
      if (!sim) { try { sim = src.similarCached(d0.type, d0.imdbId); } catch {} }
      for (const d of docsFromItems(sim || [], idx)) push(d, { kind: "similar", label: `Like ${d0.title}` });
    }
    for (const n of neighbours(d0, idx)) push(n.d, n.why);
    return { label: `More like ${d0.title}`, kind: "similar", items: out };
  }
  if (genre) {
    const pool = idx.docs.filter((d) => d.cover && d.genres.includes(genre));
    pool.sort((a, b) => (b.inLibrary ? 1 : 0) - (a.inLibrary ? 1 : 0) || (b.rating || 0) - (a.rating || 0) || b.pop - a.pop || (a.title < b.title ? -1 : 1));
    for (const d of pool) push(d, { kind: "genre", label: genre });
    return { label: genre, kind: "genre", items: out };
  }
  return { label: null, kind: null, items: [] };
};

// ---------- people from TMDB (a name the local index does not know) ----------
const personMiss = new Map(); // normalised query → at
const personInFlight = new Map();
const tmdbPerson = async (name) => {
  const key = norm(name);
  const store = seen();
  const people = store.data.people || (store.data.people = {});
  const hit = people[key];
  if (hit && Date.now() - hit.at < TMDB_PERSON_TTL) return hit;
  if (personMiss.has(key) && Date.now() - personMiss.get(key) < 6 * 3600 * 1000) return null;
  if (personInFlight.has(key)) return personInFlight.get(key);
  const p = (async () => {
    const { tmdb, addImdbIds, mapItems } = require("./similar");
    const found = ((await tmdb("search/person", `&query=${encodeURIComponent(name)}`)).results || [])
      .sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    const qv = mkView(key.split(" "));
    const person = found.find((x) => {
      const t = tierView(qv, mkView(norm(x.name).split(" ").filter(Boolean)));
      return t >= 1000 || (qv.w.length >= 2 && t >= 600);
    });
    if (!person) {
      personMiss.set(key, Date.now());
      if (personMiss.size > 500) personMiss.delete(personMiss.keys().next().value);
      return null;
    }
    const credits = await tmdb(`person/${person.id}/combined_credits`);
    const rows = [...(credits.cast || []), ...(credits.crew || []).filter((c) => c.job === "Director")]
      .filter((c) => c.poster_path && (c.media_type === "movie" || c.media_type === "tv") && !(c.genre_ids || []).includes(10767) && !(c.genre_ids || []).includes(10763))
      .sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0));
    const seenIds = new Set();
    const top = rows.filter((c) => (seenIds.has(`${c.media_type}${c.id}`) ? false : seenIds.add(`${c.media_type}${c.id}`))).slice(0, 14);
    const movies = await addImdbIds(mapItems(top.filter((c) => c.media_type === "movie"), "movie"), "movie");
    const shows = await addImdbIds(mapItems(top.filter((c) => c.media_type === "tv"), "series"), "series");
    const order = new Map(top.map((c, i) => [c.id, i]));
    const items = [...movies, ...shows].filter((m) => m.imdbId).sort((a, b) => order.get(a.tmdbId) - order.get(b.tmdbId));
    const entry = { name: person.name, id: person.id, items, ids: items.map((m) => m.imdbId), at: Date.now() };
    people[key] = entry;
    if (norm(person.name) !== key) people[norm(person.name)] = entry;
    const keys = Object.keys(people);
    if (keys.length > 300) keys.sort((a, b) => people[a].at - people[b].at).slice(0, 60).forEach((k) => delete people[k]);
    store.save();
    rememberSeen(items.map((m, i) => ({ ...m, _rank: 6 + Math.min(7, i) })));
    seenVersion++;
    return entry;
  })().finally(() => personInFlight.delete(key));
  personInFlight.set(key, p);
  return p;
};

// ---------- the search ----------
const LIVE_MIN = 3; // while typing; a committed search asks at any length
const LIVE_BUDGET = 6000;
const RELATED_BUDGET = 3000;
const liveText = (text) => String(text).replace(/[^\p{L}\p{N}'\u2019&]+/gu, " ").replace(/\s+/g, " ").trim() || String(text);
// several answers for one kind, interleaved by their own order (first of each, second of each…)
const mergeRanked = (lists) => {
  const out = [];
  const seenIds = new Set();
  const n = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < n; i++) for (const l of lists) {
    const m = l[i];
    const k = m && (m.imdbId || `${m.type}|${m.title}|${m.year}`);
    if (!m || seenIds.has(k)) continue;
    seenIds.add(k);
    out.push(m);
  }
  return out;
};
const within = (p, ms) => Promise.race([p, new Promise((r) => { const t = setTimeout(() => r(undefined), ms); if (t.unref) t.unref(); })]);

// search(q, opts) → {
//   q, results: [card], related: [card + why], relatedLabel, relatedKind,
//   anchor, pending, catalogFailed, tookMs }
// opts.wait: also wait (on a budget) for the live catalogue and for a related
// row that has to be fetched. Without it the answer is what is in memory
// right now, and `pending` says a second call with wait would add to it.
const search = async (q, opts = {}) => {
  const started = process.hrtime.bigint();
  const Q = parseQuery(q);
  const empty = { q: Q.text, results: [], related: [], relatedLabel: null, relatedKind: null, anchor: null, pending: false, catalogFailed: false, tookMs: 0 };
  if (!Q.len) return empty;
  const idx = ensureIndex();
  const allow = typeof opts.allow === "function" ? opts.allow : null;
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 60, 1), 80);
  const wantLive = !opts.localOnly && (opts.commit || Q.len >= LIVE_MIN);
  let pending = false;
  let catalogFailed = false;
  let waited = 0;

  // What the live catalogue is asked: the words (it finds nothing for
  // "WALL·E", everything for "WALL E"), and — when a year was typed — the
  // name without it too (it does not understand "her 2013").
  const asks = [liveText(Q.text)];
  if (Q.baseText) asks.push(Q.baseText);
  // "WALL·E", "wall-e": the catalogue knows it as one word
  const joined = /[\p{L}\p{N}][·•.\-][\p{L}\p{N}]/u.test(Q.text) && Q.words.length <= 3 ? Q.f.raw.q : null;
  if (joined && !asks.includes(joined)) asks.push(joined);
  const lives = [];
  for (const ask of asks) {
    let hit = null;
    try { hit = src.liveCached(ask); } catch {}
    if (!hit && wantLive) {
      const p = Promise.resolve().then(() => src.live(ask)).catch(() => null);
      if (opts.wait) hit = p; // awaited together, below
      else pending = true;
    }
    if (hit) lives.push(hit);
  }
  let live = null;
  if (lives.length) {
    const t0 = Date.now();
    const got = lives.some((x) => typeof x.then === "function")
      ? await within(Promise.all(lives), LIVE_BUDGET)
      : lives;
    waited += Date.now() - t0;
    const ok = (got || []).filter(Boolean);
    if (ok.length < lives.length) catalogFailed = true;
    if (ok.length) live = { movies: mergeRanked(ok.map((x) => x.movies || [])), shows: mergeRanked(ok.map((x) => x.shows || [])) };
  }
  if (live) {
    try {
      const rows = [];
      for (const list of [live.movies, live.shows]) list.forEach((m, i) => rows.push({ ...m, _rank: i }));
      src.remember(rows);
    } catch {}
  }

  // the query IS a genre ("comedy"): its titles are the related tail's job,
  // not forty synopsis matches
  const genreName = idx.genres.get(Q.f.raw.s) || null;
  const ranked = rank(Q, idx, { live, allow, pin: opts.pin || null, limit, type: opts.type || null, noSynopsis: !!genreName });
  const exclude = ranked.map((c) => c.doc.key);
  const bestTitle = ranked.find((c) => c.kind === "title" || c.kind === "aka");
  const anchor = anchorOf(ranked);
  const genre = !bestTitle || bestTitle.tier < 1000 ? genreName : null;
  const localPerson = ranked[0] && ranked[0].kind === "person" ? ranked[0].label : null;

  let related = { label: null, kind: null, items: [] };
  if (anchor) {
    let similarItems = null;
    const d0 = anchor.doc;
    let cached = null;
    try { cached = d0.imdbId ? src.similarCached(d0.type, d0.imdbId) : null; } catch {}
    // a row that has to be FETCHED is fetched only for a title named in full
    // (never per keystroke), only in the waiting call, and on a budget
    if (!(cached && cached.length) && d0.imdbId && anchor.tier >= 1000 && src.canFetchSimilar()) {
      if (opts.wait) {
        const t0 = Date.now();
        similarItems = (await within(Promise.resolve().then(() => src.similarFetch(d0.type, d0.imdbId)).catch(() => null), RELATED_BUDGET)) || null;
        waited += Date.now() - t0;
      } else pending = true;
    }
    related = buildRelated(idx, { anchor, similarItems, exclude, allow });
  } else if (genre) {
    related = buildRelated(idx, { genre, exclude, allow });
  } else {
    // a person: someone the index knows, or a name TMDB knows (asked only
    // when no title really matched — a title search never costs a people lookup)
    const titleStrong = bestTitle && bestTitle.tier >= LIFTED;
    const looksLikeName = Q.len >= 5 && !/\d/.test(Q.f.raw.s) && (Q.words.length >= 2 || !!localPerson);
    if (!titleStrong && looksLikeName && src.canFetchPeople()) {
      if (opts.wait) {
        const t0 = Date.now();
        const person = (await within(Promise.resolve().then(() => src.personFetch(localPerson || Q.text)).catch(() => null), RELATED_BUDGET)) || null;
        waited += Date.now() - t0;
        if (person && person.items && person.items.length) related = buildRelated(ensureIndex(), { person, exclude, allow });
      } else pending = true;
    }
  }

  return {
    q: Q.text,
    results: ranked.map(resultCard),
    related: related.items,
    relatedLabel: related.items.length ? related.label : null,
    relatedKind: related.items.length ? related.kind : null,
    anchor: anchor ? { key: anchor.doc.key, title: anchor.doc.title } : null,
    pending,
    catalogFailed,
    // the engine's own time: what it waited for outside (the catalogue, TMDB) is not in it
    tookMs: Math.max(0, Math.round((Number(process.hrtime.bigint() - started) / 1e6 - waited) * 100) / 100),
  };
};

// ---------- suggestions ----------
// Which characters of the title the query matched: [[start, end), …] in the
// title as it is printed. Empty for a typo match — nothing to underline.
const highlight = (display, Q) => {
  const chars = [];
  const at = [];
  const starts = [];
  let sep = true;
  const s = String(display || "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'" || ch === "’") continue;
    const f = ch.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (/^[a-z0-9֐-׿]+$/.test(f)) {
      for (const c of f) {
        if (sep) starts.push(chars.length);
        sep = false;
        chars.push(c);
        at.push(i);
      }
    } else sep = true;
  }
  const sq = chars.join("");
  const out = [];
  const add = (a, n) => out.push([at[a], at[a + n - 1] + 1]);
  const whole = Q.f.raw.q;
  const first = starts.find((st) => sq.startsWith(whole, st));
  if (first !== undefined) add(first, whole.length);
  else {
    for (const w of Q.f.raw.w) {
      const st = starts.find((x) => sq.startsWith(w, x));
      if (st !== undefined) add(st, w.length);
    }
  }
  out.sort((a, b) => a[0] - b[0]);
  return out.filter((r, i) => i === 0 || r[0] >= out[i - 1][1]);
};

// suggest(q, {limit, type, allow}) → [
//   { kind: "title", id?, imdbId?, type, title, year, cover, inLibrary, hl },
//   { kind: "person", name, count, hl },
//   { kind: "genre", name, hl } ]
// Titles that start with what was typed come first (library, then
// catalogue), then people and a genre, then looser and typo'd titles. The
// order inside a tier does not depend on the query, so the first row stays
// where it is while it still matches as well as anything else.
const SUGGEST_MAX = 8;
const suggest = (q, opts = {}) => {
  const Q = parseQuery(q);
  if (!Q.len) return [];
  const idx = ensureIndex();
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || SUGGEST_MAX, 1), 10);
  const type = opts.type === "movie" || opts.type === "show" ? opts.type : null;
  const allow = typeof opts.allow === "function" ? opts.allow : null;
  const floor = Q.len === 1 ? 900 : Q.len === 2 ? 760 : 580;
  // what the live catalogue already answered for these very letters is in
  // memory: its titles can be suggested too (never fetched for a suggestion)
  let live = null;
  try { live = src.liveCached(liveText(Q.text)); } catch {}
  const { extra, pops } = withLive(idx, live);
  const cands = [];
  for (const d of [...idx.docs, ...extra]) {
    if (type && d.type !== type) continue;
    if (!d.cover && !d.inLibrary) continue;
    const m = scoreDoc(Q, d, { titlesOnly: true });
    if (!m || m.tier < floor) continue;
    if (m.tier === FUZZY_WHOLE && d.inLibrary) m.tier = LIFTED;
    cands.push({ doc: d, ...m, pop: d.pop + 0.5 * (pops.get(d.key) || 0) });
  }
  cands.sort(cmp);
  const all = [];
  for (const c of cands) {
    if (allow && !allow(cardItem(c.doc))) continue;
    all.push(c);
    if (all.length >= limit) break;
  }
  // letters found in the MIDDLE of a word ("rea" in Scream) are a result, not
  // a suggestion — unless there is next to nothing else to offer
  const solid = all.filter((c) => c.tier !== 700);
  const titles = solid.length >= 3 ? solid : all;
  const people = [];
  // people from three letters; a surname (any word but the first) from four
  if (Q.len >= 3 && !type) {
    for (const p of idx.people.values()) {
      const t = tierView(Q.f.raw, p.v, false);
      if (t < (Q.len >= 4 ? 760 : 900)) continue;
      let count = 0;
      for (const key of p.keys) {
        const d = key.startsWith("lib:") ? idx.byLib.get(key.slice(4)) : idx.byImdb.get(key);
        if (d && (!allow || allow(cardItem(d)))) count++;
      }
      if (count) people.push({ t, count, name: p.name });
    }
    people.sort((a, b) => b.t - a.t || b.count - a.count || (a.name < b.name ? -1 : 1));
  }
  const genres = [];
  if (Q.len >= 3 && !type) {
    const seenG = new Set();
    for (const [k, name] of idx.genres) {
      if (!k.startsWith(Q.f.raw.s) || seenG.has(name)) continue;
      seenG.add(name);
      genres.push(name);
    }
    genres.sort();
  }
  const strong = titles.filter((c) => c.tier >= 900);
  const weak = titles.filter((c) => c.tier < 900);
  const nPeople = Math.min(people.length, strong.length >= 4 ? 2 : 3);
  const nGenre = Math.min(genres.length, 1);
  const exactPerson = people.length && people[0].t >= 1000 && !(strong[0] && strong[0].tier >= 1000);
  const titleOut = (c) => ({
    kind: "title",
    id: c.doc.libId || undefined,
    imdbId: c.doc.imdbId || undefined,
    type: c.doc.type,
    title: c.doc.title,
    year: c.doc.year,
    cover: c.doc.cover,
    inLibrary: c.doc.inLibrary,
    hl: c.tier >= 700 && c.kind === "title" ? highlight(c.doc.title, Q) : [],
    ...(c.kind === "aka" ? { aka: c.label } : {}),
  });
  const personOut = (p) => ({ kind: "person", name: p.name, count: p.count, hl: highlight(p.name, Q) });
  const genreOut = (g) => ({ kind: "genre", name: g, hl: highlight(g, Q) });
  const room = Math.max(1, limit - nPeople - nGenre);
  const head = strong.slice(0, room).map(titleOut);
  const mid = [...people.slice(0, nPeople).map(personOut), ...genres.slice(0, nGenre).map(genreOut)];
  const out = exactPerson ? [...mid, ...head] : [...head, ...mid];
  for (const c of weak) {
    if (out.length >= limit) break;
    out.push(titleOut(c));
  }
  return out.slice(0, limit);
};

// The old answer of /api/search (clients from before this file): the library
// items that matched, and the cached catalogue's matches — now in ranked order.
const legacy = (q, { allow = null } = {}) => {
  const Q = parseQuery(q);
  if (!Q.len) return { results: [], catalog: [] };
  const ranked = rank(Q, ensureIndex(), { allow, limit: 80 });
  return {
    results: ranked.filter((c) => c.doc.inLibrary).slice(0, 40).map((c) => c.doc.item),
    catalog: ranked.filter((c) => !c.doc.inLibrary && c.kind !== "synopsis").slice(0, 24).map((c) => ({
      imdbId: c.doc.imdbId, type: c.doc.type, title: c.doc.title, year: c.doc.year,
      poster: c.doc.cover, rating: c.doc.rating, genres: c.doc.genres, score: c.tier / 10,
    })),
  };
};

const stats = () => {
  const idx = ensureIndex();
  return { docs: idx.docs.length, library: idx.byLib.size, people: idx.people.size, genres: idx.genres.size, buildMs: idx.buildMs };
};

// test hooks: replace what the engine reads, drop the index
const _setSources = (next) => {
  src = { ...src, ...next };
  index = null;
};
const _reset = () => { index = null; };

module.exports = {
  search, suggest, legacy, stats,
  _internals: { norm, forms, tierView, tierForms, parseQuery, titleScore, scoreDoc, rank, highlight, build, ensureIndex, anchorOf, _setSources, _reset, canonWord },
};
