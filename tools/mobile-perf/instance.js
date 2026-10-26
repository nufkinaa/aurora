#!/usr/bin/env node
// The harness's own Aurora: the UI tests' private instance (scripts/
// ui-test-server.js — throwaway folder, free port, no outbound network) with
// a realistically large catalogue behind it and two profiles ready to use.
//
//   const { startInstance } = require("./instance");
//   const inst = await startInstance();   // { url, profiles: { glass, legacy }, lib, stop() }
//
//   node tools/mobile-perf/instance.js [--repo <dir>] [--port-file <file>]
//       the same by hand: prints the address, writes .cache/instance.json
//       (the other scripts pick a running instance up from there), CTRL-C ends it.
//
// --repo <dir>: measure ANOTHER checkout's server and website (a `git archive`
// of the baseline commit, say) with this harness — that is how before/after
// numbers come from the same machine in the same hour. The folder needs a
// node_modules (a junction to this one's is enough).
//
// What a profile sees: Home with a hero and ~12 shelves / ~260 cards
// (Continue Watching, My List, Recommended, Trending, genre shelves — the
// live server's Home is 10–14 shelves, ~240 cards, ~90 KB of JSON), Movies
// and Shows grids with a paged catalogue, title pages with episodes, Search.
// Every picture is made up (make-art.py) and comes through the server's real
// /img/ext cache and ?w= resizer.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const HERE = __dirname;
const CACHE = path.join(HERE, ".cache");
const ART = path.join(CACHE, "art-v3");
const STATE = path.join(CACHE, "instance.json");

const arg = (name, def = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] != null ? process.argv[i + 1] : def;
};

const ensureArt = () => {
  if (fs.existsSync(path.join(ART, ".ready"))) return ART;
  fs.mkdirSync(CACHE, { recursive: true });
  const r = spawnSync(process.platform === "win32" ? "python" : "python3", [path.join(HERE, "make-art.py"), ART], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("make-art.py failed (needs Python 3 with Pillow)");
  return ART;
};

const PROFILES = [
  { id: "9e7f00000001", name: "Glass", look: "glass" },
  { id: "9e7f00000002", name: "Legacy", look: "legacy" },
];
const profilesSeed = () => ({
  profiles: PROFILES.map((p, i) => ({ id: p.id, name: p.name, color: i ? "#e0782c" : "#2c9fe0", avatar: "🦊", realName: `${p.name} Tester`, approvedAt: 1790000000000 + i, look: p.look, lookNoticeSeen: true })),
  state: {},
});

const startInstance = async ({ repo = path.join(HERE, "..", ".."), verbose = false, config = {}, upstreamMs = 0 } = {}) => {
  const server = require(path.join(repo, "scripts", "ui-test-server.js"));
  const cat = require("./catalogue");
  const srv = await server.start({
    verbose,
    preload: [path.join(HERE, "fixture-preload.js")],
    env: { MP_ART_DIR: ensureArt(), MP_CATALOGUE: path.join(HERE, "catalogue.js"), MP_UPSTREAM_MS: String(upstreamMs) },
    // (My List downloads off: adding to a list must not try to fetch anything)
    seed: { "cache/discover.json": cat.discoverSeed(), "profiles.json": profilesSeed(), "settings.json": {} },
    config,
  });

  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(srv.url + url, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch {}
    if (res.status >= 300) throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(json)}`);
    return json;
  };
  const admin = { "X-Admin-Password": srv.adminPassword };

  // the library the tests generate: three films, one show
  const library = await call("GET", "/api/library");
  const film = (t) => library.movies.find((m) => m.title === t);
  const show = await call("GET", `/api/item/${library.shows[0].id}`);
  const lib = {
    film1: film("Test Film One"), film2: film("Test Film Two"), show,
    e1: show.seasons[0].episodes[0], e2: show.seasons[0].episodes[1],
  };

  // Two profiles without a password (the door lets them straight in), one
  // per look. Their ids are FIXED (seeded into data/profiles.json below, not
  // made by the server): Home's daily sampling is seeded by profile id, so
  // two instances — the baseline's and the changed code's — hand out the
  // same Home, and their screenshots can be compared pixel for pixel.
  const fill = async (p) => {
    // a lived-in profile: something half watched, a list, ratings, liked genres
    await call("POST", `/api/profiles/${p.id}/progress`, { itemId: lib.film1.id, position: 20, duration: 60 });
    await call("POST", `/api/profiles/${p.id}/progress`, { itemId: lib.e1.id, position: 15, duration: 45 });
    for (const m of [...cat.CATALOGUE.movie.slice(3, 11), ...cat.CATALOGUE.series.slice(5, 11)]) {
      await call("POST", `/api/profiles/${p.id}/watchlist`, { add: true, stream: { imdbId: m.id, type: m.type === "series" ? "show" : "movie", title: m.name, poster: m.poster, year: parseInt(m.releaseInfo, 10) } });
    }
    for (const [i, m] of cat.CATALOGUE.movie.slice(20, 26).entries()) {
      await call("POST", `/api/profiles/${p.id}/rating`, { itemId: m.id, stars: i % 2 ? 5 : 4 });
    }
    await call("POST", `/api/profiles/${p.id}/preferences`, { likedGenres: ["Drama", "Sci-Fi"] });
    return p;
  };
  const profiles = { glass: await fill({ ...PROFILES[0] }), legacy: await fill({ ...PROFILES[1] }) };

  // Warm what a server that has been up for a day has warm: the catalogue
  // pages Home's hero pool draws on, and one title's page of each kind.
  const film0 = cat.CATALOGUE.movie[0];
  const series0 = cat.CATALOGUE.series[0];
  for (let i = 0; i < 3; i++) {
    await call("GET", `/api/home?profile=${profiles.glass.id}`);
    await new Promise((r) => setTimeout(r, 700));
  }
  await call("GET", `/api/discover/meta/movie/${film0.id}`).catch(() => {});
  await call("GET", `/api/discover/meta/series/${series0.id}`).catch(() => {});

  const routes = {
    home: "#/",
    movies: "#/movies",
    shows: "#/shows",
    search: "#/search",
    list: "#/list",
    film: `#/discover/movie/${film0.id}`,
    show: `#/discover/series/${series0.id}`,
    libfilm: `#/movie/${lib.film1.id}`,
    libshow: `#/show/${lib.show.id}`,
    settings: "#/preferences",
    downloads: "#/downloads",
  };
  return {
    url: srv.url, port: srv.port, root: srv.root, dataDir: srv.dataDir, log: srv.log, adminPassword: srv.adminPassword,
    profiles, routes, lib: { film1: lib.film1.id, film2: lib.film2.id, show: lib.show.id, e1: lib.e1.id },
    stop: srv.stop,
  };
};

// A running by-hand instance, if there is one (so a script need not boot its own).
const attach = async () => {
  try {
    // --instance <file>: a particular by-hand instance (see snapshot.js)
    const s = JSON.parse(fs.readFileSync(arg("instance") ? path.resolve(arg("instance")) : STATE, "utf-8"));
    const res = await fetch(`${s.url}/api/ping`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) return { ...s, attached: true, stop: async () => {}, log: () => [] };
  } catch {}
  return null;
};
// What the scripts call: --url wins, then a by-hand instance, then a new one.
const getInstance = async (opts = {}) => (opts.fresh ? null : await attach()) || startInstance(opts);

module.exports = { startInstance, getInstance, attach, CACHE };

if (require.main === module) {
  startInstance({ repo: arg("repo") ? path.resolve(arg("repo")) : undefined, verbose: process.argv.includes("--verbose"), upstreamMs: Number(arg("upstream-ms", 0)) })
    .then(async (inst) => {
      const { stop, log, ...plain } = inst;
      const file = arg("state") ? path.resolve(arg("state")) : STATE;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ ...plain, pid: process.pid }, null, 2));
      const home = await (await fetch(`${inst.url}/api/home?profile=${inst.profiles.glass.id}`)).json();
      const cards = home.rows.reduce((n, r) => n + r.items.length, 0);
      console.log(`\n  Mobile-perf instance\n\n    App       ${inst.url}\n    Profiles  Glass ${inst.profiles.glass.id} · Legacy ${inst.profiles.legacy.id}\n    Home      ${home.hero.length} hero slides, ${home.rows.length} shelves, ${cards} cards\n    State     ${file}\n\n  CTRL-C stops it and removes its folder.\n`);
      const bye = () => { try { fs.rmSync(file, { force: true }); } catch {} };
      process.on("exit", bye);
    })
    .catch((err) => { console.error(err.stack || err.message); process.exit(1); });
}
