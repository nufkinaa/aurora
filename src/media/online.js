// Online metadata: genres, synopsis, ratings, and poster/backdrop art.
// Shows come from TVMaze, movies from the iTunes Search API - both free and
// keyless. Results (and poster images) are cached on disk so everything
// keeps working offline afterwards.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const config = require("../config");
const { JsonStore } = require("../lib/jsonstore");

const events = new EventEmitter();
const store = new JsonStore(path.join(config.DATA_DIR, "online-metadata.json"), {});
const POSTER_DIR = path.join(config.CACHE_DIR, "posters");

const RETRY_FAILED_MS = 7 * 24 * 3600 * 1000;

const keyFor = (type, title) => `${type}|${title.toLowerCase().trim()}`;

const stripHtml = (s) => (s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

const normalize = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

const similarity = (a, b) => {
  a = normalize(a);
  b = normalize(b);
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.8;
  const aw = new Set(a.split(" "));
  const bw = b.split(" ");
  const hits = bw.filter((w) => aw.has(w)).length;
  return hits / Math.max(aw.size, bw.length);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fetchJson = async (url, attempt = 0) => {
  const res = await fetch(url, {
    headers: { "User-Agent": "Aurora/1.0 (personal media server)" },
    signal: AbortSignal.timeout(12000),
  });
  if (res.status === 429 || res.status === 403) {
    if (attempt < 2) {
      await sleep(4000 * (attempt + 1)); // back off and retry
      return fetchJson(url, attempt + 1);
    }
  }
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
};

// Download an image once; serve it locally afterwards.
const cachePoster = async (url) => {
  if (!url) return null;
  const name = crypto.createHash("md5").update(url).digest("hex") + ".jpg";
  const file = path.join(POSTER_DIR, name);
  if (fs.existsSync(file)) return name;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    fs.mkdirSync(POSTER_DIR, { recursive: true });
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    return name;
  } catch {
    return null;
  }
};

const fetchShowMeta = async (title) => {
  const data = await fetchJson(
    `https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(title)}`
  );
  if (!data || similarity(data.name || "", title) < 0.45) return null;
  return {
    matchedTitle: data.name,
    genres: data.genres || [],
    synopsis: stripHtml(data.summary),
    rating: data.rating?.average || null,
    certificate: null,
    year: data.premiered ? parseInt(data.premiered.slice(0, 4), 10) : null,
    posterUrl: data.image?.original || data.image?.medium || null,
  };
};

// Map descriptive words in a Wikipedia lead sentence to display genres
const WIKI_GENRES = [
  [/science[ -]fiction|sci[ -]fi/i, "Sci-Fi"],
  [/mystery/i, "Mystery"],
  [/thriller/i, "Thriller"],
  [/romantic comedy|rom[ -]com/i, "Romance"],
  [/comedy/i, "Comedy"],
  [/romance|romantic/i, "Romance"],
  [/drama/i, "Drama"],
  [/horror/i, "Horror"],
  [/action/i, "Action"],
  [/adventure/i, "Adventure"],
  [/fantasy/i, "Fantasy"],
  [/crime|heist/i, "Crime"],
  [/western/i, "Western"],
  [/animated|animation/i, "Animation"],
  [/documentary/i, "Documentary"],
  [/biographical|biopic/i, "Biography"],
  [/\bwar\b/i, "War"],
  [/musical/i, "Musical"],
  [/superhero/i, "Superhero"],
  [/disaster/i, "Disaster"],
  [/psychological/i, "Psychological"],
];

// TMDB (used automatically when a free API key is set in config.json)
const fetchMovieMetaTmdb = async (title, year) => {
  const q = `https://api.themoviedb.org/3/search/movie?api_key=${config.TMDB_KEY}` +
    `&query=${encodeURIComponent(title)}${year ? `&year=${year}` : ""}`;
  const data = await fetchJson(q);
  const best = (data.results || [])[0];
  if (!best || similarity(best.title, title) < 0.45) return null;

  const details = await fetchJson(
    `https://api.themoviedb.org/3/movie/${best.id}?api_key=${config.TMDB_KEY}`
  );
  return {
    matchedTitle: best.title,
    genres: (details.genres || []).map((g) => g.name),
    synopsis: details.overview || "",
    rating: details.vote_average ? Math.round(details.vote_average * 10) / 10 : null,
    certificate: null,
    year: details.release_date ? parseInt(details.release_date.slice(0, 4), 10) : null,
    posterUrl: details.poster_path
      ? `https://image.tmdb.org/t/p/w500${details.poster_path}`
      : null,
  };
};

// Wikipedia (keyless fallback): lead paragraph gives synopsis, year, poster,
// and enough of a description to extract genres.
const fetchMovieMeta = async (title, year) => {
  if (config.TMDB_KEY) {
    try {
      const viaTmdb = await fetchMovieMetaTmdb(title, year);
      if (viaTmdb) return viaTmdb;
    } catch {}
  }

  const search = await fetchJson(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=5` +
      `&srsearch=${encodeURIComponent(`${title} ${year || ""} film`.trim())}`
  );
  const hits = search.query?.search || [];
  if (hits.length === 0) return null;

  // Prefer "(film)" pages and close title matches
  const best = hits
    .map((h) => {
      const clean = h.title.replace(/\s*\([^)]*film\)$/i, "");
      let score = similarity(clean, title);
      if (/\([^)]*film\)$/i.test(h.title)) score += 0.25;
      return { h, score };
    })
    .sort((a, b) => b.score - a.score)[0];
  if (!best || best.score < 0.5) return null;

  const page = await fetchJson(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
      best.h.title.replace(/ /g, "_")
    )}`
  );
  const extract = page.extract || "";
  if (!/film|movie/i.test(extract.slice(0, 300))) return null;

  // "...is a 2019 American mystery film directed by..."
  const lead = extract.slice(0, 300);
  const yearMatch = lead.match(/\b(19|20)\d{2}\b/);
  const genres = [];
  const genreZone = (lead.match(/is an? (.*?)(film|movie)/i) || [])[1] || "";
  for (const [re, g] of WIKI_GENRES) {
    if (re.test(genreZone) && !genres.includes(g)) genres.push(g);
  }

  return {
    matchedTitle: page.title,
    genres,
    synopsis: extract,
    rating: null,
    certificate: null,
    year: yearMatch ? parseInt(yearMatch[0], 10) : null,
    posterUrl: page.originalimage?.source || page.thumbnail?.source || null,
  };
};

const get = (type, title) => {
  const entry = store.data[keyFor(type, title)];
  return entry && !entry.failed ? entry : null;
};

let running = false;

// Fetch metadata for every item that doesn't have it yet, one at a time.
const enrich = async (items) => {
  if (running || !config.ONLINE_METADATA) return;
  running = true;
  let fetched = 0;

  for (const item of items) {
    const key = keyFor(item.type, item.title);
    const existing = store.data[key];
    if (existing) {
      if (!existing.failed) continue;
      if (Date.now() - existing.fetchedAt < RETRY_FAILED_MS) continue;
    }

    try {
      const meta =
        item.type === "show"
          ? await fetchShowMeta(item.title)
          : await fetchMovieMeta(item.title, item.year);

      if (meta) {
        meta.poster = await cachePoster(meta.posterUrl);
        delete meta.posterUrl;
        store.data[key] = { ...meta, fetchedAt: Date.now() };
        fetched++;
      } else {
        store.data[key] = { failed: true, fetchedAt: Date.now() };
      }
    } catch (err) {
      console.warn(`Metadata fetch failed for "${item.title}": ${err.message}`);
      store.data[key] = { failed: true, fetchedAt: Date.now() };
    }
    store.save();
    await sleep(900); // be polite to the APIs
  }

  running = false;
  if (fetched > 0) events.emit("updated", fetched);
};

const posterFile = (name) => {
  const file = path.join(POSTER_DIR, path.basename(name));
  return fs.existsSync(file) ? file : null;
};

module.exports = { get, enrich, posterFile, events };
