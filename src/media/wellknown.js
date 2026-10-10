// The well-known titles: what the search can suggest before anyone here has
// searched for it.
//
// The typeahead only knew the library, the ~400 trending titles and whatever
// an earlier search had brought back — so "du" offered Dune: Part Two and not
// Dune (2021) until the live catalogue answered. This keeps the catalogue's
// own popularity list on disk: the first 3,000 films and 2,000 series of
// Cinemeta's "top" catalogue, in its order (their place in that list is the
// popularity signal search.js ranks and judges "notable" by), each as a
// compact card with its first-billed cast.
//
// Fetched OFF the request path: a few minutes after boot when the file is
// missing or a week old, one page at a time with a pause between pages
// (100 small requests a week). A failed round keeps the old file. Memory:
// one object of ~5,000 small records (about 1.5 MB on disk).
const path = require("path");
const config = require("../config");
const { JsonStore } = require("../lib/jsonstore");

const V = 1;
const DEPTH = { movie: 3000, series: 2000 };
const PAGE = 50;
const REFRESH_MS = 7 * 24 * 3600 * 1000;
const RETRY_MS = 6 * 3600 * 1000; // a round that got nothing is tried again later the same day
const PAUSE_MS = 700;
const UA = { "User-Agent": "Aurora/1.0 (personal media server)" };

let store = null;
const open = () =>
  store || (store = new JsonStore(path.join(config.CACHE_DIR, "search-known.json"), { v: V, at: 0, tried: 0, titles: [] }));

// One catalogue entry → the compact record. `k` is its place in the list.
const fromMeta = (m, type, k) => {
  const imdbId = /^tt\d+$/.test(m.id || "") ? m.id : null;
  if (!imdbId || !m.name || !m.poster) return null;
  const list = (v) => (Array.isArray(v) ? v : v ? String(v).split(/,\s*/) : []).map((s) => String(s).trim()).filter(Boolean);
  return {
    imdbId,
    type: type === "series" ? "show" : "movie",
    title: m.name,
    year: m.releaseInfo ? parseInt(String(m.releaseInfo).slice(0, 4), 10) || null : null,
    poster: m.poster,
    rating: m.imdbRating ? parseFloat(m.imdbRating) || null : null,
    genres: list(m.genres || m.genre).slice(0, 4),
    cast: list(m.cast).slice(0, 4),
    director: list(m.director).slice(0, 2),
    k,
  };
};

const fetchPage = async (type, skip) => {
  const res = await fetch(`https://v3-cinemeta.strem.io/catalog/${type}/top${skip ? `/skip=${skip}` : ""}.json`, {
    headers: UA,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`cinemeta ${res.status}`);
  return (await res.json()).metas || [];
};

let running = null;
// Fetch the lists again. Resolves to how many titles are now known.
const refresh = ({ pause = PAUSE_MS, depth = DEPTH, fetchPage: page = fetchPage } = {}) => {
  if (running) return running;
  running = (async () => {
    const s = open();
    s.data.tried = Date.now();
    const out = [];
    const seen = new Set();
    for (const type of ["movie", "series"]) {
      let k = 0;
      let misses = 0;
      for (let skip = 0; skip < depth[type]; skip += PAGE) {
        let metas = [];
        try { metas = await page(type, skip); } catch { metas = []; }
        if (!metas.length) {
          if (++misses >= 2) break; // the list ended, or the catalogue is not answering
        } else misses = 0;
        for (const m of metas) {
          const rec = fromMeta(m, type, k++);
          if (!rec || seen.has(rec.imdbId)) continue;
          seen.add(rec.imdbId);
          out.push(rec);
        }
        if (pause) await new Promise((r) => { const t = setTimeout(r, pause); if (t.unref) t.unref(); });
      }
    }
    // a round that came back thin (offline, catalogue down) never replaces a good file
    if (out.length >= Math.max(200, (s.data.titles || []).length / 2)) {
      s.data.v = V;
      s.data.titles = out;
      s.data.at = Date.now();
      version++;
    }
    s.save();
    return (s.data.titles || []).length;
  })().finally(() => { running = null; });
  return running;
};

let version = 0;
// Sync, no network: the records as they are on disk, and a stamp that
// changes when they do (search.js rebuilds its index on it).
const all = () => {
  const d = open().data;
  return d.v === V && Array.isArray(d.titles) ? d.titles : [];
};
const stamp = () => `${open().data.at || 0}:${version}`;

const due = (now = Date.now()) => {
  const d = open().data;
  if (!all().length) return now - (d.tried || 0) > RETRY_MS;
  return now - (d.at || 0) > REFRESH_MS && now - (d.tried || 0) > RETRY_MS;
};

// Called once at boot: a look a few minutes in, then one a day.
let timer = null;
const start = ({ first = 3 * 60 * 1000, every = 24 * 3600 * 1000 } = {}) => {
  if (timer) return;
  const tick = () => { if (due()) refresh().catch(() => {}); };
  const t = setTimeout(tick, first);
  if (t.unref) t.unref();
  timer = setInterval(tick, every);
  if (timer.unref) timer.unref();
};

module.exports = { all, stamp, refresh, start, due, _internals: { fromMeta, DEPTH, useStore: (s) => { store = s; version++; } } };
