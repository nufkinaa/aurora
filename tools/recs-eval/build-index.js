#!/usr/bin/env node
// Build the title index the evaluation runs on, in THIS checkout's data/cache
// (never the live server's). Seeds: the cached catalogue, the library's title
// list, the personas, the ids (only) of what the household's profiles have
// touched, then one hop along TMDB's recommended/similar links.
//
//   TMDB_API_KEY=… node tools/recs-eval/build-index.js \
//     [--profiles <profiles.json>] [--library <http://host:4000/api/library>] [--hop 10] [--budget 3000]
//
// Prints counts and the TMDB request cost. Idempotent: a second run only
// fetches what is still missing. Nothing personal is printed or written
// outside data/ (which is gitignored).
const fs = require("fs");
const path = require("path");
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const titleindex = require("../../src/media/recs/titleindex");
const tmdb = require("../../src/media/recs/tmdb");
const personas = require("./personas");

const RESOLVED = path.join(__dirname, "personas.resolved.json");

(async () => {
  let budget = parseInt(arg("budget", "3000"), 10);
  const spend = async (wants, opts = {}) => {
    const r = await titleindex.ensure(wants, { budget: Math.max(0, budget), ...opts });
    budget -= r.asked;
    return r;
  };

  // 1. the catalogue the server has cached + the hero pool's catalogue pages
  const discover = require("../../src/media/discover");
  const trending = discover.trendingCached() || { movies: [], shows: [] };
  const cards = [...trending.movies, ...trending.shows];
  if (arg("pool", "1") !== "0") {
    try {
      const pool = await require("../../src/media/hero").warm();
      cards.push(...pool);
    } catch {}
  }
  // 2. the library's titles (a read-only GET against the running server)
  const libUrl = arg("library", null);
  if (libUrl) {
    try {
      const lib = await (await fetch(libUrl)).json();
      const items = [...(lib.movies || []), ...(lib.shows || [])].filter((i) => i.imdbId);
      fs.writeFileSync(path.join(__dirname, "..", "..", "data", "recs-eval-library.json"), JSON.stringify(
        items.map((i) => ({
          id: i.id, imdbId: i.imdbId, type: i.type, title: i.title, year: i.year, genres: i.genres,
          rating: i.rating, synopsis: (i.synopsis || "").slice(0, 400), cover: i.cover,
        })),
      ));
      cards.push(...items);
      console.log(`library titles: ${items.length}`);
    } catch (e) { console.log("library fetch failed:", e.message); }
  }
  titleindex.noteCards(cards);
  const wantOf = (c) => ({
    imdbId: c.imdbId, kind: c.type === "show" ? "tv" : "movie", genres: c.genres,
    poster: c.poster, backdrop: c.backdrop, synopsis: c.synopsis,
  });
  console.log("catalogue cards:", cards.length, await spend(cards.map(wantOf)));

  // 3. personas: title+year -> TMDB id (search, cached in personas.resolved.json)
  const resolved = fs.existsSync(RESOLVED) ? JSON.parse(fs.readFileSync(RESOLVED, "utf8")) : {};
  for (const p of personas) {
    for (const [title, year, kind] of p.titles || []) {
      const key = `${kind}|${title}|${year}`;
      if (resolved[key]) continue;
      const q = `&query=${encodeURIComponent(title)}`;
      let hit = null;
      for (const y of [year, year - 1, year + 1, null]) {
        const yp = y ? (kind === "tv" ? `&first_air_date_year=${y}` : `&year=${y}`) : "";
        const r = await tmdb.get(`search/${kind}`, q + yp).catch(() => ({ results: [] }));
        hit = (r.results || []).sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0))[0];
        if (hit) break;
      }
      if (hit) resolved[key] = { tmdbId: hit.id, name: hit.title || hit.name };
      else console.log("persona title not found:", key);
    }
  }
  const personaWants = Object.entries(resolved).map(([key, v]) => ({ tmdbId: v.tmdbId, kind: key.split("|")[0] }));
  console.log("persona titles:", personaWants.length, await spend(personaWants));
  for (const [key, v] of Object.entries(resolved)) {
    const rec = titleindex.byTmdb(key.split("|")[0], v.tmdbId);
    if (rec) v.imdbId = rec.id;
  }
  fs.writeFileSync(RESOLVED, JSON.stringify(resolved, null, 1));

  // 4. ids of what the household's profiles touched (ids only; nothing printed)
  const profPath = arg("profiles", null);
  const anchors = [...personaWants];
  if (profPath) {
    const P = JSON.parse(fs.readFileSync(profPath, "utf8"));
    const wants = new Map();
    const add = (imdbId, kind, extra = {}) => {
      if (/^tt\d{4,12}$/.test(String(imdbId || "")) && !wants.has(imdbId)) wants.set(imdbId, { imdbId, kind, ...extra });
    };
    for (const state of Object.values(P.state || {})) {
      for (const key of Object.keys(state.titles || {})) add(key.split(":")[0], key.includes(":") ? "tv" : "movie");
      for (const sm of Object.values(state.streamItems || {})) {
        if (sm && sm.imdbId) add(sm.imdbId, sm.type === "show" || sm.season != null ? "tv" : "movie");
      }
      for (const e of state.watchlist || []) {
        if (e && typeof e === "object") add(e.imdbId, e.type === "show" ? "tv" : "movie", { genres: e.genres });
      }
      for (const key of Object.keys(state.ratings || {})) add(key, "movie");
      for (const t of state.likedTitles || []) add(t.imdbId, "movie");
    }
    for (const p of P.profiles || []) for (const f of p.follows || []) add(f.imdbId, "tv");
    const list = [...wants.values()];
    const r = await spend(list);
    // a wrong movie/tv guess: try the other kind once
    const retry = list
      .filter((w) => !titleindex.get(w.imdbId) || titleindex.get(w.imdbId).lite)
      .map((w) => ({ ...w, kind: w.kind === "tv" ? "movie" : "tv" }));
    const r2 = retry.length ? await spend(retry) : null;
    console.log("household-touched titles:", list.length, r, r2 || "");
    anchors.push(...list);
  }

  // 5. one hop: each anchor's top recommended + similar neighbours
  const hop = parseInt(arg("hop", "10"), 10);
  const next = [];
  for (const a of anchors) {
    const rec = a.imdbId ? titleindex.get(a.imdbId) : titleindex.byTmdb(a.kind, a.tmdbId);
    if (!rec || rec.lite) continue;
    for (const id of [...(rec.recs || []).slice(0, hop), ...(rec.sim || []).slice(0, Math.ceil(hop / 2))]) {
      next.push({ tmdbId: id, kind: rec.k });
    }
  }
  console.log("one-hop neighbours:", next.length, await spend(next));

  titleindex.flush();
  const all = titleindex.all();
  console.log(`index: ${all.length} titles, ${all.filter((r) => !r.lite).length} full, ${all.filter((r) => r.lite).length} lite`);
  console.log("TMDB calls this run:", tmdb.stats().calls, "failed:", tmdb.stats().failed);
  process.exit(0);
})();
