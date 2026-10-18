#!/usr/bin/env node
// Fault injection against a PRIVATE Aurora instance (scripts/ui-test-server.js
// start(): its own folder, port, data and library; no outbound network).
// Never point this at the live server.
//
//   node tools/resilience/faultinject.js [--repo <checkout>] [--label after] [--seconds 20] [--only a,b]
//
// --repo: the checkout whose scripts/ui-test-server.js (and so whose server)
// is started — this one by default; an exported older commit for "before".
//
// A local FAKE UPSTREAM stands in for every provider (TMDB, Cinemeta,
// TVmaze…; tools/resilience/preload.js routes them to it) and is switched
// between: answering (20 ms), 500, never answering, dripping a byte a
// second. Against it, scenario by scenario:
//
//   baseline      providers fine
//   up-500        providers answer 500
//   up-hang       providers never answer
//   up-drip       providers answer headers, then a byte a second
//   slowloris     300 clients dripping their headers + 200 dripping a body
//   idle-sockets  1500 connections opened and never used
//   ws-flood      20 sockets sending as fast as they can + 5 oversize messages
//
// Throughout, NORMAL USERS (6 loops: the library, a title, the health check,
// a script file) measure their latency; PAGE USERS (8 loops, upstream
// scenarios only) open catalogue title pages and searches that need the
// provider and measure how long a page waits. The fake counts the
// connections the server holds open to it. The instance's CPU time, event-
// loop delay and memory come from the preload's side door.
//
// Output: one JSON line per scenario, and a table, on stdout.
"use strict";
const path = require("path");
const http = require("http");
const net = require("net");
const fs = require("fs");

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const REPO = path.resolve(arg("repo", path.join(__dirname, "..", "..")));
const LABEL = arg("label", "run");
const SECONDS = Number(arg("seconds", 20));
const ONLY = arg("only", "") ? arg("only").split(",") : null;
// a smaller box: the instance pinned to N cores (Windows: processor
// affinity; Linux: taskset), and/or its heap capped (--heap MB)
const CORES = Number(arg("cores", 0)) || 0;
const HEAP_MB = Number(arg("heap", 0)) || 0;
const pin = (pid) => {
  if (!CORES) return;
  const { execFileSync } = require("child_process");
  try {
    if (process.platform === "win32") execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).ProcessorAffinity = ${(1 << CORES) - 1}`], { stdio: "ignore" });
    else execFileSync("taskset", ["-a", "-p", `0x${((1 << CORES) - 1).toString(16)}`, String(pid)], { stdio: "ignore" });
  } catch (e) { console.error(`[faultinject] could not pin to ${CORES} cores: ${e.message}`); }
};
const WebSocket = require(path.join(REPO, "node_modules", "ws"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (list, q) => { if (!list.length) return null; const s = [...list].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] * 10) / 10; };

// ---------- the fake upstream ----------
let mode = "ok";
let fakeOpen = 0;
let fakeMaxOpen = 0;
let fakeRequests = 0;
const fake = http.createServer((req, res) => {
  fakeRequests++;
  const body = JSON.stringify(req.url.includes("/meta/")
    ? { meta: { id: "tt1", name: "Fake Title", releaseInfo: "2001", genres: ["Drama"], description: "fake" } }
    : { metas: [{ id: "tt1", name: "Fake", poster: "https://images.metahub.space/poster/small/tt1/img", releaseInfo: "2001" }], results: [], subtitles: [] });
  if (mode === "ok") return setTimeout(() => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(body); }, 20);
  if (mode === "500") { res.writeHead(500, { "Content-Type": "application/json" }); return res.end('{"error":"boom"}'); }
  if (mode === "hang") return; // never
  if (mode === "drip") {
    res.writeHead(200, { "Content-Type": "application/json" });
    const iv = setInterval(() => { try { res.write(" "); } catch {} }, 1000);
    res.on("close", () => clearInterval(iv));
  }
});
const fakeSockets = new Set();
fake.on("connection", (s) => { fakeOpen++; fakeMaxOpen = Math.max(fakeMaxOpen, fakeOpen); fakeSockets.add(s); s.on("close", () => { fakeOpen--; fakeSockets.delete(s); }); });
const dropFakeSockets = () => { for (const s of fakeSockets) s.destroy(); };
const probeRead = async (url) => {
  let last = null;
  for (let i = 0; i < 4; i++) {
    try { return await (await fetch(url, { signal: AbortSignal.timeout(5000) })).json(); } catch (e) { last = e; await sleep(300); }
  }
  return { error: String(last && last.message), loop: {} };
};

// ---------- helpers ----------
const getTimed = (url, timeoutMs = 30000) => new Promise((resolve) => {
  const t0 = performance.now();
  const req = http.get(url, { agent: keepAgent, timeout: timeoutMs }, (res) => {
    res.resume();
    res.on("end", () => resolve({ ms: performance.now() - t0, status: res.statusCode }));
    res.on("error", () => resolve({ ms: performance.now() - t0, status: 0 }));
  });
  req.on("timeout", () => req.destroy(new Error("timeout")));
  req.on("error", () => resolve({ ms: performance.now() - t0, status: 0 }));
});
const keepAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });

const loop = async (stopAt, fn, out) => { while (Date.now() < stopAt) out.push(await fn()); };

const scenario = async (srv, probe, name, setup) => {
  await probeRead(`${probe}/reset`);
  fakeMaxOpen = fakeOpen;
  fakeRequests = 0;
  const ctx = { cleanup: [], notes: {} };
  const upstreamCase = name.startsWith("up-") || name === "baseline";
  if (setup) await setup(ctx);
  // (the stalled-client cases run 12 s longer: the server's header limit is 20 s)
  const stopAt = Date.now() + (SECONDS + (name === "slowloris" || name === "idle-sockets" ? 12 : 0)) * 1000;
  const normal = [];
  const pages = [];
  const urls = srv.normalUrls;
  const users = Array.from({ length: 6 }, (_, i) => loop(stopAt, async () => getTimed(srv.url + urls[(i + Math.floor(Math.random() * 100)) % urls.length]), normal));
  let n = 0;
  const pageUsers = upstreamCase ? Array.from({ length: 8 }, (_, i) => loop(stopAt, async () => {
    n++;
    const u = n % 3 === 0 ? `/api/discover/search?q=zz${n}${i}` : `/api/discover/meta/movie/tt${7000000 + n * 10 + i}`;
    return getTimed(srv.url + u, 30000);
  }, pages)) : [];
  await Promise.all([...users, ...pageUsers]);
  const p = await probeRead(probe);
  for (const c of ctx.cleanup) { try { await c(); } catch {} }
  const ok = (l) => l.filter((x) => x.status && x.status < 500);
  const r = {
    label: LABEL, scenario: name,
    normal: { n: normal.length, ok: ok(normal).length, p50: pct(normal.map((x) => x.ms), 0.5), p95: pct(normal.map((x) => x.ms), 0.95), p99: pct(normal.map((x) => x.ms), 0.99), max: pct(normal.map((x) => x.ms), 1) },
    pages: pages.length ? { n: pages.length, p50: pct(pages.map((x) => x.ms), 0.5), p95: pct(pages.map((x) => x.ms), 0.95), max: pct(pages.map((x) => x.ms), 1), statuses: [...new Set(pages.map((x) => x.status))].join("/") } : null,
    upstream: upstreamCase ? { requests: fakeRequests, maxOpenSockets: fakeMaxOpen } : null,
    server: p.error ? { error: p.error } : { cpuMs: p.cpuMs, loopP50: Math.round(p.loop.p50 * 10) / 10, loopP99: Math.round(p.loop.p99 * 10) / 10, loopMax: Math.round(p.loop.max * 10) / 10, rssMb: Math.round(p.rss / 1048576), handles: p.handles },
    notes: ctx.notes,
  };
  console.log(JSON.stringify(r));
  return r;
};

const SCENARIOS = {
  baseline: async () => { mode = "ok"; },
  "up-500": async () => { mode = "500"; },
  "up-hang": async () => { mode = "hang"; },
  "up-drip": async () => { mode = "drip"; },
  slowloris: async (ctx, srv) => {
    mode = "ok";
    const socks = [];
    const t0 = Date.now();
    let closed = 0;
    const closedAt = [];
    for (let i = 0; i < 500; i++) {
      const s = net.connect(srv.port, "127.0.0.1");
      s.on("error", () => {});
      s.on("data", () => {}); // (a socket that does not read never hears the server close it)
      s.on("close", () => { closed++; closedAt.push(Date.now() - t0); });
      const body = i >= 300;
      s.once("connect", () => s.write(body ? "POST /api/usage HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100000\r\n\r\n" : "GET /api/library HTTP/1.1\r\nHost: x\r\n"));
      socks.push(s);
      if (i % 50 === 49) await sleep(50);
    }
    const iv = setInterval(() => { for (const s of socks) { try { if (!s.destroyed) s.write("a"); } catch {} } }, 1000);
    ctx.cleanup.push(async () => {
      clearInterval(iv);
      ctx.notes.slowSockets = 500;
      ctx.notes.closedByServer = closed;
      ctx.notes.closedAfterMsP50 = pct(closedAt, 0.5);
      for (const s of socks) s.destroy();
    });
  },
  "idle-sockets": async (ctx, srv) => {
    mode = "ok";
    const socks = [];
    let closed = 0;
    for (let i = 0; i < 1500; i++) {
      const s = net.connect(srv.port, "127.0.0.1");
      s.on("error", () => {});
      s.on("data", () => {}); // (a socket that does not read never hears the server close it)
      s.on("close", () => closed++);
      socks.push(s);
      if (i % 50 === 49) await sleep(60);
    }
    ctx.cleanup.push(async () => {
      ctx.notes.idleSockets = 1500;
      ctx.notes.closedByServer = closed;
      for (const s of socks) s.destroy();
    });
  },
  "ws-flood": async (ctx, srv) => {
    mode = "ok";
    const wss = [];
    let closes = {};
    for (let i = 0; i < 25; i++) {
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}`);
      ws.on("error", () => {});
      ws.on("close", (code) => { closes[code] = (closes[code] || 0) + 1; });
      wss.push(ws);
    }
    await sleep(800);
    let stop = false;
    const msg = JSON.stringify({ type: "activity", action: "Browsing", details: "x".repeat(100) });
    const big = "x".repeat(2 * 1024 * 1024);
    wss.slice(20).forEach((ws) => { try { ws.send(big); } catch {} });
    // as fast as the socket takes it (not faster: this process must not
    // buffer gigabytes of its own sends)
    const blast = async (ws) => { while (!stop && ws.readyState === WebSocket.OPEN) { if (ws.bufferedAmount > 1 << 20) { await sleep(5); continue; } for (let k = 0; k < 200; k++) ws.send(msg); await new Promise((r) => setImmediate(r)); } };
    wss.slice(0, 20).forEach((ws) => blast(ws));
    ctx.cleanup.push(async () => {
      stop = true;
      ctx.notes.wsCloses = closes;
      for (const ws of wss) { try { ws.terminate(); } catch {} }
    });
  },
};

const boot = async () => {
  const { start } = require(path.join(REPO, "scripts", "ui-test-server.js"));
  const srv = await start({
    preload: [path.join(__dirname, "preload.js")],
    env: { AURORA_FAKE_UPSTREAM: `http://127.0.0.1:${fake.address().port}`, AURORA_PROBE: "1", ...(HEAP_MB ? { NODE_OPTIONS: `--max-old-space-size=${HEAP_MB}` } : {}) },
    config: { onlineMetadata: false },
  });
  pin(srv.pid);
  let probePort = null;
  for (let i = 0; i < 50 && !probePort; i++) { try { probePort = Number(fs.readFileSync(path.join(srv.root, "probe-port"), "utf8")); } catch { await sleep(100); } }
  const lib = await (await fetch(`${srv.url}/api/library`)).json();
  const ids = [...(lib.movies || []), ...(lib.shows || [])].map((m) => m.id).filter(Boolean);
  srv.normalUrls = ["/api/library", "/healthz", "/js/main.js", ...ids.map((id) => `/api/item/${id}`)];
  srv.probe = `http://127.0.0.1:${probePort}`;
  return srv;
};

(async () => {
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  console.error(`[faultinject] ${LABEL}: repo ${REPO}, ${SECONDS}s per scenario, a fresh private instance for each${CORES ? `, pinned to ${CORES} cores` : ""}${HEAP_MB ? `, heap ${HEAP_MB} MB` : ""}`);
  const results = [];
  const notable = [];
  for (const [name, setup] of Object.entries(SCENARIOS)) {
    if (ONLY && !ONLY.includes(name)) continue;
    mode = "ok";
    const srv = await boot();
    try {
      results.push(await scenario(srv, srv.probe, name, setup && ((ctx) => setup(ctx, srv))));
      await sleep(1500);
      for (const l of srv.log()) if (/\[upstream\]|\[slow\]|\[ratelimit\]|\[ws\]|\[http\]|uncaught|unhandled/i.test(l)) notable.push(`${name}: ${l}`);
    } catch (e) {
      console.error(`[faultinject] ${name} failed: ${(e && e.stack) || e}\n  ${srv.log().slice(-15).join("\n  ")}`);
    } finally {
      await srv.stop();
      dropFakeSockets();
      await sleep(1000);
    }
  }
  console.error("\nscenario      | normal p50/p95/p99/max ms | pages p50/p95/max ms (status) | upstream reqs / max sockets | loop p99/max ms | cpu ms | notes");
  for (const r of results) {
    console.error(`${r.scenario.padEnd(13)} | ${[r.normal.p50, r.normal.p95, r.normal.p99, r.normal.max].join(" / ").padEnd(25)} | ${r.pages ? `${r.pages.p50} / ${r.pages.p95} / ${r.pages.max} (${r.pages.statuses}, n=${r.pages.n})` : "-"} | ${r.upstream ? `${r.upstream.requests} / ${r.upstream.maxOpenSockets}` : "-"} | ${r.server.loopP99} / ${r.server.loopMax} | ${r.server.cpuMs} | ${JSON.stringify(r.notes)}`);
  }
  console.error(`\nserver log lines of note (${notable.length}):
  ${notable.slice(-40).join("\n  ")}`);
  fake.close();
  keepAgent.destroy();
  setTimeout(() => process.exit(0), 500).unref();
})().catch((e) => { console.error(e); process.exit(1); });
