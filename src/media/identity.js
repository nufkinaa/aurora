// THE library ↔ stream identity matcher. A title can exist twice — as a
// library item (id, local cover) and as a discover/stream entry (imdbId,
// hotlinked poster) — and before this module there were three separate
// title-matching implementations (server /api/imdb-for, the web client's
// findInLibrary, the TV's port) plus two title-ONLY dedupes that merged
// "Dune" 1984 onto "Dune" 2021. This is the single source of truth; new
// callers use this, never a fourth matcher.
//
// The rules are deliberately STRICT — a duplicate card beats a wrong merge:
//   1. A cached IMDb resolution for a library title is authoritative.
//   2. Exact normalized-title match, as long as years don't CONTRADICT
//      (a missing year on either side is fine).
//   3. Prefix match either way (folder names carry junk words: "Avatar
//      Movie") ONLY when both years are present and within one.
const scanner = require("./scanner");
const imdb = require("./imdb");

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/['’]/g, "") // don't -> dont, not "don t"
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const titlesMatch = (aTitle, aYear, bTitle, bYear) => {
  const a = norm(aTitle);
  const b = norm(bTitle);
  if (!a || !b) return false;
  if (a === b) {
    if (aYear && bYear && Math.abs(aYear - bYear) > 1) return false;
    return true;
  }
  if (!aYear || !bYear || Math.abs(aYear - bYear) > 1) return false;
  return a.startsWith(b) || b.startsWith(a);
};

// Fast lookup maps over the whole library — rebuilt per batch call. Library
// titles are normalized ONCE here; findLibraryFor then only norms the query.
// (Before this, markLibrary re-normed every catalog×library pair — measured
// at 26ms per /api/home request on the household library.)
const libraryMaps = (allItems = scanner.allItems()) => {
  const byImdb = new Map();
  const byTitle = new Map();
  const pools = { movie: [], show: [] };
  for (const item of allItems) {
    const id = imdb.cachedIdFor(item.title, item.type, item.year);
    if (id) byImdb.set(id, item);
    const nt = norm(item.title);
    if (!byTitle.has(nt)) byTitle.set(nt, []);
    byTitle.get(nt).push(item);
    // An empty normalized title (Hebrew/CJK/punctuation-only names — this
    // norm is ASCII-only by design) must NEVER enter the prefix pool:
    // "".startsWith / startsWith("") are both true, so an empty nt would
    // match EVERY same-year query. titlesMatch refuses empties; so do we.
    if (nt) pools[item.type === "show" ? "show" : "movie"].push({ item, nt });
  }
  return { byImdb, byTitle, pools };
};

// The library item a stream identity ({imdbId, type, title, year}) refers
// to, or null. `maps` lets batch callers reuse one set of maps.
const findLibraryFor = ({ imdbId, type, title, year } = {}, maps = null) => {
  const wantType = type === "series" || type === "show" ? "show" : "movie";
  const m = maps || libraryMaps();
  if (imdbId && m.byImdb.has(imdbId)) return m.byImdb.get(imdbId);
  if (!title) return null;
  const nq = norm(title);
  if (!nq) return null;
  // exact normalized title first (with year non-contradiction) …
  for (const item of m.byTitle.get(nq) || []) {
    if (
      item.type === wantType &&
      !(item.year && year && Math.abs(item.year - year) > 1)
    )
      return item;
  }
  // … then the strict prefix rule — which REQUIRES both years present and
  // within one, so a query with no year can skip the pool walk entirely.
  if (!year) return null;
  for (const { item, nt } of m.pools[wantType]) {
    if (!item.year || Math.abs(item.year - year) > 1) continue;
    if (nt !== nq && (nt.startsWith(nq) || nq.startsWith(nt))) return item;
  }
  return null;
};

// The cached IMDb id for a library item (sync, no network), or null.
const imdbIdFor = (item) =>
  item ? imdb.cachedIdFor(item.title, item.type, item.year) : null;

// Mark catalog items with the library id they correspond to. Replaces the
// old title-only map in discover.js (which had no year and no imdbId path).
const markLibrary = (items) => {
  const maps = libraryMaps();
  for (const item of items) {
    const lib = findLibraryFor(item, maps);
    item.inLibrary = lib ? lib.id : null;
  }
  return items;
};

module.exports = {
  findLibraryFor,
  imdbIdFor,
  markLibrary,
  titlesMatch,
  _internals: { norm, titlesMatch, libraryMaps },
};
