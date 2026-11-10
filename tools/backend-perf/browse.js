#!/usr/bin/env node
// PEOPLE BROWSING (perf-server, 2026-11-10): N devices (website, TV, phone in
// turn) going from screen to screen the way the apps do — each screen the
// burst of requests that app makes for it (the inventory in the perf-server
// report: Home, title pages, show pages, grids, search keystrokes, My List,
// Calendar, What's new; pictures from a warmed set) — with one person
// watching (a progress save every 5 s) per ten devices, which is what makes
// Home compose afresh in a real house. Against one private instance with the
// large household (dataset.js).
//
//   node tools/backend-perf/browse.js [--viewers 1,10,30] [--minutes 2] [--think 12] [--ref <commit>]
//                                     [--weak] [--profile] [--label x]
//   -> <results>/browse[-label].json
//
// Per step: requests per screen kind (wall p50/p95/p99), the event-loop delay
// (monitorEventLoopDelay p50/p99/max), loop stalls seen by a 50 ms ticker,
// event-loop utilisation, CPU, heap/RSS, and a /healthz ping every 200 ms on
// its own connection (the wait anyone would meet). --profile: a CPU profile of
// each step, top functions.
const http = require("http");
const { start } = require("./instance");
const { round, saveJson, arg, table, sleep, median, pct } = require("./lib");

const R = (seed) => () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

(async () => {
  const ref = arg("ref") === true ? undefined : arg("ref");
  const steps = String(arg("viewers", "1,10,30")).split(",").map(Number);
  const minutes = +arg("minutes", 2);
  const think = +arg("think", 12);
  const weak = !!arg("weak");
  const profile = !!arg("profile");
  const label = arg("label") === true ? undefined : arg("label");
  const full = !!arg("full"); // the full probe: data/ writes per file and blocking fs calls by call site (costs a little itself)
  const srv = await start({ weak, ref, probe: full ? "full" : "light", config: { scanIntervalMinutes: 24 * 60 } });
  const out = { at: new Date().toISOString(), ref: ref || "working tree", minutes, think, weak, steps: [] };
  try {
    await srv.waitWarm();
    await srv.waitQuiet();
    // past the torrent engine's code preload (media/torrent.js preload(): 60 s
    // after boot, seconds of the loop on this PC) — a one-off of every start,
    // not part of browsing
    { const s0 = await srv.snap(); if (s0.uptimeMs < 80000) await sleep(80000 - s0.uptimeMs); }
    const ds = srv.ds;
    const nP = ds.sessions.length;
    const lib = await (await fetch(`${srv.url}/api/library`, { headers: srv.session(0) })).json();
    const covers = lib.movies.filter((m) => m.cover && m.cover.startsWith("/img/")).map((m) => m.cover).slice(0, 48);
    const films = ds.sample.films, eps = ds.sample.episodes, cat = ds.sample.catalogue;
    const libFilms = lib.movies.filter((m) => m.imdbId).slice(0, 200);
    const shows = lib.shows.slice(0, 60);
    // pictures: made once before the windows (first-sight variant encodes are a cost of their own)
    for (const w of [256, 360]) for (const c of covers) await fetch(`${srv.url}${c}?w=${w}`, { headers: srv.session(0) }).then((r) => r.arrayBuffer()).catch(() => {});
    const words = ["si", "sil", "sile", "silent", "gol", "gold", "golden r", "mid", "midn", "broken", "elec", "pa", "fro", "lucky"];

    // the screens: [kind, (device, i, rnd) -> list of request groups; a group's requests go out together]
    const pic = (n, w, rnd) => Array.from({ length: n }, () => ({ p: `${covers[Math.floor(rnd() * covers.length)]}?w=${w}` }));
    const screens = {
      home: (d, i, rnd) => d.app === "web"
        ? [[{ p: `/api/home?profile=${d.P}`, inm: true }, { p: `/api/profiles/${d.P}/wrapped` }, { p: "/api/party" }], pic(12, 360, rnd)]
        : [[{ p: `/api/home?profile=${d.P}&slim=1`, inm: true }, { p: "/api/party" }], [{ p: `/api/downloads?profile=${d.P}` }], pic(10, 256, rnd)],
      title: (d, i, rnd) => {
        const f = libFilms[Math.floor(rnd() * libFilms.length)];
        const meta = { p: `/api/discover/meta/movie/${f.imdbId}` };
        return d.app === "web"
          ? [[{ p: `/api/item/${f.id}?profile=${d.P}` }, meta, { p: `/api/profiles/${d.P}/state` }], [{ p: `/api/discover/similar/movie/${f.imdbId}?profile=${d.P}` }, { p: `/api/franchises/for/${f.imdbId}?type=movie&profile=${d.P}` }, { p: `/api/profiles/${d.P}/household/for?key=${f.imdbId}` }], pic(4, 360, rnd)]
          : [[{ p: `/api/item/${f.id}?profile=${d.P}` }, { p: `/api/profiles/${d.P}/watchlist` }, { p: `/api/downloads?profile=${d.P}` }, meta, { p: `/api/profiles/${d.P}/household/for?key=${f.imdbId}` }, { p: `/api/profiles/${d.P}/state` }, { p: "/api/profiles" }],
            [{ p: `/api/discover/similar/movie/${f.imdbId}?profile=${d.P}` }, { p: `/api/franchises/for/${f.imdbId}?type=movie&profile=${d.P}` }], pic(4, 256, rnd), ...(d.app === "tv" ? [[{ p: `/api/profiles/${d.P}/state` }]] : [])];
      },
      show: (d, i, rnd) => {
        const s = shows[Math.floor(rnd() * shows.length)];
        return [[{ p: `/api/item/${s.id}?profile=${d.P}` }, { p: `/api/profiles/${d.P}/state` }, ...(s.imdbId ? [{ p: `/api/discover/meta/series/${s.imdbId}` }] : [])], [{ p: `/api/next-episode?profile=${d.P}&imdbId=${s.imdbId || ""}&season=1&episode=1` }], pic(4, 256, rnd)];
      },
      episode: (d, i, rnd) => [[{ p: `/api/item/${eps[Math.floor(rnd() * eps.length)]}?profile=${d.P}` }, { p: `/api/intro/auto/${eps[Math.floor(rnd() * eps.length)]}` }]],
      grid: (d, i, rnd) => [[{ p: `/api/library?profile=${d.P}`, inm: true }, { p: `/api/profiles/${d.P}/state` }], [{ p: "/api/catalog?type=movie&category=trending&page=0" }, { p: "/api/catalog/genres?type=movie" }], pic(12, 256, rnd)],
      search: (d, i, rnd) => {
        const w = words[Math.floor(rnd() * words.length)];
        const keys = Array.from({ length: Math.min(w.length, 4) }, (_, k) => [{ p: `/api/search/suggest?v=2&q=${encodeURIComponent(w.slice(0, k + 2))}&profile=${d.P}` }]);
        return [[{ p: `/api/profiles/${d.P}/searches` }, { p: `/api/popular?profile=${d.P}` }], ...keys, [{ p: `/api/search?v=2&q=${encodeURIComponent(w)}&profile=${d.P}` }]];
      },
      mylist: (d) => [[{ p: `/api/profiles/${d.P}/state` }, { p: `/api/profiles/${d.P}/watchlist` }]],
      calendar: (d) => [[{ p: `/api/profiles/${d.P}/calendar?grid=1&tz=Europe/London&locale=en-GB` }]],
      whatsnew: (d) => [[{ p: d.app === "web" ? "/api/changelog?head=1" : "/api/changelog" }]],
    };
    const weights = { home: 25, title: 25, show: 8, episode: 4, grid: 12, search: 14, mylist: 6, calendar: 4, whatsnew: 2 };
    const deck = Object.entries(weights).flatMap(([k, w]) => Array(w).fill(k));

    const runStep = async (n) => {
      const times = Object.fromEntries(Object.keys(screens).map((k) => [k, []]));
      const errors = {};
      const devices = Array.from({ length: n }, (_, c) => ({ c, app: ["web", "tv", "phone"][c % 3], si: c % nP, P: srv.profile(c % nP), agent: new http.Agent({ keepAlive: true, maxSockets: 6 }), etags: new Map() }));
      const one = (d, r) => new Promise((resolve) => {
        const body = r.b ? JSON.stringify(r.b) : null;
        const h = { ...srv.session(d.si), "Accept-Encoding": "gzip, deflate, br", ...(body ? {} : { "X-Blur": "1" }), ...(r.inm && d.app !== "web" && d.etags.get(r.p) ? { "If-None-Match": d.etags.get(r.p) } : {}), ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}) };
        const req = http.request(srv.url + r.p, { agent: d.agent, method: r.m || "GET", headers: h }, (res) => {
          if (r.inm && res.headers.etag) d.etags.set(r.p, res.headers.etag);
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        });
        req.on("error", () => resolve(0));
        req.setTimeout(60000, () => { req.destroy(); resolve(0); });
        if (body) req.write(body);
        req.end();
      });
      // the healthz line
      const hz = [];
      const hzAgent = new http.Agent({ keepAlive: true, maxSockets: 1 });
      let stop = false;
      const hzLoop = (async () => { while (!stop) { const t = process.hrtime.bigint(); await new Promise((res) => { const q = http.get(`${srv.url}/healthz`, { agent: hzAgent }, (r) => { r.resume(); r.on("end", res); }); q.on("error", res); }); hz.push(Number(process.hrtime.bigint() - t) / 1e6); await sleep(200); } })();
      // arrival: everyone opens the app over the first 10 s (Home), then browses
      await srv.reset();
      if (profile) await srv.probe("/cpu/start?us=500");
      const t0 = Date.now();
      const end = t0 + minutes * 60e3;
      // memory every minute (a soak: --viewers 10 --minutes 15)
      const memSeries = [];
      const memTimer = setInterval(() => { srv.snap().then((m) => memSeries.push({ min: Math.round((Date.now() - t0) / 60000), rssMb: Math.round(m.mem.rss / 1048576), heapMb: Math.round(m.mem.heapUsed / 1048576), externalMb: Math.round(m.mem.external / 1048576) })).catch(() => {}); }, 60000);
      const watchers = Array.from({ length: Math.max(1, Math.round(n / 10)) }, (_, k) => (async () => {
        const P = srv.profile(k % nP);
        const d = { si: k % nP, agent: new http.Agent({ keepAlive: true, maxSockets: 1 }), etags: new Map(), app: "web" };
        let pos = 600;
        while (Date.now() < end) { await one(d, { m: "POST", p: `/api/profiles/${P}/progress`, b: { itemId: films[k % films.length], position: (pos += 5), duration: 6000 } }); await sleep(5000); }
        d.agent.destroy();
      })());
      await Promise.all([...watchers, ...devices.map(async (d) => {
        const rnd = R(1000 + d.c * 7919);
        await sleep(rnd() * 10000);
        let i = 0;
        while (Date.now() < end) {
          const kind = i === 0 ? "home" : deck[Math.floor(rnd() * deck.length)];
          const t = Date.now();
          for (const group of screens[kind](d, i, rnd)) {
            const st = await Promise.all(group.map((r) => one(d, r)));
            for (const s of st) if (s >= 400 || s === 0) errors[`${kind} ${s}`] = (errors[`${kind} ${s}`] || 0) + 1;
          }
          times[kind].push(Date.now() - t);
          i++;
          await sleep((think * (0.5 + rnd())) * 1000);
        }
      })]);
      clearInterval(memTimer);
      const secs = (Date.now() - t0) / 1000;
      const prof = profile ? await srv.probe("/cpu/stop?top=60") : null;
      const s = await srv.snap();
      stop = true;
      await hzLoop;
      hzAgent.destroy();
      devices.forEach((d) => d.agent.destroy());
      const row = {
        viewers: n, secs: round(secs, 0), screens: Object.values(times).reduce((a, t) => a + t.length, 0),
        cpuCores: round((s.cpuSinceReset.user + s.cpuSinceReset.system) / 1e6 / secs, 3), elu: round(s.elu.utilization, 3),
        loopP50: round(s.loopDelay.p50, 1), loopP99: round(s.loopDelay.p99, 1), loopMax: round(s.loopDelay.max, 1),
        healthzP50: round(median(hz), 1), healthzP99: round(pct(hz, 99), 1), healthzMax: round(Math.max(...hz), 1),
        rssMb: round(s.mem.rss / 1048576, 0), heapMb: round(s.mem.heapUsed / 1048576, 0), gcMs: round(Object.values(s.gc).reduce((a, g) => a + g.ms, 0), 0), gcMaxMs: round(Math.max(0, ...Object.values(s.gc).map((g) => g.maxMs)), 1),
        memSeries, errors, kinds: Object.entries(times).map(([k, t]) => ({ kind: k, n: t.length, p50: median(t), p95: pct(t, 95), p99: pct(t, 99), max: t.length ? Math.max(...t) : null })),
      };
      if (full) {
        row.writes = s.writes.slice(0, 12).map((w) => ({ file: w.key, kb: Math.round(w.bytes / 1024), n: w.n }));
        row.syncFsSites = s.syncFs.filter((r) => / @ /.test(r.key)).sort((a, b) => b.ms - a.ms).slice(0, 12).map((r) => ({ site: r.key, n: r.n, ms: round(r.ms, 0) }));
      }
      if (prof) row.profile = { busyMs: prof.busyMs, functions: prof.functions.filter((f) => !/^\((idle|program)\)/.test(f.name)).slice(0, 40) };
      return row;
    };
    for (const n of steps) {
      const row = await runStep(n);
      out.steps.push(row);
      process.stderr.write(`[browse] ${n} viewers: ${row.screens} screens, cpu ${row.cpuCores} cores, ELU ${row.elu}, loop p99 ${row.loopP99} max ${row.loopMax} ms, healthz p99 ${row.healthzP99} max ${row.healthzMax} ms, rss ${row.rssMb} MB\n`);
      await sleep(5000);
    }
  } finally { await srv.stop(); }
  const f = saveJson(`browse${label ? `-${label}` : ""}.json`, out);
  console.log(table(out.steps, [["viewers", "viewers"], ["screens", "screens"], ["cpu cores", "cpuCores"], ["ELU", "elu"], ["loop p50", "loopP50"], ["loop p99", "loopP99"], ["loop max", "loopMax"], ["healthz p50", "healthzP50"], ["healthz p99", "healthzP99"], ["healthz max", "healthzMax"], ["RSS MB", "rssMb"], ["heap MB", "heapMb"], ["GC ms", "gcMs"], ["GC max", "gcMaxMs"]]));
  for (const st of out.steps) {
    console.log(`\n${st.viewers} viewers ${JSON.stringify(st.errors)}`);
    console.log(table(st.kinds, [["screen", "kind"], ["n", "n"], ["p50 ms", "p50"], ["p95 ms", "p95"], ["p99 ms", "p99"], ["max ms", "max"]]));
    if (st.writes) console.log(table(st.writes, [["file written", "file"], ["KB", "kb"], ["writes", "n"]]));
    if (st.syncFsSites) console.log(table(st.syncFsSites, [["blocking fs site", "site"], ["n", "n"], ["ms", "ms"]]));
    if (st.profile) console.log(table(st.profile.functions.slice(0, 25), [["function", "name"], ["ms", "ms"]]));
  }
  console.log(`\n${f}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
