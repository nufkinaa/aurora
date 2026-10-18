// Preloaded (node -r) into the PRIVATE instance by tools/backend-perf/instance.js.
// It changes nothing about what the server does; it counts what it does:
//
//   require()        every module load: inclusive and self milliseconds, in order
//   fs.*Sync         calls and time per function, and per call site (first src/ frame)
//   file writes      bytes and writes per file (writeFile, appendFile, their Sync twins, promises)
//   timers           every setInterval / setTimeout created from src/: site, delay, fires, time in the callback
//   child processes  every spawn / execFile / exec (and Sync): program, first arguments, site, blocking time
//   outbound         every connection attempt that is not this machine (the UI preload refuses them)
//   the process      CPU (user/system), event-loop utilisation and delay, GC count and pause time, memory
//
// and it answers on 127.0.0.1:<EFF_PROBE_PORT>:
//
//   GET  /snap            everything above, as JSON
//   GET  /reset           zero the counters (the module table stays)
//   POST /exec            { file, arg }  -> require(file)(arg, ctx): a measurement that must run INSIDE the process
//   GET  /cpu/start, /cpu/stop[?file=]   V8 CPU profile of a window -> self time per function and per file
//   GET  /alloc/start, /alloc/stop       V8 sampling heap profile of a window -> bytes allocated, per function
//   GET  /heapsnapshot?file=             v8.writeHeapSnapshot
//   GET  /gc                             a full collection (needs --expose-gc)
//
// EFF_PROBE=full   (default) everything
// EFF_PROBE=light  no call-site capture, no fs/timer wrapping: for CPU-per-request runs,
//                  where the probe's own cost must not be in the number
// EFF_PROBE_LOOP=0 no event-loop delay monitor (it is a 10 ms timer: it would be
//                  the largest source of wake-ups in an idle run)
//
// One fence of its own: aria2c is never started (the download engine is a
// separate process the network fence cannot reach); the attempt is counted.
"use strict";
const Module = require("module");
const fs = require("fs");
const path = require("path");
const http = require("http");
const net = require("net");
const v8 = require("v8");
const cp = require("child_process");
const { performance, PerformanceObserver, monitorEventLoopDelay } = require("perf_hooks");

const MODE = process.env.EFF_PROBE || "full";
const FULL = MODE === "full";
const ROOT = process.cwd();
const now = () => performance.now();
const rel = (p) => {
  const s = String(p);
  return s.startsWith(ROOT) ? s.slice(ROOT.length + 1).replace(/\\/g, "/") : s.replace(/\\/g, "/");
};

// ---------- where a call came from: the first frame inside the instance's own code ----------
const SELF = __filename;
const site = () => {
  if (!FULL) return "?";
  const keep = Error.stackTraceLimit;
  const prep = Error.prepareStackTrace;
  Error.stackTraceLimit = 25;
  Error.prepareStackTrace = (_, frames) => frames;
  const frames = new Error().stack;
  Error.prepareStackTrace = prep;
  Error.stackTraceLimit = keep;
  let lib = null;
  for (const f of frames || []) {
    const file = f.getFileName && f.getFileName();
    if (!file || file === SELF || file.startsWith("node:")) continue;
    if (/ui-preload\.js$/.test(file)) continue;
    if (file.includes("node_modules")) { if (!lib) lib = `node_modules/${file.split("node_modules").pop().replace(/\\/g, "/").split("/").filter(Boolean).slice(0, 2).join("/")}`; continue; }
    if (file.startsWith(ROOT)) return `${rel(file)}:${f.getLineNumber()}`;
  }
  return lib || "?";
};

// ---------- require() ----------
const mods = []; // { id, ms, self, parent, order, at }
const stack = [];
// Timed where a file is actually LOADED (the extension handlers run once per
// file), never where it is merely asked for: a wrapper around require() itself
// turns every require() of an already-loaded module into a full path
// resolution — 80 µs instead of 1 µs on Node 22 — and the server has such
// calls inside its request handlers. (The first version of this probe did
// exactly that and added 140 ms to every Home request it measured.)
for (const ext of [".js", ".json", ".node"]) {
  const origExt = Module._extensions[ext];
  Module._extensions[ext] = function (module, filename) {
    const rec = { id: filename.includes("node_modules") ? `node_modules/${filename.split("node_modules").pop().replace(/\\/g, "/").replace(/^\//, "")}` : rel(filename), ms: 0, kids: 0, parent: stack.length ? stack[stack.length - 1].id : null, order: mods.length, at: now() };
    mods.push(rec);
    stack.push(rec);
    const t0 = now();
    try {
      return origExt.apply(this, arguments);
    } finally {
      rec.ms = now() - t0;
      stack.pop();
      if (stack.length) stack[stack.length - 1].kids += rec.ms;
    }
  };
}

// ---------- fs: sync calls, and bytes written ----------
const syncFs = new Map(); // "fn" -> { n, ms }   and   "fn @ site" -> { n, ms }
const bump = (map, key, ms, extra) => {
  let r = map.get(key);
  if (!r) map.set(key, (r = { n: 0, ms: 0 }));
  r.n++;
  r.ms += ms;
  if (extra) for (const k in extra) r[k] = (r[k] || 0) + extra[k];
};
const writes = new Map(); // file -> { n, bytes }
const asyncFs = new Map(); // "fsync" | "writeFile" | "write" -> { n } (off the loop)
const fdPaths = new Map(); // fd opened for writing -> its path
const fileKey = (p) => {
  // (a store's temp file: <name>.<pid>[.<n>|.a<n>].tmp -> <name>)
  let r = rel(typeof p === "number" ? `fd:${p}` : p).replace(/\.\d+(\.a?\d+)?\.tmp$/, "").replace(/\.tmp$/, "");
  r = r.replace(/^(data\/cache\/(?:img-variants|posters-web|posters|blur|stills|vtt|jit|hls|torrent-hls|offline|torrents))\/.*/, "$1/*");
  return r;
};
const sizeOf = (d) => (typeof d === "string" ? Buffer.byteLength(d) : d && d.byteLength != null ? d.byteLength : 0);
const noteWrite = (p, data) => bump(writes, fileKey(p), 0, { bytes: sizeOf(data) });
if (FULL) {
  for (const name of Object.keys(fs)) {
    if (!/Sync$/.test(name) || typeof fs[name] !== "function") continue;
    const orig = fs[name];
    fs[name] = function (...a) {
      const t0 = now();
      let ret;
      try { ret = orig.apply(this, a); if (name === "openSync" && /[wa]/.test(String(a[1] || "r"))) fdPaths.set(ret, a[0]); return ret; } finally {
        const ms = now() - t0;
        bump(syncFs, name, ms);
        bump(syncFs, `${name} @ ${site()}`, ms);
        if (name === "writeFileSync" || name === "appendFileSync") noteWrite(a[0], a[1]);
        // open(path, "w") + write(fd, text): how the stores are written since 1.6.93
        else if (name === "writeSync" && fdPaths.has(a[0])) noteWrite(fdPaths.get(a[0]), a[1]);
        else if (name === "closeSync") fdPaths.delete(a[0]);
      }
    };
  }
  for (const name of ["writeFile", "appendFile"]) {
    const orig = fs[name];
    fs[name] = function (...a) { noteWrite(a[0], a[1]); return orig.apply(this, a); };
    const p = fs.promises[name];
    fs.promises[name] = function (...a) { noteWrite(a[0], a[1]); return p.apply(this, a); };
  }
  const cws = fs.createWriteStream;
  // writes made off the loop (lib/jsonstore.js FileWriter): fs.promises.open
  // handles — bytes per file, and how many fsyncs reached the disk that way
  const pOpen = fs.promises.open;
  fs.promises.open = async function (p, flags, ...rest) {
    const fh = await pOpen.call(this, p, flags, ...rest);
    if (/[wa]/.test(String(flags || "r"))) {
      const key = fileKey(p);
      for (const m of ["writeFile", "write"]) {
        const orig = fh[m];
        if (typeof orig === "function") fh[m] = function (data, ...r) { bump(writes, key, 0, { bytes: sizeOf(data) }); bump(asyncFs, m, 0); return orig.call(this, data, ...r); };
      }
      const sync = fh.sync;
      fh.sync = function (...r) { bump(asyncFs, "fsync", 0); return sync.apply(this, r); };
    }
    return fh;
  };
  fs.createWriteStream = function (p, ...rest) {
    const s = cws.call(this, p, ...rest);
    const key = fileKey(p);
    const w = s.write;
    s.write = function (chunk, ...r) { bump(writes, key, 0, { bytes: sizeOf(chunk) }); return w.call(this, chunk, ...r); };
    return s;
  };
}

// ---------- timers ----------
const timers = new Map(); // "kind delay @ site" -> { kind, delay, site, created, fires, ms, live }
if (FULL) {
  for (const kind of ["setInterval", "setTimeout"]) {
    const orig = global[kind];
    const wrapped = function (fn, delay, ...args) {
      if (typeof fn !== "function") return orig(fn, delay, ...args);
      const at = site();
      const d = Math.round(Number(delay) || 0);
      const key = `${kind} ${d} @ ${at}`;
      let r = timers.get(key);
      if (!r) timers.set(key, (r = { kind, delay: d, site: at, created: 0, fires: 0, ms: 0, maxMs: 0 }));
      r.created++;
      const cb = function (...a) {
        const t0 = now();
        try { return fn.apply(this, a); } finally {
          const ms = now() - t0;
          r.fires++;
          r.ms += ms;
          if (ms > r.maxMs) r.maxMs = ms;
        }
      };
      return orig(cb, delay, ...args);
    };
    // util.promisify(setTimeout) must keep working
    for (const sym of Object.getOwnPropertySymbols(orig)) wrapped[sym] = orig[sym];
    global[kind] = wrapped;
  }
}

// ---------- child processes ----------
const spawns = new Map(); // "prog args… @ site" -> { n, ms (blocking, sync only), sync }
const blocked = { aria2c: 0 };
const progOf = (file) => path.basename(String(file || "?")).replace(/\.exe$/i, "").toLowerCase();
const describe = (file, args) => {
  const prog = progOf(file);
  const a = Array.isArray(args) ? args : [];
  let hint = "";
  if (prog === "ffmpeg" || prog === "ffprobe") {
    const flat = a.join(" ");
    hint = /-show_chapters/.test(flat) ? "chapters" : /-filters|-encoders|-version/.test(flat) ? flat.match(/-(filters|encoders|version)/)[0]
      : /blackdetect/.test(flat) ? "blackdetect" : /tonemap|zscale/.test(flat) ? "tonemap chain" : /s16le/.test(flat) ? "pcm decode"
      : /-show_entries/.test(flat) ? "probe" : /webvtt/.test(flat) ? "subtitle" : /libwebp|scale=/.test(flat) ? "picture" : /-f (segment|hls)/.test(flat) ? "segments" : a.slice(0, 3).join(" ");
  } else hint = a.slice(0, 3).join(" ").slice(0, 60);
  return `${prog} ${hint}`.trim();
};
for (const name of ["spawn", "execFile", "exec", "spawnSync", "execFileSync", "execSync"]) {
  const orig = cp[name];
  cp[name] = function (file, args, ...rest) {
    const isExec = name === "exec" || name === "execSync";
    const what = isExec ? String(file).split(/\s+/).slice(0, 3).join(" ").replace(/"/g, "").replace(/^.*[\\/]/, "").slice(0, 60) : describe(file, args);
    if (!isExec && progOf(file) === "aria2c") {
      blocked.aria2c++;
      if (/Sync$/.test(name)) throw Object.assign(new Error("eff-probe: aria2c is not started in a private instance"), { code: "ENOENT" });
      return orig.call(this, path.join(ROOT, "no-such-program-eff-probe"), [], { windowsHide: true });
    }
    const key = `${what} @ ${site()}`;
    const t0 = now();
    try { return orig.call(this, file, args, ...rest); } finally {
      bump(spawns, key, /Sync$/.test(name) ? now() - t0 : 0, { sync: /Sync$/.test(name) ? 1 : 0 });
    }
  };
}

// ---------- outbound connection attempts ----------
const outbound = new Map();
const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "::", "[::1]", "::ffff:127.0.0.1"]);
const prevConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const a = Array.isArray(args[0]) ? args[0] : args;
  let host = null;
  if (a[0] && typeof a[0] === "object") host = a[0].path ? null : a[0].host || a[0].hostname || "localhost";
  else if (typeof a[0] !== "string" || /^\d+$/.test(a[0])) host = typeof a[1] === "string" ? a[1] : "localhost";
  if (host && !LOCAL.has(String(host).toLowerCase())) bump(outbound, FULL ? `${host} @ ${site()}` : String(host), 0);
  return prevConnect.apply(this, args);
};

// ---------- the process ----------
const marks = { preloadAt: now() };
let onListening = null;
const origListen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...a) {
  this.once("listening", () => { if (!marks.listeningAt && this !== control) { marks.listeningAt = now(); marks.cpuAtListening = process.cpuUsage(); marks.rssAtListening = process.memoryUsage().rss; if (onListening) onListening(); } });
  return origListen.apply(this, a);
};
const gc = {};
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      const k = e.detail && e.detail.kind === 1 ? "scavenge" : e.detail && e.detail.kind === 4 ? "mark-compact" : e.detail && e.detail.kind === 8 ? "incremental" : "other";
      const g = gc[k] || (gc[k] = { n: 0, ms: 0, maxMs: 0 });
      g.n++; g.ms += e.duration; if (e.duration > g.maxMs) g.maxMs = e.duration;
    }
  }).observe({ entryTypes: ["gc"] });
} catch {}
let loop = null;
if (process.env.EFF_PROBE_LOOP !== "0") { loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable(); }
let elu0 = performance.eventLoopUtilization();
let cpu0 = process.cpuUsage();
let resetAt = now();

const snap = () => {
  const mem = process.memoryUsage();
  const hs = v8.getHeapStatistics();
  const elu = performance.eventLoopUtilization(elu0);
  const cpu = process.cpuUsage(cpu0);
  const obj = (map, sortKey = "ms") => [...map.entries()].map(([k, v]) => ({ key: k, ...v })).sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0));
  const ms = (x) => Math.round(x * 100) / 100;
  return {
    mode: MODE, pid: process.pid, uptimeMs: ms(now()), sinceResetMs: ms(now() - resetAt), marks,
    cpuTotal: process.cpuUsage(), cpuSinceReset: cpu, elu: { utilization: elu.utilization, activeMs: ms(elu.active), idleMs: ms(elu.idle) },
    loopDelay: loop ? { p50: loop.percentile(50) / 1e6, p99: loop.percentile(99) / 1e6, max: loop.max / 1e6, mean: loop.mean / 1e6 } : null,
    gc, mem: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external, arrayBuffers: mem.arrayBuffers },
    heap: { used: hs.used_heap_size, total: hs.total_heap_size, limit: hs.heap_size_limit, malloced: hs.malloced_memory, peakMalloced: hs.peak_malloced_memory },
    handles: process._getActiveHandles ? process._getActiveHandles().length : null,
    resource: process.resourceUsage ? (({ fsRead, fsWrite, voluntaryContextSwitches, involuntaryContextSwitches, maxRSS }) => ({ fsRead, fsWrite, voluntaryContextSwitches, involuntaryContextSwitches, maxRSS }))(process.resourceUsage()) : null,
    modules: mods.map((m) => ({ id: m.id, ms: ms(m.ms), self: ms(m.ms - m.kids), parent: m.parent, order: m.order, at: ms(m.at) })),
    syncFs: obj(syncFs).map((r) => ({ ...r, ms: ms(r.ms) })), writes: obj(writes, "bytes"), asyncFs: obj(asyncFs, "n"),
    timers: obj(timers, "fires").map((r) => ({ ...r, ms: ms(r.ms), maxMs: ms(r.maxMs) })),
    spawns: obj(spawns, "n").map((r) => ({ ...r, ms: ms(r.ms) })), outbound: obj(outbound, "n"), blocked, bootProfiles,
  };
};
const reset = () => {
  syncFs.clear(); asyncFs.clear(); writes.clear(); spawns.clear(); outbound.clear();
  for (const r of timers.values()) { r.fires = 0; r.ms = 0; r.maxMs = 0; r.created = 0; }
  for (const k of Object.keys(gc)) delete gc[k];
  if (loop) loop.reset();
  elu0 = performance.eventLoopUtilization();
  cpu0 = process.cpuUsage();
  resetAt = now();
};

// ---------- profiles of a window ----------
let session = null;
const post = (method, params) => new Promise((resolve, reject) => {
  if (!session) { session = new (require("inspector").Session)(); session.connect(); }
  session.post(method, params || {}, (err, res) => (err ? reject(err) : resolve(res)));
});
const cpuSummary = (profile, top = 40) => {
  const dt = profile.timeDeltas || [];
  const self = new Map();
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  let total = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const n = byId.get(profile.samples[i]);
    const d = dt[i] || 0;
    total += d;
    self.set(n, (self.get(n) || 0) + d);
  }
  const fn = new Map();
  const file = new Map();
  for (const [n, us] of self) {
    const cf = n.callFrame;
    const url = cf.url ? (cf.url.startsWith("node:") ? cf.url : rel(cf.url.replace(/^file:\/\/\//, "").replace(/\//g, path.sep)).replace(/^.*node_modules\//, "node_modules/")) : "(native)";
    const name = `${cf.functionName || "(anonymous)"} ${url}${cf.lineNumber >= 0 ? `:${cf.lineNumber + 1}` : ""}`;
    fn.set(name, (fn.get(name) || 0) + us);
    const f = url.startsWith("node_modules/") ? `node_modules/${url.split("/")[1]}` : url;
    file.set(f, (file.get(f) || 0) + us);
  }
  const idle = [...fn].filter(([k]) => /^\((idle|program)\)/.test(k)).reduce((s, [, v]) => s + v, 0);
  const list = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, us]) => ({ name: k, ms: Math.round(us / 10) / 100 }));
  return { totalMs: Math.round(total / 1000), busyMs: Math.round((total - idle) / 1000), functions: list(fn), files: list(file) };
};
const allocSummary = (profile, top = 30) => {
  const fn = new Map();
  let total = 0;
  const walk = (n) => {
    if (n.selfSize) {
      const cf = n.callFrame;
      const url = cf.url ? (cf.url.startsWith("node:") ? cf.url : rel(cf.url.replace(/^file:\/\/\//, "").replace(/\//g, path.sep)).replace(/^.*node_modules\//, "node_modules/")) : "(native)";
      const name = `${cf.functionName || "(anonymous)"} ${url}${cf.lineNumber >= 0 ? `:${cf.lineNumber + 1}` : ""}`;
      fn.set(name, (fn.get(name) || 0) + n.selfSize);
      total += n.selfSize;
    }
    for (const c of n.children || []) walk(c);
  };
  walk(profile.head);
  return { totalBytes: total, functions: [...fn].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, b]) => ({ name: k, bytes: b })) };
};

// ---------- EFF_PROBE_BOOTPROF=1: a CPU profile of the boot itself ----------
// One profile from the first line of the preload to "listening", and a second
// from there until EFF_PROBE_BOOTPROF_MS later (default 25 s: the timers that
// build the recommender and the search index have fired by then).
const bootProfiles = {};
if (process.env.EFF_PROBE_BOOTPROF === "1") {
  // (posts to an in-process session are dispatched synchronously: the profiler
  // is running before the server's first line)
  const raw = (method, params, cb) => {
    if (!session) { session = new (require("inspector").Session)(); session.connect(); }
    session.post(method, params || {}, cb || (() => {}));
  };
  raw("Profiler.enable");
  raw("Profiler.setSamplingInterval", { interval: 250 });
  raw("Profiler.start");
  onListening = () => {
    raw("Profiler.stop", {}, (err, res) => {
      if (!err) bootProfiles.toListening = cpuSummary(res.profile, 70);
      raw("Profiler.start");
      setTimeout(() => raw("Profiler.stop", {}, (e2, r2) => { if (!e2) bootProfiles.afterListening = cpuSummary(r2.profile, 70); }), Number(process.env.EFF_PROBE_BOOTPROF_MS) || 25000).unref();
    });
  };
}

// ---------- the control door ----------
const ctx = { root: ROOT, req: (r) => require(path.join(ROOT, r)), snap, reset, now };
const body = (req) => new Promise((resolve) => { let s = ""; req.on("data", (d) => (s += d)); req.on("end", () => resolve(s)); });
const control = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const send = (code, data) => { const s = JSON.stringify(data); res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) }); res.end(s); };
  try {
    if (u.pathname === "/snap") return send(200, snap());
    if (u.pathname === "/reset") { reset(); return send(200, { ok: true }); }
    if (u.pathname === "/gc") { if (global.gc) { global.gc(); global.gc(); } return send(200, { ok: !!global.gc, mem: process.memoryUsage() }); }
    if (u.pathname === "/exec") {
      const { file, arg } = JSON.parse((await body(req)) || "{}");
      delete require.cache[require.resolve(file)];
      return send(200, { result: await require(file)(arg, ctx) });
    }
    if (u.pathname === "/cpu/start") { await post("Profiler.enable"); await post("Profiler.setSamplingInterval", { interval: Number(u.searchParams.get("us")) || 200 }); await post("Profiler.start"); return send(200, { ok: true }); }
    if (u.pathname === "/cpu/stop") {
      const { profile } = await post("Profiler.stop");
      const f = u.searchParams.get("file");
      if (f) fs.writeFileSync(f, JSON.stringify(profile));
      return send(200, cpuSummary(profile, Number(u.searchParams.get("top")) || 40));
    }
    if (u.pathname === "/alloc/start") { await post("HeapProfiler.enable"); await post("HeapProfiler.startSampling", { samplingInterval: Number(u.searchParams.get("bytes")) || 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true }); return send(200, { ok: true }); }
    if (u.pathname === "/alloc/stop") { const { profile } = await post("HeapProfiler.stopSampling"); return send(200, allocSummary(profile, Number(u.searchParams.get("top")) || 30)); }
    if (u.pathname === "/heapsnapshot") { if (global.gc) global.gc(); return send(200, { file: v8.writeHeapSnapshot(u.searchParams.get("file")) }); }
    send(404, { error: "unknown" });
  } catch (e) { send(500, { error: String((e && e.stack) || e) }); }
});
// (idle connections kept longer than the measuring side keeps them: with
// Node's 5 s the server closed a socket the client was just reusing, and a
// measurement call failed with ECONNRESET now and then on a busy machine)
control.keepAliveTimeout = 65000;
control.headersTimeout = 70000;
control.listen(Number(process.env.EFF_PROBE_PORT) || 0, "127.0.0.1");
control.unref();
