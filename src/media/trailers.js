// Trailers for the TV app, chosen here and played on the TV by ExoPlayer —
// never in a WebView (elia, 2026-10-09). The order:
//
//   1. Apple's trailer, when the title has one. trailers.apple.com is gone
//      (2023), but the Apple TV app's own catalogue API still serves each
//      film's trailer as a plain HLS playlist (no DRM, H.264 up to 1080p,
//      AAC; segment URLs carry no token). The Apple id ("umc.cmc.…") comes
//      from Wikidata by IMDb id (P9586 films, P9751 shows) — good for known
//      films, thin for new releases and most shows.
//   2. The title's YouTube keys (TMDB's videos through Cinemeta, the same
//      ones the site embeds). The TV resolves them ITSELF, from its own
//      address (NewPipeExtractor, android .../AuroraTrailers.kt) — a stream
//      URL is bound to the IP that asked for it, so the server cannot do it.
//   3. Nothing — the TV then shows no trailer at all.
//
// GET /api/trailer answers one of
//   { source: "apple", hls, id, quality }
//   { source: "youtube", ids: [key, …] }   best first
//   { source: "none", why }
//
// Cache (data/cache/trailers.json):
//   ids[imdbId]    the Wikidata answer: an Apple id is kept for good, "no
//                  Apple id" for 30 days, a failed lookup for a day
//   clips[appleId] Apple's answer: a playlist for 7 days (the URL form may
//                  change), "no trailer" for 30 days, an error for a day
// The playlist URL is kept as Apple served it; nothing is downloaded.
//
// Every outside answer is counted (lib/signals.js: provider "wikidata:…" /
// "apple-tv:…", and "trailer-apple" for the ways Apple can go wrong) so the
// healer's "TV trailers" check can say when Apple's catalogue moved.
"use strict";
const path = require("path");
const config = require("../config");
const { JsonStore } = require("../lib/jsonstore");

const DAY = 24 * 3600 * 1000;
const TTL = {
  idHit: Infinity,
  idMiss: 30 * DAY,
  clipHit: 7 * DAY,
  clipMiss: 30 * DAY,
  error: DAY,
};
// The Apple TV web app's own parameters. `utsk` and `sf` (the storefront,
// 143441 = US) may change one day: anything Apple answers that is not the
// expected shape is "no trailer today" (cached a day), counted, and the
// healer names this line as the fix.
const APPLE_API = "https://uts-api.itunes.apple.com/uts/v3";
const APPLE_QS = "caller=web&locale=en-US&pfm=web&sf=143441&v=90&utsk=6e3013c6d6fae3c2::::::235656c069bb0efb";
const WIKIDATA = "https://www.wikidata.org/w/api.php";
const UA = { "User-Agent": "Aurora/1.0 (personal media server; trailers)" };
const TIMEOUT_MS = 8000;
const IMDB_RE = /^tt\d{4,12}$/;
const APPLE_ID_RE = /^umc\.cmc\.[a-z0-9]{10,40}$/;
const YT_RE = /^[\w-]{6,20}$/;

// ---------------------------------------------------------------- injection
let store = null;
const getStore = () => {
  if (!store) store = new JsonStore(path.join(config.CACHE_DIR, "trailers.json"), { ids: {}, clips: {} });
  if (!store.data.ids) store.data.ids = {};
  if (!store.data.clips) store.data.clips = {};
  return store;
};
let fetchImpl = (...a) => fetch(...a);
const signals = () => require("../lib/signals");
const count = (key) => { try { signals().hit("trailer-apple", key); } catch {} };
const provider = (url, status) => { try { signals().provider(url, status); } catch {} };

// One GET → parsed JSON, or a thrown Error with .code: "http" (+ .status),
// "timeout", "net", "json".
const getJson = async (url) => {
  let res;
  try {
    res = await fetchImpl(url, { headers: UA, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const timeout = !!err && (err.name === "TimeoutError" || err.name === "AbortError");
    const e = new Error(timeout ? "timeout" : `network: ${err && err.message}`);
    e.code = timeout ? "timeout" : "net";
    throw e;
  }
  provider(url, res.status);
  if (!res.ok) {
    const e = new Error(`HTTP ${res.status}`);
    e.code = "http";
    e.status = res.status;
    throw e;
  }
  try {
    return await res.json();
  } catch {
    const e = new Error("not JSON");
    e.code = "json";
    throw e;
  }
};

const fresh = (entry, now, ttlOf) => !!entry && now - (entry.at || 0) < ttlOf(entry);
const shapeError = (what) => {
  const e = new Error(`${what}: unexpected shape`);
  e.code = "shape";
  return e;
};

// ---------------------------------------------------------------- Wikidata
// IMDb id → Apple id. Two small API calls (the search index answers the
// IMDb-id question; wbgetentities reads the two properties) — the SPARQL
// endpoint is slower and has had the longer outages.
const P_MOVIE = "P9586";
const P_SHOW = "P9751";
const claimValues = (entity, prop) =>
  ((entity && entity.claims && entity.claims[prop]) || [])
    .map((c) => c && c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value)
    .filter((v) => typeof v === "string" && APPLE_ID_RE.test(v));

// → { id, kind: "movies"|"shows" } | null (no Apple id). Throws on errors.
const wikidataLookup = async (imdbId, type) => {
  const q = await getJson(`${WIKIDATA}?action=query&list=search&srsearch=${encodeURIComponent(`haswbstatement:P345=${imdbId}`)}&srlimit=3&srprop=&format=json`);
  const hits = q && q.query && Array.isArray(q.query.search) ? q.query.search.map((s) => s && s.title).filter((t) => /^Q\d+$/.test(String(t))) : null;
  if (!hits) throw shapeError("wikidata search");
  if (!hits.length) return null;
  const ents = await getJson(`${WIKIDATA}?action=wbgetentities&ids=${hits.join("|")}&props=claims&format=json`);
  if (!ents || !ents.entities || typeof ents.entities !== "object") throw shapeError("wikidata entities");
  const all = Object.values(ents.entities);
  const order = type === "show" ? [P_SHOW, P_MOVIE] : [P_MOVIE, P_SHOW];
  for (const prop of order) {
    for (const ent of all) {
      const v = claimValues(ent, prop)[0];
      if (v) return { id: v, kind: prop === P_SHOW ? "shows" : "movies" };
    }
  }
  return null;
};

const appleIdFor = async (imdbId, type, now) => {
  const st = getStore();
  const hit = st.data.ids[imdbId];
  if (fresh(hit, now, (e) => (e.err ? TTL.error : e.id ? TTL.idHit : TTL.idMiss))) return hit;
  let entry;
  try {
    const r = await wikidataLookup(imdbId, type);
    entry = r ? { id: r.id, kind: r.kind, at: now } : { id: null, at: now };
  } catch (err) {
    count(`wikidata:${err.code === "http" ? err.status : err.code}`);
    entry = { id: null, err: String(err.message).slice(0, 80), at: now };
  }
  st.data.ids[imdbId] = entry;
  st.save();
  return entry;
};

// ---------------------------------------------------------------- Apple
const isHls = (u) => typeof u === "string" && /^https:\/\/[\w.-]+\.apple\.com\//.test(u) && /\.m3u8(\?|$)/.test(u);
const isTrailerTitle = (t) => /trailer|teaser/i.test(String(t || ""));

// The catalogue answer → the trailer's playlist URL, or null when the title
// has no trailer. Throws (code "shape") when the answer is not what Apple
// has been sending — that is the signal that the API moved.
//   films: data.playables[*].itunesMediaApiData.movieClips[] { title, hlsUrl }
//          (the full film's own entries are DRM-locked; the clip is not)
//   shows: data.canvas.shelves[] whose id starts "uts.col.Trailers" →
//          items[].playables[0].assets.hlsUrl (unencrypted, checked
//          2026-10-09: the master lists no keys)
const pickAppleClip = (body) => {
  const d = body && body.data;
  if (!d || typeof d !== "object" || (!d.content && !d.playables && !d.canvas)) throw shapeError("apple");
  const clips = [];
  const playables = d.playables && typeof d.playables === "object" ? Object.values(d.playables) : [];
  for (const p of playables) {
    const mc = p && p.itunesMediaApiData && p.itunesMediaApiData.movieClips;
    if (Array.isArray(mc)) for (const c of mc) if (c && isHls(c.hlsUrl)) clips.push({ title: c.title, hls: c.hlsUrl });
  }
  const shelves = d.canvas && Array.isArray(d.canvas.shelves) ? d.canvas.shelves : [];
  for (const s of shelves) {
    if (!s || !/^uts\.col\.Trailers/i.test(String(s.id || ""))) continue;
    for (const it of Array.isArray(s.items) ? s.items : []) {
      const p = it && Array.isArray(it.playables) ? it.playables[0] : null;
      const u = p && p.assets && p.assets.hlsUrl;
      if (isHls(u)) clips.push({ title: (p && p.title) || (it && it.title), hls: u });
    }
  }
  if (!clips.length) return null;
  return (clips.find((c) => /^trailer$/i.test(String(c.title || "").trim())) || clips.find((c) => isTrailerTitle(c.title)) || clips[0]).hls;
};

const appleClip = async (appleId, kind, now) => {
  const st = getStore();
  const hit = st.data.clips[appleId];
  if (fresh(hit, now, (e) => (e.err ? TTL.error : e.hls ? TTL.clipHit : TTL.clipMiss))) return hit;
  let entry;
  try {
    const body = await getJson(`${APPLE_API}/${kind === "shows" ? "shows" : "movies"}/${appleId}?${APPLE_QS}`);
    const hls = pickAppleClip(body);
    entry = { hls: hls || null, at: now };
  } catch (err) {
    // A 404 is Apple saying the id is not in its catalogue (any more): a
    // plain "no trailer", not a fault.
    if (err.code === "http" && err.status === 404) entry = { hls: null, at: now };
    else {
      count(`apple:${err.code === "http" ? err.status : err.code}`);
      entry = { hls: null, err: String(err.message).slice(0, 80), at: now };
    }
  }
  st.data.clips[appleId] = entry;
  st.save();
  return entry;
};

// ---------------------------------------------------------------- YouTube
// The title's known YouTube keys, best first (discover.meta puts the ones
// typed "Trailer" first). `meta` is injectable for the tests.
const defaultMeta = (type, id) => require("./discover").meta(type, id);
let metaImpl = defaultMeta;
const youtubeIds = async (imdbId, type) => {
  try {
    const m = await metaImpl(type === "show" ? "series" : "movie", imdbId);
    return ((m && m.trailers) || []).filter((k) => typeof k === "string" && YT_RE.test(k)).slice(0, 3);
  } catch {
    return [];
  }
};

// ---------------------------------------------------------------- the answer
const inflight = new Map();
const trailerFor = async ({ imdbId, type } = {}, now = Date.now()) => {
  imdbId = String(imdbId || "");
  type = type === "show" || type === "series" ? "show" : "movie";
  if (!IMDB_RE.test(imdbId)) return { source: "none", why: "no IMDb id" };
  const key = `${type}|${imdbId}`;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const idEntry = await appleIdFor(imdbId, type, now);
    if (idEntry.id) {
      const clip = await appleClip(idEntry.id, idEntry.kind || (type === "show" ? "shows" : "movies"), now);
      if (clip.hls) return { source: "apple", hls: clip.hls, id: idEntry.id, quality: 1080 };
    }
    const ids = await youtubeIds(imdbId, type);
    if (ids.length) return { source: "youtube", ids };
    return { source: "none", why: "no trailer known for this title" };
  })();
  inflight.set(key, p);
  try {
    return await p;
  } finally {
    inflight.delete(key);
  }
};

// ---------------------------------------------------------------- TV reports
// A TV saying a trailer failed: one log line and one count. `stage` is
// "resolve" (no playable URL came out) or "play" (the player gave up).
const tidy = (v, n) => String(v == null ? "" : v).replace(/[\x00-\x1f\x7f]/g, "").slice(0, n);
const report = (b = {}, who = "") => {
  b = b && typeof b === "object" ? b : {};
  const source = ["apple", "youtube"].includes(b.source) ? b.source : "other";
  const stage = ["resolve", "play"].includes(b.stage) ? b.stage : "play";
  const imdbId = IMDB_RE.test(String(b.imdbId || "")) ? b.imdbId : "-";
  const vid = b.id && YT_RE.test(String(b.id)) ? ` ${b.id}` : "";
  const why = tidy(b.why, 120) || "unknown";
  console.log(`[trailer] ${source} ${stage} failed on a TV: ${imdbId}${vid} — ${why}${who ? ` (${tidy(who, 40)})` : ""}`);
  try { signals().hit("trailer-fail", `${source}:${stage}`); } catch {}
  return { source, stage };
};

module.exports = {
  trailerFor,
  report,
  _internals: {
    TTL, APPLE_QS, pickAppleClip, wikidataLookup, appleIdFor, appleClip,
    setFetch: (f) => { fetchImpl = f; },
    setMeta: (f) => { metaImpl = f; },
    setStore: (s) => { store = s; },
    reset: () => { store = null; fetchImpl = (...a) => fetch(...a); metaImpl = defaultMeta; inflight.clear(); },
  },
};
