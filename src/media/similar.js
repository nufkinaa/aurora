// "More like this": per-title similar/recommended rows for the detail page.
// Primary source: TMDB recommendations (collaborative "people also liked",
// far better than its keyword-overlap /similar, which only tops up short
// rows). Needs a TMDB key; without one — or when TMDB has nothing — falls
// back to genre overlap over the cached Discover trending pool, which is
// keyless and costs no network. Rows cache for a week: recommendations for a
// given film barely move, and each TMDB row costs a dozen external_ids
// lookups to attach the IMDb ids the client navigates by.
const path = require("path");
const config = require("../config");
const discover = require("./discover");
const { JsonStore } = require("../lib/jsonstore");

const store = new JsonStore(path.join(config.CACHE_DIR, "similar.json"), {
  v: 1,
  ids: {}, // imdbId -> {tmdbId, at} — permanent, an id can't change
  rows: {}, // "movie|tt123" -> {items, source, at}
});
const ROW_TTL = 7 * 24 * 3600 * 1000;
const MISS_TTL = 24 * 3600 * 1000; // an empty answer is retried the next day

const TMDB = "https://api.themoviedb.org/3";
const tmdb = async (pathname, params = "") => {
  const res = await fetch(
    `${TMDB}/${pathname}?api_key=${config.TMDB_KEY}${params}`,
    { signal: AbortSignal.timeout(8000) },
  );
  if (!res.ok) throw new Error(`tmdb ${res.status}`);
  return res.json();
};

// imdbId -> TMDB id via /find, movie AND tv aware (availability.js's own
// resolver is movie-only). Cached forever.
const tmdbIdFor = async (imdbId, type) => {
  const hit = store.data.ids[imdbId];
  if (hit) return hit.tmdbId;
  const data = await tmdb(`find/${imdbId}`, "&external_source=imdb_id");
  const found =
    type === "series"
      ? (data.tv_results || [])[0]
      : (data.movie_results || [])[0];
  const tmdbId = found ? found.id : null;
  if (tmdbId) {
    store.data.ids[imdbId] = { tmdbId, at: Date.now() };
    store.save();
  }
  return tmdbId;
};

// TMDB result -> the discover-item shape every catalog response uses
// (poster/imdbId filtering happens after external_ids are attached).
const mapItems = (results, type) =>
  (results || [])
    .filter((m) => m.poster_path)
    .slice(0, 18)
    .map((m) => ({
      type: type === "series" ? "show" : "movie",
      title: m.title || m.name || "",
      year:
        parseInt((m.release_date || m.first_air_date || "").slice(0, 4), 10) ||
        null,
      poster: `https://image.tmdb.org/t/p/w342${m.poster_path}`,
      backdrop: m.backdrop_path
        ? `https://image.tmdb.org/t/p/w780${m.backdrop_path}`
        : null,
      synopsis: m.overview || "",
      rating: m.vote_average ? Math.round(m.vote_average * 10) / 10 : null,
      genres: [],
      tmdbId: m.id,
    }));

// TMDB recommendations carry no IMDb id, and the client card navigates by
// IMDb id — one batched external_ids pass attaches them (concurrency 6,
// misses dropped). Paid once per title per week thanks to the row cache.
const addImdbIds = async (items, type) => {
  const kind = type === "series" ? "tv" : "movie";
  const out = [];
  const queue = [...items];
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (queue.length) {
        const it = queue.shift();
        try {
          const ext = await tmdb(`${kind}/${it.tmdbId}/external_ids`);
          if (ext.imdb_id) out.push({ ...it, imdbId: ext.imdb_id });
        } catch {}
      }
    }),
  );
  const order = new Map(items.map((it, i) => [it.tmdbId, i]));
  return out.sort((a, b) => order.get(a.tmdbId) - order.get(b.tmdbId));
};

// Keyless fallback: shared genres over the cached trending pool, best-rated
// first. Zero network beyond the meta the detail page fetched anyway.
const genreFallback = async (type, imdbId) => {
  let genres = [];
  try {
    const meta = await discover.meta(
      type === "series" ? "series" : "movie",
      imdbId,
    );
    genres = (meta && meta.genres) || [];
  } catch {}
  const wanted = type === "series" ? "show" : "movie";
  const items = (discover.trendingCached() || [])
    .filter(
      (m) => m.type === wanted && m.imdbId && m.imdbId !== imdbId && m.poster,
    )
    .map((m) => ({
      m,
      shared: (m.genres || []).filter((g) => genres.includes(g)).length,
    }))
    .filter((x) => genres.length === 0 || x.shared > 0)
    .sort(
      (a, b) => b.shared - a.shared || (b.m.rating || 0) - (a.m.rating || 0),
    )
    .slice(0, 16)
    .map((x) => x.m);
  return { items, source: "genre" };
};

const similar = async (type, imdbId, tmdbHint) => {
  const key = `${type}|${imdbId}`;
  const hit = store.data.rows[key];
  if (
    hit &&
    Date.now() - hit.at < ((hit.items || []).length ? ROW_TTL : MISS_TTL)
  ) {
    return { items: hit.items, source: hit.source };
  }

  let result = { items: [], source: "tmdb" };
  if (config.TMDB_KEY) {
    try {
      const kind = type === "series" ? "tv" : "movie";
      const tmdbId = tmdbHint || (await tmdbIdFor(imdbId, type));
      if (tmdbId) {
        let raw = (await tmdb(`${kind}/${tmdbId}/recommendations`)).results || [];
        if (raw.length < 6) {
          const more = (await tmdb(`${kind}/${tmdbId}/similar`)).results || [];
          const have = new Set(raw.map((m) => m.id));
          raw = raw.concat(more.filter((m) => !have.has(m.id)));
        }
        const items = await addImdbIds(mapItems(raw, type), type);
        result.items = items.filter((m) => m.imdbId !== imdbId).slice(0, 14);
      }
    } catch {}
  }
  if (!result.items.length) result = await genreFallback(type, imdbId);

  store.data.rows[key] = {
    items: result.items,
    source: result.source,
    at: Date.now(),
  };
  store.save();
  return result;
};

module.exports = { similar, _internals: { mapItems, genreFallback, tmdbIdFor } };
