// Preloaded (node -r) into the PRIVATE instance by tools/loadtest/instance.js,
// after the network fence. It changes nothing the server does; it measures:
//
//   event loop   delay histogram (perf_hooks, 10 ms resolution... and a 1 ms
//                resolution one for the percentiles), utilisation (ELU)
//   CPU          process user + system
//   memory       RSS, heap used/total, external, array buffers; GC count + pause
//   handles      active handles (sockets, timers, files, child pipes)
//   fs           calls per fs function (counted only: no stack capture, so it is
//                cheap), bytes written per data/ file (sync, async, streams)
//   http         server-side time per route group (request -> response finish),
//                responses by status, requests in flight
//
// and answers on 127.0.0.1:<LT_PROBE_PORT>:
//   GET /snap     everything above since the last reset, as JSON
//   GET /reset    start a new window
//   GET /gc       a full collection (needs --expose-gc)
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const { performance, PerformanceObserver, monitorEventLoopDelay } = require("perf_hooks");

const ROOT = process.cwd();
const now = () => performance.now();
const r2 = (x) => Math.round(x * 100) / 100;

// ---------- route groups (the same names the load driver uses) ----------
const group = (method, url) => {
  const p = String(url || "").split("?")[0];
  if (p === "/healthz" || p === "/api/ping") return "health";
  if (/^\/stream\/video\//.test(p)) return "direct";
  if (/\.m3u8$/.test(p)) return "playlist";
  if (/\.(ts|m4s|mp4|aac)$/.test(p) && /^\/stream\//.test(p)) return "segment";
  if (/^\/stream\//.test(p)) return "stream-other";
  if (/^\/img\//.test(p) || /^\/api\/(proxy\/)?img/.test(p) || /^\/api\/poster/.test(p)) return "image";
  if (/^\/api\/home/.test(p)) return "home";
  if (/^\/api\/search\/suggest/.test(p)) return "suggest";
  if (/^\/api\/search/.test(p)) return "search";
  if (/^\/api\/library/.test(p)) return "library";
  if (/\/progress$/.test(p) && method === "POST") return "progress";
  if (/^\/api\/profiles\/[^/]+\/state/.test(p)) return "state";
  if (/^\/api\/(item|title|meta|discover|similar|xray|person|availability|vibe|nextep)/.test(p)) return "title";
  if (/^\/api\/usage|^\/api\/tel|^\/api\/reports/.test(p)) return "telemetry";
  if (/^\/api\/tv\//.test(p) || /tv-version\.json$/.test(p)) return "tv";
  if (/^\/api\//.test(p)) return "api-other";
  return "static";
};

// ---------- fs ----------
const fsCalls = new Map();
const slowSync = [];
const writes = new Map(); // data/ file (folded) -> { n, bytes }
const fdPaths = new Map();
const fileKey = (p) => {
  let r = String(typeof p === "number" ? fdPaths.get(p) || `fd:${p}` : p && p.href ? p.pathname : p);
  if (r.startsWith(ROOT)) r = r.slice(ROOT.length + 1);
  r = r.replace(/\\/g, "/").replace(/\.(tmp[-.\w]*|\d+)$/, "").replace(/\.(tmp[-.\w]*|\d+)$/, "");
  return r.replace(/^(data\/cache\/[^/]+)\/.*/, "$1/*").replace(/^(data\/(?:usage|backups|aria2))\/.*/, "$1/*");
};
const sizeOf = (d) => (typeof d === "string" ? Buffer.byteLength(d) : d && d.byteLength != null ? d.byteLength : 0);
const noteWrite = (p, data) => {
  const k = fileKey(p);
  let w = writes.get(k);
  if (!w) writes.set(k, (w = { n: 0, bytes: 0 }));
  w.n++;
  w.bytes += sizeOf(data);
};
const copyProps = (from, to) => { for (const k of Reflect.ownKeys(from)) { if (k === "length" || k === "name" || k === "prototype") continue; try { Object.defineProperty(to, k, Object.getOwnPropertyDescriptor(from, k)); } catch {} } return to; };
const SKIP = new Set(["Stats", "Dirent", "Dir", "ReadStream", "WriteStream", "FileReadStream", "FileWriteStream", "createReadStream", "createWriteStream", "watch", "watchFile", "unwatchFile", "constants", "promises", "F_OK", "R_OK", "W_OK", "X_OK"]);
for (const name of Object.keys(fs)) {
  const orig = fs[name];
  if (typeof orig !== "function" || SKIP.has(name) || /^[A-Z]/.test(name)) continue;
  const c = { n: 0 };
  fsCalls.set(name, c);
  const wrapped = function (...a) {
    c.n++;
    if (name === "writeFileSync" || name === "appendFileSync" || name === "writeFile" || name === "appendFile") noteWrite(a[0], a[1]);
    else if ((name === "writeSync" || name === "write") && typeof a[0] === "number" && fdPaths.has(a[0])) noteWrite(a[0], a[1]);
    const sync = name.endsWith("Sync");
    const t0 = sync ? now() : 0;
    const ret = orig.apply(this, a);
    if (sync) {
      const ms = now() - t0;
      c.ms = (c.ms || 0) + ms;
      // the slowest synchronous calls of the window: each one held the event loop that long
      if (ms > 20) { slowSync.push({ fn: name, arg: typeof a[0] === "string" ? a[0].slice(-90) : typeof a[0], ms: r2(ms), at: r2(now()) }); if (slowSync.length > 200) { slowSync.sort((x, y) => y.ms - x.ms); slowSync.length = 100; } }
    }
    if (name === "openSync" && /[wa]/.test(String(a[1] || "r"))) fdPaths.set(ret, String(a[0]));
    else if (name === "closeSync") fdPaths.delete(a[0]);
    return ret;
  };
  fs[name] = copyProps(orig, wrapped);
}
for (const name of ["writeFile", "appendFile"]) {
  const p = fs.promises[name];
  const c = { n: 0 };
  fsCalls.set(`promises.${name}`, c);
  fs.promises[name] = function (...a) { c.n++; noteWrite(a[0], a[1]); return p.apply(this, a); };
}
for (const name of ["readFile", "stat", "open", "readdir", "rename", "unlink", "rm", "mkdir", "copyFile", "lstat", "access"]) {
  const p = fs.promises[name];
  if (typeof p !== "function") continue;
  const c = { n: 0 };
  fsCalls.set(`promises.${name}`, c);
  fs.promises[name] = function (...a) { c.n++; return p.apply(this, a); };
}
const cws = fs.createWriteStream;
fs.createWriteStream = function (p, ...rest) {
  const s = cws.call(this, p, ...rest);
  const w = s.write;
  s.write = function (chunk, ...r) { noteWrite(p, chunk); return w.call(this, chunk, ...r); };
  return s;
};
let readStreams = 0;
const crs = fs.createReadStream;
fs.createReadStream = function (...a) { readStreams++; return crs.apply(this, a); };

// ---------- child processes started synchronously (they hold the loop for their whole run) ----------
const cp = require("child_process");
for (const name of ["spawnSync", "execFileSync", "execSync"]) {
  const orig = cp[name];
  const c = { n: 0, ms: 0 };
  fsCalls.set(`child_process.${name}`, c);
  cp[name] = function (...a) {
    const t0 = now();
    try { return orig.apply(this, a); } finally {
      const ms = now() - t0;
      c.n++; c.ms += ms;
      if (ms > 20) slowSync.push({ fn: name, arg: String(a[0]).split(/[\\/]/).pop().slice(0, 40) + " " + (Array.isArray(a[1]) ? a[1].slice(0, 4).join(" ") : "").slice(0, 60), ms: r2(ms), at: r2(now()) });
    }
  };
}

// ---------- http, server side ----------
const routes = new Map(); // group -> { n, ms: [], codes }
let inFlight = 0, maxInFlight = 0, upgrades = 0;
const control = { server: null };
const origEmit = http.Server.prototype.emit;
http.Server.prototype.emit = function (ev, req, res) {
  if (this !== control.server) {
    if (ev === "request" && req && res) {
      const t0 = now();
      const g = group(req.method, req.url);
      inFlight++; if (inFlight > maxInFlight) maxInFlight = inFlight;
      let done = false;
      const fin = () => {
        if (done) return;
        done = true;
        inFlight--;
        let r = routes.get(g);
        if (!r) routes.set(g, (r = { n: 0, ms: [], codes: {}, aborted: 0 }));
        r.n++;
        const ms = now() - t0;
        if (r.ms.length < 50000) r.ms.push(ms); else r.ms[Math.floor(Math.random() * 50000)] = ms;
        r.codes[res.statusCode] = (r.codes[res.statusCode] || 0) + 1;
        if (!res.writableFinished) r.aborted++;
      };
      res.once("finish", fin);
      res.once("close", fin);
    } else if (ev === "upgrade") upgrades++;
  }
  return origEmit.apply(this, arguments);
};

// ---------- the process ----------
const gc = {};
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      const k = e.detail && e.detail.kind === 1 ? "minor" : e.detail && e.detail.kind === 4 ? "major" : "other";
      const g = gc[k] || (gc[k] = { n: 0, ms: 0, maxMs: 0 });
      g.n++; g.ms += e.duration; if (e.duration > g.maxMs) g.maxMs = e.duration;
    }
  }).observe({ entryTypes: ["gc"] });
} catch {}
// resolution 1 ms: monitorEventLoopDelay samples with a timer of that period;
// the histogram records how late each tick fired (the time everyone waited).
const loop = monitorEventLoopDelay({ resolution: 1 });
loop.enable();
// Stalls, counted by a timer of our own. On Windows every timer is rounded to
// the 15.6 ms system tick, so the histogram above reads ~14 ms at its median
// on an idle server; what is comparable across machines is how often, and
// for how long, the loop was held well past that: delays over 50 / 100 / 250
// / 1000 ms, and their total.
const STALL_EVERY = 20;
const stalls = { n50: 0, n100: 0, n250: 0, n1000: 0, totalMs: 0, busyMs: 0, waitMs: 0, cpuMs: 0, max: 0, ticks: 0 };
// For each stall: how much CPU the process used during it. A stall that used
// its whole length in CPU is the server's own work; one that used next to
// none was spent WAITING — a synchronous disk call, or a machine so busy the
// thread was not scheduled (other agents share this PC).
let lastTick = now();
let lastCpu = process.cpuUsage();
const stallList = [];
const stallTick = () => {
  const t = now();
  const d = t - lastTick - STALL_EVERY;
  const cpu = process.cpuUsage();
  const cpuMs = (cpu.user - lastCpu.user + cpu.system - lastCpu.system) / 1000;
  lastTick = t;
  lastCpu = cpu;
  stalls.ticks++;
  if (d > 50) {
    stalls.n50++; stalls.totalMs += d; if (d > 100) stalls.n100++; if (d > 250) stalls.n250++; if (d > 1000) stalls.n1000++;
    // (the process has other threads — libuv's pool, GC helpers — so cpu can exceed the gap; capped)
    const own = Math.min(d, cpuMs);
    stalls.cpuMs += own;
    if (own < d * 0.5) stalls.waitMs += d; else stalls.busyMs += d;
    if (d > 250) { stallList.push({ at: r2(t), ms: r2(d), cpuMs: r2(cpuMs), slow: slowSync.filter((x) => x.at >= t - d - 5 && x.at <= t).sort((a, b) => b.ms - a.ms).slice(0, 2).map((x) => `${x.fn} ${r2(x.ms)}ms ${x.arg}`) }); if (stallList.length > 60) stallList.shift(); }
  }
  if (d > stalls.max) stalls.max = d;
  setTimeout(stallTick, STALL_EVERY).unref();
};
setTimeout(stallTick, STALL_EVERY).unref();
let elu0 = performance.eventLoopUtilization();
let cpu0 = process.cpuUsage();
let resetAt = now();
const pctOf = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]; };

const snap = () => {
  const mem = process.memoryUsage();
  const elu = performance.eventLoopUtilization(elu0);
  const cpu = process.cpuUsage(cpu0);
  const ms = (ns) => r2(ns / 1e6);
  const hist = {};
  // how much of the window the loop spent late by more than X (a "stall budget")
  for (const [k, v] of loop.percentiles) hist[String(r2(k))] = ms(v);
  return {
    pid: process.pid, uptimeMs: r2(now()), windowMs: r2(now() - resetAt),
    cpu: { userMs: r2(cpu.user / 1000), systemMs: r2(cpu.system / 1000) },
    elu: r2(elu.utilization * 1000) / 1000,
    loop: { n: loop.count, mean: ms(loop.mean), p50: ms(loop.percentile(50)), p90: ms(loop.percentile(90)), p99: ms(loop.percentile(99)), p999: ms(loop.percentile(99.9)), max: ms(loop.max), percentiles: hist },
    stalls: { ...stalls, totalMs: r2(stalls.totalMs), busyMs: r2(stalls.busyMs), waitMs: r2(stalls.waitMs), cpuMs: r2(stalls.cpuMs), max: r2(stalls.max), list: stallList.slice(-25) },
    gc: Object.fromEntries(Object.entries(gc).map(([k, v]) => [k, { n: v.n, ms: r2(v.ms), maxMs: r2(v.maxMs) }])),
    mem: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external, arrayBuffers: mem.arrayBuffers },
    handles: process._getActiveHandles ? process._getActiveHandles().length : null,
    requests: process._getActiveRequests ? process._getActiveRequests().length : null,
    fs: Object.fromEntries([...fsCalls].filter(([, c]) => c.n).sort((a, b) => b[1].n - a[1].n).map(([k, c]) => [k, c.n])),
    readStreams,
    syncMs: Object.fromEntries([...fsCalls].filter(([, c]) => c.ms > 1).sort((a, b) => b[1].ms - a[1].ms).slice(0, 12).map(([k, c]) => [k, r2(c.ms)])),
    slowSync: slowSync.slice().sort((x, y) => y.ms - x.ms).slice(0, 15),
    writes: Object.fromEntries([...writes].filter(([k]) => /^data\//.test(k)).sort((a, b) => b[1].bytes - a[1].bytes).map(([k, w]) => [k, w])),
    writesOutsideData: [...writes].filter(([k]) => !/^data\//.test(k) && !/^tmp\//.test(k)).map(([k, w]) => ({ file: k, ...w })).slice(0, 20),
    http: {
      inFlight, maxInFlight, upgrades,
      routes: Object.fromEntries([...routes].map(([g, r]) => [g, { n: r.n, p50: r2(pctOf(r.ms, 50)), p95: r2(pctOf(r.ms, 95)), p99: r2(pctOf(r.ms, 99)), max: r2(r.ms.length ? Math.max(...r.ms) : 0), codes: r.codes, aborted: r.aborted }])),
    },
  };
};
const reset = () => {
  for (const c of fsCalls.values()) { c.n = 0; c.ms = 0; }
  slowSync.length = 0;
  writes.clear(); routes.clear(); readStreams = 0; maxInFlight = inFlight; upgrades = 0;
  for (const k of Object.keys(gc)) delete gc[k];
  loop.reset();
  Object.assign(stalls, { n50: 0, n100: 0, n250: 0, n1000: 0, totalMs: 0, busyMs: 0, waitMs: 0, cpuMs: 0, max: 0, ticks: 0 });
  stallList.length = 0;
  elu0 = performance.eventLoopUtilization();
  cpu0 = process.cpuUsage();
  resetAt = now();
};

control.server = http.createServer((req, res) => {
  const send = (code, data) => { const s = JSON.stringify(data); res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) }); res.end(s); };
  try {
    const u = req.url.split("?")[0];
    if (u === "/snap") { const s = snap(); if (/reset=1/.test(req.url)) reset(); return send(200, s); }
    if (u === "/reset") { reset(); return send(200, { ok: true }); }
    if (u === "/gc") { if (global.gc) { global.gc(); global.gc(); } return send(200, { ok: !!global.gc, mem: process.memoryUsage() }); }
    send(404, { error: "unknown" });
  } catch (e) { send(500, { error: String((e && e.stack) || e) }); }
});
control.server.listen(Number(process.env.LT_PROBE_PORT) || 0, "127.0.0.1");
control.server.unref();
module.exports = { group };
