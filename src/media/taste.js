// THE taste model: one explainable recommender per profile, built from what
// the person actually DID — rated, finished, abandoned, listed, picked in
// onboarding — instead of the old genre-tally heuristics. Dependency-free,
// cache-only (it must never block /api/home on network), and every
// recommendation carries a `why` so a bad one is debuggable instead of
// mysterious.
//
// Named decision (prompt 9 spec): ships WITHOUT kids/certificate filtering —
// kids profiles were deferred to post-sign-in (prompt 8), so there is no
// profile the filter could apply to. Revisit alongside sign-in.
const scanner = require("./scanner");
const discover = require("./discover");
const similar = require("./similar");
const profiles = require("../profiles");

// ---------- pure core (everything _internals-tested) ----------

// Half-life of a signal: something you finished last week says more about
// tonight than something you finished in spring.
const HALF_LIFE_DAYS = 90;
const decay = (at, now = Date.now()) => {
  if (!at) return 1; // undated signals (ratings) count full — documented
  const days = Math.max(0, (now - at) / 86400000);
  return Math.pow(0.5, days / HALF_LIFE_DAYS);
};

const eraOf = (year) => (year ? `${Math.floor(year / 10) * 10}s` : null);

// signals: [{genres, type, year, weight, why, at}]
const buildVector = (signals, now = Date.now()) => {
  const v = { genres: {}, types: {}, eras: {}, total: 0 };
  for (const s of signals) {
    const w = s.weight * decay(s.at, now);
    v.total += Math.abs(w);
    if (s.type) v.types[s.type] = (v.types[s.type] || 0) + w;
    const era = eraOf(s.year);
    if (era) v.eras[era] = (v.eras[era] || 0) + w * 0.5; // era is a hint, not a verdict
    for (const g of s.genres || []) {
      if (!v.genres[g]) v.genres[g] = { w: 0, why: s.why };
      v.genres[g].w += w;
      // the strongest contributor names the genre's why
      if (Math.abs(w) > Math.abs(v.genres[g].topW || 0)) {
        v.genres[g].topW = w;
        v.genres[g].why = s.why;
      }
    }
  }
  return v;
};

// Score one candidate against the vector. Returns {score, why} — why is the
// single strongest positive reason, or null when the match is generic.
const scoreItem = (vector, item) => {
  let score = 0;
  let why = null;
  let whyW = 0;
  for (const g of item.genres || []) {
    const gv = vector.genres[g];
    if (!gv) continue;
    score += gv.w;
    if (gv.w > whyW) {
      whyW = gv.w;
      why = gv.why;
    }
  }
  const t = item.type === "show" ? "show" : "movie";
  score += (vector.types[t] || 0) * 0.4;
  const era = eraOf(item.year);
  if (era) score += (vector.eras[era] || 0) * 0.4;
  // quality prior: a 7.8 beats a 5.9 at equal taste-match
  if (item.rating) score *= 0.7 + 0.3 * Math.min(1, item.rating / 10);
  return { score, why };
};

// Rank candidates: unseen only, diversity-capped (a model that collapses to
// one genre feels broken even when it's mathematically right — hero.js's
// lesson, kept).
const recommend = (vector, candidates, { seen = new Set(), max = 16, maxPerGenre = 3 } = {}) => {
  const scored = [];
  for (const c of candidates) {
    const key = c.imdbId || c.id;
    if (!key || seen.has(key) || (c.id && seen.has(c.id))) continue;
    const { score, why } = scoreItem(vector, c);
    if (score > 0) scored.push({ c, score, why });
  }
  scored.sort((a, b) => b.score - a.score);
  const out = [];
  const perGenre = {};
  for (const { c, why } of scored) {
    if (out.length >= max) break;
    const primary = (c.genres || [])[0];
    if (primary) {
      if ((perGenre[primary] || 0) >= maxPerGenre) continue;
      perGenre[primary] = (perGenre[primary] || 0) + 1;
    }
    out.push(why ? { ...c, why } : { ...c });
  }
  return out;
};

// ---------- signal collection (server-integrated) ----------

const W = {
  rate5: 3, rate4: 2, rate2: -2, rate1: -3,
  finished: 1.5, deep: 1, abandoned: -0.75,
  listed: 1, loved: 2.5, likedGenre: 1.5,
};

// Everything known about a title, from the caches only.
const metaIndex = () => {
  const byKey = new Map();
  const identity = require("./identity"); // lazy: identity ↔ heavy deps
  for (const item of scanner.allItems()) {
    // the cached IMDb id (sync, no network) lets a loved LIBRARY title
    // anchor a "Because you loved" row and be rated under either key
    const imdbId = identity.imdbIdFor(item);
    const m = { genres: item.genres || [], type: item.type, year: item.year, title: item.title, imdbId };
    byKey.set(item.id, m);
    if (imdbId && !byKey.has(imdbId)) byKey.set(imdbId, m);
  }
  const t = discover.trendingCached();
  for (const i of t ? [...(t.movies || []), ...(t.shows || [])] : []) {
    if (i.imdbId && !byKey.has(i.imdbId)) {
      byKey.set(i.imdbId, { genres: i.genres || [], type: i.type, year: i.year, title: i.title, imdbId: i.imdbId });
    }
  }
  return byKey;
};

const collectSignals = (profileId, meta) => {
  const signals = [];
  const anchors = []; // strong positives with an imdbId → "because you loved"
  const push = (key, weight, why, at, extraMeta) => {
    const m = meta.get(key) || extraMeta;
    if (!m || (!m.genres || !m.genres.length) && !m.type) return;
    signals.push({ genres: m.genres, type: m.type, year: m.year, weight, why, at });
    if (weight >= 2 && (m.imdbId || (key.startsWith && key.startsWith("tt")))) {
      anchors.push({ imdbId: m.imdbId || key, title: m.title, type: m.type, weight });
    }
  };

  const ratings = profiles.getRatings(profileId);
  for (const [key, stars] of Object.entries(ratings)) {
    const m = meta.get(key);
    const title = (m && m.title) || "it";
    if (stars >= 5) push(key, W.rate5, `Because you rated ${title} 5★`);
    else if (stars === 4) push(key, W.rate4, `Because you rated ${title} 4★`);
    else if (stars === 2) push(key, W.rate2, `rated ${title} 2★`);
    else if (stars === 1) push(key, W.rate1, `rated ${title} 1★`);
  }

  const progress = profiles.getProgress(profileId);
  const streamItems = profiles.getStreamItems(profileId);
  for (const [id, row] of Object.entries(progress)) {
    // stream ids resolve through their stored play-meta to an imdbId
    const sm = streamItems[id];
    let key = sm && sm.imdbId ? sm.imdbId : id;
    let extra = null;
    if (!meta.get(key)) {
      // a library EPISODE id — the household's core viewing — resolves to
      // its parent show (metaIndex holds movies+shows, not episodes)
      const found = scanner.findById(id);
      if (found && found.showId) key = found.showId;
      else if (sm) extra = { genres: sm.genres || [], type: sm.type, year: sm.year, title: sm.title, imdbId: sm.imdbId };
    }
    const m = meta.get(key);
    const title = (m && m.title) || (sm && sm.title) || "it";
    if (row.finished) push(key, W.finished, `You finished ${title}`, row.updatedAt, extra);
    else if (row.duration > 0 && row.position / row.duration > 0.7) {
      push(key, W.deep, `You watched most of ${title}`, row.updatedAt, extra);
    } else if (row.duration > 600 && row.position > 300 && row.position / row.duration < 0.2) {
      push(key, W.abandoned, `abandoned ${title}`, row.updatedAt, extra);
    }
  }

  for (const entry of profiles.getWatchlist(profileId)) {
    const key = typeof entry === "string" ? entry : entry.imdbId;
    if (!key) continue;
    const m = meta.get(key);
    push(key, W.listed, `${(m && m.title) || "It"} is on your list`, null,
      typeof entry === "object" ? { genres: entry.genres || [], type: entry.type, year: entry.year, title: entry.title, imdbId: entry.imdbId } : null);
  }

  for (const t of profiles.getLikedTitles(profileId)) {
    const key = t.imdbId || t.id;
    if (!key) continue;
    push(key, W.loved, `Because you love ${t.title}`);
  }

  for (const g of profiles.getLikedGenres(profileId)) {
    signals.push({ genres: [g], type: null, year: null, weight: W.likedGenre, why: `You like ${g}`, at: null });
  }

  anchors.sort((a, b) => b.weight - a.weight);
  // dedupe (a 5★ + an onboarding love on one title = one anchor, not two
  // crowding the shortlist)
  const seenAnchors = new Set();
  const unique = anchors.filter((a) => !seenAnchors.has(a.imdbId) && seenAnchors.add(a.imdbId));
  return { signals, anchors: unique };
};

// ---------- the per-profile model (cached, invalidated on new signals) ----------

const MODEL_TTL = 3 * 60 * 1000;
const modelCache = new Map(); // profileId -> {at, stamp, vector, anchors}

const modelFor = (profileId) => {
  const stamp = profiles.signalsStamp(profileId);
  const hit = modelCache.get(profileId);
  if (hit && hit.stamp === stamp && Date.now() - hit.at < MODEL_TTL) return hit;
  const meta = metaIndex();
  const { signals, anchors } = collectSignals(profileId, meta);
  const model = { at: Date.now(), stamp, vector: buildVector(signals), anchors: anchors.slice(0, 5) };
  if (modelCache.size > 50) modelCache.clear(); // deleted-profile retention cap
  modelCache.set(profileId, model);
  // background: make sure the top anchors have similar-rows for next time
  for (const a of model.anchors.slice(0, 3)) {
    if (a.imdbId) similar.warmSimilar(a.type === "show" ? "series" : "movie", a.imdbId);
  }
  return model;
};

// Enough signal to beat the generic fallback? (cold start → caller keeps
// today's behavior, never worse)
const COLD_START = 6;

// The home surfaces: an upgraded For-You row + up to two "Because you loved
// <anchor>" rows from the similar cache. Everything unseen-only, everything
// carries why. Returns null on cold start.
const homeRecommendations = ({ profileId, candidates, seen, exclude = [] }) => {
  const model = modelFor(profileId);
  if (model.vector.total < COLD_START) return null;
  const seenAll = new Set(seen);
  for (const e of exclude) {
    if (e.id) seenAll.add(e.id);
    if (e.imdbId) seenAll.add(e.imdbId);
  }
  const forYou = recommend(model.vector, candidates, { seen: seenAll, max: 16 });
  for (const i of forYou) {
    if (i.imdbId) seenAll.add(i.imdbId);
    if (i.id) seenAll.add(i.id);
  }
  const because = [];
  for (const a of model.anchors) {
    if (because.length >= 2 || !a.imdbId) continue;
    const rows = similar.similarCached(a.type === "show" ? "series" : "movie", a.imdbId);
    if (!rows || !rows.length) continue;
    const items = [];
    for (const r of rows) {
      const key = r.imdbId;
      if (!key || seenAll.has(key)) continue;
      seenAll.add(key);
      items.push({ ...r, source: "stream", cover: r.poster || r.cover || null, why: `Because you loved ${a.title}` });
      if (items.length >= 12) break;
    }
    if (items.length >= 4) because.push({ anchor: a, items });
  }
  return { forYou, because };
};

module.exports = {
  homeRecommendations,
  _internals: { buildVector, scoreItem, recommend, decay, eraOf, W, COLD_START },
};
