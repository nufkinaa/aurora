// "Running low? Free N GB → Suggest what to delete" (admin → Downloads → On
// disk). The admin is shown the suggestions as a list to tick and untick
// (elia 2026-10-26: "a place to SELECT what to delete from the suggestions"),
// and only what stays ticked is deleted.
//
// What is a suggestion (the rules the page used to apply by itself):
//   * a STALE My List download — fetched because a title was added to a
//     list, not watched by anybody in the weeks since. Nobody asked for the
//     file itself, so these come first (the oldest add first);
//   * a film or an episode somebody FINISHED, with nobody part-way through
//     it — the longest-ago watched first, the bigger first on a tie.
// A file somebody is playing right now is still listed (so the admin sees
// why it is not offered) but marked inUse, never counted, never deleted.
//
// The same rules answer the delete: an id is deleted only while it is still
// a suggestion and nobody is playing it (routes/admin.js).
const scanner = require("./scanner");
const profiles = require("../profiles");
const inuse = require("../lib/inuse");

// The library as a deletable tree: movies and shows → seasons → episodes,
// every row with its size on disk and the numbers that answer "is it safe to
// delete" — watched: how many profiles FINISHED it; midway: how many are
// PART-WAY through it (deleting it would take it from under them);
// lastWatched: when it was last finished; streaming: somebody is playing it
// right now; mylist: a copy the removed My List downloads fetched that nobody
// has watched yet ({ state: "fresh" | "stale", why, by, addedAt, staleAt,
// deleteAt } — media/mylistdl.js).
const tree = () => {
  const watchedBy = new Map();
  const midway = new Map();
  const lastWatched = new Map();
  for (const p of profiles.list()) {
    const prog = profiles.getProgress(p.id) || {};
    for (const [itemId, pr] of Object.entries(prog)) {
      if (!pr) continue;
      if (pr.finished) {
        watchedBy.set(itemId, (watchedBy.get(itemId) || 0) + 1);
        lastWatched.set(itemId, Math.max(lastWatched.get(itemId) || 0, pr.updatedAt || 0));
      } else if ((pr.position || 0) > 60) midway.set(itemId, (midway.get(itemId) || 0) + 1);
    }
  }
  let marks = new Map();
  try { marks = require("./mylistdl").libraryMarks(); } catch (e) {
    console.warn("[mylist] pass failed:", e && e.message ? e.message : e);
  }
  const movies = scanner.index.movies.map((m) => ({
    id: m.id,
    title: m.title,
    year: m.year,
    cover: m.cover || null,
    addedAt: m.addedAt || 0,
    mylist: marks.get(m.id) || null,
    watched: watchedBy.get(m.id) || 0,
    midway: midway.get(m.id) || 0,
    streaming: inuse.streamingNow(m.id),
    lastWatched: lastWatched.get(m.id) || 0,
    sizeBytes: m.sizeBytes || 0,
  }));
  const shows = scanner.index.shows.map((s) => {
    const seasons = (s.seasons || []).map((se) => ({
      season: se.number,
      sizeBytes: (se.episodes || []).reduce((n, e) => n + (e.sizeBytes || 0), 0),
      episodes: (se.episodes || []).map((e) => ({
        id: e.id,
        season: e.season,
        episode: e.episode,
        title: e.title,
        fileName: e.fileName,
        addedAt: e.addedAt || 0,
        mylist: marks.get(e.id) || null,
        watched: watchedBy.get(e.id) || 0,
        midway: midway.get(e.id) || 0,
        streaming: inuse.streamingNow(e.id),
        lastWatched: lastWatched.get(e.id) || 0,
        sizeBytes: e.sizeBytes || 0,
      })),
    }));
    return {
      id: s.id,
      title: s.title,
      cover: s.cover || null,
      addedAt: s.addedAt || 0,
      sizeBytes: seasons.reduce((n, se) => n + se.sizeBytes, 0),
      seasons,
    };
  });
  return { movies, shows };
};

const DAY = 86400e3;
// "3 weeks ago" — how long ago something was last finished, in the words the page uses.
const agoText = (t, now = Date.now()) => {
  if (!t) return "";
  const d = Math.floor((now - t) / DAY);
  if (d < 1) return "today";
  if (d < 2) return "yesterday";
  if (d < 14) return `${d} days ago`;
  if (d < 60) return `${Math.floor(d / 7)} weeks ago`;
  if (d < 365) return `${Math.floor(d / 30)} months ago`;
  const y = Math.floor(d / 365);
  return y === 1 ? "over a year ago" : `over ${y} years ago`;
};
const people = (n) => (n === 1 ? "1 person" : `${n} people`);
const pad = (n) => String(n || 0).padStart(2, "0");

// Every suggestion, in the order they are offered. Each: { id, kind: "movie" |
// "episode", name, title, year?, cover, show?: { id, title, cover }, season?,
// episode?, sizeBytes, reason: "mylist" | "finished", why, inUse }.
const candidates = (t, now = Date.now()) => {
  const stale = [];
  const done = [];
  const isStale = (x) => x.mylist && x.mylist.state === "stale" && !x.midway && !x.watched && x.sizeBytes > 0;
  const isDone = (x) => x.watched > 0 && !x.midway && x.sizeBytes > 0;
  const add = (x, base) => {
    const inUse = !!x.streaming;
    if (isStale(x)) {
      stale.push({ ...base, reason: "mylist", why: `My List download — ${x.mylist.why}`, inUse, addedAt: x.mylist.addedAt || 0 });
    } else if (isDone(x)) {
      const last = agoText(x.lastWatched, now);
      done.push({ ...base, reason: "finished", why: `Finished by ${people(x.watched)}${last ? `, last watched ${last}` : ""} · nobody is part-way through`, inUse, lastWatched: x.lastWatched || 0 });
    }
  };
  for (const m of t.movies || []) {
    add(m, { id: m.id, kind: "movie", name: m.title + (m.year ? ` (${m.year})` : ""), title: m.title, year: m.year || null, cover: m.cover || null, sizeBytes: m.sizeBytes });
  }
  for (const s of t.shows || []) for (const se of s.seasons || []) for (const e of se.episodes || []) {
    add(e, {
      id: e.id, kind: "episode", name: `${s.title} S${pad(e.season)}E${pad(e.episode)}`, title: e.title || e.fileName || "",
      cover: s.cover || null, show: { id: s.id, title: s.title, cover: s.cover || null }, season: e.season, episode: e.episode,
      sizeBytes: e.sizeBytes,
    });
  }
  stale.sort((a, b) => a.addedAt - b.addedAt);
  done.sort((a, b) => a.lastWatched - b.lastWatched || b.sizeBytes - a.sizeBytes);
  return [...stale, ...done];
};

// Just enough of them, in order, to reach `targetBytes`. One being played
// right now is listed where it falls, as inUse, and does not count.
const suggest = (t, targetBytes, now = Date.now()) => {
  const all = candidates(t, now);
  const items = [];
  let totalBytes = 0;
  for (const c of all) {
    if (totalBytes >= targetBytes) break;
    items.push(c);
    if (!c.inUse) totalBytes += c.sizeBytes;
  }
  const availableBytes = all.reduce((n, c) => n + (c.inUse ? 0 : c.sizeBytes), 0);
  return { items, totalBytes, targetBytes, short: totalBytes < targetBytes, availableBytes, available: all.filter((c) => !c.inUse).length };
};

// What a library id is, when it is not (or no longer) a suggestion: its name, or null.
const nameOf = (t, id) => {
  const m = (t.movies || []).find((x) => x.id === id);
  if (m) return m.title + (m.year ? ` (${m.year})` : "");
  for (const s of t.shows || []) for (const se of s.seasons || []) for (const e of se.episodes || []) {
    if (e.id === id) return `${s.title} S${pad(e.season)}E${pad(e.episode)}`;
  }
  return null;
};

module.exports = { tree, candidates, suggest, nameOf, agoText };
