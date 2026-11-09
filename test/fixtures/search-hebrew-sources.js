// A search corpus → the engine's sources (search.js _setSources), with no
// network and no disk. Shared by test/search-hebrew.test.js and
// tools/search-eval/hebrew-eval.js.
//
// corpus: {
//   library:  [{ id, type, title, year, imdbId, genres, rating }]
//   trending: { movies: [...], shows: [...] }   (catalogue cards)
//   known:    [{ imdbId, type, title, year, poster, rating, genres, k }]
//   recs:     [{ imdbId, type, title, year, poster, rating, votes }]
//   he:       { tt…: "the official Hebrew name" }
// }
// opts.hebrewNames false: the engine runs as if no Hebrew name were known
// (the "sound" cases must be found from the letters alone).
const sourcesFor = (corpus, { hebrewNames = true } = {}) => {
  const library = (corpus.library || []).map((i) => ({ cover: `/img/${i.id}`, synopsis: "", genres: [], rating: 7, ...i }));
  const libByImdb = new Map(library.filter((i) => i.imdbId).map((i) => [i.imdbId, i]));
  const he = new Map(Object.entries(hebrewNames ? corpus.he || {} : {}));
  const mark = (list) => {
    for (const m of list) m.inLibrary = libByImdb.has(m.imdbId) ? libByImdb.get(m.imdbId).id : null;
    return list;
  };
  const trending = corpus.trending
    ? { movies: mark((corpus.trending.movies || []).map((m) => ({ ...m }))), shows: mark((corpus.trending.shows || []).map((m) => ({ ...m }))) }
    : null;
  return {
    stamp: () => 1,
    libraryItems: () => library,
    imdbIdFor: (i) => i.imdbId || null,
    markLibrary: mark,
    trending: () => trending,
    seenTitles: () => [],
    seenPeople: () => [],
    knownTitles: () => corpus.known || [],
    knownStamp: () => "",
    recTitles: () => corpus.recs || [],
    facts: () => [],
    hebrewTitle: (id) => he.get(id) || null,
    liveCached: () => null,
    live: async () => ({ movies: [], shows: [] }),
    similarCached: () => null,
    collectionCached: () => null,
    canFetchSimilar: () => false,
    similarFetch: async () => [],
    canFetchPeople: () => false,
    personFetch: async () => null,
    remember: () => {},
  };
};

// Does a result title satisfy a case's `want`? ("Prefix*" = starts with)
const fold = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const wanted = (want, title) =>
  want.some((w) => (w.endsWith("*") ? fold(title).startsWith(fold(w.slice(0, -1))) : fold(title) === fold(w)));

module.exports = { sourcesFor, wanted };
