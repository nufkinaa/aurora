#!/usr/bin/env node
// What a save of a JSON store costs as the household's history grows.
//
//   node tools/capacity/store-bench.js
//
// The server keeps each store whole in memory and writes the WHOLE file on
// every save (src/lib/jsonstore.js: JSON.stringify + writeFileSync + rename,
// debounced 1.5 s, all on the event loop). While anybody is watching,
// profiles.json and watch-sessions.json are saved every 5 s per viewer
// (collapsed by the debounce to at most one write per 1.5 s each), and
// telemetry-hours.json every 30 s whether anybody is watching or not.
//
// This times exactly that write — with the server's own JsonStore class — for
// stores shaped like the real ones at several sizes, and says how long the
// event loop stands still per save and how many bytes go to disk per hour of
// viewing. It also times the boot-time read (JSON.parse of the file) and the
// usage log's boot replay.
const fs = require("fs");
const path = require("path");
const { REPO, WORK, round, saveJson, median } = require("./lib");
const { JsonStore } = require(path.join(REPO, "src/lib/jsonstore"));

const DIR = path.join(WORK, "stores");
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

const rid = (i) => (0x100000000000 + i * 7919).toString(16).slice(0, 12);
// profiles.json: per profile a progress row per thing played, a title row beside it, some stream metas, a watchlist
const profilesStore = (profiles, played) => {
  const state = {};
  const list = [];
  for (let p = 0; p < profiles; p++) {
    const id = `p${p}`;
    list.push({ id, name: `Viewer ${p}`, color: "#e05f2c", avatar: "🍿", passwordHash: "x".repeat(128), salt: "y".repeat(32), prefs: { smartDownloads: true }, rows: null });
    const s = (state[id] = { progress: {}, watchlist: [], ratings: {}, likedGenres: ["Drama", "Comedy"], streamItems: {}, upNextDismissed: {}, titles: {} });
    for (let k = 0; k < played; k++) {
      const row = { position: 1200 + k, duration: 2700, finished: k % 3 === 0, updatedAt: 1790000000000 + k * 1000 };
      if (k % 4 === 0) {
        const key = `torrent|${"a".repeat(40)}|${k}`;
        s.progress[key] = row;
        s.streamItems[key] = { title: `Some Show S01E${k}`, imdbId: `tt${1000000 + k}`, season: 1, episode: k, poster: `https://images.metahub.space/poster/small/tt${1000000 + k}/img`, type: "show", sources: [{ infoHash: "a".repeat(40), fileIdx: k, quality: "1080p" }] };
      } else s.progress[rid(k)] = row;
      s.titles[`tt${1000000 + k}:1:${k}`] = { ...row, itemId: rid(k) };
      if (k % 10 === 0) s.ratings[rid(k)] = 4;
      if (k % 25 === 0) s.watchlist.push({ stream: true, imdbId: `tt${1000000 + k}`, type: "movie", title: "A Watchlist Title", poster: "https://images.metahub.space/poster/small/tt/img", year: 2020 });
    }
  }
  return { profiles: list, state, pending: [], access: {} };
};
// watch-sessions.json: one row per viewing session (capped at 8000 by telemetry.js)
const sessionsStore = (n) => Array.from({ length: n }, (_, i) => ({ id: rid(i), clientId: rid(i + 1), profile: "Viewer 1", ip: "192.168.1.23", device: { browser: "Chrome", os: "Android", device: "Mobile" }, content: "Some Show - S01E05 - A Reasonable Episode Title", startedAt: "2026-10-10T18:00:00.000Z", updatedAt: "2026-10-10T18:42:00.000Z", endedAt: "2026-10-10T18:42:00.000Z", watchedSec: 2520, position: 2520, duration: 2700, live: false }));
// telemetry-hours.json: 90 days x 24 hours
const hoursStore = () => { const o = {}; for (let i = 0; i < 90 * 24; i++) o[`2026-07-${String(i).padStart(5, "0")}`] = { samples: 120, maxClients: 4, sumClients: 310, maxWatching: 2, sumWatching: 130, downKB: 0 }; return o; };

const timeSave = (name, data) => {
  const file = path.join(DIR, `${name}.json`);
  const store = new JsonStore(file, () => data);
  store.data = data;
  const all = [], str = [];
  for (let i = 0; i < 9; i++) {
    const t0 = process.hrtime.bigint();
    JSON.stringify(store.data);
    const t1 = process.hrtime.bigint();
    store._writeNow(); // stringify again + writeFileSync + renameSync — what the debounce timer runs
    const t2 = process.hrtime.bigint();
    str.push(Number(t1 - t0) / 1e6);
    all.push(Number(t2 - t1) / 1e6);
  }
  const bytes = fs.statSync(file).size;
  const t0 = process.hrtime.bigint();
  JSON.parse(fs.readFileSync(file, "utf8"));
  const parseMs = Number(process.hrtime.bigint() - t0) / 1e6;
  return { bytes, saveMs: median(all), stringifyMs: median(str), parseMs };
};

const rows = [];
const add = (label, store, savesPerHourWatching, note) => {
  const r = timeSave(label.replace(/[^a-z0-9]+/gi, "-"), store);
  rows.push({
    store: label, sizeKb: Math.round(r.bytes / 1024), loopBlockedMsPerSave: round(r.saveMs, 2), ofWhichStringifyMs: round(r.stringifyMs, 2), bootParseMs: round(r.parseMs, 2),
    savesPerHour: savesPerHourWatching, mbWrittenPerHour: round((r.bytes * savesPerHourWatching) / 1048576, 0), loopBlockedSecPerHour: round((r.saveMs * savesPerHourWatching) / 1000, 1), note,
  });
};
// one viewer -> a save every 5 s (720/h); four or more viewers out of step -> the debounce's ceiling, one per 1.5 s (2400/h)
add("profiles.json — today's size class (5 profiles x 150 played)", profilesStore(5, 150), 720, "1 viewer");
add("profiles.json — a year on (8 profiles x 1500 played)", profilesStore(8, 1500), 2400, "4+ viewers");
add("profiles.json — big household (20 profiles x 3000 played)", profilesStore(20, 3000), 2400, "4+ viewers");
add("profiles.json — far end (50 profiles x 5000 played)", profilesStore(50, 5000), 2400, "4+ viewers");
add("watch-sessions.json — today (300 sessions)", sessionsStore(300), 720, "1 viewer");
add("watch-sessions.json — at its cap (8000 sessions)", sessionsStore(8000), 2400, "4+ viewers");
add("telemetry-hours.json — 90 days (its cap)", hoursStore(), 120, "always, viewers or not");

// The usage log: appended (cheap), but replayed in full at every boot, synchronously.
{
  const file = path.join(DIR, "events.jsonl");
  const line = JSON.stringify({ profile: "p1", sid: "abcdef12", device: "tv", look: "tv", events: Array.from({ length: 8 }, (_, i) => ({ n: "route", t: 1790000000000 + i, p: { r: "home", ms: 321 } })) }) + "\n";
  const target = 30 * 1024 * 1024; // the cap per month (lib/usage.js)
  const fd = fs.openSync(file, "w");
  const chunk = line.repeat(1000);
  for (let w = 0; w < target; w += chunk.length) fs.writeSync(fd, chunk);
  fs.closeSync(fd);
  const usage = require(path.join(REPO, "src/lib/usage"));
  const t0 = process.hrtime.bigint();
  const raw = fs.readFileSync(file, "utf8");
  let n = 0;
  for (const l of raw.split("\n")) { if (!l) continue; try { const b = JSON.parse(l); if (b && Array.isArray(b.events)) { usage.record(b, { persist: false }); n++; } } catch {} }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  rows.push({ store: "usage/events-<month>.jsonl at its 30 MB cap — replay at boot", sizeKb: Math.round(fs.statSync(file).size / 1024), loopBlockedMsPerSave: null, bootParseMs: round(ms, 0), note: `${n} batches re-applied on the event loop before the server answers` });
  const heap = process.memoryUsage();
  rows.push({ store: "…process memory after that replay", sizeKb: null, note: `heapUsed ${Math.round(heap.heapUsed / 1048576)} MB, rss ${Math.round(heap.rss / 1048576)} MB` });
}

for (const r of rows) console.log(`${r.store}\n    ${r.sizeKb ?? "-"} KB · loop blocked ${r.loopBlockedMsPerSave ?? "-"} ms/save (stringify ${r.ofWhichStringifyMs ?? "-"}) · boot parse ${r.bootParseMs ?? "-"} ms · ${r.savesPerHour ?? "-"} saves/h (${r.note}) -> ${r.mbWrittenPerHour ?? "-"} MB written/h, loop blocked ${r.loopBlockedSecPerHour ?? "-"} s/h`);
console.log("\nsaved", saveJson("store-bench.json", { when: new Date().toISOString(), disk: "this machine's system SSD (NVMe) — a hard disk adds a seek and a slower write to every save", rows }));
fs.rmSync(DIR, { recursive: true, force: true });
