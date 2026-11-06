// "Free up space" (admin → Downloads): the titles that are SAFE to remove,
// as a list the admin chooses from. Nothing here deletes by itself — the
// route (routes/admin.js, POST /api/admin/library/freeup/delete) removes only
// what the admin confirmed, through the same deletes as the On disk buttons,
// after checking each one is still on this list.
//
// Safe to remove means all of:
//   * somebody FINISHED it, and every profile that started it finished it
//     ("started" = finished, or more than 60 s in — the rule the rest of the
//     admin uses for part-way, media/freeup.js and media/copies.js);
//   * it is on nobody's My List (a show counts for its episodes);
//   * it has been in the library at least `days` days (the file's date);
//   * plus the EXTRA copies of a title held more than once (media/copies.js):
//     every copy but the one that stays (the one the app plays, else the
//     biggest) — the title itself never leaves the library this way.
// One being played right now is listed (so the admin sees why) but marked
// inUse: never counted, never deleted.
//
// The watch state is each profile's progress as the app shows it
// (profiles.getProgressView: the raw rows plus library ids filled in from the
// title history, so a film watched as a stream before it was downloaded
// counts as watched). My List is profiles.watchlistItems (a stream ref of a
// title the library holds resolves to that library id).
//
// safeTitles() and spareCopies() are pure (test/freespace.test.js);
// gather() reads the live library, profiles, copies and lib/inuse.js.
"use strict";

const DAY = 86400e3;
const GB = 1024 ** 3;
const STARTED_SEC = 60;
const DEFAULT_DAYS = 60;

const fmtGb = (b) => (b >= 100 * GB ? `${Math.round(b / GB)} GB` : b >= GB ? `${(b / GB).toFixed(1)} GB` : `${Math.max(0, Math.round(b / 1024 ** 2))} MB`);
const pad = (n) => String(n || 0).padStart(2, "0");

// "Dor", "Dor and jn", "Dor, jn and Niso", "A, B, C and 2 others"
const names = (list) => {
  const n = list.length;
  if (n <= 1) return list[0] || "";
  if (n <= 4) return `${list.slice(0, -1).join(", ")} and ${list[n - 1]}`;
  return `${list.slice(0, 3).join(", ")} and ${n - 3} others`;
};
const daysWord = (d) => (d === 1 ? "1 day" : `${d} days`);

// people: [{ id, name, progress: { itemId: { finished, position, updatedAt } }, list: Set<library id> }]
// → for one library id: { finishers: [names], midway: n, lastWatched }
const watchOf = (people, id) => {
  const finishers = [];
  let midway = 0;
  let lastWatched = 0;
  for (const p of people) {
    const pr = p.progress && p.progress[id];
    if (!pr) continue;
    if (pr.finished) {
      finishers.push(p.name);
      lastWatched = Math.max(lastWatched, pr.updatedAt || 0);
    } else if ((pr.position || 0) > STARTED_SEC) midway++;
  }
  return { finishers, midway, lastWatched };
};
const onListOf = (people, id) => people.filter((p) => p.list && p.list.has(id)).map((p) => p.name);

// The titles safe to remove, biggest first. Each row:
//   { key: "m:<id>" | "s:<showId>", kind: "movie" | "show", name, title, year?,
//     cover, ids: [library ids it removes], episodes?: [{ id, season, episode, sizeBytes, inUse }],
//     sizeBytes (what would be freed: not counting one being played),
//     watchedBy: [names], ageDays, lastWatched, inUse, why }
// A show's row holds its safe episodes only (each one checked on its own);
// the show folder goes only if every episode in it does.
const safeTitles = ({ movies = [], shows = [], people = [], now = Date.now(), days = DEFAULT_DAYS } = {}) => {
  const minAge = Math.max(0, days) * DAY;
  const oldEnough = (addedAt) => addedAt > 0 && now - addedAt >= minAge;
  const ageDays = (addedAt) => Math.max(0, Math.floor((now - addedAt) / DAY));
  const rows = [];
  for (const m of movies) {
    if (!(m.sizeBytes > 0) || !oldEnough(m.addedAt)) continue;
    const w = watchOf(people, m.id);
    if (!w.finishers.length || w.midway) continue;
    if (onListOf(people, m.id).length) continue;
    const age = ageDays(m.addedAt);
    const inUse = !!m.streaming;
    rows.push({
      key: `m:${m.id}`, kind: "movie", name: m.title + (m.year ? ` (${m.year})` : ""), title: m.title, year: m.year || null,
      cover: m.cover || null, ids: [m.id], sizeBytes: inUse ? 0 : m.sizeBytes, fileBytes: m.sizeBytes,
      watchedBy: w.finishers.slice().sort((a, b) => a.localeCompare(b)), ageDays: age, lastWatched: w.lastWatched, inUse,
      why: `watched by ${names(w.finishers.slice().sort((a, b) => a.localeCompare(b)))}, nobody's My List, ${daysWord(age)} old`,
    });
  }
  for (const s of shows) {
    if (onListOf(people, s.id).length) continue;
    const eps = [];
    const who = new Set();
    let last = 0;
    for (const se of s.seasons || []) for (const e of se.episodes || []) {
      if (!(e.sizeBytes > 0) || !oldEnough(e.addedAt)) continue;
      const w = watchOf(people, e.id);
      if (!w.finishers.length || w.midway) continue;
      if (onListOf(people, e.id).length) continue;
      w.finishers.forEach((n) => who.add(n));
      last = Math.max(last, w.lastWatched);
      eps.push({ id: e.id, season: e.season, episode: e.episode, title: e.title || null, sizeBytes: e.sizeBytes, inUse: !!e.streaming, ageDays: ageDays(e.addedAt) });
    }
    if (!eps.length) continue;
    eps.sort((a, b) => a.season - b.season || a.episode - b.episode);
    const free = eps.filter((e) => !e.inUse);
    const watchedBy = [...who].sort((a, b) => a.localeCompare(b));
    const minAgeDays = Math.min(...eps.map((e) => e.ageDays));
    const first = eps[0];
    const lastEp = eps[eps.length - 1];
    const span = eps.length === 1 ? `S${pad(first.season)}E${pad(first.episode)}` : `S${pad(first.season)}E${pad(first.episode)}–S${pad(lastEp.season)}E${pad(lastEp.episode)}`;
    rows.push({
      key: `s:${s.id}`, kind: "show", name: s.title, title: s.title, year: s.year || null, cover: s.cover || null,
      ids: free.map((e) => e.id), episodes: eps,
      sizeBytes: free.reduce((n, e) => n + e.sizeBytes, 0), fileBytes: eps.reduce((n, e) => n + e.sizeBytes, 0),
      watchedBy, ageDays: minAgeDays, lastWatched: last, inUse: free.length === 0,
      why: `${eps.length === 1 ? "1 episode" : `${eps.length} episodes`} (${span}) watched by ${names(watchedBy)}, nobody's My List, ${eps.length > 1 ? `${minAgeDays}+ days` : daysWord(minAgeDays)} old`,
    });
  }
  rows.sort((a, b) => b.sizeBytes - a.sizeBytes || a.name.localeCompare(b.name));
  return rows;
};

// The extra copies from media/copies.js view() groups: every copy of a title
// held more than once except the first (copies.js sorts the one the app plays
// first, then the biggest). A title already offered whole above (skipIds: its
// library ids) is left out — removing it takes every copy anyway.
//   → [{ key: "c:<ref>", kind: "copy", ref, name, quality, sizeBytes, keeps, inUse, why }]
const height = (q) => parseInt(String(q || "").replace(/\D/g, ""), 10) || 0;
const spareCopies = (groups = [], skipIds = new Set()) => {
  const rows = [];
  for (const g of groups) {
    const copies = g.copies || [];
    if (copies.length < 2) continue;
    if (copies.some((c) => c.libraryId && skipIds.has(c.libraryId))) continue;
    const keep = copies[0];
    const name = g.kind === "episode"
      ? `${g.title} S${pad(g.season)}E${pad(g.episode)}`
      : g.title + (g.year ? ` (${g.year})` : "");
    const keepWord = `the ${keep.quality ? keep.quality + " " : ""}copy (${fmtGb(keep.sizeBytes || 0)})`;
    for (const c of copies.slice(1)) {
      if (!c.ref || !(c.sizeBytes > 0)) continue;
      const inUse = !!c.streaming;
      rows.push({
        key: `c:${c.ref}`, kind: "copy", ref: c.ref, name, cover: g.cover || null, quality: c.quality || null, fileName: c.fileName || null,
        sizeBytes: inUse ? 0 : c.sizeBytes, fileBytes: c.sizeBytes, inUse,
        keeps: keepWord,
        why: `an extra ${c.quality ? c.quality + " " : ""}copy — ${keepWord} stays${keep.indexed ? " and is the one the app plays" : ""}${height(c.quality) > height(keep.quality) ? " (this one is the sharper copy: to keep it instead, use More than one copy)" : ""}`,
      });
    }
  }
  rows.sort((a, b) => b.sizeBytes - a.sizeBytes || a.name.localeCompare(b.name));
  return rows;
};

const totalsOf = (rows) => ({
  count: rows.filter((r) => !r.inUse).length,
  bytes: rows.reduce((n, r) => n + (r.inUse ? 0 : r.sizeBytes), 0),
});

// The days asked for: a whole number 0–3650, else the default.
const cleanDays = (v) => {
  if (v == null || v === "") return DEFAULT_DAYS;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 3650 ? Math.floor(n) : DEFAULT_DAYS;
};

// The live answer: { days, safe, duplicates, totals: { safe, duplicates, all } }.
const gather = ({ days = DEFAULT_DAYS, now = Date.now() } = {}) => {
  const scanner = require("./scanner");
  const profiles = require("../profiles");
  const inuse = require("../lib/inuse");
  days = cleanDays(days);
  const people = profiles.list().map((p) => {
    let progress = {};
    let list = new Set();
    try { progress = profiles.getProgressView(p.id) || {}; } catch {}
    try { list = new Set((profiles.watchlistItems(p.id) || []).map((c) => c && c.id).filter(Boolean)); } catch {}
    return { id: p.id, name: p.name, progress, list };
  });
  const movies = scanner.index.movies.map((m) => ({
    id: m.id, title: m.title, year: m.year, cover: m.cover || null, addedAt: m.addedAt || 0, sizeBytes: m.sizeBytes || 0,
    streaming: inuse.streamingNow(m.id),
  }));
  const shows = scanner.index.shows.map((s) => ({
    id: s.id, title: s.title, year: s.year, cover: s.cover || null,
    seasons: (s.seasons || []).map((se) => ({
      episodes: (se.episodes || []).map((e) => ({
        id: e.id, season: e.season, episode: e.episode, title: e.title, addedAt: e.addedAt || 0, sizeBytes: e.sizeBytes || 0,
        streaming: inuse.streamingNow(e.id),
      })),
    })),
  }));
  const safe = safeTitles({ movies, shows, people, now, days });
  let groups = [];
  try { groups = require("./copies").view(); } catch (e) {
    console.warn("[freespace] copies view failed:", e && e.message ? e.message : e);
  }
  const skip = new Set(safe.filter((r) => r.kind === "movie").flatMap((r) => r.ids));
  const duplicates = spareCopies(groups, skip);
  const a = totalsOf(safe);
  const b = totalsOf(duplicates);
  return { days, safe, duplicates, totals: { safe: a, duplicates: b, all: { count: a.count + b.count, bytes: a.bytes + b.bytes } } };
};

module.exports = { safeTitles, spareCopies, gather, cleanDays, names, totalsOf, DEFAULT_DAYS, STARTED_SEC };
