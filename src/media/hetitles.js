// The official Hebrew names of the titles the search knows.
//
// TMDB keeps each title's name per language: Harry Potter and the
// Philosopher's Stone is "הארי פוטר ואבן החכמים", Breaking Bad "שובר שורות",
// Interstellar "בין כוכבים". search.js indexes these as another name of the
// title (like the catalogue's own spelling of a library folder), so the
// Hebrew name a person types finds the English title it belongs to.
//
// One call a title: /find by IMDb id with language=he-IL, through the
// recommender's paced TMDB door (recs/tmdb.js: ~9 requests a second shared
// with everything else, retried once). TMDB answers in English when it has no
// Hebrew name; that is remembered as a miss and asked again a month later.
// Off the request path: a round a few minutes after boot, then one every half
// hour, ROUND titles at most — the library first, then the trending titles,
// then the well-known and recommender titles by popularity (search.js says
// which, hebrewWants()). ~8,000 titles are all asked within the first day;
// after that a round only asks what is new. No key: nothing is asked.
//
// cache/search-he.json: { v, titles: { tt…: { he, at } }, miss: { tt…: at } }
// (~8,000 names ≈ 400 KB).
"use strict";

const path = require("path");
const config = require("../config");
const { JsonStore } = require("../lib/jsonstore");
const lazy = require("../lib/lazy");
const { hasHebrew } = require("./hebrew");

const tmdbLib = lazy(require, "./recs/tmdb");

const V = 1;
const HIT_TTL = 180 * 24 * 3600 * 1000;
const MISS_TTL = 30 * 24 * 3600 * 1000;
const ROUND = 240; // lookups a round (≈ 27 s of the shared TMDB door)
const EVERY_MS = 30 * 60 * 1000;
const FIRST_MS = 4 * 60 * 1000;
const MAX_TITLES = 20000;

let store = null;
const blank = () => ({ v: V, titles: {}, miss: {} });
const open = () => {
  if (!store) {
    store = new JsonStore(path.join(config.CACHE_DIR, "search-he.json"), blank());
    if (store.data.v !== V) store.data = blank();
    for (const k of ["titles", "miss"]) if (!store.data[k] || typeof store.data[k] !== "object") store.data[k] = {};
  }
  return store;
};

let version = 0;
// A stamp that changes when the names do (once a round, not once a name: the
// search index is rebuilt on it).
const stamp = () => version;
const get = (imdbId) => {
  const r = imdbId ? open().data.titles[imdbId] : null;
  return r && typeof r.he === "string" ? r.he : null;
};
const size = () => Object.keys(open().data.titles).length;

// Is this title worth asking about now?
const due = (imdbId, now = Date.now()) => {
  const d = open().data;
  const hit = d.titles[imdbId];
  if (hit) return now - (hit.at || 0) > HIT_TTL;
  const miss = d.miss[imdbId];
  return !miss || now - miss > MISS_TTL;
};

// The Hebrew name in a /find answer, or null. A film by its movie result, a
// series by its tv result; TMDB's English fallback is not a Hebrew name.
const pick = (found, type) => {
  const lists = type === "show" ? [found.tv_results, found.movie_results] : [found.movie_results, found.tv_results];
  for (const list of lists) {
    const x = (list || [])[0];
    if (!x) continue;
    const name = String(x.title || x.name || "").trim();
    return name && hasHebrew(name) ? name.slice(0, 160) : null;
  }
  return null;
};

// Ask TMDB for these titles' Hebrew names: [{ imdbId, type }], at most
// `budget` calls. Never throws; stops after a few failures in a row (TMDB down).
let running = null;
const ensure = (wants, { budget = ROUND, get: getImpl = null } = {}) => {
  if (running) return running;
  const ask = getImpl || ((p, q) => tmdbLib().get(p, q));
  running = (async () => {
    const out = { asked: 0, got: 0, missed: 0, failed: 0 };
    if (!getImpl && !tmdbLib().hasKey()) return { ...out, noKey: true };
    const d = open().data;
    const now = Date.now();
    const queue = [];
    const seen = new Set();
    for (const w of wants || []) {
      if (!w || !/^tt\d{4,12}$/.test(w.imdbId || "") || seen.has(w.imdbId)) continue;
      seen.add(w.imdbId);
      if (!due(w.imdbId, now)) continue;
      queue.push(w);
      if (queue.length >= budget) break;
    }
    let fails = 0;
    for (const w of queue) {
      if (fails >= 5) break;
      out.asked++;
      try {
        const found = await ask(`find/${w.imdbId}`, "&external_source=imdb_id&language=he-IL");
        fails = 0;
        const he = pick(found || {}, w.type);
        if (he) {
          d.titles[w.imdbId] = { he, at: Date.now() };
          delete d.miss[w.imdbId];
          out.got++;
        } else {
          d.miss[w.imdbId] = Date.now();
          out.missed++;
        }
      } catch {
        out.failed++;
        fails++;
      }
    }
    if (out.got || out.missed) {
      prune();
      version++;
      open().save();
    }
    return out;
  })().finally(() => { running = null; });
  return running;
};

// Bounded: the oldest names go first beyond MAX_TITLES (a cap nobody reaches
// with the search's ~8,000 titles; it keeps a runaway from growing the file).
const prune = () => {
  const d = open().data;
  for (const k of ["titles", "miss"]) {
    const ids = Object.keys(d[k]);
    if (ids.length <= MAX_TITLES) continue;
    const at = (id) => (k === "titles" ? d[k][id].at || 0 : d[k][id] || 0);
    ids.sort((a, b) => at(a) - at(b)).slice(0, ids.length - MAX_TITLES).forEach((id) => delete d[k][id]);
  }
};

// One round: what the search wants named, in its order.
const round = async () => {
  let wants = [];
  try { wants = require("./search").hebrewWants(); } catch { wants = []; }
  return ensure(wants);
};

let timer = null;
const start = ({ first = FIRST_MS, every = EVERY_MS } = {}) => {
  if (timer) return;
  const tick = () => { round().catch(() => {}); };
  const t = setTimeout(tick, first);
  if (t.unref) t.unref();
  timer = setInterval(tick, every);
  if (timer.unref) timer.unref();
};

module.exports = {
  get, stamp, size, ensure, round, start,
  _internals: {
    pick, due, open,
    useMemory: (data = null) => { store = { data: data || blank(), save() {}, flush() {} }; version++; return store; },
    ROUND, HIT_TTL, MISS_TTL,
  },
};
