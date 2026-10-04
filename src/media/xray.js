// X-Ray: who is in this, who made it, and what people thought of it — for a
// title, and for ONE EPISODE of a series.
//
// The title page's X-Ray view (public/js/xray.js) replaces everything under
// the hero with this. The point of the per-episode half is the anthology:
// Black Mirror or Modern Love has no cast of its own — every episode is a
// different film with different people — so a series-level cast list is
// either empty or wrong for the episode you are about to watch. Here the
// episode is asked for by number and answers with ITS guest cast, director
// and writers, its own rating and air date; and a series whose regular cast
// is (nearly) empty is flagged `anthology`, so the page leads with the
// episode instead of the show.
//
// Sources, all asked by IMDb id, each optional, none needing a key except
// TMDB (used for films when the server has one):
//   Cinemeta   top-billed names, director, writers, awards, country, IMDb rating
//   TVMaze     series: regular cast with characters and photos, network,
//              status, rating; episodes: guest cast, guest crew, rating
//   TMDB       films (with a key): full cast with characters and photos, crew
//   Wikidata   films (without a key): cast with characters and photos
// Whatever answers is merged; a source that is down just leaves its part out.
// Answers are kept on disk — a title for two weeks, an aired episode for a
// month (people don't change), an empty answer for a day.
const path = require("path");
const config = require("../config");
const { JsonStore } = require("../lib/jsonstore");

const UA = { "User-Agent": "Aurora/1.6 (personal media server; X-Ray)" };
const TITLE_TTL = 14 * 24 * 3600 * 1000;
const EPISODE_TTL = 30 * 24 * 3600 * 1000;
const EMPTY_TTL = 24 * 3600 * 1000;
const V = 1;
const MAX_ENTRIES = 600; // a long series is ~100 kB on its own: this keeps the file to a few MB

const store = new JsonStore(path.join(config.CACHE_DIR, "xray.json"), {});

const getJson = async (url, headers = {}) => {
  const res = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(7000) });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
};
const quiet = (p) => p.catch(() => null);
const stripHtml = (s) => String(s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const list = (v) => (Array.isArray(v) ? v : v ? String(v).split(/,\s*/) : []).map((s) => String(s).trim()).filter(Boolean);

// ---------- people ----------
// { name, role, photo } — one entry per person (a second character is folded
// into the first: "Jesse Plemons — Robert Daly / Captain Daly").
const mergePeople = (people, max = 40) => {
  const byName = new Map();
  for (const p of people) {
    if (!p || !p.name || /^Q\d+$/.test(p.name)) continue; // a Wikidata id with no English label
    const k = norm(p.name);
    const hit = byName.get(k);
    if (!hit) byName.set(k, { name: p.name, role: p.role || null, photo: p.photo || null });
    else {
      if (!hit.photo && p.photo) hit.photo = p.photo;
      if (p.role && hit.role && !norm(hit.role).includes(norm(p.role))) hit.role = `${hit.role} / ${p.role}`;
      else if (p.role && !hit.role) hit.role = p.role;
    }
  }
  return [...byName.values()].slice(0, max);
};

// Put the top-billed names (Cinemeta's order is the billing order) first;
// everyone else keeps the order their source gave.
const billedFirst = (people, billed) => {
  const rank = new Map(billed.map((n, i) => [norm(n), i]));
  return people
    .map((p, i) => ({ p, i, r: rank.has(norm(p.name)) ? rank.get(norm(p.name)) : 1000 + i }))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.p);
};

// ---------- sources ----------
const cinemeta = async (type, imdbId) => {
  const raw = await getJson(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`);
  const m = raw.meta || {};
  return {
    title: m.name || "",
    billed: list(m.cast),
    directors: list(m.director),
    writers: list(m.writer),
    awards: m.awards && !/^n\/?a$/i.test(m.awards) ? m.awards : null,
    country: m.country || null,
    runtime: m.runtime || null,
    released: m.released || null,
    imdbRating: m.imdbRating ? parseFloat(m.imdbRating) : null,
    status: m.status || null,
    tmdbId: m.moviedb_id || null,
    videos: (m.videos || []).filter((v) => v.season >= 1).map((v) => ({
      season: v.season, episode: v.episode || v.number, title: v.name || null,
      // (the fallback overview only — TVMaze's own is used when it answers — so a short one is enough to keep)
      overview: String(v.overview || v.description || "").slice(0, 320), still: v.thumbnail || null, aired: v.released || v.firstAired || null,
    })),
  };
};

const tvmazeShow = async (imdbId) => {
  const s = await getJson(`https://api.tvmaze.com/lookup/shows?imdb=${imdbId}`);
  if (!s || !s.id) return null;
  const cast = (await quiet(getJson(`https://api.tvmaze.com/shows/${s.id}/cast`))) || [];
  return {
    id: s.id,
    rating: s.rating && s.rating.average ? s.rating.average : null,
    network: (s.network && s.network.name) || (s.webChannel && s.webChannel.name) || null,
    status: s.status || null,
    premiered: s.premiered || null,
    ended: s.ended || null,
    cast: cast.map((c) => ({
      name: c.person && c.person.name,
      role: c.character && c.character.name,
      photo: (c.person && c.person.image && c.person.image.medium) || (c.character && c.character.image && c.character.image.medium) || null,
    })),
  };
};

const tvmazeEpisode = async (showId, season, episode) => {
  const e = await getJson(`https://api.tvmaze.com/shows/${showId}/episodebynumber?season=${season}&number=${episode}`);
  if (!e || !e.id) return null;
  const full = (await quiet(getJson(`https://api.tvmaze.com/episodes/${e.id}?embed[]=guestcast&embed[]=guestcrew`))) || e;
  const emb = full._embedded || {};
  return {
    title: e.name || null,
    overview: stripHtml(e.summary),
    still: (e.image && (e.image.original || e.image.medium)) || null,
    aired: e.airdate || null,
    runtime: e.runtime || null,
    rating: e.rating && e.rating.average ? e.rating.average : null,
    guests: (emb.guestcast || []).map((c) => ({
      name: c.person && c.person.name,
      role: c.character && c.character.name,
      photo: (c.person && c.person.image && c.person.image.medium) || null,
    })),
    crew: (emb.guestcrew || []).map((c) => ({ name: c.person && c.person.name, job: c.guestCrewType || null })).filter((c) => c.name),
  };
};

const tmdbMovie = async (tmdbId, imdbId) => {
  const key = config.TMDB_KEY;
  if (!key) return null;
  let id = tmdbId;
  if (!id) {
    const f = await getJson(`https://api.themoviedb.org/3/find/${imdbId}?external_source=imdb_id&api_key=${key}`);
    id = f && f.movie_results && f.movie_results[0] && f.movie_results[0].id;
  }
  if (!id) return null;
  const m = await getJson(`https://api.themoviedb.org/3/movie/${id}?append_to_response=credits&api_key=${key}`);
  const credits = m.credits || {};
  return {
    rating: m.vote_average ? Math.round(m.vote_average * 10) / 10 : null,
    votes: m.vote_count || null,
    studio: (m.production_companies || []).slice(0, 2).map((c) => c.name).join(", ") || null,
    budget: m.budget || null,
    revenue: m.revenue || null,
    cast: (credits.cast || []).slice(0, 40).map((c) => ({
      name: c.name, role: c.character || null, photo: c.profile_path ? `https://image.tmdb.org/t/p/w185${c.profile_path}` : null,
    })),
    crew: (credits.crew || [])
      .filter((c) => ["Director", "Screenplay", "Writer", "Story", "Original Music Composer", "Director of Photography", "Editor"].includes(c.job))
      .map((c) => ({ name: c.name, job: c.job })),
  };
};

// Films with no TMDB key: Wikidata knows the cast, the characters and has a
// portrait for most of them. Its order is arbitrary — billedFirst() fixes
// the top of the list from Cinemeta.
const wikidataCast = async (imdbId) => {
  const q = `SELECT ?actorLabel ?img ?charLabel WHERE { ?film wdt:P345 "${imdbId}". ?film p:P161 ?st. ?st ps:P161 ?actor. OPTIONAL{?st pq:P453 ?char} OPTIONAL{?actor wdt:P18 ?img} SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul,en-gb,en-us". } } LIMIT 80`;
  const r = await getJson(`https://query.wikidata.org/sparql?query=${encodeURIComponent(q)}`, { Accept: "application/sparql-results+json" });
  return ((r.results && r.results.bindings) || []).map((b) => {
    const img = b.img && b.img.value;
    const file = img && decodeURIComponent(img.split("Special:FilePath/")[1] || "");
    const role = b.charLabel && b.charLabel.value;
    return {
      name: b.actorLabel && b.actorLabel.value,
      role: role && !/^Q\d+$/.test(role) ? role : null,
      // a 240px thumbnail through Commons' own redirect (the image proxy
      // follows it; both hosts are on its allow-list)
      photo: file ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=240` : null,
    };
  });
};

// ---------- the household's own verdict ----------
const household = (keys) => {
  try {
    const profiles = require("../profiles");
    const stars = [];
    for (const p of profiles.list()) {
      const r = profiles.getRatings(p.id) || {};
      const v = keys.map((k) => r[k]).find((x) => x > 0);
      if (v) stars.push(v);
    }
    if (!stars.length) return null;
    return { stars: Math.round((stars.reduce((a, b) => a + b, 0) / stars.length) * 10) / 10, count: stars.length };
  } catch {
    return null;
  }
};

// ---------- assembly ----------
// An anthology is a series with (almost) no regular cast: every episode
// brings its own. Pure, so it can be tested.
const isAnthology = (regulars) => (regulars || []).length < 3;

const crewLine = (crew, jobs) => [...new Set(crew.filter((c) => jobs.some((j) => new RegExp(j, "i").test(c.job || ""))).map((c) => c.name))];

const buildTitle = async (type, imdbId) => {
  const isShow = type === "series";
  const cm = (await quiet(cinemeta(type, imdbId))) || { billed: [], directors: [], writers: [], videos: [] };
  const [tv, tm, wd] = await Promise.all([
    isShow ? quiet(tvmazeShow(imdbId)) : null,
    !isShow ? quiet(tmdbMovie(cm.tmdbId, imdbId)) : null,
    !isShow && !config.TMDB_KEY ? quiet(wikidataCast(imdbId)) : null,
  ]);
  const sourced = isShow ? (tv && tv.cast) || [] : (tm && tm.cast) || wd || [];
  // Only a series TVMaze actually answered for can be called an anthology —
  // a failed lookup is not an empty cast.
  const anthology = isShow && !!tv && isAnthology(tv.cast);
  // An anthology has no cast of its own: the names Cinemeta bills are just
  // some episode's actors, and belong to that episode's list, not the show's.
  const cast = anthology ? [] : mergePeople(billedFirst([...sourced, ...cm.billed.map((name) => ({ name }))], cm.billed));
  const crew = [];
  const add = (job, names) => { for (const name of names) if (!crew.some((c) => c.name === name && c.job === job)) crew.push({ name, job }); };
  add(isShow ? "Created / directed by" : "Director", cm.directors);
  add("Writer", cm.writers);
  if (tm) for (const c of tm.crew) if (!["Director", "Writer", "Screenplay", "Story"].includes(c.job) || !crew.some((x) => x.name === c.name)) add(c.job, [c.name]);

  const ratings = [];
  if (cm.imdbRating) ratings.push({ source: "IMDb", value: cm.imdbRating, scale: 10 });
  if (tv && tv.rating) ratings.push({ source: "TVMaze", value: tv.rating, scale: 10 });
  if (tm && tm.rating) ratings.push({ source: "TMDB", value: tm.rating, scale: 10, votes: tm.votes });

  const facts = [];
  const fact = (label, value) => { if (value) facts.push({ label, value: String(value) }); };
  fact("Awards", cm.awards);
  fact(isShow ? "On" : "Studio", isShow ? tv && tv.network : tm && tm.studio);
  fact("Released", (cm.released || (tv && tv.premiered) || "").slice(0, 10));
  fact("Status", isShow ? (tv && tv.status) || cm.status : null);
  fact("Runtime", cm.runtime);
  fact("Country", cm.country);
  if (tm && tm.budget > 0) fact("Budget", `$${Math.round(tm.budget / 1e6)} million`);
  if (tm && tm.revenue > 0) fact("Box office", `$${Math.round(tm.revenue / 1e6)} million`);

  return {
    title: cm.title,
    cast,
    crew,
    ratings,
    facts,
    anthology,
    billed: cm.billed,
    tvmazeId: tv ? tv.id : null,
    episodes: cm.videos.map((v) => ({ season: v.season, episode: v.episode, title: v.title })),
    _videos: cm.videos,
    sources: [cm.title ? "cinemeta" : null, tv ? "tvmaze" : null, tm ? "tmdb" : null, wd && wd.length ? "wikidata" : null].filter(Boolean),
  };
};

const buildEpisode = async (title, season, episode) => {
  const base = (title._videos || []).find((v) => v.season === season && v.episode === episode) || {};
  const tv = title.tvmazeId ? await quiet(tvmazeEpisode(title.tvmazeId, season, episode)) : null;
  // the series' top-billed names lead when they are in this episode
  const guests = mergePeople(billedFirst((tv && tv.guests) || [], title.billed || []));
  const crew = (tv && tv.crew) || [];
  return {
    season,
    episode,
    title: (tv && tv.title) || base.title || `Episode ${episode}`,
    overview: (tv && tv.overview) || base.overview || "",
    still: base.still || (tv && tv.still) || null,
    aired: (tv && tv.aired) || (base.aired || "").slice(0, 10) || null,
    runtime: tv && tv.runtime ? `${tv.runtime} min` : null,
    rating: tv && tv.rating ? { source: "TVMaze", value: tv.rating, scale: 10 } : null,
    guests,
    directors: crewLine(crew, ["^director$"]),
    writers: crewLine(crew, ["writer", "teleplay", "story"]),
  };
};

const fresh = (hit, ttl) => hit && hit.v === V && Date.now() - hit.at < ttl;
const remember = (key, data, empty) => {
  const keys = Object.keys(store.data);
  if (keys.length > MAX_ENTRIES) {
    // the oldest fifth goes: the file stays bounded on a small disk
    keys.sort((a, b) => (store.data[a].at || 0) - (store.data[b].at || 0)).slice(0, Math.ceil(MAX_ENTRIES / 5)).forEach((k) => delete store.data[k]);
  }
  store.data[key] = { at: Date.now(), v: V, empty: !!empty, data };
  store.save();
};

const inflight = new Map();
const once = (key, fn) => {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
};

// The whole answer for the page. `season`/`episode` optional (series only).
const get = async ({ type, imdbId, season = null, episode = null, rateKeys = [] }) => {
  type = type === "series" || type === "show" ? "series" : "movie";
  if (!/^tt\d{5,10}$/.test(String(imdbId || ""))) return { error: "no IMDb id for this title" };
  const tKey = `t|${type}|${imdbId}`;
  let hit = store.data[tKey];
  if (!fresh(hit, hit && hit.empty ? EMPTY_TTL : TITLE_TTL)) {
    const data = await once(tKey, () => buildTitle(type, imdbId));
    const empty = !data.cast.length && !data.ratings.length;
    remember(tKey, data, empty);
    hit = store.data[tKey];
  }
  const title = hit.data;
  let ep = null;
  season = parseInt(season, 10);
  episode = parseInt(episode, 10);
  if (type === "series" && season >= 1 && episode >= 1) {
    const eKey = `e|${imdbId}|${season}|${episode}`;
    let eHit = store.data[eKey];
    if (!fresh(eHit, eHit && eHit.empty ? EMPTY_TTL : EPISODE_TTL)) {
      const data = await once(eKey, () => buildEpisode(title, season, episode));
      remember(eKey, data, !data.guests.length && !data.overview);
      eHit = store.data[eKey];
    }
    ep = eHit.data;
    // Someone stepping through a season asks for the next one next: have it
    // ready (one quiet lookup, kept for a month), so the step is instant.
    const next = (title._videos || []).find((v) => (v.season === season && v.episode === episode + 1) || (v.season === season + 1 && v.episode === 1));
    if (next) {
      const nKey = `e|${imdbId}|${next.season}|${next.episode}`;
      if (!store.data[nKey] && !inflight.has(nKey)) {
        once(nKey, () => buildEpisode(title, next.season, next.episode))
          .then((data) => remember(nKey, data, !data.guests.length && !data.overview))
          .catch(() => {});
      }
    }
  }
  const home = household([imdbId, ...rateKeys]);
  const { _videos, tvmazeId, billed, ...pub } = title;
  return { ...pub, imdbId, type, episode: ep, household: home };
};

module.exports = { get, _internals: { mergePeople, billedFirst, isAnthology, crewLine } };
