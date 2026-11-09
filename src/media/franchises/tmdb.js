// TMDB COLLECTIONS as franchises — every film series TMDB groups ("The Matrix
// Collection", "Paddington Collection"…), for the films the curated list
// (./data) does not cover. Needs a TMDB key (config.TMDB_KEY); without one
// every answer is "none" and nothing is asked.
//
// It rides on what the title page already fetches: similar.collection() reads
// the film's belongs_to_collection (cached a week under "coll|movie|tt…") and
// now keeps the collection's id. The collection itself (its parts, in release
// order, with IMDb ids attached) is cached here for a week, the title →
// collection answer for four (an empty answer a day). The same TMDB plumbing
// as similar.js: lib/upstream.js timeouts, the fair share, the breaker.
//
// The shape is the curated one (index.js build()), so logic.js serves both:
//   { id: "tmdb-<collectionId>", name, the: false, priority: 0, source: "tmdb",
//     tmdbCollection, orders: { release: [entry…] }, sources }
// Films not out yet are left out (an unreleased part has nothing to play).
"use strict";
const path = require("path");
const config = require("../../config");
const { JsonStore } = require("../../lib/jsonstore");

const COLL_TTL = 7 * 24 * 3600 * 1000;
const TITLE_TTL = 28 * 24 * 3600 * 1000;
const MISS_TTL = 24 * 3600 * 1000;

let store = null;
const db = () =>
  store ||
  (store = new JsonStore(path.join(config.CACHE_DIR, "franchise-tmdb.json"), {
    v: 1,
    titles: {}, // imdbId -> { coll: <id>|null, at }
    colls: {}, // id -> { name, parts: [entry…], at }
  }));
const SAVE_WITHIN_MS = 60 * 1000;

// "The Matrix Collection" → "The Matrix"; "Toy Story - Coleção" stays as it is
const cleanName = (name) => String(name || "").replace(/\s+(?:Collection|Saga|Series)$/i, "").trim() || String(name || "");

const asFranchise = (collId, hit) =>
  hit && Array.isArray(hit.parts) && hit.parts.length > 1
    ? {
        id: `tmdb-${collId}`,
        name: cleanName(hit.name),
        the: false,
        priority: 0,
        source: "tmdb",
        tmdbCollection: Number(collId),
        entries: hit.parts,
        orders: { release: hit.parts },
        sources: [`https://www.themoviedb.org/collection/${collId}`],
      }
    : null;

const today = () => new Date().toISOString().slice(0, 10);

// One collection by id, fetched when it is not cached (or is old). → franchise | null
const collection = async (collId, { network = true } = {}) => {
  const id = parseInt(collId, 10);
  if (!(id > 0)) return null;
  const hit = db().data.colls[id];
  if (hit && (Date.now() - hit.at < COLL_TTL || !network || !config.TMDB_KEY)) return asFranchise(id, hit);
  if (!network || !config.TMDB_KEY) return null;
  const similar = require("../similar");
  try {
    const data = await similar.tmdb(`collection/${id}`);
    const now = today();
    const parts = (data.parts || [])
      .filter((m) => m && m.release_date && m.release_date <= now)
      .sort((a, b) => a.release_date.localeCompare(b.release_date))
      .map((m) => ({
        tmdbId: m.id,
        type: "movie",
        title: m.title || m.name || "",
        year: parseInt(m.release_date.slice(0, 4), 10) || null,
        date: m.release_date,
        poster: m.poster_path ? `https://image.tmdb.org/t/p/w342${m.poster_path}` : null,
        optional: false,
      }));
    const withIds = (await similar.addImdbIds(parts, "movie")).map(({ imdbId, ...rest }) => ({ imdbId, ...rest }));
    db().data.colls[id] = { name: data.name || "", parts: withIds, at: Date.now() };
    db().save({ within: SAVE_WITHIN_MS });
    return asFranchise(id, db().data.colls[id]);
  } catch {
    return hit ? asFranchise(id, hit) : null; // an old answer beats none
  }
};

// The collection a film belongs to: its id, or null. Cache first; with
// network, what the title page's shelves already learned, else one TMDB ask.
const collectionIdFor = async (imdbId, { tmdbHint = null, network = true } = {}) => {
  const hit = db().data.titles[imdbId];
  if (hit && (Date.now() - hit.at < (hit.coll ? TITLE_TTL : MISS_TTL) || !network || !config.TMDB_KEY)) return hit.coll || null;
  if (!network || !config.TMDB_KEY) return null;
  const similar = require("../similar");
  let coll = null;
  let known = false;
  try {
    const shelves = await similar.collection("movie", imdbId, tmdbHint);
    if (shelves && shelves.collection && shelves.collection.id) {
      coll = shelves.collection.id;
      known = true;
    }
  } catch {}
  if (!known) {
    try {
      const tmdbId = tmdbHint || (await similar._internals.tmdbIdFor(imdbId, "movie"));
      if (tmdbId) {
        const movie = await similar.tmdb(`movie/${tmdbId}`);
        coll = (movie.belongs_to_collection && movie.belongs_to_collection.id) || null;
        known = true;
      }
    } catch {}
  }
  if (!known) return hit ? hit.coll || null : null; // could not ask: nothing remembered
  db().data.titles[imdbId] = { coll, at: Date.now() };
  db().save({ within: SAVE_WITHIN_MS });
  return coll;
};

// Sync, cache only: the collection of a film as far as this server knows.
const cachedFor = (imdbId) => {
  if (!store && !config.TMDB_KEY) return null; // (no key: the store was never needed)
  const t = db().data.titles[imdbId];
  if (!t || !t.coll) return null;
  return asFranchise(t.coll, db().data.colls[t.coll]);
};

const forTitle = async (imdbId, opts = {}) => {
  const id = await collectionIdFor(imdbId, opts);
  return id ? collection(id, opts) : null;
};

module.exports = { forTitle, collection, collectionIdFor, cachedFor, cleanName, _internals: { db, asFranchise, reset: () => { store = null; } } };
