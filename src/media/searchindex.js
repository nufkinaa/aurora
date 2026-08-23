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

const fuzzyWordMatch = (queryWords, titleWords) =>
  queryWords.length > 0 &&
  queryWords.every((qw) => {
    const budget = qw.length >= 8 ? 2 : qw.length >= 4 ? 1 : 0;
    // 3-letter words get typo tolerance ONLY for pure transpositions
    // ("teh" → "the"). A general edit budget of 1 at this length matches a
    // third of the dictionary — "man" would pull in men/mad/map/any.
    const sorted3 =
      qw.length === 3 ? [...qw].sort().join("") : null;
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
  });

// Score one entry for a normalized query. 0 = no match.
const scoreTitle = (nq, qWords, entry) => {
  const nt = entry.normTitle;
  if (!nt) return 0;
  if (nt === nq) return 100;
  if (nt.startsWith(nq)) return 90;
  if (qWords.every((qw) => entry.words.some((tw) => tw.startsWith(qw)))) return 80;
  if (nt.includes(nq)) return 70;
  if (fuzzyWordMatch(qWords, entry.words)) return 55;
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
    inLibrary: !!inLibrary,
    normTitle,
    words: normTitle.split(" ").filter(Boolean),
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
const suggest = (q, limit = 8) => {
  const nq = norm(String(q || "").slice(0, 80));
  if (!nq) return [];
  ensureFresh();
  const qWords = nq.split(" ").filter(Boolean);
  const scored = [];
  for (const e of entries) {
    const s = scoreTitle(nq, qWords, e);
    if (s > 0) scored.push({ e, s });
  }
  scored.sort(
    (a, b) =>
      b.s - a.s ||
      (b.e.inLibrary ? 1 : 0) - (a.e.inLibrary ? 1 : 0) ||
      (b.e.rating || 0) - (a.e.rating || 0),
  );
  return scored.slice(0, limit).map(({ e }) => ({
    id: e.id,
    imdbId: e.imdbId,
    type: e.type,
    title: e.title,
    year: e.year,
    cover: e.cover,
    inLibrary: e.inLibrary,
  }));
};

module.exports = {
  suggest,
  _internals: { norm, editWithin, fuzzyWordMatch, scoreTitle, entryFor, build },
};
