// FRANCHISE ORDER for one person — what the routes (routes/franchises.js) and
// Home's "Continue the franchise" row hand to the website, the TV and the
// phone. The rules are logic.js's; this file gathers what they need:
//   · the franchises: the curated list (index.js, shipped + data/franchises)
//     first, a TMDB collection (tmdb.js) for a film the list does not cover;
//   · what this person has watched: the shared title history (profiles.js
//     streamTitleProgress / streamEpisodeProgress — a film played from the
//     library, from a torrent or ticked off all count, by IMDb id);
//   · what the server holds: identity.findLibraryFor (by IMDb id, then by
//     title and year — never a copy whose own IMDb id says it is another film);
//   · the order the person chose per franchise (profiles.franchiseOrderOf).
// Every word a client shows comes from here, so the three say the same.
"use strict";
const franchises = require("./index");
const logic = require("./logic");
const tmdb = require("./tmdb");

// (what this file reads, behind one switch the tests can swap)
const D = {
  profiles: () => require("../../profiles"),
  identity: () => require("../identity"),
  discover: () => require("../discover"),
  catalogue: () => franchises.catalogue(),
  tmdb: () => tmdb,
};
const DEFAULTS = { ...D };
const profilesLib = () => D.profiles();
const identity = () => D.identity();
const discover = () => D.discover();

const metahubPoster = (imdbId) => `https://images.metahub.space/poster/small/${imdbId}/img`;

// ---------- the person ----------
const personOf = (profileId, now = Date.now()) => {
  if (!profileId) return { stateOf: () => null, lastAt: () => 0, has: false };
  let films = {};
  let eps = {};
  try { films = profilesLib().streamTitleProgress(profileId) || {}; } catch {}
  try { eps = profilesLib().streamEpisodeProgress(profileId) || {}; } catch {}
  const shows = new Map(); // imdbId -> { done, any, at }
  for (const [k, row] of Object.entries(eps)) {
    const id = k.split(":")[0];
    const s = shows.get(id) || { done: 0, any: false, at: 0 };
    if (row.finished) s.done++;
    if (row.finished || row.position > 0) s.any = true;
    s.at = Math.max(s.at, row.updatedAt || 0);
    shows.set(id, s);
  }
  const stateOf = (e) => {
    if (e.type !== "series") {
      const r = films[e.imdbId];
      if (!r) return null;
      if (r.finished) return "watched";
      return r.position > 0 ? "started" : null;
    }
    const s = shows.get(e.imdbId);
    if (!s || !s.any) return null;
    // every aired episode finished (the catalogue's list, cache only) = watched
    let aired = 0;
    try {
      const meta = discover().metaCached("series", e.imdbId);
      for (const se of (meta && meta.seasons) || []) {
        for (const ep of se.episodes || []) if (!ep.released || Date.parse(ep.released) <= now) aired++;
      }
    } catch {}
    return aired && s.done >= aired ? "watched" : "started";
  };
  const lastAt = (e) => (e.type !== "series" ? (films[e.imdbId] && films[e.imdbId].updatedAt) || 0 : (shows.get(e.imdbId) || {}).at || 0);
  return { stateOf, lastAt, has: true, films };
};

const orderFor = (profileId, fr) => {
  if (!profileId) return "release";
  try {
    return logic.orderName(fr, profilesLib().franchiseOrderOf(profileId, fr.id));
  } catch {
    return "release";
  }
};

// ---------- the server's copy ----------
// → the library item (movie or show) for an entry, or null
const onServerOf = () => {
  try { identity().ensureStamped(); } catch {}
  const memo = new Map();
  return (e) => {
    if (memo.has(e.imdbId)) return memo.get(e.imdbId);
    let item = null;
    try {
      item = identity().findLibraryFor({ imdbId: e.imdbId, type: e.type === "series" ? "show" : "movie", title: e.title, year: e.year });
      // a title match whose own IMDb id is another film is not this one
      if (item) {
        const own = identity().imdbIdFor(item) || item.imdbId || null;
        if (own && own !== e.imdbId) item = null;
      }
    } catch {
      item = null;
    }
    memo.set(e.imdbId, item);
    return item;
  };
};

// ---------- which franchises a title is in ----------
// Curated first (best priority first); a TMDB collection only for a film the
// curated list does not have — and not when its collection is one a curated
// franchise already covers and lists this film in.
const franchisesFor = async (imdbId, { network = true, tmdbHint = null, type = "movie" } = {}) => {
  const cat = D.catalogue();
  const curated = cat.byTitle.get(imdbId) || [];
  if (curated.length) return curated;
  if (type === "series") return [];
  const coll = network ? await D.tmdb().forTitle(imdbId, { tmdbHint }) : D.tmdb().cachedFor(imdbId);
  if (!coll || !coll.orders.release.some((e) => e.imdbId === imdbId)) return [];
  return [coll];
};

const byId = async (id, { network = true } = {}) => {
  const m = /^tmdb-(\d{1,9})$/.exec(String(id || ""));
  if (m) return D.tmdb().collection(m[1], { network });
  return D.catalogue().byId.get(String(id || "")) || null;
};

// ---------- the answers ----------

// The title page's line. → { franchise: line | null, others: [line…] }
const forTitle = async (imdbId, profileId, opts = {}) => {
  const frs = await franchisesFor(imdbId, opts);
  const lines = frs.map((fr) => logic.lineFor(fr, imdbId, orderFor(profileId, fr))).filter(Boolean);
  return { franchise: lines[0] || null, others: lines.slice(1) };
};

const cardOf = (e, onServer, extra = {}) => {
  const lib = onServer(e);
  let poster = e.poster || null;
  if (!poster) {
    try {
      const meta = discover().metaCached(e.type === "series" ? "series" : "movie", e.imdbId);
      poster = (meta && meta.poster) || null;
    } catch {}
  }
  if (!poster) poster = metahubPoster(e.imdbId);
  return {
    imdbId: e.imdbId,
    type: e.type === "series" ? "show" : "movie",
    title: e.title,
    year: e.year || null,
    date: e.date || null,
    poster,
    cover: (lib && lib.cover) || poster,
    optional: !!e.optional,
    ...(e.note ? { note: e.note } : {}),
    onServer: lib ? { id: lib.id, type: lib.type === "show" ? "show" : "movie" } : null,
    ...extra,
  };
};

// The franchise page. → page | null
const page = async (id, profileId, wantOrder = null) => {
  const fr = await byId(id);
  if (!fr) return null;
  const saved = orderFor(profileId, fr);
  const order = logic.orderName(fr, wantOrder || saved);
  const person = personOf(profileId);
  const onServer = onServerOf();
  const list = logic.listOf(fr, order);
  const main = logic.mainOf(list);
  const entries = list.map((e) => {
    const i = main.indexOf(e);
    return cardOf(e, onServer, { position: i >= 0 ? i + 1 : null, state: person.stateOf(e) });
  });
  return {
    id: fr.id,
    name: fr.name,
    the: !!fr.the,
    source: fr.source || "curated",
    title: fr.name,
    summary: logic.summaryOf(fr, { onServer, stateOf: person.stateOf }),
    order,
    savedOrder: saved,
    orders: logic.ordersOf(fr),
    total: main.length,
    entries,
    sources: fr.sources || [],
  };
};

// The end card: what comes after this film in the person's order.
// → { next: { franchise: {id, name, the}, kicker, line, entry } | null }
const nextFor = async (imdbId, profileId, opts = {}) => {
  const frs = await franchisesFor(imdbId, opts);
  const onServer = onServerOf();
  for (const fr of frs) {
    const order = orderFor(profileId, fr);
    const n = logic.nextAfter(fr, imdbId, order);
    if (!n) continue;
    return {
      next: {
        franchise: { id: fr.id, name: fr.name, the: !!fr.the },
        order,
        kicker: logic.nextKicker(fr),
        position: n.position,
        total: n.total,
        entry: cardOf(n.entry, onServer, { position: n.position }),
      },
    };
  }
  return { next: null };
};

// Home's "Continue the franchise": cache only, no network (Home never waits).
// → [card…], most recently watched franchise first; each card is the library
// item when the server holds it (it plays from its card like any other), the
// catalogue title otherwise, and carries `franchise` (the row's small print).
const homeRow = (profileId, { limit = 12, used = null } = {}) => {
  if (!profileId) return [];
  const person = personOf(profileId);
  const cat = D.catalogue();
  const seen = new Map();
  for (const [imdbId, row] of Object.entries(person.films || {})) {
    if (!row || !row.finished) continue;
    for (const fr of cat.byTitle.get(imdbId) || []) seen.set(fr.id, fr);
    if (!(cat.byTitle.get(imdbId) || []).length) {
      const coll = D.tmdb().cachedFor(imdbId);
      if (coll) seen.set(coll.id, coll);
    }
  }
  if (!seen.size) return [];
  const onServer = onServerOf();
  const picks = [];
  const taken = new Set();
  for (const fr of seen.values()) {
    const c = logic.continueFor(fr, orderFor(profileId, fr), { stateOf: person.stateOf, lastAt: person.lastAt });
    if (!c || taken.has(c.entry.imdbId) || (used && used.has(c.entry.imdbId))) continue;
    taken.add(c.entry.imdbId);
    picks.push({ fr, c });
  }
  // the franchise watched most recently first; a tie, the bigger one
  picks.sort((a, b) => b.c.at - a.c.at || b.fr.priority - a.fr.priority);
  const out = [];
  for (const { fr, c } of picks.slice(0, limit)) {
    const lib = onServer(c.entry);
    const small = { id: fr.id, name: fr.name, the: !!fr.the, position: c.position, total: c.total, line: `${logic.nextKicker(fr)} · ${c.position} of ${c.total}` };
    if (lib) out.push({ ...lib, franchise: small });
    else out.push({ ...cardOf(c.entry, onServer), source: "stream", franchise: small });
  }
  return out;
};

const setOrder = async (id, profileId, order) => {
  const fr = await byId(id, { network: false });
  if (!fr) return { error: "No such franchise", status: 404 };
  if (!logic.ordersOf(fr).some((o) => o.id === order)) return { error: "That order isn't one this franchise has", status: 400 };
  const saved = profilesLib().setFranchiseOrder(profileId, fr.id, order);
  if (!saved) return { error: "Couldn't save that", status: 400 };
  return { ok: true, order: saved };
};

module.exports = { forTitle, page, nextFor, homeRow, setOrder, franchisesFor, byId, _internals: { personOf, onServerOf, cardOf, orderFor, use: (o) => Object.assign(D, o), restore: () => Object.assign(D, DEFAULTS) } };
