// A poster for a title that has none, by IMDb id — the backup behind every
// other source.
//
// Why covers go missing (the few grey tiles elia sees):
//   * a library title is matched to its metadata BY NAME (TVMaze for shows,
//     TMDB or Wikipedia for films). A name the provider doesn't recognise, or
//     a match whose record simply has no image, leaves the title without a
//     poster — and nothing ever tried another source, even though identity.js
//     usually knows the title's IMDb id by then;
//   * a catalogue card carries one poster URL (Cinemeta's image host). When
//     that one image is missing or the host hiccups past the client's retry,
//     the card falls back to a titled tile.
//
// This resolves an IMDb id to a poster through a chain, first one that turns
// out to be a real image wins, and the file is cached with the others
// (online.js's poster cache — validated bytes, atomic writes):
//   1. Cinemeta's image host at medium size (a different rendition from the
//      small one cards ask for — often there when the small one isn't)
//   2. the poster URL in Cinemeta's own metadata record
//   3. TVMaze, looked up BY IMDb id (shows)
//   4. TMDB, found by IMDb id (when a key is configured)
//   5. iTunes, searched by title + year (the last resort; needs the title)
// "Nothing anywhere" is remembered for a week so a title that truly has no
// art doesn't cost five lookups on every page.
const path = require("path");
const config = require("../config");
const { JsonStore } = require("../lib/jsonstore");

const store = new JsonStore(path.join(config.CACHE_DIR, "poster-fallback.json"), {});
const MISS_TTL = 7 * 24 * 3600 * 1000;
const inflight = new Map();

const getJson = async (url) => {
  const res = await fetch(url, { headers: { "User-Agent": "Aurora (personal media server)" }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  return res.json();
};

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Candidate image URLs, lazily — each step runs only if the ones before it
// produced nothing usable. Exported for tests (with a stubbed getJson).
const candidates = async function* ({ imdbId, type, title, year }, fetchJson = getJson) {
  const kind = type === "show" || type === "series" ? "series" : "movie";
  yield `https://images.metahub.space/poster/medium/${imdbId}/img`;
  try {
    const j = await fetchJson(`https://v3-cinemeta.strem.io/meta/${kind}/${imdbId}.json`);
    const p = j && j.meta && j.meta.poster;
    if (p && !/metahub\.space\/poster\/medium\//.test(p)) yield p;
  } catch {}
  if (kind === "series") {
    try {
      const j = await fetchJson(`https://api.tvmaze.com/lookup/shows?imdb=${imdbId}`);
      const p = j && j.image && (j.image.original || j.image.medium);
      if (p) yield p;
    } catch {}
  }
  if (config.TMDB_KEY) {
    try {
      const j = await fetchJson(`https://api.themoviedb.org/3/find/${imdbId}?api_key=${config.TMDB_KEY}&external_source=imdb_id`);
      const hit = j && [...(j.movie_results || []), ...(j.tv_results || [])].find((r) => r.poster_path);
      if (hit) yield `https://image.tmdb.org/t/p/w500${hit.poster_path}`;
    } catch {}
  }
  if (title) {
    try {
      const entity = kind === "series" ? "tvSeason" : "movie";
      const j = await fetchJson(`https://itunes.apple.com/search?term=${encodeURIComponent(title)}&media=${kind === "series" ? "tvShow" : "movie"}&entity=${entity}&limit=8`);
      const want = norm(title);
      const hit = ((j && j.results) || []).find((r) => {
        const name = norm(r.trackName || r.collectionName || r.artistName);
        const y = parseInt(String(r.releaseDate || "").slice(0, 4), 10);
        const nameOk = kind === "series" ? norm(r.artistName) === want || name.startsWith(want) : name === want;
        return nameOk && (kind === "series" || !year || !y || Math.abs(y - Number(year)) <= 1);
      });
      if (hit && hit.artworkUrl100) yield hit.artworkUrl100.replace(/\/\d+x\d+bb\./, "/600x900bb.");
    } catch {}
  }
};

// The cached poster's file name (served by /img/meta/<name>), or null.
const resolve = (q) => {
  const imdbId = String((q && q.imdbId) || "");
  if (!/^tt\d{4,12}$/.test(imdbId)) return Promise.resolve(null);
  const hit = store.data[imdbId];
  if (hit && hit.name) {
    // still on disk? (the poster cache can be cleared independently)
    if (require("./online").posterFile(hit.name)) return Promise.resolve(hit.name);
  } else if (hit && Date.now() - (hit.at || 0) < MISS_TTL) {
    return Promise.resolve(null);
  }
  if (inflight.has(imdbId)) return inflight.get(imdbId);
  const p = (async () => {
    const online = require("./online");
    let name = null;
    try {
      for await (const url of candidates({ ...q, imdbId })) {
        name = await online.cachePoster(url);
        if (name) break;
      }
    } catch {}
    store.data[imdbId] = name ? { name, at: Date.now() } : { name: null, at: Date.now() };
    store.save();
    if (name) console.log(`[poster] backup source found a cover for ${imdbId}${q.title ? ` (${q.title})` : ""}`);
    return name;
  })().finally(() => inflight.delete(imdbId));
  inflight.set(imdbId, p);
  return p;
};

// The URL a client (or the scanner) uses for "the backup poster of this
// title". Hints ride as query so the last-resort search has a name to use.
const urlFor = ({ imdbId, type, title, year }) =>
  `/img/poster/${imdbId}?type=${type === "show" || type === "series" ? "show" : "movie"}` +
  (title ? `&t=${encodeURIComponent(String(title).slice(0, 80))}` : "") +
  (year ? `&y=${encodeURIComponent(year)}` : "");

module.exports = { resolve, urlFor, _internals: { candidates } };
