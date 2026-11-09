// FRANCHISES — the curated list: one JSON file per franchise in ./list (not ./data: .gitignore keeps every data/ folder out of git).
//
// TMDB collections (media/franchises/tmdb.js) cover most film series, but
// they split the big shared universes (the MCU is a dozen TMDB collections and
// a pile of single films), they know nothing of the TV series that sit between
// the films, and a server without a TMDB key (this household's) has none of
// them at all. So the big ones are written down here, by hand, with their
// viewing orders, and every entry is checked against the catalogue:
//   tools/franchises/snapshot.js asks Cinemeta for every id and writes
//   test/fixtures/franchise-meta.json; test/franchises-data.test.js holds the
//   list to it (the id is that title, the TMDB id and year are right, nothing
//   twice, every order a full and consistent ordering).
//
// A FILE (list/<id>.json):
//   id          the file's name, [a-z0-9-]
//   name        "Marvel Cinematic Universe"
//   the         true → "Part of the Marvel Cinematic Universe" (false: "Part of Star Wars")
//   priority    a title in two franchises shows the higher one (MCU over Spider-Man)
//   entries     IN RELEASE ORDER: { imdbId, tmdbId, type: "movie"|"series", title, year,
//               date: "YYYY-MM-DD" (first release), optional?: true, note?: "…" }
//               optional = may be skipped (a series between the films, a spin-off):
//               it is listed on the franchise page, never counted ("12 of 34") and
//               never offered by the end card or Continue the franchise
//   story       (optional) every entry's imdbId in STORY / timeline order
//   tmdbCollections  the TMDB collection ids this franchise already covers, so a
//               film of one is shown under the curated franchise, not twice
//   sources     where the entries and the orders were checked (URLs / names)
//   notes       (optional) how the orders were decided
//
// Read once, at the first ask; the files ship with the server and change only
// with a release.
"use strict";
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "list");
const { ORDER_LABELS } = require("./logic");
const ORDERS = Object.keys(ORDER_LABELS);
const TYPES = new Set(["movie", "series"]);
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const IMDB_RE = /^tt\d{7,10}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const readAll = (dir = DATA_DIR) => {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const fr = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      out.push({ ...fr, _file: f });
    } catch (e) {
      out.push({ _file: f, _broken: e.message });
    }
  }
  return out;
};

// → [problem, …] ([] = all good). `fixture` (imdbId → { type, name, year,
// released, tmdbId }) is the catalogue snapshot; without one only the list's
// own shape and orders are checked.
const validate = (list, fixture = null) => {
  const problems = [];
  const say = (fr, msg) => problems.push(`${(fr && (fr.id || fr._file)) || "?"}: ${msg}`);
  const ids = new Set();
  for (const fr of list) {
    if (fr._broken) { say(fr, `not JSON (${fr._broken})`); continue; }
    if (!ID_RE.test(String(fr.id || ""))) say(fr, "id must be [a-z0-9-]");
    if (fr._file && fr._file !== `${fr.id}.json`) say(fr, `file name ${fr._file} is not ${fr.id}.json`);
    if (ids.has(fr.id)) say(fr, "franchise id used twice");
    ids.add(fr.id);
    if (!fr.name || typeof fr.name !== "string") say(fr, "no name");
    if (typeof fr.the !== "boolean") say(fr, "`the` must be true or false");
    if (!Number.isFinite(fr.priority)) say(fr, "priority must be a number");
    if (!Array.isArray(fr.sources) || !fr.sources.length || fr.sources.some((s) => typeof s !== "string" || !s.trim())) say(fr, "sources missing");
    if (fr.tmdbCollections != null && (!Array.isArray(fr.tmdbCollections) || fr.tmdbCollections.some((c) => !Number.isInteger(c) || c <= 0))) say(fr, "tmdbCollections must be positive integers");
    const entries = Array.isArray(fr.entries) ? fr.entries : [];
    if (entries.filter((e) => !e.optional).length < 2) say(fr, "fewer than two main entries");
    const seen = new Set();
    let lastDate = "";
    for (const e of entries) {
      const tag = `${e.imdbId} (${e.title})`;
      if (!IMDB_RE.test(String(e.imdbId || ""))) say(fr, `${tag}: bad IMDb id`);
      if (seen.has(e.imdbId)) say(fr, `${tag}: listed twice`);
      seen.add(e.imdbId);
      if (!TYPES.has(e.type)) say(fr, `${tag}: type must be movie or series`);
      if (!Number.isInteger(e.tmdbId) || e.tmdbId <= 0) say(fr, `${tag}: no TMDB id`);
      if (!e.title || typeof e.title !== "string") say(fr, `${tag}: no title`);
      if (!Number.isInteger(e.year)) say(fr, `${tag}: no year`);
      if (!DATE_RE.test(String(e.date || ""))) say(fr, `${tag}: date must be YYYY-MM-DD`);
      else {
        if (Number(e.date.slice(0, 4)) !== e.year) say(fr, `${tag}: date ${e.date} is not in ${e.year}`);
        if (e.date < lastDate) say(fr, `${tag}: entries must be in release order (${e.date} after ${lastDate})`);
        lastDate = e.date;
      }
      if (e.optional != null && typeof e.optional !== "boolean") say(fr, `${tag}: optional must be true/false`);
      if (fixture) {
        const m = fixture[e.imdbId];
        if (!m) say(fr, `${tag}: not in the catalogue snapshot (run tools/franchises/snapshot.js)`);
        else {
          if (m.type !== e.type) say(fr, `${tag}: the catalogue says ${m.type}`);
          if (m.name !== e.title) say(fr, `${tag}: the catalogue calls it "${m.name}"`);
          if (m.year !== e.year) say(fr, `${tag}: the catalogue says ${m.year}`);
          if (m.tmdbId && m.tmdbId !== e.tmdbId) say(fr, `${tag}: the catalogue's TMDB id is ${m.tmdbId}`);
        }
      }
    }
    if (fr.story != null) {
      if (!Array.isArray(fr.story)) say(fr, "story must be a list of IMDb ids");
      else {
        const s = new Set(fr.story);
        if (s.size !== fr.story.length) say(fr, "story order lists an id twice");
        for (const id of fr.story) if (!seen.has(id)) say(fr, `story order names ${id}, which is not an entry`);
        for (const id of seen) if (!s.has(id)) say(fr, `story order leaves out ${id}`);
        if (fr.story.join() === entries.map((e) => e.imdbId).join()) say(fr, "story order is the release order — leave it out");
      }
    }
  }
  return problems;
};

// Ready to use: every franchise with its orders as entry lists, and a title →
// franchises index. Broken files are left out (the data test fails on them).
const build = (list) => {
  const byId = new Map();
  const byTitle = new Map(); // imdbId -> [franchise, …] best first
  const byTmdbCollection = new Map(); // TMDB collection id -> franchise
  for (const raw of list) {
    if (raw._broken || !raw.id || !Array.isArray(raw.entries)) continue;
    const entries = raw.entries.map((e) => ({ ...e, optional: !!e.optional }));
    const at = new Map(entries.map((e) => [e.imdbId, e]));
    const orders = { release: entries };
    if (Array.isArray(raw.story) && raw.story.length === entries.length && raw.story.every((id) => at.has(id))) {
      orders.story = raw.story.map((id) => at.get(id));
    }
    const fr = {
      id: raw.id,
      name: raw.name,
      the: !!raw.the,
      priority: Number(raw.priority) || 0,
      source: "curated",
      entries,
      orders,
      tmdbCollections: raw.tmdbCollections || [],
      sources: raw.sources || [],
    };
    byId.set(fr.id, fr);
    for (const e of entries) {
      if (!byTitle.has(e.imdbId)) byTitle.set(e.imdbId, []);
      byTitle.get(e.imdbId).push(fr);
    }
    for (const c of fr.tmdbCollections) if (!byTmdbCollection.has(c)) byTmdbCollection.set(c, fr);
  }
  for (const arr of byTitle.values()) arr.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  return { byId, byTitle, byTmdbCollection, all: [...byId.values()] };
};

// The household's own additions and corrections: data/franchises/<id>.json on
// the server, the same shape (a file with a shipped franchise's id replaces
// it). Read with the shipped list; a broken local file is left out and said.
const localDir = () => path.join(require("../../config").DATA_DIR, "franchises");
const withLocal = () => {
  const shipped = readAll();
  let local = [];
  try { local = readAll(localDir()); } catch {}
  if (!local.length) return shipped;
  const mine = new Map();
  for (const fr of local) {
    if (fr._broken) { console.warn(`[franchises] ${fr._file} in data/franchises is not JSON: ${fr._broken}`); continue; }
    const problems = validate([fr]).filter((p) => !/file name/.test(p));
    if (problems.length) { console.warn(`[franchises] ${fr._file} in data/franchises left out: ${problems[0]}`); continue; }
    mine.set(fr.id, fr);
  }
  return [...shipped.filter((fr) => !mine.has(fr.id)), ...mine.values()];
};

let cache = null;
const catalogue = () => cache || (cache = build(withLocal()));
const _reset = (list = null) => { cache = list ? build(list) : null; };

module.exports = { catalogue, readAll, validate, build, ORDERS, ORDER_LABELS, DATA_DIR, localDir, _reset };
