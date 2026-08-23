// Fuzzy title search over the library + the cached streaming catalog.
// Measured before this existed (findings/search.md): any 1-character typo
// returned zero library results, punctuation was load-bearing ("honey dont"
// found nothing), and the catalog fallback cost 370–920ms of upstream per
// keystroke. This index answers typo'd, half-typed and mis-spaced queries
// from memory in well under a millisecond per candidate set.
//
// Ranking tiers (higher wins; library beats catalog inside a tier):
//   100 exact normalized title
//    90 title starts with the query
//    80 every query word starts some title word ("thursday club")
//    70 title contains the query as a substring
//    55 every query word fuzzy-matches some title word
//       (Damerau-Levenshtein ≤1, ≤2 for words of 8+ chars)
const scanner = require("./scanner");
const discover = require("./discover");

// Normalization keeps Hebrew letters (the household searches in Hebrew too) —
// stripping to [a-z0-9] would collapse a Hebrew query to an empty string.
const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/['’]/g, "") // don't -> dont, not "don t"
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // fold diacritics: café → cafe
    .replace(/[^a-z0-9֐-׿]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// Damerau-Levenshtein "is the distance ≤ max?", with the cheap outs first.
// Titles and queries are short words — the DP is a few dozen cells.
const editWithin = (a, b, max) => {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > max) return false;
  const la = a.length, lb = b.length;
  let prev2 = null;
  let prev = Array.from({ length: lb + 1 }, (_, j) => j);
  for (let i = 1; i <= la; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      // transposition (the classic swapped-letters typo)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return false; // the whole row is already over budget
    prev2 = prev;
    prev = cur;
  }
  return prev[lb] <= max;
};

// Does ONE query word land on any title word? (prefix, typo budget, or
// substring for longer words.) 3-letter words get typo tolerance ONLY for
// pure transpositions ("teh" → "the") — a general edit budget of 1 at that
// length matches a third of the dictionary ("man" would pull in men/mad/map).
const wordHits = (qw, titleWords) => {
  // Digit words (years, sequel numbers) match by PREFIX only — a fuzzy
  // budget would make "2016" hit 2019/2015/2026, i.e. half the catalog.
  if (/^\d+$/.test(qw)) return titleWords.some((tw) => tw.startsWith(qw));
  const budget = qw.length >= 8 ? 2 : qw.length >= 4 ? 1 : 0;
  const sorted3 = qw.length === 3 ? [...qw].sort().join("") : null;
  return titleWords.some(
    (tw) =>
      tw.startsWith(qw) ||
      (budget > 0 && editWithin(qw, tw, budget)) ||
      (sorted3 !== null &&
        tw.length === 3 &&
        sorted3 === [...tw].sort().join("") &&
        editWithin(qw, tw, 1)) ||
      (qw.length >= 4 && tw.includes(qw)),
  );
};

const fuzzyWordMatch = (queryWords, titleWords) =>
  queryWords.length > 0 && queryWords.every((qw) => wordHits(qw, titleWords));

// Score one entry for a normalized query. 0 = no match. The year token
// (entry.wordsWithYear) joins the word pool ONLY when the query carries at
// least one non-digit word — a bare "20" prefix-matching every 20xx year
// would score the whole catalog at tier 80.
const scoreTitle = (nq, qWords, entry, useYear = qWords.some((w) => !/^\d+$/.test(w))) => {
  const nt = entry.normTitle;
  if (!nt) return 0;
  const words = useYear && entry.wordsWithYear ? entry.wordsWithYear : entry.words;
  if (nt === nq) return 100;
  if (nt.startsWith(nq)) return 90;
  if (qWords.every((qw) => words.some((tw) => tw.startsWith(qw)))) return 80;
  if (nt.includes(nq)) return 70;
  if (fuzzyWordMatch(qWords, words)) return 55;
  return 0;
};

// ---------- the index ----------
let entries = [];
let builtScanStamp = null;
let builtAt = 0;
const REBUILD_MS = 60000; // catches trending-cache refreshes without a hook

const entryFor = (item, inLibrary) => {
  const normTitle = norm(item.title);
  return {
    id: inLibrary ? item.id : undefined,
    imdbId: item.imdbId || undefined,
    type: item.type,
    title: item.title,
    year: item.year || null,
    cover: inLibrary ? item.cover || null : item.poster || null,
    rating: item.rating || null,
    genres: item.genres || [],
    inLibrary: !!inLibrary,
    normTitle,
    words: normTitle.split(" ").filter(Boolean),
    // The year as a searchable word — kept SEPARATE so scoring can include
    // it only for queries that also carry a real word ("dune 2021",
    // "arrival 2") and never for a bare digit prefix ("20" → everything).
    wordsWithYear: item.year
      ? [...normTitle.split(" ").filter(Boolean), String(item.year)]
      : null,
  };
};

const build = () => {
  const out = [];
  const seenTitles = new Set();
  for (const item of scanner.allItems()) {
    out.push(entryFor(item, true));
    seenTitles.add(`${item.type}|${norm(item.title)}|${item.year || ""}`);
  }
  // trendingCached returns {movies, shows} (or null before first warm)
  const trending = discover.trendingCached();
  const catalog = trending
    ? [...(trending.movies || []), ...(trending.shows || [])]
    : [];
  for (const item of catalog) {
    if (!item.imdbId || !item.poster) continue;
    // A catalog twin of an owned title is the library entry's job to answer —
    // trendingCached already ran the identity matcher (inLibrary), and the
    // title+year belt catches anything it left.
    if (item.inLibrary) continue;
    if (seenTitles.has(`${item.type}|${norm(item.title)}|${item.year || ""}`)) continue;
    out.push(entryFor(item, false));
  }
  entries = out;
  builtScanStamp = scanner.index.scannedAt;
  builtAt = Date.now();
};

const ensureFresh = () => {
  // Rebuild on every scan (admin rescans included) and periodically so a
  // trending-cache refresh shows up — the check itself is two comparisons.
  if (
    !entries.length ||
    scanner.index.scannedAt !== builtScanStamp ||
    Date.now() - builtAt > REBUILD_MS
  ) {
    build();
  }
};

// Top suggestions for a query: tiny objects, library-first inside each tier.
// The dropdown should never look dead while the user is telling us MORE —
// so below the strict tiers sit two fillers (elia: "always recommend,
// keep it between 4 and 10 when we can"):
//   40+ most-of-the-words — ≥half the query words land ("arrival 2" while
//       typing a year no longer zeroes everything)
//   related — when real matches still number <4, top-rated titles sharing
//       a genre with the best hit fill the list to ~8, each tagged
//       `relatedTo` so the client can label them honestly.
const MIN_FILL = 4; // fewer real matches than this triggers the related fill
const FILL_TO = 8; // related fill aims here; real matches may reach `limit`
const suggest = (q, opts = {}) => {
  if (typeof opts === "number") opts = { limit: opts };
  const limit = Math.min(Math.max(Number(opts.limit) || 10, 1), 10);
  const type = opts.type === "movie" || opts.type === "show" ? opts.type : null;
  const nq = norm(String(q || "").slice(0, 80));
  if (!nq) return [];
  ensureFresh();
  const qWords = nq.split(" ").filter(Boolean);
  const pool = type ? entries.filter((e) => e.type === type) : entries;
  const scored = [];
  for (const e of pool) {
    const s = scoreTitle(nq, qWords, e);
    if (s > 0) scored.push({ e, s });
  }
  // most-of-the-words tier (multi-word queries only — for a single word this
  // would just duplicate the fuzzy tier)
  if (qWords.length >= 2) {
    const have = new Set(scored.map((x) => x.e));
    for (const e of pool) {
      if (have.has(e)) continue;
      let hits = 0;
      let wordHit = false; // a digit-only hit ("2" → every 20xx year) can't carry an entry alone
      for (const qw of qWords)
        if (wordHits(qw, e.words)) {
          hits++;
          if (!/^\d+$/.test(qw)) wordHit = true;
        }
      if (wordHit && hits / qWords.length >= 0.5)
        scored.push({ e, s: 40 + (hits / qWords.length) * 10 });
    }
  }
  scored.sort(
    (a, b) =>
      b.s - a.s ||
      (b.e.inLibrary ? 1 : 0) - (a.e.inLibrary ? 1 : 0) ||
      (b.e.rating || 0) - (a.e.rating || 0),
  );
  const picks = scored.slice(0, limit).map(({ e }) => ({ ...e }));
  // fill only when REAL matches are scarce (not when `limit` truncated a
  // plentiful set), and never beyond what the caller asked for
  if (picks.length > 0 && scored.length < MIN_FILL) {
    const anchor = picks[0];
    const ag = new Set(anchor.genres || []);
    if (ag.size) {
      const have = new Set(picks.map((p) => p.normTitle + "|" + (p.year || "")));
      const rel = [];
      for (const e of pool) {
        if (!e.cover || e.type !== anchor.type) continue;
        if (have.has(e.normTitle + "|" + (e.year || ""))) continue;
        const shared = (e.genres || []).filter((g) => ag.has(g)).length;
        if (shared > 0) rel.push({ e, shared });
      }
      rel.sort(
        (a, b) =>
          b.shared - a.shared ||
          (b.e.inLibrary ? 1 : 0) - (a.e.inLibrary ? 1 : 0) ||
          (b.e.rating || 0) - (a.e.rating || 0),
      );
      const fillTo = Math.min(FILL_TO, limit);
      for (const { e } of rel.slice(0, Math.max(0, fillTo - picks.length)))
        picks.push({ ...e, relatedTo: anchor.title });
    }
  }
  return picks.map((e) => ({
    id: e.id,
    imdbId: e.imdbId,
    type: e.type,
    title: e.title,
    year: e.year,
    cover: e.cover,
    inLibrary: e.inLibrary,
    ...(e.relatedTo ? { relatedTo: e.relatedTo } : {}),
  }));
};

// test hook: pin the index to a known set (marks it fresh so ensureFresh
// doesn't rebuild over it mid-test)
const _setEntries = (list) => {
  entries = list;
  builtScanStamp = scanner.index.scannedAt;
  builtAt = Date.now();
};

module.exports = {
  suggest,
  _internals: { norm, editWithin, wordHits, fuzzyWordMatch, scoreTitle, entryFor, build, _setEntries },
};
