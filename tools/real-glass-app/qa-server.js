#!/usr/bin/env node
// The phone app's QA server for the glass sweep: the mobile-perf instance
// (tools/mobile-perf/instance.js — a private throwaway Aurora with ~270
// catalogue cards, three films and a show) plus what that one lacks:
//   - a household Calendar (test/ui/support/calendar-showcase.js: a dozen
//     titles over this month and the next), in the Glass profile's list;
//   - a long "My downloads" list: 24 records seeded into data/downloads.json
//     in states that stay put (ready, waiting for an admin, did not make it,
//     cancelled) — the instance cannot download, so nothing is "on its way".
//
//   node tools/real-glass-app/qa-server.js <state.json>
//       prints the address, writes { url, port, pid } to <state.json>;
//       reach it from the emulator with `adb reverse tcp:4000 tcp:<port>`.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const MP = path.join(ROOT, "tools", "mobile-perf");
const server = require(path.join(ROOT, "scripts", "ui-test-server.js"));
const cat = require(path.join(MP, "catalogue.js"));
const showcase = require(path.join(ROOT, "test", "ui", "support", "calendar-showcase.js"));
const calBase = require(path.join(ROOT, "test", "ui", "support", "calendar-seed.js"));

const GLASS = "9e7f00000001";
const ART = path.join(MP, ".cache", "art-v3");
if (!fs.existsSync(path.join(ART, ".ready"))) throw new Error("no made-up art: run tools/mobile-perf/instance.js once first");

// a made-up poster the instance can serve, per calendar title (React Native draws no SVG)
const pool = [...cat.CATALOGUE.movie, ...cat.CATALOGUE.series].map((m) => m.poster);
const posterOf = new Map(showcase.TITLES.map(([id], i) => [id, pool[(i * 7 + 3) % pool.length]]));
const posterUrl = (id) => posterOf.get(id) || null;

const iso = (minsAgo) => new Date(Date.now() - minsAgo * 60000).toISOString();
const jobs = () => {
  const films = cat.CATALOGUE.movie.slice(30, 44);
  const shows = cat.CATALOGUE.series.slice(12, 17);
  const out = [];
  const add = (m, i, over) => out.push({
    id: (0xd10000000000 + out.length).toString(16), infoHash: (out.length + 10).toString(16).padStart(40, "0"), fileIdx: 0,
    imdbId: m.id, title: m.name, label: m.name, type: "movie", season: null, episode: null,
    quality: i % 3 ? "1080p" : "2160p", sizeBytes: (2 + (i % 5) * 1.7) * 1e9, poster: m.poster, provider: null, release: null,
    seeders: 40, profile: GLASS, profileName: "Glass", smart: false,
    status: "done", autoApproved: true, approvedAt: iso(600 + i * 30), holdReason: null,
    progress: 1, downloadSpeed: 0, peers: 0, error: null, at: iso(620 + i * 30), doneAt: iso(500 + i * 30), seenAt: iso(400), ...over,
  });
  films.forEach((m, i) => {
    if (i % 5 === 3) add(m, i, { status: "pending", autoApproved: false, approvedAt: null, doneAt: null, seenAt: null, progress: 0, holdReason: "It is bigger than what starts by itself." });
    else if (i % 5 === 4) add(m, i, { status: "error", doneAt: null, seenAt: null, progress: 0.3, error: "No one had this file any more." });
    else if (i === 7) add(m, i, { status: "canceled", doneAt: null, progress: 0.1 });
    else add(m, i, {});
  });
  shows.forEach((m, i) => {
    for (const e of [1, 2]) add(m, i, { type: "show", season: 1, episode: e, label: `${m.name} · S1 E${e}`, sizeBytes: 1.1e9 });
  });
  return out;
};

(async () => {
  const stateFile = process.argv[2];
  const srv = await server.start({
    preload: [path.join(MP, "fixture-preload.js")],
    env: { MP_ART_DIR: ART, MP_CATALOGUE: path.join(MP, "catalogue.js"), MP_UPSTREAM_MS: "0" },
    seed: {
      "cache/discover.json": cat.discoverSeed(),
      "profiles.json": { profiles: [{ id: GLASS, name: "Glass", color: "#2c9fe0", avatar: "🦊", realName: "Glass Tester", approvedAt: 1790000000000, look: "glass", lookNoticeSeen: true }], state: {} },
      "settings.json": {},
      "downloads.json": jobs(),
      ...showcase.seed({ posterUrl }),
    },
  });
  const call = async (method, url, body) => {
    const res = await fetch(srv.url + url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await res.json(); } catch {}
    if (res.status >= 300) throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(json)}`);
    return json;
  };
  const library = await call("GET", "/api/library");
  const show = await call("GET", `/api/item/${library.shows[0].id}`);
  const film1 = library.movies.find((m) => m.title === "Test Film One");
  await call("POST", `/api/profiles/${GLASS}/progress`, { itemId: film1.id, position: 20, duration: 60 });
  await call("POST", `/api/profiles/${GLASS}/progress`, { itemId: show.seasons[0].episodes[0].id, position: 15, duration: 45 });
  for (const m of [...cat.CATALOGUE.movie.slice(3, 9), ...cat.CATALOGUE.series.slice(5, 9)]) {
    await call("POST", `/api/profiles/${GLASS}/watchlist`, { add: true, stream: { imdbId: m.id, type: m.type === "series" ? "show" : "movie", title: m.name, poster: m.poster, year: parseInt(m.releaseInfo, 10) } });
  }
  // the Calendar's titles: calendar-seed.js's five and the showcase's dozen
  const api = { as: async () => ({}), ok: (method, url, body) => call(method, url, body) };
  await showcase.fill(api, { id: GLASS }, library.shows[0].id, { posterUrl });
  void calBase;
  const cal = await call("GET", `/api/profiles/${GLASS}/calendar`);
  const dl = await call("GET", `/api/downloads?profile=${GLASS}`);
  const state = { url: srv.url, root: srv.root, port: Number(new URL(srv.url).port), pid: process.pid, show: show.id, showImdb: library.shows[0].imdbId || null, downloads: dl.length, calendarKeys: Object.keys(cal || {}) };
  if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  console.log(JSON.stringify(state));
  const stop = async () => { try { await srv.stop(); } finally { process.exit(0); } };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  setInterval(() => {}, 1 << 30);
})().catch((e) => { console.error(e); process.exit(1); });
