#!/usr/bin/env node
// EVERY ROUTE THE APPS CALL (perf-server, 2026-11-10): one table of what each
// data request the website, the TV app and the phone app make on start and on
// the common screens costs the server, outside playback.
//
//   node tools/backend-perf/routes.js [--weak] [--n 20] [--only calendar,state] [--ref <commit>|<dir>]
//                                     [--label before] [--profile] [--repeat 3]
//   -> <EFF_RESULTS>/routes[-weak][-label].json and a markdown table
//
// Per route, on one keep-alive connection, signed in (X-Session, wall closed),
// asked the way the clients ask (Accept-Encoding: gzip, deflate, br; X-Blur: 1
// where the website sends it):
//   first ms     the first request of that route in this process (wall, and the
//                server's own Server-Timing app;dur) — "cold" for the route
//   warm p50/p95 the next --n requests (Server-Timing dur: the server's time)
//   cpu ms/req   process user+system CPU over the warm window / requests
//   loop ms/req  event-loop active time over the warm window / requests
//   raw / br / gz the body as JSON, as brotli, as gzip (bytes on the wire)
//   etag         none / weak (express's, the body is built every time) / strong
//                (a kept answer); 304 p50: what an If-None-Match costs
//   --profile    a V8 CPU profile over the warm window: the top functions
//   --bodies d   keep every /api answer (uncompressed) in folder d, and its sha1 in the table
// --repeat k     the whole table k times on the same instance (medians), for a busy PC
const http = require("http");
const path = require("path");
const { start } = require("./instance");
const { median, round, saveJson, arg, sleep } = require("./lib");

const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
const ask = (srv, p, { method = "GET", headers = {}, body = null, si = 0, keep = false } = {}) => new Promise((resolve, reject) => {
  const u = new URL(srv.url + p);
  const data = body ? JSON.stringify(body) : null;
  const t0 = process.hrtime.bigint();
  const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, agent,
    headers: { ...srv.session(si), ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
    let n = 0;
    const parts = [];
    res.on("data", (d) => { n += d.length; if (keep) parts.push(d); });
    res.on("end", () => {
      const st = /app;dur=([\d.]+)/.exec(String(res.headers["server-timing"] || ""));
      resolve({ status: res.statusCode, bytes: n, body: keep ? Buffer.concat(parts) : null, ms: Number(process.hrtime.bigint() - t0) / 1e6, serverMs: st ? +st[1] : null, etag: res.headers.etag || null, enc: res.headers["content-encoding"] || null, cc: res.headers["cache-control"] || null });
    });
  });
  req.on("error", reject);
  if (data) req.write(data);
  req.end();
});
const BR = { "Accept-Encoding": "gzip, deflate, br" };
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : null; };

// The routes, as the clients ask for them (inventory: perf-server report).
// `blur`: the website sends X-Blur: 1 on every GET; the TV and phone do not.
const routesFor = (srv) => {
  const ds = srv.ds;
  const P = srv.profile(0);
  const K = srv.profile(ds.sessions.length - 1); // the kids profile (dataset: the last one)
  const f = ds.sample.films;
  const e = ds.sample.episodes;
  const show = ds.sample.show;
  const cat = ds.sample.catalogue;
  return [
    // start
    { name: "me", path: "/api/me", c: "web tv phone" },
    { name: "ping", path: "/api/ping", c: "tv phone" },
    { name: "server-info", path: "/api/server-info", c: "web" },
    { name: "profiles", path: "/api/profiles", c: "web tv phone" },
    { name: "state", path: `/api/profiles/${P}/state`, c: "web tv phone" },
    { name: "home (web)", path: `/api/home?profile=${P}`, blur: true, c: "web" },
    { name: "home slim (tv/phone)", path: `/api/home?profile=${P}&slim=1`, c: "tv phone" },
    { name: "home (kids)", path: `/api/home?profile=${K}`, blur: true, si: ds.sessions.length - 1, c: "web" },
    { name: "library", path: "/api/library", blur: true, c: "web tv phone" },
    { name: "watchlist", path: `/api/profiles/${P}/watchlist`, c: "web tv phone" },
    { name: "downloads", path: "/api/downloads", c: "web tv phone" },
    { name: "changelog head", path: "/api/changelog?head=1", c: "web" },
    { name: "changelog (New)", path: "/api/changelog", c: "web" },
    { name: "ai status", path: "/api/ai/status", c: "web" },
    { name: "party", path: "/api/party", c: "tv" },
    { name: "tv tuning", path: "/api/tv/tuning", c: "tv" },
    { name: "kids status", path: "/api/kids/status", c: "web tv" },
    { name: "today", path: `/api/profiles/${P}/today`, c: "web tv" },
    { name: "searches", path: `/api/profiles/${P}/searches`, c: "web tv phone" },
    { name: "push pending", path: `/api/push/pending`, c: "web" },
    { name: "household for", path: `/api/profiles/${P}/household/for`, c: "web tv phone" },
    { name: "netprobe", path: "/api/netprobe?kb=48", c: "web" },
    { name: "tv-version.json", path: "/tv-version.json", c: "tv" },
    // browse / title pages
    { name: "item film", path: (i) => `/api/item/${f[i % f.length]}`, blur: true, c: "web tv phone" },
    { name: "item show", path: `/api/item/${show.id}`, blur: true, c: "web tv phone" },
    { name: "item episode", path: (i) => `/api/item/${e[i % e.length]}`, blur: true, c: "web tv phone" },
    { name: "discover meta (cached)", path: (i) => `/api/discover/meta/movie/${cat[i % 10].imdbId}`, blur: true, c: "web tv phone" },
    { name: "discover meta show", path: `/api/discover/meta/series/${show.imdbId}`, blur: true, c: "web tv phone" },
    { name: "similar (cached)", path: (i) => `/api/discover/similar/${cat[(i * 5) % cat.length].type}/${cat[(i * 5) % cat.length].imdbId}`, blur: true, c: "web tv phone" },
    { name: "next-episode", path: `/api/next-episode?profile=${P}&imdbId=${show.imdbId}&season=1&episode=1`, c: "web tv phone" },
    { name: "franchise for", path: `/api/franchises/for/${cat[0].imdbId}?profile=${P}`, c: "web tv phone" },
    { name: "intro auto", path: (i) => `/api/intro/auto/${e[i % e.length]}`, c: "web tv phone" },
    { name: "segments", path: (i) => `/api/segments?itemId=${e[i % e.length]}`, c: "web tv phone" },
    { name: "catalog trending", path: "/api/catalog?type=movie&category=trending&page=0", blur: true, c: "web tv phone" },
    { name: "catalog genres", path: "/api/catalog/genres?type=movie", c: "web tv phone" },
    { name: "popular", path: `/api/popular?profile=${P}`, blur: true, c: "web tv phone" },
    { name: "search suggest", path: (i) => `/api/search/suggest?v=2&q=${["si", "gol", "mid", "broken r", "elec"][i % 5]}&profile=${P}`, blur: true, c: "web tv phone" },
    { name: "search", path: (i) => `/api/search?v=2&q=${["silent", "golden river", "midnight", "broken", "electric eng"][i % 5]}&profile=${P}`, blur: true, c: "web tv phone" },
    { name: "calendar (old apps)", path: `/api/profiles/${P}/calendar`, c: "tv5.9.1 phone1.1.1" },
    { name: "calendar grid", path: `/api/profiles/${P}/calendar?grid=1&tz=Europe/London&locale=en-GB`, c: "web tv phone" },
    { name: "taste", path: `/api/profiles/${P}/taste`, c: "web tv" },
    { name: "wrapped", path: `/api/profiles/${P}/wrapped`, c: "web" },
    { name: "household", path: `/api/profiles/${P}/household`, c: "web tv phone" },
    // pictures
    { name: "img cover", path: null, img: "orig", c: "web tv phone" },
    { name: "img cover w=256", path: null, img: "variant", c: "web tv phone" },
    // writes the apps make while browsing / playing
    { name: "POST progress", method: "POST", path: `/api/profiles/${P}/progress`, body: (i) => ({ itemId: f[i % 5], position: 600 + i, duration: 6000 }), c: "web tv phone" },
    { name: "POST usage", method: "POST", path: "/api/usage", body: (i) => ({ profile: P, sid: "abcd1234", device: "desktop", look: "glass", events: Array.from({ length: 5 }, (_, k) => ({ n: "route", t: Date.now(), p: { r: "/movie/:id", ms: 40 + k + (i % 7) } })) }), c: "web tv phone" },
  ];
};

const prepare = async (srv, list) => {
  const lib = await (await fetch(`${srv.url}/api/library`, { headers: srv.session(0) })).json();
  const withCover = lib.movies.filter((m) => m.cover && m.cover.startsWith("/img/")).slice(0, 60);
  for (const r of list) {
    if (r.img === "orig") r.path = (i) => withCover[i % withCover.length].cover;
    if (r.img === "variant") r.path = (i) => `${withCover[i % withCover.length].cover}?w=256`;
  }
  return list.filter((r) => r.path);
};

const pathOf = (r, i) => (typeof r.path === "function" ? r.path(i) : r.path);
const hdr = (r, extra) => ({ ...BR, ...(r.blur ? { "X-Blur": "1" } : {}), ...extra });
const bodyOf = (r, i) => (r.body ? (typeof r.body === "function" ? r.body(i) : r.body) : null);

const measure = async (srv, r, { n, wantProfile, bodies }) => {
  const si = r.si || 0;
  const method = r.method || "GET";
  const first = await ask(srv, pathOf(r, 0), { method, headers: hdr(r), body: bodyOf(r, 0), si });
  const out = { name: r.name, clients: r.c, status: first.status, firstMs: round(first.ms, 1), firstServerMs: first.serverMs };
  if (method === "GET") {
    const raw = await ask(srv, pathOf(r, 0), { headers: { ...(r.blur ? { "X-Blur": "1" } : {}), "Accept-Encoding": "identity" }, si, keep: !!bodies });
    if (bodies && raw.status === 200 && /^\/api\//.test(pathOf(r, 0))) {
      const fsx = require("fs");
      fsx.mkdirSync(bodies, { recursive: true });
      fsx.writeFileSync(path.join(bodies, `${r.name.replace(/[^\w.-]+/g, "_")}.json`), raw.body);
      out.sha1 = require("crypto").createHash("sha1").update(raw.body).digest("hex").slice(0, 12);
    }
    const gz = await ask(srv, pathOf(r, 0), { headers: { ...(r.blur ? { "X-Blur": "1" } : {}), "Accept-Encoding": "gzip" }, si });
    const br = await ask(srv, pathOf(r, 0), { headers: hdr(r), si });
    Object.assign(out, { raw: raw.bytes, br: br.bytes, gz: gz.bytes, enc: br.enc || "-", etag: !br.etag ? "none" : /^W\//.test(br.etag) ? "weak" : "strong", cacheControl: br.cc || "" });
  }
  for (let i = 1; i <= 3; i++) await ask(srv, pathOf(r, i), { method, headers: hdr(r), body: bodyOf(r, i), si });
  await srv.reset();
  if (wantProfile) await srv.probe("/cpu/start");
  const wall = [], server = [];
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    const x = await ask(srv, pathOf(r, i), { method, headers: hdr(r), body: bodyOf(r, i), si });
    wall.push(x.ms);
    if (x.serverMs != null) server.push(x.serverMs);
  }
  const s = await srv.snap();
  if (wantProfile) {
    const prof = await srv.probe("/cpu/stop?top=30");
    out.profile = prof.functions.filter((fn) => !/^\((idle|program|garbage collector)\)/.test(fn.name)).slice(0, 12).map((fn) => `${round(fn.ms / n, 2)} ms ${fn.name}`);
  }
  Object.assign(out, {
    warmP50: round(pct(wall, 50), 2), warmP95: round(pct(wall, 95), 2),
    serverP50: server.length ? round(pct(server, 50), 2) : null, serverP95: server.length ? round(pct(server, 95), 2) : null,
    cpuMs: round((s.cpuSinceReset.user + s.cpuSinceReset.system) / 1000 / n, 2), loopMs: round(s.elu.activeMs / n, 2), windowMs: Date.now() - t0,
  });
  if (method === "GET") {
    const b = await ask(srv, pathOf(r, 0), { headers: hdr(r), si });
    if (b.etag) {
      const t = [];
      let status = null;
      for (let i = 0; i < Math.min(n, 10); i++) { const x = await ask(srv, pathOf(r, 0), { headers: hdr(r, { "If-None-Match": b.etag }), si }); t.push(x.serverMs != null ? x.serverMs : x.ms); status = x.status; }
      out.inm = `${status} ${round(median(t), 2)} ms`;
    }
  }
  return out;
};

const table = (rows) => {
  const cols = [["route", "name"], ["status", "status"], ["first ms", "firstMs"], ["srv p50", "serverP50"], ["srv p95", "serverP95"], ["cpu/req", "cpuMs"], ["loop/req", "loopMs"], ["raw B", "raw"], ["br B", "br"], ["gz B", "gz"], ["etag", "etag"], ["If-None-Match", "inm"], ["clients", "clients"]];
  const lines = [`| ${cols.map((c) => c[0]).join(" | ")} |`, `| ${cols.map(() => "---").join(" | ")} |`];
  for (const r of rows) lines.push(`| ${cols.map((c) => (r[c[1]] == null ? "" : String(r[c[1]]))).join(" | ")} |`);
  return lines.join("\n");
};

module.exports = { routesFor, ask, measure, prepare };

if (require.main === module) (async () => {
  const weak = !!arg("weak");
  const n = +arg("n", 20);
  const repeat = +arg("repeat", 1);
  const only = arg("only") && arg("only") !== true ? String(arg("only")).split(",") : null;
  const ref = arg("ref") === true ? undefined : arg("ref");
  const label = arg("label") === true ? undefined : arg("label");
  const wantProfile = !!arg("profile");
  const bodiesDir = arg("bodies") && arg("bodies") !== true ? String(arg("bodies")) : null; // keep each answer (identity) for a before/after diff
  const out = { at: new Date().toISOString(), ref: ref || "working tree", weak, n, repeat, rows: [] };
  const srv = await start({ weak, ref, probe: "light", config: { scanIntervalMinutes: 24 * 60 } });
  try {
    await srv.waitWarm();
    await srv.waitQuiet();
    // past the torrent engine's code preload (60 s after boot: seconds of the loop here)
    { const s = await srv.snap(); if (s.uptimeMs < 80000) await sleep(80000 - s.uptimeMs); }
    const s0 = await srv.snap();
    out.afterWarm = { rssMb: round(s0.mem.rss / 1048576, 1), heapMb: round(s0.mem.heapUsed / 1048576, 1) };
    let list = await prepare(srv, routesFor(srv));
    if (only) list = list.filter((r) => only.some((o) => r.name.toLowerCase().includes(o.toLowerCase())));
    const runs = [];
    for (let k = 0; k < repeat; k++) {
      const rows = [];
      for (const r of list) {
        const row = await measure(srv, r, { n, wantProfile: wantProfile && k === 0, bodies: k === 0 ? bodiesDir : null });
        rows.push(row);
        process.stderr.write(`[routes] ${row.name}: ${row.status} srv p50 ${row.serverP50} ms  cpu ${row.cpuMs} ms  ${row.raw ?? ""}B -> br ${row.br ?? ""}B  ${row.etag || ""} ${row.inm || ""}\n`);
      }
      runs.push(rows);
    }
    // medians across repeats for the timing columns; first-run values for the rest
    out.rows = runs[0].map((row, i) => {
      const m = (k) => (runs.every((rs) => rs[i][k] != null) ? round(median(runs.map((rs) => rs[i][k])), 2) : row[k]);
      return { ...row, serverP50: m("serverP50"), serverP95: m("serverP95"), cpuMs: m("cpuMs"), loopMs: m("loopMs"), warmP50: m("warmP50"), warmP95: m("warmP95") };
    });
    const s1 = await srv.snap();
    out.afterRun = { rssMb: round(s1.mem.rss / 1048576, 1), heapMb: round(s1.mem.heapUsed / 1048576, 1) };
  } finally { await srv.stop(); }
  const f = saveJson(`routes${weak ? "-weak" : ""}${label ? `-${label}` : ""}.json`, out);
  console.log(table(out.rows));
  if (wantProfile) for (const r of out.rows) if (r.profile) console.log(`\n${r.name}:\n  ${r.profile.join("\n  ")}`);
  console.log(`\n${f}`);
  agent.destroy();
})().catch((e) => { console.error(e); process.exit(1); });
