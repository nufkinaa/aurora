// Discover: browsable catalogs of movies and shows that AREN'T in the
// library yet, for the Requests storefront. Keyless sources:
//   shows  - TVMaze (currently-airing schedules ranked by popularity weight)
//   movies - Wikipedia trending page-views filtered to film articles
// With a TMDB key in config.json, movies upgrade to TMDB trending/search.
const path = require("path");
const config = require("../config");
const scanner = require("./scanner");
const certification = require("./certification");
const { JsonStore } = require("../lib/jsonstore");

const cache = new JsonStore(path.join(config.CACHE_DIR, "discover.json"), {
  fetchedAt: 0,
  movies: [],
  shows: [],
});
const searchCache = new Map(); // q -> {at, result}
const TRENDING_TTL = 24 * 3600 * 1000;
const SEARCH_TTL = 3600 * 1000;

const UA = { "User-Agent": "Aurora/1.0 (personal media server)" };

const fetchJson = async (url) => {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
};

const normalize = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

const stripHtml = (s) => (s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

// Map every result onto one shape the frontend renders directly
const showItem = (s) => ({
  type: "show",
  title: s.name,
  year: s.premiered ? parseInt(s.premiered.slice(0, 4), 10) : null,
  poster: s.image?.medium || s.image?.original || null,
  synopsis: stripHtml(s.summary).slice(0, 400),
  rating: s.rating?.average || null,
  genres: s.genres || [],
});

const markLibrary = (items) => {
  // Delegates to the shared identity matcher (title+year strict, imdb-map
  // aware) — the old title-only map here merged "Dune" 1984 onto "Dune" 2021.
  // Lazily required: identity → imdb → THIS module; a top-level require
  // during our own load would hand imdb.js an empty partial export.
  return require("./identity").markLibrary(items);
};

// ---------- trending ----------

const trendingShows = async () => {
  const today = new Date().toISOString().slice(0, 10);
  const [tv, web] = await Promise.all([
    fetchJson(`https://api.tvmaze.com/schedule?country=US&date=${today}`).catch(() => []),
    fetchJson(`https://api.tvmaze.com/schedule/web?date=${today}`).catch(() => []),
  ]);

  const seen = new Map();
  for (const ep of [...tv, ...web]) {
    const show = ep.show || ep._embedded?.show;
    if (!show || !show.image || seen.has(show.id)) continue;
    seen.set(show.id, show);
  }
  return [...seen.values()]
    .sort(
      (a, b) =>
        (b.weight || 0) - (a.weight || 0) ||
        (b.rating?.average || 0) - (a.rating?.average || 0)
    )
    .slice(0, 40)
    .map(showItem);
};

const trendingMoviesWiki = async () => {
  // Last full month of page views
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");

  const data = await fetchJson(
    `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${y}/${m}/all-days`
  );
  const articles = (data.items?.[0]?.articles || [])
    .map((a) => a.article.replace(/_/g, " "))
    .filter(
      (t) =>
        /\((\d{4}\s+)?[A-Za-z ]*film\)$/.test(t) &&
        !/film series/i.test(t)
    )
    .slice(0, 28);

  const items = [];
  const batch = 4;
  for (let i = 0; i < articles.length; i += batch) {
    const chunk = await Promise.all(
      articles.slice(i, i + batch).map(async (title) => {
        try {
          const page = await fetchJson(
            `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`
          );
          const extract = page.extract || "";
          if (!/film/i.test(extract.slice(0, 260))) return null;
          const yearMatch = extract.slice(0, 260).match(/\b(19|20)\d{2}\b/);
          return {
            type: "movie",
            title: page.title.replace(/\s*\([^)]*film\)$/i, ""),
            year: yearMatch ? parseInt(yearMatch[0], 10) : null,
            poster: page.thumbnail?.source || null,
            synopsis: extract.slice(0, 400),
            rating: null,
            genres: [],
          };
        } catch {
          return null;
        }
      })
    );
    items.push(...chunk.filter(Boolean));
  }
  return items;
};

const trendingMoviesTmdb = async () => {
  const data = await fetchJson(
    `https://api.themoviedb.org/3/trending/movie/week?api_key=${config.TMDB_KEY}`
  );
  return (data.results || []).slice(0, 30).map((r) => ({
    type: "movie",
    title: r.title,
    year: r.release_date ? parseInt(r.release_date.slice(0, 4), 10) : null,
    poster: r.poster_path ? `https://image.tmdb.org/t/p/w342${r.poster_path}` : null,
    synopsis: (r.overview || "").slice(0, 400),
    rating: r.vote_average ? Math.round(r.vote_average * 10) / 10 : null,
    genres: [],
  }));
};

// Cinemeta popular catalogs — carry IMDb ids + posters, consistent with
// search, so every trending card can open its detail page directly.
const trendingCinemeta = async (type) => {
  // Cinemeta pages ~50 metas per skip step. Pull several pages so Browse has
  // a deep catalog to scroll through, not just the first page of trending.
  const pages = await Promise.all(
    [0, 100, 200, 300].map((skip) =>
      fetchJson(`https://v3-cinemeta.strem.io/catalog/${type}/top/skip=${skip}.json`).catch(() => ({ metas: [] }))
    )
  );
  const seen = new Set();
  return pages
    .flatMap((d) => d.metas || [])
    .map((m) => {
      const imdbId = /^tt\d+/.test(m.id) ? m.id : null;
      return {
        type: type === "series" ? "show" : "movie",
        title: m.name,
        year: m.releaseInfo ? parseInt(String(m.releaseInfo).slice(0, 4), 10) : null,
        poster: m.poster || null,
        // Real landscape art for the home hero (metahub serves one for
        // virtually every IMDb id) — without it the hero falls back to a
        // heavily blurred portrait poster.
        backdrop: m.background || (imdbId ? `https://images.metahub.space/background/medium/${imdbId}/img` : null),
        synopsis: (m.description || "").slice(0, 400),
        rating: m.imdbRating ? parseFloat(m.imdbRating) : null,
        genres: m.genres || [],
        imdbId,
      };
    })
    .filter((m) => {
      if (!m.poster || !m.imdbId || seen.has(m.imdbId)) return false;
      seen.add(m.imdbId);
      return true;
    })
    .slice(0, 200);
};

const trending = async () => {
  // Reuse cache only if fresh AND in the current shape (multi-page catalog)
  if (
    Date.now() - cache.data.fetchedAt < TRENDING_TTL &&
    cache.data.shows.length &&
    cache.data.shows[0].imdbId &&
    cache.data.v === 3 // catalog version; older caches lack backdrops — refetch
  ) {
    return {
      movies: markLibrary(cache.data.movies),
      shows: markLibrary(cache.data.shows),
    };
  }
  // Cinemeta first (ids + consistency); fall back to the older sources
  let [shows, movies] = await Promise.all([
    trendingCinemeta("series").catch(() => []),
    trendingCinemeta("movie").catch(() => []),
  ]);
  if (shows.length === 0) shows = await trendingShows().catch(() => []);
  if (movies.length === 0) {
    movies = await (config.TMDB_KEY ? trendingMoviesTmdb() : trendingMoviesWiki()).catch(() => []);
  }
  if (shows.length || movies.length) {
    cache.data = { fetchedAt: Date.now(), movies, shows, v: 3 };
    cache.save();
  }
  return { movies: markLibrary(movies), shows: markLibrary(shows) };
};

// ---------- browsable catalogs (paged) ----------
//
// What Browse runs on. The old page had one fixed list of 200 trending titles
// and filtered it in the browser, so picking a genre left you with a handful of
// results — "Westerns" out of 200 popular titles is three films. These catalogs
// are fetched per category AND per genre, a page at a time, so every genre has
// its own deep list instead of a slice of one.
//
// Cinemeta's three usable catalogs (from its manifest, verified 2026-07-27):
//   top         popular      genre + skip
//   imdbRating  best rated   genre + skip
//   year        newest       the "genre" extra IS the year here, so it cannot
//                            also filter by genre — see newCatalog() below.
const CATALOGS = {
  trending: { id: "top" },
  top: { id: "imdbRating" },
  new: { id: "year" },
};
const PAGE_SIZE = 50;                       // what Cinemeta returns per skip step
const catalogCache = new Map();              // key -> { at, items, rawCount }
const CATALOG_TTL = 6 * 3600 * 1000;
// "New" means released this year or last.
const NEW_SPAN = 2;
// Hard stop on how deep to walk one year's catalog. Measured 2026-07-27: a year
// runs ~4 pages (skip=200 comes back empty), so 6 is headroom, not a limit that
// bites. The pages are cached and genre-independent, so the second genre you
// try costs nothing.
const NEW_PAGES_PER_YEAR = 6;
const NEW_BATCH = 4;                        // source pages fetched concurrently
const GENRE_TTL = 24 * 3600 * 1000;
let genreCache = { at: 0, movie: [], series: [] };

const cinemetaType = (type) => (type === "show" || type === "series" ? "series" : "movie");

// One Cinemeta meta -> the shape every Aurora card expects. Shared with the
// trending path so a card looks identical wherever it came from.
const fromMeta = (m, type) => {
  const imdbId = /^tt\d+/.test(m.id) ? m.id : null;
  return {
    type: type === "series" ? "show" : "movie",
    title: m.name,
    year: m.releaseInfo ? parseInt(String(m.releaseInfo).slice(0, 4), 10) : null,
    poster: m.poster || null,
    backdrop: m.background || (imdbId ? `https://images.metahub.space/background/medium/${imdbId}/img` : null),
    synopsis: (m.description || "").slice(0, 400),
    rating: m.imdbRating ? parseFloat(m.imdbRating) : null,
    genres: m.genres || [],
    imdbId,
  };
};

// The genres Cinemeta itself offers, read from its manifest so the UI can never
// show a genre that returns nothing.
const genres = async (type) => {
  const ct = cinemetaType(type);
  if (Date.now() - genreCache.at < GENRE_TTL && genreCache[ct].length) return genreCache[ct];
  try {
    const manifest = await fetchJson("https://v3-cinemeta.strem.io/manifest.json");
    for (const t of ["movie", "series"]) {
      const cat = (manifest.catalogs || []).find((c) => c.type === t && c.id === "top");
      const extra = ((cat && cat.extra) || []).find((e) => e.name === "genre");
      genreCache[t] = (extra && extra.options) || [];
    }
    genreCache.at = Date.now();
  } catch {}
  return genreCache[ct];
};

// One raw Cinemeta page, cached. `extra` is whatever goes in the single extra
// slot — a genre for top/imdbRating, a YEAR for the year catalog.
//
// The cache key is the REQUEST, never the category that asked for it. Keying it
// by category-resolved state is what made "New + Western" hand back 1967
// westerns: "new" used to rewrite itself to the `top` catalog, so it collided
// with plain Trending + Western on the same key while caching a differently
// filtered list. Whichever page you opened first poisoned the other.
const cacheKey = (ct, catalogId, extra, skip) => `${ct}|${catalogId}|${extra || ""}|${skip}`;

const sourcePage = async (ct, catalogId, extra, skip) => {
  const key = cacheKey(ct, catalogId, extra, skip);
  const hit = catalogCache.get(key);
  if (hit && Date.now() - hit.at < CATALOG_TTL) return hit;

  const parts = [];
  if (extra) parts.push(`genre=${encodeURIComponent(extra)}`);
  if (skip) parts.push(`skip=${skip}`);
  const suffix = parts.length ? `/${parts.join("&")}` : "";

  let metas = [];
  try {
    const data = await fetchJson(`https://v3-cinemeta.strem.io/catalog/${ct}/${catalogId}${suffix}.json`);
    metas = data.metas || [];
  } catch {
    return { at: 0, items: [], rawCount: 0, failed: true };
  }
  const entry = {
    at: Date.now(),
    items: metas.map((m) => fromMeta(m, ct)).filter((m) => m.poster && m.imdbId),
    rawCount: metas.length,
  };
  catalogCache.set(key, entry);
  if (catalogCache.size > 400) catalogCache.delete(catalogCache.keys().next().value);
  return entry;
};

// Cinemeta signals the end of a catalog with a short page.
const isFullPage = (rawCount) => rawCount >= PAGE_SIZE * 0.6;

// Does this title belong under "New"? The year catalogs leak — 2026's first
// page carries a 1998 title — so the release year on the meta is the thing to
// trust, not the shelf it arrived on.
const isNewRelease = (m, floor, genre) =>
  !!m.year && m.year >= floor && (!genre || (m.genres || []).includes(genre));

// Genuinely-new titles, optionally within a genre.
//
// The year catalog is the only recency-ordered one, but its extra slot holds the
// year, so it can't filter by genre as well. Every meta carries its own `genres`
// though, so the filtering happens here instead of being pushed onto the wrong
// catalog.
//
// This builds the WHOLE pool every time rather than stopping once the requested
// page is covered. That matters: an early exit made the pool a different length
// per request, so the slice boundaries moved between pages and 57 of 400 titles
// came back on two pages at once. The pool is a couple of hundred items and the
// source pages are cached for six hours (and shared across genres and pages), so
// only the first request of the day actually goes to the network.
const newPool = async (ct, genre) => {
  const thisYear = new Date().getFullYear();
  const floor = thisYear - (NEW_SPAN - 1);
  const seen = new Set();
  const pool = [];

  // Newest year first, then in catalog order — no re-sorting needed, and the
  // order is identical on every call, which is what makes paging stable.
  for (let i = 0; i < NEW_SPAN; i++) {
    const year = String(thisYear - i);
    for (let p = 0; p < NEW_PAGES_PER_YEAR; p += NEW_BATCH) {
      const skips = [];
      for (let k = p; k < Math.min(p + NEW_BATCH, NEW_PAGES_PER_YEAR); k++) skips.push(k * PAGE_SIZE);
      const pages = await Promise.all(skips.map((s) => sourcePage(ct, "year", year, s)));
      for (const entry of pages) {
        for (const m of entry.items) {
          if (!isNewRelease(m, floor, genre) || seen.has(m.imdbId)) continue;
          seen.add(m.imdbId);
          pool.push(m);
        }
      }
      // A short page is Cinemeta saying that year is spent; asking for deeper
      // skips just buys empty replies.
      if (pages.some((e) => !isFullPage(e.rawCount))) break;
    }
  }
  return pool;
};

const newCatalog = async (ct, genre, page) => {
  const pool = await newPool(ct, genre);
  const want = (page + 1) * PAGE_SIZE;
  // Exact, because the pool is the same on every request. The original derived
  // hasMore from the PRE-filter count, so Load more kept promising pages that
  // came back empty.
  return { items: pool.slice(page * PAGE_SIZE, want), page, hasMore: pool.length > want };
};

// One page of one category. `page` is 0-based.
const catalog = async ({ type, category = "trending", genre = null, page = 0 }) => {
  const ct = cinemetaType(type);
  page = Math.max(0, page);

  if (category === "new") {
    const out = await newCatalog(ct, genre, page);
    return { ...out, items: markLibrary(out.items.map((i) => ({ ...i }))) };
  }

  const spec = CATALOGS[category] || CATALOGS.trending;
  const entry = await sourcePage(ct, spec.id, genre, page * PAGE_SIZE);
  return {
    items: markLibrary(entry.items.map((i) => ({ ...i }))),
    page,
    hasMore: isFullPage(entry.rawCount),
  };
};

// ---------- search ----------

const searchShows = async (q) => {
  const results = await fetchJson(
    `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(q)}`
  );
  const seen = new Set();
  return results
    .slice(0, 12)
    .map((r) => showItem(r.show))
    .filter((s) => {
      if (!s.poster) return false;
      const k = normalize(s.title);
      if (seen.has(k)) return false; // TVMaze lists US/UK versions separately
      seen.add(k);
      return true;
    })
    .slice(0, 10);
};

const searchMoviesWiki = async (q) => {
  const search = await fetchJson(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=10` +
      `&srsearch=${encodeURIComponent(q + " film")}`
  );
  const hits = (search.query?.search || []).slice(0, 8);
  const out = [];
  const batch = 4;
  for (let i = 0; i < hits.length; i += batch) {
    const chunk = await Promise.all(
      hits.slice(i, i + batch).map(async (h) => {
        try {
          const page = await fetchJson(
            `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(h.title.replace(/ /g, "_"))}`
          );
          const lead = (page.extract || "").slice(0, 260);
          if (!/\bfilm\b|\bmovie\b/i.test(lead)) return null;
          const yearMatch = lead.match(/\b(19|20)\d{2}\b/);
          return {
            type: "movie",
            title: page.title.replace(/\s*\([^)]*film\)$/i, ""),
            year: yearMatch ? parseInt(yearMatch[0], 10) : null,
            poster: page.thumbnail?.source || null,
            synopsis: (page.extract || "").slice(0, 400),
            rating: null,
            genres: [],
          };
        } catch {
          return null;
        }
      })
    );
    out.push(...chunk.filter(Boolean));
  }
  // dedupe by title
  const seen = new Set();
  return out.filter((m) => {
    const k = normalize(m.title);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

// Cinemeta (keyless, what Stremio uses) - far better title matching than
// Wikipedia, with posters and IMDb ids baked in.
const searchCinemeta = async (q, type) => {
  const data = await fetchJson(
    `https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(q)}.json`
  );
  return (data.metas || []).slice(0, 14).map((m) => ({
    type: type === "series" ? "show" : "movie",
    title: m.name,
    year: m.releaseInfo ? parseInt(String(m.releaseInfo).slice(0, 4), 10) : null,
    poster: m.poster || null,
    synopsis: (m.description || "").slice(0, 400),
    rating: m.imdbRating ? parseFloat(m.imdbRating) : null,
    genres: m.genres || [],
    imdbId: /^tt\d+/.test(m.id) ? m.id : null,
  })).filter((m) => m.poster);
};

const searchMoviesTmdb = async (q) => {
  const data = await fetchJson(
    `https://api.themoviedb.org/3/search/movie?api_key=${config.TMDB_KEY}&query=${encodeURIComponent(q)}`
  );
  return (data.results || []).slice(0, 12).map((r) => ({
    type: "movie",
    title: r.title,
    year: r.release_date ? parseInt(r.release_date.slice(0, 4), 10) : null,
    poster: r.poster_path ? `https://image.tmdb.org/t/p/w342${r.poster_path}` : null,
    synopsis: (r.overview || "").slice(0, 400),
    rating: r.vote_average ? Math.round(r.vote_average * 10) / 10 : null,
    genres: [],
  }));
};

const search = async (q) => {
  const key = normalize(q);
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < SEARCH_TTL) {
    return {
      movies: markLibrary(hit.result.movies),
      shows: markLibrary(hit.result.shows),
    };
  }

  // Cinemeta is the primary source for both (accurate + posters + IMDb ids);
  // fall back to TVMaze / TMDB / Wikipedia only if it returns nothing.
  let [shows, movies] = await Promise.all([
    searchCinemeta(q, "series").catch(() => []),
    searchCinemeta(q, "movie").catch(() => []),
  ]);
  if (shows.length === 0) shows = await searchShows(q).catch(() => []);
  if (movies.length === 0) {
    movies = await (config.TMDB_KEY ? searchMoviesTmdb(q) : searchMoviesWiki(q)).catch(() => []);
  }

  const result = { movies, shows };
  searchCache.set(key, { at: Date.now(), result });
  if (searchCache.size > 60) {
    searchCache.delete(searchCache.keys().next().value);
  }
  return { movies: markLibrary(movies), shows: markLibrary(shows) };
};

// Full metadata for a title (backdrop, cast, runtime, and episode list for
// series) from Cinemeta. Cached per id.
const metaCache = new Map();
const META_TTL = 12 * 3600 * 1000;

const meta = async (type, id) => {
  const cinemetaType = type === "series" || type === "show" ? "series" : "movie";
  const key = `${cinemetaType}|${id}`;
  const hit = metaCache.get(key);
  if (hit && Date.now() - hit.at < META_TTL) return hit.data;

  const raw = await fetchJson(`https://v3-cinemeta.strem.io/meta/${cinemetaType}/${id}.json`);
  const m = raw.meta || {};

  let seasons = null;
  if (cinemetaType === "series") {
    const bySeason = {};
    for (const v of m.videos || []) {
      if (!v.season || v.season < 1) continue; // skip specials (season 0)
      (bySeason[v.season] = bySeason[v.season] || []).push({
        season: v.season,
        episode: v.episode || v.number,
        title: v.name || `Episode ${v.episode}`,
        overview: v.overview || "",
        thumbnail: v.thumbnail || null,
        released: v.released || v.firstAired || null,
      });
    }
    seasons = Object.keys(bySeason)
      .map(Number)
      .sort((a, b) => a - b)
      .map((n) => ({
        number: n,
        episodes: bySeason[n].sort((a, b) => (a.episode || 0) - (b.episode || 0)),
      }));
  }

  const data = {
    id,
    type: cinemetaType === "series" ? "show" : "movie",
    imdbId: id,
    title: m.name || "",
    year: m.releaseInfo ? parseInt(String(m.releaseInfo).slice(0, 4), 10) : null,
    poster: m.poster || null,
    backdrop: m.background || null,
    logo: m.logo || null,
    synopsis: m.description || "",
    genres: m.genres || [],
    rating: m.imdbRating ? parseFloat(m.imdbRating) : null,
    runtime: m.runtime || null,
    cast: (m.cast || []).slice(0, 6),
    director: Array.isArray(m.director) ? m.director.slice(0, 2).join(", ") : m.director || null,
    seasons,
    episodeCount: seasons ? seasons.reduce((n, s) => n + s.episodes.length, 0) : null,
    // Cinemeta hands back the TMDB id — expose it so per-title features
    // (similar titles) skip their own /find lookup.
    tmdbId: m.moviedb_id || null,
    // Cinemeta has no age rating, but it does hand back the TMDB id, so this
    // costs one request off an id we already hold. Null without a TMDB key.
    certificate: await certification.fetchCertificate(
      cinemetaType === "series" ? "show" : "movie",
      m.moviedb_id,
    ),
  };

  metaCache.set(key, { at: Date.now(), data });
  return data;
};

// Whatever meta() already has in memory for this id, or null. Home needs episode
// counts to answer "has this profile finished the show?", and it must answer that
// without a single blocking fetch — so it asks this and treats a miss as "don't
// know", which fails open and leaves the title in.
const metaCached = (type, id) => {
  const ct = type === "series" || type === "show" ? "series" : "movie";
  const hit = metaCache.get(`${ct}|${id}`);
  return hit && Date.now() - hit.at < META_TTL ? hit.data : null;
};

// Synchronous access to whatever trending data is already cached (in memory or
// on disk from a previous fetch), so Home can blend in streamable titles with
// zero network wait. Returns null if nothing is cached yet.
const trendingCached = () => {
  const movies = cache.data.movies || [];
  const shows = cache.data.shows || [];
  if (!movies.length && !shows.length) return null;
  return { movies: markLibrary([...movies]), shows: markLibrary([...shows]) };
};

module.exports = {
  trending, trendingCached, search, meta, metaCached, catalog, genres, CATALOGS, normalize,
  _internals: { cacheKey, isNewRelease, isFullPage, PAGE_SIZE, NEW_SPAN },
};
