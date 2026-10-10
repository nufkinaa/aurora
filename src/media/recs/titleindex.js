// What Aurora KNOWS about a title — the recommender's knowledge base.
//
// Before this file the server knew a title by its genres, year and rating
// (whatever the catalogue card carried); the vibe ranker fetched keywords per
// row and threw them away. Here every title the server meets is kept as one
// record: genres, keywords, the people who made it, its franchise, language,
// countries, runtime, age rating, votes and popularity, plot, and TMDB's own
// "recommended" / "similar" neighbours (ids only — they are the frontier the
// index grows along).
//
//   full record   one TMDB detail call with everything appended (a film by
//                 its IMDb id; a series needs one /find first)
//   lite record   built from a catalogue card with NO network — genres, year,
//                 rating, plot. What the recommender degrades to when TMDB is
//                 unreachable or there is no key; upgraded when a call lands.
//
// The store is cache/recs-titles.json. Records refresh after REFRESH_MS (votes
// and popularity move), a few a day. Nothing here is called on a request path:
// readers (get/all) are sync and memory-only; ensure() is the background door.
const path = require("path");
const config = require("../../config");
const { JsonStore } = require("../../lib/jsonstore");
const tmdb = require("./tmdb");
const certification = require("../certification");
const { canonGenres } = require("./taxonomy");

const V = 1; // record shape version
const REFRESH_MS = 45 * 24 * 3600 * 1000;
const MISS_MS = 7 * 24 * 3600 * 1000;
// Bound on the index: ~1.5 KB a record on disk, ~11 KB in memory once its
// vectors are built (measured: 2,418 titles = 3.6 MB file, +28 MB heap), so
// 5,000 titles is ~7.5 MB on disk and ~58 MB of heap. Beyond it the
// least-voted titles nobody has touched go first (prune()).
const MAX_TITLES = 5000;
// The file is several megabytes: written at most every SAVE_MS while a sync
// is adding records, not once per record (JsonStore's own debounce is 1.5 s,
// which during a sync meant re-serialising the whole index forty times).
const SAVE_MS = 20 * 1000;

const blank = () => ({ v: V, titles: {}, tm: {}, miss: {}, lists: {} });
let store = null;
const open = () => {
  if (!store) {
    store = new JsonStore(path.join(config.CACHE_DIR, "recs-titles.json"), blank());
    if (store.data.v !== V) store.data = blank();
    for (const k of ["titles", "tm", "miss", "lists"]) if (!store.data[k]) store.data[k] = {};
  }
  return store;
};

// Bumped whenever a record is added or replaced — feature caches key on it.
let version = 1;
const stamp = () => version;

let saveTimer = null;
const saveSoon = () => {
  if (saveTimer || !store) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { store.flush(); } catch {}
  }, SAVE_MS);
  saveTimer.unref?.();
};
const flush = () => {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (store && store.flush) store.flush();
};

// Titles that must never be pruned whatever their vote count: what profiles
// have watched, the library, the catalogue being browsed. Set by the engine.
let keepIds = new Set();
const setKeep = (ids) => { keepIds = new Set(ids || []); };

// tests and the evaluation harness: an in-memory store, never the disk
const useMemory = (data = null) => {
  store = { data: data || blank(), save() {}, flush() {} };
  version++;
  return store;
};

const pair = (x) => [x.id, x.name];
const yearOf = (d) => parseInt(String(d || "").slice(0, 4), 10) || null;
const IMG = "https://image.tmdb.org/t/p";

// A TMDB detail payload (with the appends below) -> a full record.
// `extra.genres`: the catalogue's own genre names for this title, which are
// IMDb's and finer than TMDB's for series ("Sci-Fi & Fantasy" is one bucket
// there) — merged in when we have them.
const fromTmdb = (raw, kind, extra = {}) => {
  const imdbId = extra.imdbId || (raw.external_ids && raw.external_ids.imdb_id) || raw.imdb_id || null;
  if (!imdbId || !/^tt\d{4,12}$/.test(imdbId)) return null;
  const crew = (raw.credits && raw.credits.crew) || [];
  const cast = ((raw.credits && raw.credits.cast) || []).slice().sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
  const uniq = (list) => {
    const seen = new Set();
    return list.filter((p) => p && p.id && !seen.has(p.id) && seen.add(p.id));
  };
  const kws = raw.keywords ? raw.keywords.keywords || raw.keywords.results || [] : [];
  const ratingsPayload = kind === "tv"
    ? raw.content_ratings && raw.content_ratings.results
    : raw.release_dates && raw.release_dates.results;
  const certKind = kind === "tv" ? "show" : "movie";
  const ids = (list) => ((list && list.results) || []).filter((r) => r && r.id && r.poster_path).map((r) => r.id).slice(0, 20);
  const rec = {
    id: imdbId,
    tm: raw.id,
    k: kind,
    title: raw.title || raw.name || "",
    year: yearOf(raw.release_date || raw.first_air_date),
    rel: raw.release_date || raw.first_air_date || null,
    st: raw.status || null,
    g: canonGenres([...(extra.genres || []), ...(raw.genres || []).map((g) => g.name)]),
    gid: (raw.genres || []).map((g) => g.id),
    kw: kws.filter((k) => k && k.id && k.name).map((k) => [k.id, String(k.name).trim().toLowerCase()]).slice(0, 40),
    dir: uniq(crew.filter((c) => c.job === "Director")).slice(0, 2).map(pair),
    wr: uniq(crew.filter((c) => /^(Screenplay|Writer|Novel|Story)$/.test(c.job || ""))).slice(0, 3).map(pair),
    cre: uniq(raw.created_by || []).slice(0, 3).map(pair),
    cast: uniq(cast).slice(0, 8).map(pair),
    col: raw.belongs_to_collection && raw.belongs_to_collection.id ? pair(raw.belongs_to_collection) : null,
    net: kind === "tv" && raw.networks && raw.networks[0] ? pair(raw.networks[0]) : null,
    lang: raw.original_language || null,
    cc: (raw.origin_country || (raw.production_countries || []).map((c) => c.iso_3166_1) || []).slice(0, 3),
    rt: kind === "movie" ? raw.runtime || null : (raw.episode_run_time && raw.episode_run_time[0]) || null,
    eps: kind === "tv" ? raw.number_of_episodes || null : null,
    age: ratingsPayload ? certification.strictestAge(ratingsPayload, certKind) : null,
    cert: ratingsPayload ? certification.pickCertificate(ratingsPayload, certKind) : null,
    va: raw.vote_average || 0,
    vc: raw.vote_count || 0,
    pop: raw.popularity || 0,
    poster: raw.poster_path ? `${IMG}/w342${raw.poster_path}` : extra.poster || null,
    backdrop: raw.backdrop_path ? `${IMG}/w780${raw.backdrop_path}` : extra.backdrop || null,
    ov: String(raw.overview || extra.synopsis || "").slice(0, 600),
    recs: ids(raw.recommendations),
    sim: ids(raw.similar),
    at: Date.now(),
  };
  if (raw.adult) rec.adult = true;
  if (rec.age == null) delete rec.age;
  if (!rec.cert) delete rec.cert;
  return rec;
};

// A catalogue / library card -> a lite record. No network.
const fromCard = (item) => {
  if (!item || !item.imdbId || !/^tt\d{4,12}$/.test(item.imdbId)) return null;
  return {
    id: item.imdbId,
    k: item.type === "show" || item.type === "series" ? "tv" : "movie",
    title: item.title || "",
    year: item.year || null,
    g: canonGenres(item.genres || []),
    kw: [], dir: [], wr: [], cre: [], cast: [], col: null, cc: [],
    va: typeof item.rating === "number" ? item.rating : 0,
    vc: 0,
    pop: 0,
    poster: item.poster || (typeof item.cover === "string" && /^https?:/.test(item.cover) ? item.cover : null),
    backdrop: item.backdrop || null,
    ov: String(item.synopsis || "").slice(0, 600),
    lite: true,
    at: Date.now(),
  };
};

const put = (rec) => {
  if (!rec || !rec.id) return null;
  const s = open();
  const cur = s.data.titles[rec.id];
  // a lite record never replaces a full one
  if (cur && !cur.lite && rec.lite) return cur;
  // genres learned from a catalogue card survive the upgrade to a full record
  if (cur && cur.g && cur.g.length && !rec.lite) {
    rec.g = canonGenres([...cur.g, ...rec.g]);
    if (cur.cg) rec.cg = 1;
  }
  if (cur && !rec.poster) rec.poster = cur.poster;
  if (cur && !rec.backdrop) rec.backdrop = cur.backdrop;
  s.data.titles[rec.id] = rec;
  if (rec.tm) s.data.tm[`${rec.k}:${rec.tm}`] = rec.id;
  version++;
  saveSoon();
  return rec;
};

// Cards we merely SAW (catalogue pages, the library): make sure each has at
// least a lite record, and that its catalogue genres are on the record. Sync,
// no network — cheap enough for the request path (one map lookup per card).
const noteCards = (items) => {
  const s = open();
  let changed = 0;
  for (const item of items || []) {
    if (!item || !item.imdbId) continue;
    const cur = s.data.titles[item.imdbId];
    if (cur) {
      if (!cur.cg && (item.genres || []).length) {
        cur.cg = 1;
        const merged = canonGenres([...(item.genres || []), ...(cur.g || [])]);
        if (merged.join("|") !== (cur.g || []).join("|")) { cur.g = merged; changed++; }
      }
      continue;
    }
    const rec = fromCard(item);
    if (rec) {
      if ((item.genres || []).length) rec.cg = 1;
      s.data.titles[rec.id] = rec;
      changed++;
    }
  }
  if (changed) { version++; saveSoon(); }
  return changed;
};

const get = (imdbId) => open().data.titles[imdbId] || null;
const byTmdb = (kind, tmdbId) => {
  const id = open().data.tm[`${kind}:${tmdbId}`];
  return id ? open().data.titles[id] || null : null;
};
const all = () => Object.values(open().data.titles);
const size = () => Object.keys(open().data.titles).length;

const APPEND = {
  movie: "&append_to_response=keywords,credits,external_ids,release_dates,recommendations,similar",
  tv: "&append_to_response=keywords,credits,external_ids,content_ratings,recommendations,similar",
};

const stale = (rec, now = Date.now()) => !rec || !!rec.lite || now - (rec.at || 0) > REFRESH_MS;
const missed = (key, now = Date.now()) => {
  const at = open().data.miss[key];
  return !!at && now - at < MISS_MS;
};
const noteMiss = (key) => { open().data.miss[key] = Date.now(); saveSoon(); };

// One title, by whichever id we hold. Costs 1 call (a film, or anything by
// TMDB id) or 2 (a series known only by its IMDb id: /find first).
//   want: { imdbId?, tmdbId?, kind: "movie"|"tv", genres?, poster?, backdrop?, synopsis? }
// Returns the record, or null when TMDB has nothing (remembered for a week).
const fetchOne = async (want) => {
  const kind = want.kind === "tv" ? "tv" : "movie";
  const key = want.imdbId || `${kind}:${want.tmdbId}`;
  let id = want.tmdbId || null;
  if (!id && want.imdbId) {
    const known = get(want.imdbId);
    if (known && known.tm) id = known.tm;
  }
  if (!id && want.imdbId && kind === "tv") {
    const found = await tmdb.get(`find/${want.imdbId}`, "&external_source=imdb_id");
    const hit = (found.tv_results || [])[0];
    if (!hit) { noteMiss(key); return null; }
    id = hit.id;
  }
  let raw;
  try {
    // a film's detail endpoint accepts the IMDb id directly
    raw = await tmdb.get(`${kind}/${id || want.imdbId}`, APPEND[kind]);
  } catch (err) {
    if (err.status === 404) { noteMiss(key); return null; }
    throw err;
  }
  const rec = fromTmdb(raw, kind, want);
  if (!rec) { noteMiss(key); return null; }
  // the kids gate's long-lived rating store learns from this call too
  try {
    if (rec.age != null || rec.cert) {
      require("../discover").noteCertificate({
        imdbId: rec.id, certificate: rec.cert || null, kidsAge: rec.age ?? null,
        type: kind === "tv" ? "show" : "movie", title: rec.title, year: rec.year,
      });
    }
  } catch {}
  return put(rec);
};

// Bring a list of wanted titles up to full records, at most `budget` DETAIL
// calls (a /find for a series rides along — one more small call). Three at a
// time behind tmdb.js's global pacing. Never throws; a dead network just
// returns what it managed.
const ensure = async (wants, { budget = 100, concurrency = 3, refresh = false } = {}) => {
  const out = { asked: 0, got: 0, missed: 0, failed: 0, skipped: 0 };
  if (!tmdb.hasKey()) return { ...out, skipped: (wants || []).length, noKey: true };
  const now = Date.now();
  const seen = new Set();
  const queue = [];
  for (const w of wants || []) {
    if (!w) continue;
    const kind = w.kind === "tv" ? "tv" : "movie";
    const key = w.imdbId || (w.tmdbId ? `${kind}:${w.tmdbId}` : null);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const cur = w.imdbId ? get(w.imdbId) : byTmdb(kind, w.tmdbId);
    if (cur && !cur.lite && !(refresh && stale(cur, now))) continue;
    if (missed(key, now)) { out.skipped++; continue; }
    queue.push({ ...w, kind });
    if (queue.length >= budget) break;
  }
  let fails = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length) {
        if (fails >= 8) return; // TMDB is down: stop asking
        const w = queue.shift();
        out.asked++;
        try {
          const rec = await fetchOne(w);
          if (rec) out.got++;
          else out.missed++;
        } catch {
          out.failed++;
          fails++;
        }
      }
    }),
  );
  prune();
  if (out.asked) flush(); // a round of learning is on disk when it ends
  return out;
};

// Keep the file bounded: beyond MAX_TITLES the least-voted, oldest go first.
const prune = (keep = keepIds, max = MAX_TITLES) => {
  const s = open();
  const ids = Object.keys(s.data.titles);
  if (ids.length <= max) return 0;
  const victims = ids
    .map((id) => s.data.titles[id])
    .filter((r) => !(keep && keep.has(r.id)))
    .sort((a, b) => (a.vc || 0) - (b.vc || 0) || (a.at || 0) - (b.at || 0))
    .slice(0, ids.length - max);
  for (const r of victims) {
    delete s.data.titles[r.id];
    if (r.tm) delete s.data.tm[`${r.k}:${r.tm}`];
  }
  version++;
  saveSoon();
  return victims.length;
};

// Small cached lists (a director's films, a keyword query's results): TMDB
// ids only, refreshed weekly. `load` does the network call.
const LIST_MS = 7 * 24 * 3600 * 1000;
const cachedList = async (key, load) => {
  const s = open();
  const hit = s.data.lists[key];
  if (hit && Date.now() - hit.at < LIST_MS) return hit.ids;
  const ids = await load();
  s.data.lists[key] = { at: Date.now(), ids };
  const keys = Object.keys(s.data.lists);
  if (keys.length > 600) for (const k of keys.slice(0, keys.length - 600)) delete s.data.lists[k];
  saveSoon();
  return ids;
};
const listCached = (key) => {
  const hit = open().data.lists[key];
  return hit ? hit.ids : null;
};

module.exports = {
  get, byTmdb, all, size, stamp, put, noteCards, ensure, fetchOne, cachedList, listCached, stale, flush, prune, setKeep,
  _internals: { fromTmdb, fromCard, useMemory, open, V, REFRESH_MS, MAX_TITLES, APPEND },
};
