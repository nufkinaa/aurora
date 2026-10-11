// A made-up catalogue for the mobile-perf fixture: 400 titles with invented
// names, the shape Cinemeta answers in. Deterministic (no Math.random), so
// two runs measure the same page. Shared by the instance's preload (which
// answers the server's catalogue lookups with it) and by the harness (which
// seeds data/cache/discover.json with it).
"use strict";

const A = ["Quiet", "Last", "Glass", "Paper", "Northern", "Hollow", "Silver", "Burning", "Distant", "Broken", "Golden", "Midnight", "Salt", "Winter", "Electric", "Crimson", "Velvet", "Iron", "Hidden", "Wandering"];
const B = ["Harbor", "Orchard", "Signal", "Kingdom", "Station", "Garden", "River", "Lantern", "Meridian", "Frontier", "Archive", "Tide", "Summit", "Parade", "Engine", "Compass", "Shore", "Theatre", "Almanac", "Circuit"];
const GENRES = ["Drama", "Crime", "Action", "Comedy", "Adventure", "Thriller", "Sci-Fi", "Romance", "Mystery", "Animation", "Fantasy", "Family", "Horror", "Documentary"];
const NAMES = ["Mara Ellison", "Jonah Vale", "Priya Anand", "Tomas Reyes", "Lena Fischer", "Odin Marsh", "Sofia Lund", "Caleb Stone", "Noor Haddad", "Ezra Finch", "Ines Duarte", "Felix Brandt"];
const LOREM = "A made-up synopsis for the performance fixture: someone leaves, someone returns, and a small town keeps a secret through one long season while the weather turns. Nothing here describes a real film or series.";

// mulberry32 — a seeded generator, so the catalogue is the same every run
const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const PER_TYPE = 200;
const build = () => {
  const out = { movie: [], series: [] };
  for (const [ti, type] of ["movie", "series"].entries()) {
    const r = rng(77 + ti);
    for (let i = 0; i < PER_TYPE; i++) {
      const n = ti * PER_TYPE + i;
      const id = `tt8${String(100000 + n).padStart(6, "0")}`;
      const g0 = GENRES[Math.floor(r() * GENRES.length)];
      const g1 = GENRES[Math.floor(r() * GENRES.length)];
      const g2 = GENRES[Math.floor(r() * GENRES.length)];
      const year = 2026 - Math.floor(r() * r() * 30);
      const name = `${type === "movie" ? "The " : ""}${A[(i * 7 + ti * 3) % A.length]} ${B[(i * 3 + Math.floor(i / 20)) % B.length]}${i >= 100 ? " " + (type === "movie" ? "II" : "Returns") : ""}`;
      out[type].push({
        id,
        type,
        name,
        releaseInfo: type === "series" ? `${year}-` : String(year),
        poster: `https://images.metahub.space/poster/small/${id}/img`,
        background: `https://images.metahub.space/background/medium/${id}/img`,
        description: `${name}. ${LOREM}`,
        imdbRating: (5.5 + r() * 3.6).toFixed(1),
        genres: [...new Set([g0, g1, g2])],
        runtime: type === "movie" ? `${90 + Math.floor(r() * 60)} min` : `${25 + Math.floor(r() * 35)} min`,
        cast: [0, 1, 2, 3].map((k) => NAMES[(n + k * 5) % NAMES.length]),
        director: [NAMES[(n + 7) % NAMES.length]],
      });
    }
  }
  return out;
};

const CATALOGUE = build();
const byId = new Map([...CATALOGUE.movie, ...CATALOGUE.series].map((m) => [m.id, m]));

// The episodes of a series: 2 seasons x 8, with stills on the catalogue host.
const videos = (m) => {
  const out = [];
  const year = parseInt(m.releaseInfo, 10) || 2020;
  for (let s = 1; s <= 2; s++) {
    for (let e = 1; e <= 8; e++) {
      out.push({
        id: `${m.id}:${s}:${e}`,
        season: s,
        episode: e,
        name: `Chapter ${(s - 1) * 8 + e}`,
        overview: "A made-up episode summary: the plan changes at the last minute and nobody says why.",
        released: new Date(Date.UTC(Math.min(year + s - 1, 2025), 1, e * 3)).toISOString(),
        thumbnail: `https://episodes.metahub.space/${m.id}/${s}/${e}/w780.jpg`, // the real catalogue's own shape and host
      });
    }
  }
  return out;
};
const meta = (type, id) => {
  const m = byId.get(id);
  if (!m || m.type !== type) return null;
  return { ...m, ...(type === "series" ? { videos: videos(m) } : {}) };
};

// One catalogue page, the way Cinemeta pages: 50 a step, a short page ends it.
const page = (type, catalogId, { genre = "", skip = 0, search = "" } = {}) => {
  let list = CATALOGUE[type] || [];
  if (search) {
    const q = search.toLowerCase();
    return list.filter((m) => m.name.toLowerCase().includes(q)).slice(0, 30);
  }
  if (catalogId === "year") list = list.filter((m) => String(parseInt(m.releaseInfo, 10)) === String(genre));
  else if (genre) list = list.filter((m) => m.genres.includes(genre));
  if (catalogId === "imdbRating") list = [...list].sort((a, b) => parseFloat(b.imdbRating) - parseFloat(a.imdbRating));
  return list.slice(skip, skip + 50);
};

// data/cache/discover.json — what media/discover.js keeps of "trending"
const discoverSeed = () => {
  const item = (m, type) => ({
    type: type === "series" ? "show" : "movie",
    title: m.name,
    year: parseInt(m.releaseInfo, 10),
    poster: m.poster,
    backdrop: m.background,
    synopsis: m.description.slice(0, 400),
    rating: parseFloat(m.imdbRating),
    genres: m.genres,
    imdbId: m.id,
  });
  return {
    fetchedAt: Date.now(),
    v: 3,
    movies: CATALOGUE.movie.map((m) => item(m, "movie")),
    shows: CATALOGUE.series.map((m) => item(m, "series")),
  };
};

module.exports = { CATALOGUE, GENRES, meta, page, discoverSeed, byId };
