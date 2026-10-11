#!/usr/bin/env node
// REQUEST HOT PATHS: what one request of each kind costs the server process.
//
//   node tools/backend-perf/endpoints.js [--weak] [--rounds 3] [--only home,library] [--ref <commit>] [--label before]
//                                        [--profile] [--mode closed|open] [--quick]
//   -> docs/qa/backend-efficiency/results/endpoints[-weak][-label].json and a table
//
// For each endpoint, alone, on one keep-alive connection, as a signed-in
// device (sign-in wall closed, X-Session), with the headers the real clients
// send (Accept-Encoding: gzip, deflate, br — and X-Blur: 1 on every GET):
//   cpu ms/request   the server process's own user+system CPU over the window / requests,
//                    less the idle server's CPU over an equally long window. Two
//                    figures over the --rounds windows: the BEST one (the least a
//                    request was seen to cost: what the code needs with nothing in
//                    its way — the steadier figure on a busy machine) and the median
//   loop ms/request  event-loop active time / requests: how long everyone else waited
//   alloc KB/request V8 sampling heap profiler over a window (everything allocated,
//                    collected or not) / requests
//   sync fs/request  blocking filesystem calls per request, with the busiest call sites
//   --profile        also a V8 CPU profile per endpoint: the top functions and files
//
// CPU and allocation windows run with the LIGHT probe (no wrapping of fs or
// timers), the sync-fs window with the full one, in a second instance.
const http = require("http");
const path = require("path");
const { start } = require("./instance");
const { median, round, saveJson, arg, table, sleep } = require("./lib");

const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
const call = (srv, e, i) => new Promise((resolve, reject) => {
  const p = typeof e.path === "function" ? e.path(i) : e.path;
  const body = e.body ? JSON.stringify(typeof e.body === "function" ? e.body(i) : e.body) : null;
  const req = http.request(srv.url + p, {
    agent, method: e.method || "GET",
    // as the web app and the TV app ask: compressed, and (every GET) with blur-up placeholders
    headers: { ...srv.session(0), "Accept-Encoding": "gzip, deflate, br", ...((e.method || "GET") === "GET" ? { "X-Blur": "1" } : {}), ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}), ...(typeof e.headers === "function" ? e.headers(i) : e.headers || {}) },
  }, (res) => {
    let n = 0;
    res.on("data", (d) => { n += d.length; });
    res.on("end", () => resolve({ status: res.statusCode, bytes: n, etag: res.headers.etag }));
  });
  req.on("error", reject);
  if (body) req.write(body);
  req.end();
});

const endpoints = (srv) => {
  const ds = srv.ds;
  const P = srv.profile(0);
  const films = ds.sample.films;
  const eps = ds.sample.episodes;
  const cover = (i) => films[i % films.length];
  return [
    { name: "GET /healthz", path: "/healthz", n: 400, freq: "monitor" },
    { name: "GET /api/ping", path: "/api/ping", n: 400, freq: "each app start" },
    { name: "GET /api/me", path: "/api/me", n: 400, freq: "each app start" },
    { name: "POST progress (library film)", method: "POST", path: `/api/profiles/${P}/progress`, body: (i) => ({ itemId: films[i % 5], position: 600 + i, duration: 6000 }), n: 300, freq: "every 5 s per viewer" },
    { name: "POST progress (stream, with meta)", method: "POST", path: `/api/profiles/${P}/progress`, body: (i) => ({ itemId: `torrent|${"ab".repeat(20)}|0`, position: 600 + i, duration: 6000, item: { id: `torrent|${"ab".repeat(20)}|0`, type: "movie", stream: true, title: ds.sample.catalogue[1].title, imdbId: ds.sample.catalogue[1].imdbId, year: 2010 } }), n: 300, freq: "every 5 s per stream viewer" },
    { name: "POST /api/usage (5 events)", method: "POST", path: "/api/usage", body: (i) => ({ profile: P, sid: "abcd1234", device: "desktop", look: "glass", events: Array.from({ length: 5 }, (_, k) => ({ n: "route", t: Date.now(), p: { r: "/movie/:id", ms: 40 + k + (i % 7) } })) }), headers: (i) => ({ "X-Forwarded-For": `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}` }), n: 300, freq: "every 20 s per active device" },
    { name: "GET /api/profiles", path: "/api/profiles", n: 300, freq: "each app start" },
    { name: "GET /api/profiles/:id/state", path: `/api/profiles/${P}/state`, n: 100, freq: "app start + each library_updated" },
    { name: "GET /api/profiles/:id/watchlist", path: `/api/profiles/${P}/watchlist`, n: 100, freq: "My List" },
    { name: "GET /api/library", path: "/api/library", n: 30, freq: "app start + each library_updated" },
    { name: "GET /api/library (If-None-Match)", path: "/api/library", n: 30, needsEtag: true, freq: "the same, client copy current" },
    { name: "GET /api/home", path: `/api/home?profile=${P}`, n: 30, freq: "each visit to Home" },
    { name: "GET /api/home slim (TV)", path: `/api/home?profile=${P}&slim=1`, n: 30, freq: "each visit to Home (TV)" },
    { name: "GET /api/item/:id (film)", path: (i) => `/api/item/${films[i % films.length]}`, n: 300, freq: "each title page / play" },
    { name: "GET /api/item/:id (episode)", path: (i) => `/api/item/${eps[i % eps.length]}`, n: 300, freq: "each episode play" },
    { name: "GET /api/discover/meta (cached)", path: (i) => `/api/discover/meta/movie/${ds.sample.catalogue[0].imdbId}`, n: 200, freq: "each title page" },
    { name: "GET /api/search/suggest v2", path: (i) => `/api/search/suggest?v=2&q=${["si", "gol", "mid", "broken r", "elec"][i % 5]}`, n: 100, freq: "each keystroke" },
    { name: "GET /api/search v2", path: (i) => `/api/search?v=2&q=${["silent", "golden river", "midnight", "broken", "electric eng"][i % 5]}`, n: 60, freq: "each keystroke (debounced)" },
    { name: "GET /api/popular", path: `/api/popular?profile=${P}`, n: 60, freq: "opening Search" },
    { name: "GET /api/intro/auto/:id (library episode)", path: (i) => `/api/intro/auto/${eps[i % eps.length]}`, n: 300, freq: "each episode play" },
    { name: "GET /img/:id (cover, original)", path: null, n: 300, freq: "pictures", img: "orig" },
    { name: "GET /img/:id?w=256 (variant made)", path: null, n: 300, freq: "about 40-300 per Home", img: "variant" },
    { name: "GET /img/ext?u=&w=256 (cached, variant made)", path: null, n: 300, freq: "about 300 per Home", img: "ext" },
    { name: "GET /stream/video/:id (range, 64 KB)", path: (i) => `/stream/video/${films[i % films.length]}`, headers: (i) => ({ Range: `bytes=${(i % 4) * 1000}-${(i % 4) * 1000 + 65535}` }), n: 300, freq: "each seek / buffer refill" },
    { name: "GET /stream/subtitle/:id (sidecar)", path: null, n: 200, freq: "each play", sub: "sidecar" },
    { name: "GET /stream/embedded/:id/0 (cached)", path: (i) => `/stream/embedded/${films[i % 20]}/0`, n: 200, warm: 20, freq: "each play" },
    { name: "GET jit index.m3u8 (table cached)", path: (i) => `/stream/transcode/${ds.sample.jit}/jit/index.m3u8`, n: 200, warm: 5, freq: "each play of a repackaged file" },
    { name: "GET jit segment (made)", path: (i) => `/stream/transcode/${ds.sample.jit}/jit/seg0000${i % 3}.ts?v=copy`, n: 200, warm: 9, freq: "every 6-10 s per repackaged viewer" },
    { name: "GET / (app shell)", path: "/", n: 200, freq: "each page load" },
    { name: "GET /css/aurora.css?v=", path: null, n: 60, freq: "once per release per browser", css: true },
    { name: "GET /js/main.js (If-None-Match)", path: "/js/main.js", n: 300, needsEtag: true, freq: "about 60 files per page load" },
    { name: "GET /api/downloads", path: "/api/downloads", n: 200, freq: "Downloads page poll" },
    { name: "GET /api/changelog?head=1", path: "/api/changelog?head=1", n: 300, freq: "each page load" },
  ];
};

// things a list needs that only the running server can say
const prepare = async (srv, list) => {
  const lib = await (await fetch(`${srv.url}/api/library`, { headers: srv.session(0) })).json();
  const withCover = lib.movies.filter((m) => m.cover && m.cover.startsWith("/img/")).slice(0, 60);
  const withSub = lib.movies.filter((m) => (m.subtitles || []).some((s) => !s.embedded)).slice(0, 40);
  // one cached external picture: the file the route would have fetched, written where it keeps them
  const fs = require("fs");
  const crypto = require("crypto");
  const dir = path.join(srv.root, "data", "cache", "posters-web");
  fs.mkdirSync(dir, { recursive: true });
  const coverBytes = fs.readFileSync(path.join(path.dirname(srv.ds.library.movies), "..", "cover.jpg"));
  const urls = Array.from({ length: 40 }, (_, i) => `https://images.metahub.space/poster/small/tt9${String(i).padStart(6, "0")}/img`);
  for (const u of urls) fs.writeFileSync(path.join(dir, crypto.createHash("md5").update(u).digest("hex") + ".img"), coverBytes);
  const shell = await (await fetch(`${srv.url}/`)).text();
  const css = (shell.match(/\/css\/aurora\.css\?v=[a-f0-9]+/) || ["/css/aurora.css"])[0];
  for (const e of list) {
    if (e.img === "orig") e.path = (i) => withCover[i % withCover.length].cover;
    if (e.img === "variant") e.path = (i) => `${withCover[i % withCover.length].cover}?w=256`;
    if (e.img === "ext") e.path = (i) => `/img/ext?u=${encodeURIComponent(urls[i % urls.length])}&w=256`;
    if (e.img) e.warm = 60;
    if (e.sub === "sidecar") e.path = (i) => withSub[i % withSub.length].subtitles.find((s) => !s.embedded).url;
    if (e.css) e.path = css;
  }
  return list.filter((e) => e.path);
};

const measure = async (srv, e, { rounds, idleCpuPerMs, quick }) => {
  let etag = null;
  const first = await call(srv, e, 0);
  if (e.needsEtag) { etag = first.etag; e.headers = { "If-None-Match": etag }; }
  for (let i = 0; i < (e.warm || 15); i++) await call(srv, e, i);
  const cpu = [], loop = [], wall = [];
  let last = first;
  for (let r = 0; r < rounds; r++) {
    await srv.reset();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < e.n; i++) { last = await call(srv, e, i); if (e.pace) await sleep(e.pace); }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const s = await srv.snap();
    const used = (s.cpuSinceReset.user + s.cpuSinceReset.system) / 1000 - idleCpuPerMs * s.sinceResetMs;
    cpu.push(used / e.n);
    loop.push(s.elu.activeMs / e.n);
    wall.push(ms / e.n);
  }
  if (quick) return { name: e.name, freq: e.freq, status: last.status, bytes: last.bytes, n: e.n, cpuMs: round(Math.min(...cpu), 3), cpuMedianMs: round(median(cpu), 3), cpuMsRuns: cpu.map((x) => round(x, 3)), loopMs: round(Math.min(...loop), 3), wallMs: round(median(wall), 2) };
  // allocations: one window
  await srv.probe("/alloc/start");
  for (let i = 0; i < Math.min(e.n, 100); i++) { await call(srv, e, i); if (e.pace) await sleep(Math.min(e.pace, 200)); }
  const alloc = await srv.probe("/alloc/stop?top=8");
  return {
    name: e.name, freq: e.freq, status: last.status, bytes: last.bytes, n: e.n,
    cpuMs: round(Math.min(...cpu), 3), cpuMedianMs: round(median(cpu), 3), cpuMsRuns: cpu.map((x) => round(x, 3)), loopMs: round(Math.min(...loop), 3), wallMs: round(median(wall), 2),
    allocKb: round(alloc.totalBytes / Math.min(e.n, 100) / 1024, 1), allocTop: alloc.functions.slice(0, 5).map((f) => ({ name: f.name, kb: round(f.bytes / Math.min(e.n, 100) / 1024, 1) })),
  };
};

module.exports = { endpoints, prepare, call };

if (require.main === module) (async () => {
  const weak = !!arg("weak");
  const rounds = +arg("rounds", 5);
  const only = arg("only") && arg("only") !== true ? String(arg("only")).split(",") : null;
  const ref = arg("ref") === true ? undefined : arg("ref");
  const label = arg("label") === true ? undefined : arg("label");
  const mode = arg("mode") === true ? undefined : arg("mode");
  const wantProfile = !!arg("profile");
  const quick = !!arg("quick"); // CPU and loop time only: no allocation window, no blocking-fs window
  const pick = (list) => (only ? list.filter((e) => only.some((o) => e.name.toLowerCase().includes(o.toLowerCase()))) : list);
  const out = { at: new Date().toISOString(), ref: ref || "working tree", weak, mode: mode || "closed", rows: [] };

  // --- window 1: CPU, loop, allocations (light probe)
  let srv = await start({ weak, ref, mode, probe: "light", loop: false, config: { scanIntervalMinutes: 24 * 60 } });
  try {
    await srv.waitWarm();
    await srv.waitQuiet();
    const list = pick(await prepare(srv, endpoints(srv)));
    // the idle server's own CPU, to subtract
    await srv.reset(); await sleep(8000);
    const idle = await srv.snap();
    const idleCpuPerMs = (idle.cpuSinceReset.user + idle.cpuSinceReset.system) / 1000 / idle.sinceResetMs;
    out.idleCpuMsPerSec = round(idleCpuPerMs * 1000, 2);
    for (const e of list) {
      const row = await measure(srv, e, { rounds, idleCpuPerMs, quick });
      if (wantProfile) {
        await srv.probe("/cpu/start");
        for (let i = 0; i < Math.min(e.n, 150); i++) await call(srv, e, i);
        const prof = await srv.probe("/cpu/stop?top=25");
        row.profile = { busyMs: prof.busyMs, functions: prof.functions.filter((f) => !/^\((idle|program)\)/.test(f.name)).slice(0, 18), files: prof.files.filter((f) => !/^\((native)\)$/.test(f.name)).slice(0, 12) };
      }
      out.rows.push(row);
      process.stderr.write(`[endpoints] ${row.name}: ${row.status} ${row.bytes} B  cpu ${row.cpuMs} ms  loop ${row.loopMs} ms  alloc ${row.allocKb} KB\n`);
    }
  } finally { await srv.stop(); }

  // --- window 2: blocking filesystem calls per request (full probe)
  if (!quick) srv = await start({ weak, ref, mode, probe: "full", loop: false, config: { scanIntervalMinutes: 24 * 60 } });
  if (!quick) try {
    await srv.waitWarm();
    await srv.waitQuiet();
    const list = pick(await prepare(srv, endpoints(srv)));
    for (const e of list) {
      const first = await call(srv, e, 0);
      if (e.needsEtag) e.headers = { "If-None-Match": first.etag };
      for (let i = 0; i < (e.warm || 15); i++) await call(srv, e, i);
      const n = Math.min(e.n, 60);
      await srv.reset();
      for (let i = 0; i < n; i++) await call(srv, e, i);
      const s = await srv.snap();
      const row = out.rows.find((r) => r.name === e.name);
      if (!row) continue;
      const sites = s.syncFs.filter((r) => / @ /.test(r.key) && !/jsonstore|usage\.js|tel\//.test(r.key));
      row.syncFs = round(sites.reduce((a, r) => a + r.n, 0) / n, 2);
      row.syncFsSites = sites.slice().sort((a, b) => b.n - a.n).slice(0, 6).map((r) => `${r.key} x${round(r.n / n, 2)}`);
    }
  } finally { await srv.stop(); }
  if (quick) await srv.stop();

  const f = saveJson(`endpoints${weak ? "-weak" : ""}${quick ? "-quick" : ""}${label ? `-${label}` : ""}.json`, out);
  console.log(table(out.rows, [["request", "name"], ["status", "status"], ["answer B", "bytes"], ["cpu ms (best)", "cpuMs"], ["cpu ms (median)", "cpuMedianMs"], ["loop ms", "loopMs"], ["alloc KB", "allocKb"], ["sync fs", "syncFs"], ["how often", "freq"]]));
  console.log(`\n${path.relative(process.cwd(), f)}`);
  agent.destroy();
})().catch((e) => { console.error(e); process.exit(1); });
