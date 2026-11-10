// What Aurora knows about one person's own viewing, for the remark. The rules
// are PURE (factsFrom); factsFor gathers the inputs from memory — the watch
// sessions, the profile's stored state, the library index, the downloads list —
// and keeps the answer per profile for CACHE_MS, so a visit to Home never
// scans the history.
"use strict";

const DAY = 86400000;
const CACHE_MS = 5 * 60 * 1000;

// Library genre names → the word a line can use ("Mostly {genre} lately").
const GENRE_WORD = {
  horror: "horror", comedy: "comedy", drama: "drama", action: "action", animation: "animation",
  documentary: "documentaries", thriller: "thrillers", crime: "crime", "science fiction": "sci-fi",
  "sci-fi": "sci-fi", fantasy: "fantasy", romance: "romance", reality: "reality TV", mystery: "mystery",
  adventure: "adventure", war: "war films", western: "westerns", anime: "anime", "reality-tv": "reality TV",
};

const SHOW_RE = /\s*·\s*S\d+\s*E\d+.*$/i;
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// in: { now, tzo, sessions: [{ startedAt, watchedSec, content, device }] (this
//   person's only), progress: { itemId: row }, titles: { key: row },
//   myList, ratings: { id: stars }, findById, nextEpisode, genresOf(title),
//   jobs: [raw download jobs of this person], idForPath, newEpisode }
const factsFrom = (inp) => {
  const now = inp.now;
  const tzo = inp.tzo || 0;
  const localMs = (ms) => ms - tzo * 60000;
  const dayKey = (ms) => new Date(localMs(ms)).toISOString().slice(0, 10);
  const hourOf = (ms) => new Date(localMs(ms)).getUTCHours();
  const f = {};
  const sessions = (inp.sessions || []).filter((s) => s && s.watchedSec > 0 && s.startedAt);
  const progress = inp.progress || {};

  f.firstVisit = !sessions.length && !Object.keys(progress).length;

  // --- the sessions ---
  let lastEnd = 0;
  let lastSec = 0;
  const byDay = new Map();
  const today = dayKey(now);
  const yesterday = dayKey(now - DAY);
  let recent30 = 0, late30 = 0, phone30 = 0;
  let recent21 = 0, short21 = 0;
  const show21 = new Map();
  const titleSec60 = new Map();
  let lateLastNight = false;
  for (const s of sessions) {
    const start = Date.parse(s.startedAt);
    if (!Number.isFinite(start)) continue;
    const end = start + s.watchedSec * 1000;
    if (end > lastEnd) { lastEnd = end; lastSec = s.watchedSec; }
    const age = now - start;
    if (age < 0) continue;
    if (age < 62 * DAY) byDay.set(dayKey(start), (byDay.get(dayKey(start)) || 0) + s.watchedSec);
    const h = hourOf(start);
    if (age < 30 * DAY) {
      recent30++;
      if (h < 5) late30++;
      if (s.device && s.device.device === "Mobile") phone30++;
    }
    if (age < 21 * DAY) {
      recent21++;
      if (s.watchedSec < 600) short21++;
      const content = String(s.content || "");
      if (SHOW_RE.test(content)) {
        const show = content.replace(SHOW_RE, "").trim();
        const cur = show21.get(show) || { sec: 0, n: 0 };
        show21.set(show, { sec: cur.sec + s.watchedSec, n: cur.n + 1 });
      }
    }
    if (age < 60 * DAY) {
      const title = String(s.content || "").replace(SHOW_RE, "").trim();
      titleSec60.set(title, (titleSec60.get(title) || 0) + s.watchedSec);
    }
    // last night: started (or still going) between midnight and 5 today
    if (dayKey(start) === today && h < 5) lateLastNight = true;
    if (dayKey(end) === today && hourOf(end) >= 1 && hourOf(end) < 5 && age < 30 * 3600000) lateLastNight = true;
  }
  if (lastEnd) {
    f.awayMs = Math.max(0, now - lastEnd);
    f.justBack = now - lastEnd < 30 * 60000 && lastSec >= 20 * 60;
  }
  f.lateLastNight = lateLastNight;
  f.todayHours = Math.floor((byDay.get(today) || 0) / 3600);
  f.playedToday = (byDay.get(today) || 0) > 0;
  f.yesterdayHours = Math.floor((byDay.get(yesterday) || 0) / 3600);
  // days in a row with 10+ minutes, up to today (or yesterday, if today has none yet)
  let streak = 0;
  for (let d = (byDay.get(today) || 0) >= 600 ? 0 : 1; d < 62; d++) {
    if ((byDay.get(dayKey(now - d * DAY)) || 0) >= 600) streak++;
    else break;
  }
  f.streak = streak;
  f.nightOwl = recent30 >= 6 && late30 / recent30 >= 0.4;
  f.phoneMostly = recent30 >= 6 && phone30 / recent30 >= 0.7;
  f.sampler = recent21 >= 8 && short21 / recent21 >= 0.6;
  const showSec = [...show21.values()].reduce((a, b) => a + b.sec, 0);
  let topShow = null;
  for (const [name, v] of show21) if (!topShow || v.sec > topShow.sec) topShow = { name, ...v };
  const allSec21 = sessions.filter((s) => now - Date.parse(s.startedAt) < 21 * DAY).reduce((a, s) => a + s.watchedSec, 0);
  if (topShow && topShow.n >= 6 && allSec21 > 0 && topShow.sec / allSec21 >= 0.6 && showSec > 0) f.oneShow = topShow.name;

  // one-genre diet over 60 days (4+ hours of attributed viewing)
  if (inp.genresOf) {
    const g = new Map();
    let attributed = 0;
    for (const [title, sec] of titleSec60) {
      const gs = inp.genresOf(title) || [];
      if (!gs.length) continue;
      attributed += sec;
      for (const name of gs) g.set(String(name).toLowerCase(), (g.get(String(name).toLowerCase()) || 0) + sec);
    }
    let top = null;
    for (const [name, sec] of g) if (!top || sec > top.sec) top = { name, sec };
    if (top && attributed >= 4 * 3600 && top.sec / attributed >= 0.55 && GENRE_WORD[top.name]) f.genre = GENRE_WORD[top.name];
  }

  // --- the profile's own state ---
  f.myList = inp.myList || 0;
  const stars = Object.values(inp.ratings || {}).map(Number).filter((n) => n >= 1 && n <= 5);
  if (stars.length >= 6) {
    const avg = stars.reduce((a, b) => a + b, 0) / stars.length;
    if (avg <= 2.3) f.ratings = "harsh";
    else if (stars.length >= 8 && avg >= 4.6) f.ratings = "generous";
  }

  // shows, from the progress rows of library episodes
  const findById = inp.findById || (() => null);
  const latestByShow = new Map();
  const watchedIds = new Set();
  const watchedShows = new Set();
  for (const [itemId, row] of Object.entries(progress)) {
    if (!row) continue;
    watchedIds.add(itemId);
    let item = null;
    try { item = findById(itemId); } catch {}
    if (!item || !item.showId) continue;
    watchedShows.add(item.showId);
    const cur = latestByShow.get(item.showId);
    if (!cur || (row.updatedAt || 0) > (cur.row.updatedAt || 0)) latestByShow.set(item.showId, { itemId, row, title: item.showTitle });
  }
  let finished = null, left = null;
  for (const [showId, v] of latestByShow) {
    const age = now - (v.row.updatedAt || 0);
    if (!v.title || v.row.marked) continue;
    let more = true;
    if (v.row.finished) { try { more = !!(inp.nextEpisode && inp.nextEpisode(showId, v.itemId)); } catch { more = true; } }
    if (v.row.finished && !more && age < 4 * DAY) { if (!finished || age < finished.age) finished = { title: v.title, age }; }
    if (more && age >= 14 * DAY && age < 120 * DAY) { if (!left || age < left.age) left = { title: v.title, age }; }
  }
  if (finished) f.finishedSeries = finished.title;
  if (left && (f.awayMs == null || f.awayMs < 10 * DAY)) f.leftShow = left.title;

  // a title come back to (rewatch count on the title rows), lately
  let rewatch = null;
  for (const row of Object.values(inp.titles || {})) {
    if (!row || !(row.plays >= 2) || now - (row.updatedAt || 0) > 21 * DAY) continue;
    let item = null;
    try { item = findById(row.itemId); } catch {}
    const title = item && (item.showTitle || item.title);
    if (title && (!rewatch || row.plays > rewatch.n - 1)) rewatch = { title, n: row.plays + 1 };
  }
  if (rewatch) f.rewatch = rewatch;

  // downloads this person asked for, landed 2–45 days ago, never played
  let unwatched = 0;
  for (const j of inp.jobs || []) {
    if (!j || j.status !== "done" || j.smart || !j.destPath) continue;
    const at = Date.parse(j.doneAt);
    if (!Number.isFinite(at) || now - at < 2 * DAY || now - at > 45 * DAY) continue;
    let id = null;
    try { id = inp.idForPath ? inp.idForPath(j.destPath) : null; } catch {}
    if (!id) continue;
    if (watchedIds.has(id) || watchedShows.has(id)) continue;
    let item = null;
    try { item = findById(id); } catch {}
    if (item && item.showId && watchedShows.has(item.showId)) continue;
    unwatched++;
  }
  f.unwatchedDownloads = unwatched;
  if (inp.newEpisode) f.newEpisode = inp.newEpisode;
  return f;
};

// ---------- gathering (impure), cached per profile ----------
const cache = new Map();
let genreIndex = null;

const genresOfFactory = (scanner) => {
  if (!genreIndex || Date.now() - genreIndex.at > 10 * 60 * 1000) {
    const map = new Map();
    for (const item of scanner.allItems()) map.set(norm(item.title), item.genres || []);
    genreIndex = { at: Date.now(), map };
  }
  const map = genreIndex.map;
  return (title) => map.get(norm(title)) || [];
};

const gather = (profile, now, tzo) => {
  const telemetry = require("../../telemetry");
  const profiles = require("../../profiles");
  const scanner = require("../../media/scanner");
  const id = profile.id;
  const safe = (fn, dflt) => { try { return fn(); } catch { return dflt; } };
  const sessions = safe(() => telemetry.sessions.data.filter((s) => s.profile === profile.name), []);
  const state = safe(() => profiles.stateOf(id), {}) || {};
  const watchlist = safe(() => profiles.getWatchlist(id), []) || [];
  const ratings = state.ratings || {};
  const jobs = safe(() => require("../../media/downloads").rawJobs()
    .filter((j) => j.profile === id || j.profile === profile.name), []);
  const newEpisode = safe(() => {
    const catalogue = new Map();
    for (const item of scanner.allItems()) {
      if (item.id) catalogue.set(item.id, item);
      if (item.imdbId) catalogue.set(item.imdbId, item);
    }
    const rows = require("../../media/newEpisodes").select({
      watchlist, ratings, catalogue,
      progress: profiles.getProgressView(id),
      streamItems: profiles.getStreamItems(id),
      now,
    });
    return rows[0] && rows[0].title ? rows[0].title : null;
  }, null);
  return factsFrom({
    now, tzo, sessions,
    progress: state.progress || {},
    titles: state.titles || {},
    myList: watchlist.length,
    ratings,
    findById: scanner.findById,
    nextEpisode: profiles.nextEpisode,
    genresOf: safe(() => genresOfFactory(scanner), null),
    jobs,
    idForPath: scanner.idForPath,
    newEpisode,
  });
};

const factsFor = (profile, { now = Date.now(), tzo = 0 } = {}) => {
  const key = `${profile.id}|${tzo}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS && now >= hit.at) return hit.facts;
  const facts = gather(profile, now, tzo);
  cache.set(key, { at: now, facts });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return facts;
};

const _reset = () => { cache.clear(); genreIndex = null; };

module.exports = { factsFrom, factsFor, GENRE_WORD, CACHE_MS, _reset };
