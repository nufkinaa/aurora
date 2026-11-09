#!/usr/bin/env node
// The curated franchise list (src/media/franchises/data) held to the catalogue.
//
//   node tools/franchises/snapshot.js            ask Cinemeta about every entry not yet in
//                                                test/fixtures/franchise-meta.json, write it,
//                                                then check the whole list against it
//   node tools/franchises/snapshot.js --refresh  ask again about every entry
//   node tools/franchises/snapshot.js --check    no network: check the list against the fixture
//   node tools/franchises/snapshot.js meta tt0371746 tt1228705 …
//                                                one ready-to-paste entry line per id
//                                                (add "series:" before an id for a show)
//   node tools/franchises/snapshot.js find movie "Iron Man"   search the catalogue
//
// Cinemeta (the catalogue the server itself uses — media/discover.js) answers
// by IMDb id with the title's name, year, first release date and TMDB id, so
// an entry whose id points at the wrong film fails the check by name and year.
"use strict";
const fs = require("fs");
const path = require("path");
const franchises = require("../../src/media/franchises");

const FIXTURE = path.join(__dirname, "..", "..", "test", "fixtures", "franchise-meta.json");
const CINEMETA = "https://v3-cinemeta.strem.io";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = async (url) => {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === 3) throw e;
      await sleep(800 * (i + 1));
    }
  }
  return null;
};

const metaOf = async (type, id) => {
  const ct = type === "series" ? "series" : "movie";
  const j = await getJson(`${CINEMETA}/meta/${ct}/${id}.json`);
  const m = j && j.meta;
  if (!m || !m.name) return null;
  return {
    type: ct,
    name: m.name,
    year: parseInt(String(m.year || m.releaseInfo || ""), 10) || null,
    released: m.released ? String(m.released).slice(0, 10) : null,
    tmdbId: Number(m.moviedb_id) || null,
  };
};

// Cinemeta answers a movie id asked as a series (and the other way) with
// nothing: the other type is asked too, so a wrong `type` shows as such.
const lookup = async (type, id) => (await metaOf(type, id)) || (await metaOf(type === "series" ? "movie" : "series", id));

const readFixture = () => {
  try { return JSON.parse(fs.readFileSync(FIXTURE, "utf8")); } catch { return {}; }
};
const writeFixture = (fx) => {
  const sorted = {};
  for (const k of Object.keys(fx).sort()) sorted[k] = fx[k];
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
  fs.writeFileSync(FIXTURE, JSON.stringify(sorted, null, 1) + "\n");
};

const pool = async (items, n, fn) => {
  const q = [...items];
  await Promise.all(Array.from({ length: n }, async () => {
    while (q.length) await fn(q.shift());
  }));
};

const main = async () => {
  const args = process.argv.slice(2);
  if (args[0] === "meta") {
    for (const raw of args.slice(1)) {
      const series = raw.startsWith("series:");
      const id = raw.replace(/^series:/, "");
      const m = await lookup(series ? "series" : "movie", id);
      if (!m) { console.log(`${id}: not in the catalogue`); continue; }
      console.log(JSON.stringify({ imdbId: id, tmdbId: m.tmdbId, type: m.type, title: m.name, year: m.year, date: m.released }));
    }
    return;
  }
  if (args[0] === "find") {
    const type = args[1] === "series" ? "series" : "movie";
    const q = args.slice(2).join(" ");
    const j = await getJson(`${CINEMETA}/catalog/${type}/top/search=${encodeURIComponent(q)}.json`);
    for (const m of ((j && j.metas) || []).slice(0, 10)) {
      console.log(`${m.imdb_id || m.id}  ${m.name}  (${m.releaseInfo || m.year || "?"})`);
    }
    return;
  }
  const list = franchises.readAll();
  const fx = readFixture();
  if (!args.includes("--check")) {
    const refresh = args.includes("--refresh");
    const wanted = new Map();
    for (const fr of list) for (const e of fr.entries || []) if (e && e.imdbId && (refresh || !fx[e.imdbId])) wanted.set(e.imdbId, e.type);
    let done = 0;
    await pool([...wanted], 4, async ([id, type]) => {
      try {
        const m = await lookup(type, id);
        if (m) fx[id] = m;
        else console.log(`${id}: the catalogue does not know it`);
      } catch (e) {
        console.log(`${id}: ${e.message}`);
      }
      if (++done % 25 === 0) console.log(`… ${done}/${wanted.size}`);
    });
    // what no entry names any more is let go
    const named = new Set(list.flatMap((fr) => (fr.entries || []).map((e) => e && e.imdbId)));
    for (const k of Object.keys(fx)) if (!named.has(k)) delete fx[k];
    writeFixture(fx);
  }
  const problems = franchises.validate(list, fx);
  const entries = list.reduce((n, fr) => n + ((fr.entries || []).length), 0);
  console.log(`${list.length} franchises, ${entries} entries, ${Object.keys(fx).length} titles in the snapshot`);
  for (const p of problems) console.log("  ✗ " + p);
  console.log(problems.length ? `${problems.length} problem(s)` : "all good");
  process.exitCode = problems.length ? 1 : 0;
};

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
