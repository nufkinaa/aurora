#!/usr/bin/env node
// A HOUSEHOLD UNDER LOAD, for the profiler: N clients doing what the apps do
// (Home after a progress save, the library list, title pages, search
// keystrokes, pictures, progress saves, a subtitle), against one private
// instance, while the server does its own housekeeping (a rescan every
// --scan minutes). Reports per request kind the wall time (p50 / p99), the
// event-loop delay histogram, the process's CPU, the blocking fs calls by
// call site, and — with --profile — a V8 CPU profile of the window (the
// functions the main thread spent its time in).
//
//   node tools/backend-perf/loopload.js [--ref <commit>] [--clients 8] [--minutes 3] [--scan 1] [--weak] [--profile] [--label x]
//   -> <results>/loopload[-label].json
const http = require("http");
const path = require("path");
const { start } = require("./instance");
const { round, saveJson, arg, table, sleep, median, pct } = require("./lib");

(async () => {
  const ref = arg("ref") === true ? undefined : arg("ref");
  const clients = +arg("clients", 8);
  const minutes = +arg("minutes", 3);
  const scan = +arg("scan", 1);
  const weak = !!arg("weak");
  const profile = !!arg("profile");
  const label = arg("label") === true ? undefined : arg("label");
  const srv = await start({ weak, ref, probe: profile ? "light" : "full", config: { scanIntervalMinutes: scan } });
  const out = { at: new Date().toISOString(), ref: ref || "working tree", clients, minutes, scanMinutes: scan, weak, kinds: [] };
  try {
    await srv.waitWarm();
    await srv.waitQuiet();
    const ds = srv.ds;
    const lib = await (await fetch(`${srv.url}/api/library`, { headers: srv.session(0) })).json();
    const covers = lib.movies.filter((m) => m.cover && m.cover.startsWith("/img/")).map((m) => m.cover).slice(0, 300);
    const subs = lib.movies.flatMap((m) => (m.subtitles || []).filter((s) => !s.embedded).map((s) => s.url)).slice(0, 100);
    const films = ds.sample.films, eps = ds.sample.episodes;
    const words = ["si", "gol", "mid", "broken r", "elec", "silent ri", "pa", "fro"];
    const kinds = {
      "home (composed)": (c, i) => [{ m: "POST", p: `/api/profiles/${srv.profile(c)}/progress`, b: { itemId: films[(c * 7 + i) % films.length], position: 300 + i, duration: 6000 } }, { p: `/api/home?profile=${srv.profile(c)}` }],
      "library": () => [{ p: "/api/library" }],
      "state": (c) => [{ p: `/api/profiles/${srv.profile(c)}/state` }],
      "title page": (c, i) => [{ p: `/api/item/${films[(c * 13 + i) % films.length]}` }],
      "episode": (c, i) => [{ p: `/api/item/${eps[(c * 5 + i) % eps.length]}` }],
      "search": (c, i) => [{ p: `/api/search/suggest?v=2&q=${encodeURIComponent(words[(c + i) % words.length])}` }],
      "pictures x10": (c, i) => Array.from({ length: 10 }, (_, k) => ({ p: `${covers[(c * 31 + i * 10 + k) % covers.length]}?w=256` })),
      "progress": (c, i) => [{ m: "POST", p: `/api/profiles/${srv.profile(c)}/progress`, b: { itemId: films[c % films.length], position: 600 + i, duration: 6000 } }],
      "subtitle": (c, i) => (subs.length ? [{ p: subs[(c + i) % subs.length] }] : []),
      "shell": () => [{ p: "/" }],
    };
    const weights = { "home (composed)": 2, library: 1, state: 1, "title page": 3, episode: 2, search: 4, "pictures x10": 4, progress: 6, subtitle: 1, shell: 1 };
    const deck = Object.entries(weights).flatMap(([k, w]) => Array(w).fill(k));
    const times = Object.fromEntries(Object.keys(kinds).map((k) => [k, []]));
    const errors = {};
    const agents = Array.from({ length: clients }, () => new http.Agent({ keepAlive: true, maxSockets: 2 }));
    const one = (c, r) => new Promise((resolve) => {
      const body = r.b ? JSON.stringify(r.b) : null;
      const req = http.request(srv.url + r.p, { agent: agents[c], method: r.m || "GET", headers: { ...srv.session(c), "Accept-Encoding": "gzip, deflate, br", ...(r.m ? {} : { "X-Blur": "1" }), ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}) } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", () => resolve(0));
      req.setTimeout(60000, () => { req.destroy(); resolve(0); });
      if (body) req.write(body);
      req.end();
    });
    await srv.reset();
    if (profile) await srv.probe("/cpu/start?us=500");
    const t0 = Date.now();
    const end = t0 + minutes * 60e3;
    await Promise.all(Array.from({ length: clients }, async (_, c) => {
      let i = 0;
      while (Date.now() < end) {
        const kind = deck[(c * 7 + i * 3) % deck.length];
        const t = Date.now();
        for (const r of kinds[kind](c, i)) {
          const st = await one(c, r);
          if (st >= 400 || st === 0) errors[`${kind} ${st}`] = (errors[`${kind} ${st}`] || 0) + 1;
        }
        times[kind].push(Date.now() - t);
        i++;
        await sleep(150 + ((c * 37 + i * 53) % 400)); // a person, not a benchmark
      }
    }));
    const profFile = path.join(require("./lib").RESULTS, `loopload${label ? `-${label}` : ""}.cpuprofile`);
    const prof = profile ? await srv.probe(`/cpu/stop?top=60&file=${encodeURIComponent(profFile)}`) : null;
    if (profile) out.cpuprofile = profFile;
    const s = await srv.snap();
    const secs = (Date.now() - t0) / 1000;
    out.cpuCoresUsed = round((s.cpuSinceReset.user + s.cpuSinceReset.system) / 1e6 / secs, 3);
    out.loopBusyPct = round(s.elu.utilization * 100, 1);
    out.loopDelayMs = s.loopDelay ? { p50: round(s.loopDelay.p50, 1), p99: round(s.loopDelay.p99, 1), max: round(s.loopDelay.max, 1) } : null;
    out.requests = Object.values(times).reduce((a, t) => a + t.length, 0);
    out.errors = errors;
    for (const [k, t] of Object.entries(times)) out.kinds.push({ kind: k, n: t.length, p50: median(t), p99: pct(t, 99), max: t.length ? Math.max(...t) : null });
    if (!profile) out.syncFsSites = s.syncFs.filter((r) => / @ /.test(r.key)).sort((a, b) => b.ms - a.ms).slice(0, 25).map((r) => ({ site: r.key, n: r.n, ms: round(r.ms, 0) }));
    out.syncFsCalls = s.syncFs.filter((r) => !/ @ /.test(r.key)).reduce((a, r) => a + r.n, 0);
    if (prof) {
      out.profile = { busyMs: prof.busyMs, functions: prof.functions.filter((f) => !/^\((idle|program)\)/.test(f.name)).slice(0, 40), files: prof.files.slice(0, 25) };
    }
    agents.forEach((a) => a.destroy());
  } finally { await srv.stop(); }
  const f = saveJson(`loopload${label ? `-${label}` : ""}.json`, out);
  console.log(`cpu ${out.cpuCoresUsed} cores · loop busy ${out.loopBusyPct}% · delay ${JSON.stringify(out.loopDelayMs)} · ${out.requests} request groups · blocking fs ${out.syncFsCalls}`);
  console.log(table(out.kinds, [["kind", "kind"], ["n", "n"], ["p50 ms", "p50"], ["p99 ms", "p99"], ["max ms", "max"]]));
  if (out.profile) console.log(table(out.profile.functions.slice(0, 30), [["function", "name"], ["ms", "ms"]]));
  if (out.syncFsSites) console.log(table(out.syncFsSites.slice(0, 15), [["blocking fs site", "site"], ["n", "n"], ["ms", "ms"]]));
  console.log(`\n${path.relative(process.cwd(), f)}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
