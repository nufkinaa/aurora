#!/usr/bin/env node
// A HOUSEHOLD UNDER LOAD, before against after in the same weather: the load
// of loopload.js (N clients doing what the apps do, a rescan every --scan
// minutes) against two private instances started side by side, in windows
// that take turns — A, B, A, B … — so a busy minute on this machine falls on
// both. While one is loaded the other idles.
//
//   node tools/backend-perf/loopab.js --before <commit> [--after <commit>] [--clients 8] [--window 1.5] [--rounds 3] [--scan 1] [--weak] [--label x]
//   -> <results>/loopab[-label].json
//
// Per side, over all its windows: request groups answered, wall time per kind
// (p50 / p99 / max), the server's CPU (cores used), event-loop busy share and
// delay (p50 / p99 / max), blocking fs calls on the main thread.
const http = require("http");
const path = require("path");
const { start } = require("./instance");
const { round, saveJson, arg, table, sleep, median, pct } = require("./lib");

const kindsFor = (srv, lib) => {
  const ds = srv.ds;
  const covers = lib.movies.filter((m) => m.cover && m.cover.startsWith("/img/")).map((m) => m.cover).slice(0, 300);
  const subs = lib.movies.flatMap((m) => (m.subtitles || []).filter((s) => !s.embedded).map((s) => s.url)).slice(0, 100);
  const films = ds.sample.films, eps = ds.sample.episodes;
  const words = ["si", "gol", "mid", "broken r", "elec", "silent ri", "pa", "fro"];
  return {
    "home (composed)": (c, i) => [{ m: "POST", p: `/api/profiles/${srv.profile(c)}/progress`, b: { itemId: films[(c * 7 + i) % films.length], position: 300 + i, duration: 6000 } }, { p: `/api/home?profile=${srv.profile(c)}` }],
    "library": () => [{ p: "/api/library" }],
    "state": (c) => [{ p: `/api/profiles/${srv.profile(c)}/state` }],
    "title page": (c, i) => [{ p: `/api/item/${films[(c * 13 + i) % films.length]}` }],
    "episode": (c, i) => [{ p: `/api/item/${eps[(c * 5 + i) % eps.length]}` }],
    "search": (c, i) => [{ p: `/api/search/suggest?v=2&q=${encodeURIComponent(words[(c + i) % words.length])}` }],
    // (the same 300 covers each window: the first window makes their
    // variants, the later ones are what a household sees every day)
    "pictures x10": (c, i) => Array.from({ length: 10 }, (_, k) => ({ p: `${covers[(c * 31 + i * 10 + k) % covers.length]}?w=256` })),
    "progress": (c, i) => [{ m: "POST", p: `/api/profiles/${srv.profile(c)}/progress`, b: { itemId: films[c % films.length], position: 600 + i, duration: 6000 } }],
    "subtitle": (c, i) => (subs.length ? [{ p: subs[(c + i) % subs.length] }] : []),
    "shell": () => [{ p: "/" }],
  };
};
const WEIGHTS = { "home (composed)": 2, library: 1, state: 1, "title page": 3, episode: 2, search: 4, "pictures x10": 4, progress: 6, subtitle: 1, shell: 1 };

(async () => {
  const before = arg("before") === true ? undefined : arg("before");
  const after = arg("after") === true ? undefined : arg("after");
  const clients = +arg("clients", 8);
  const windowMin = +arg("window", 1.5);
  const rounds = +arg("rounds", 3);
  const scan = +arg("scan", 1);
  const weak = !!arg("weak");
  const label = arg("label") === true ? undefined : arg("label");
  if (!before) throw new Error("--before <commit> is required");
  const cfg = { weak, probe: "full", config: { scanIntervalMinutes: scan } };
  const sides = { before: { srv: await start({ ...cfg, ref: before }) }, after: { srv: await start({ ...cfg, ref: after }) } };
  const out = { at: new Date().toISOString(), before, after: after || "working tree", clients, windowMin, rounds, scanMinutes: scan, weak, windows: [], summary: [] };
  try {
    for (const s of Object.values(sides)) await s.srv.waitWarm();
    for (const s of Object.values(sides)) await s.srv.waitQuiet();
    for (const [k, s] of Object.entries(sides)) {
      const lib = await (await fetch(`${s.srv.url}/api/library`, { headers: s.srv.session(0) })).json();
      s.kinds = kindsFor(s.srv, lib);
      s.times = Object.fromEntries(Object.keys(s.kinds).map((x) => [x, []]));
      s.groups = 0; s.errors = 0; s.cpuS = 0; s.secs = 0; s.activeMs = 0; s.p99 = []; s.max = 0; s.syncFs = 0;
      void k;
    }
    const deck = Object.entries(WEIGHTS).flatMap(([k, w]) => Array(w).fill(k));
    const drive = async (s) => {
      const srv = s.srv;
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
      const t0 = Date.now();
      const end = t0 + windowMin * 60e3;
      await Promise.all(Array.from({ length: clients }, async (_, c) => {
        let i = 0;
        while (Date.now() < end) {
          const kind = deck[(c * 7 + i * 3 + s.groups) % deck.length];
          const t = Date.now();
          for (const r of s.kinds[kind](c, i)) { const st = await one(c, r); if (st >= 400 || st === 0) s.errors++; }
          s.times[kind].push(Date.now() - t);
          s.groups++;
          i++;
          await sleep(150 + ((c * 37 + i * 53) % 400));
        }
      }));
      const x = await srv.snap();
      const secs = (Date.now() - t0) / 1000;
      s.cpuS += (x.cpuSinceReset.user + x.cpuSinceReset.system) / 1e6;
      s.secs += secs;
      s.activeMs += x.elu.activeMs;
      if (x.loopDelay) { s.p99.push(x.loopDelay.p99); s.max = Math.max(s.max, x.loopDelay.max); }
      s.syncFs += x.syncFs.filter((r) => !/ @ /.test(r.key)).reduce((a, r) => a + r.n, 0);
      agents.forEach((a) => a.destroy());
      return { secs: round(secs, 0), cpuCores: round((x.cpuSinceReset.user + x.cpuSinceReset.system) / 1e6 / secs, 3), loopBusyPct: round((x.elu.activeMs / (secs * 1000)) * 100, 1), delayMax: x.loopDelay ? round(x.loopDelay.max, 0) : null };
    };
    for (let r = 0; r < rounds; r++) {
      const order = r % 2 ? ["after", "before"] : ["before", "after"];
      for (const k of order) {
        const g0 = sides[k].groups;
        const w = await drive(sides[k]);
        out.windows.push({ side: k, round: r, groups: sides[k].groups - g0, ...w });
        process.stderr.write(`[loopab] ${k} round ${r}: ${JSON.stringify(out.windows[out.windows.length - 1])}\n`);
      }
    }
    for (const [k, s] of Object.entries(sides)) {
      const all = Object.values(s.times).flat();
      out.summary.push({
        side: k, groups: s.groups, groupsPerMin: round(s.groups / (s.secs / 60), 1), errors: s.errors,
        p50: median(all), p99: pct(all, 99),
        cpuCores: round(s.cpuS / s.secs, 3), loopBusyPct: round((s.activeMs / (s.secs * 1000)) * 100, 1),
        delayP99: round(median(s.p99), 0), delayMax: round(s.max, 0), syncFsPerMin: round(s.syncFs / (s.secs / 60), 0),
        kinds: Object.fromEntries(Object.entries(s.times).map(([kk, t]) => [kk, { n: t.length, p50: median(t), p99: pct(t, 99) }])),
      });
    }
  } finally { for (const s of Object.values(sides)) await s.srv.stop(); }
  const f = saveJson(`loopab${label ? `-${label}` : ""}.json`, out);
  console.log(table(out.summary, [["", "side"], ["groups", "groups"], ["groups/min", "groupsPerMin"], ["errors", "errors"], ["wall p50 ms", "p50"], ["wall p99 ms", "p99"], ["CPU cores", "cpuCores"], ["loop busy %", "loopBusyPct"], ["delay p99 ms", "delayP99"], ["delay max ms", "delayMax"], ["blocking fs/min", "syncFsPerMin"]]));
  const kinds = Object.keys(out.summary[0].kinds);
  console.log(table(kinds.map((k) => ({ kind: k, b50: out.summary[0].kinds[k].p50, a50: out.summary[1].kinds[k].p50, b99: out.summary[0].kinds[k].p99, a99: out.summary[1].kinds[k].p99 })), [["kind", "kind"], ["before p50", "b50"], ["after p50", "a50"], ["before p99", "b99"], ["after p99", "a99"]]));
  console.log(`\n${path.relative(process.cwd(), f)}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
