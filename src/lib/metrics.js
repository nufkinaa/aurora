// Why is the server slow? The numbers the admin needs to answer that, in one
// place: GET /api/admin/metrics (admin only; JSON, or Prometheus text with
// ?fmt=prom) and the admin page's Server → Health card.
//
//   requests     per route GROUP — the request's shape ("/api/item/:id",
//                lib/tel/scrub.js: a path word the server does not have is
//                ":id", so a title or a name never becomes a group) — how
//                many, how they ended (2xx/3xx/4xx/5xx, or the client went
//                away first), how many are in flight now, and how long the
//                server took to START answering (time to first byte) as a
//                histogram. First byte, not last: a film streams for an hour
//                on one request, and that is not slowness.
//   slow log     a request whose first byte took over SLOW_MS is one log
//                line: route group, status, total, and the steps the route
//                named in its Server-Timing header (lib/servertiming.js).
//                One line per group per SLOW_LOG_EVERY_MS at most, with how
//                many were left unsaid — a slow minute is a line, not a flood.
//   event loop   delay p50 / p99 / max (lib/looplag.js windows), CPU %,
//                memory (rss, heap, external, array buffers).
//   work         streams in flight, encoders, torrents, downloads, the heavy
//                lane's queue (lib/admission.js), the picture-variant queue,
//                the CPU budget's waiting jobs (media/cpuwork.js).
//   outside      every upstream host's breaker, calls, failures, latency and
//                cache (lib/upstream.js); rate-limit counts (lib/ratelimit.js);
//                WebSocket hygiene (realtime.js).
//   checks       config problems found at boot and the resource checks
//                (lib/resources.js).
//
// Bounded: at most MAX_GROUPS route groups (the rest are "other"); 13
// histogram buckets each; counters since boot only, nothing on disk.
"use strict";

const SLOW_MS = 1000;
const SLOW_LOG_EVERY_MS = 10 * 1000;
const MAX_GROUPS = 300;
const BOUNDS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, Infinity];

const groups = new Map(); // group -> stats
const slowSaid = new Map(); // group -> { at, unsaid }
let startedAt = Date.now();

let scrub = null;
const groupOf = (req) => {
  const p = req.path || req.url || "/";
  // the shells and the static files are one group each: their names are not routes
  if (p === "/" || p === "/admin" || p === "/web" || p === "/link") return `page ${p}`;
  if (/^\/(css|js|vendor)\//.test(p) || /\.(js|css|png|ico|webmanifest|svg|woff2|json|html|txt|apk)$/i.test(p)) {
    if (!/^\/(api|stream|img)\//.test(p)) return "static";
  }
  try {
    if (!scrub) scrub = require("./tel/scrub");
    return scrub.urlPattern(p).replace(/\?.*$/, "");
  } catch {
    return "other";
  }
};
const statsOf = (g) => {
  let s = groups.get(g);
  if (s) return s;
  if (groups.size >= MAX_GROUPS) g = "other";
  s = groups.get(g);
  if (s) return s;
  s = { n: 0, inflight: 0, s2: 0, s3: 0, s4: 0, s5: 0, aborted: 0, slow: 0, sum: 0, max: 0, b: BOUNDS.map(() => 0) };
  groups.set(g, s);
  return s;
};
const observe = (s, ms) => {
  s.sum += ms;
  if (ms > s.max) s.max = ms;
  for (let i = 0; i < BOUNDS.length; i++) if (ms <= BOUNDS[i]) { s.b[i]++; break; }
};

const sayIfSlow = (g, req, res, ms) => {
  const now = Date.now();
  let w = slowSaid.get(g);
  if (!w) { w = { at: 0, unsaid: 0 }; slowSaid.set(g, w); }
  if (now - w.at < SLOW_LOG_EVERY_MS) { w.unsaid++; return; }
  let steps = "";
  try {
    const st = res.getHeader("Server-Timing");
    if (st) {
      const parsed = require("./servertiming").parse(String(st));
      steps = Object.entries(parsed).filter(([k]) => k !== "app").map(([k, v]) => `${k} ${Math.round(v.ms)}${v.desc ? ` (${v.desc})` : ""}`).join(", ");
    }
  } catch {}
  let lag = "";
  try { const l = require("./looplag").read(); if (l.maxMs > 50) lag = `, event loop blocked up to ${Math.round(l.maxMs)} ms lately`; } catch {}
  console.warn(`[slow] ${req.method} ${g} ${res.statusCode} first byte after ${Math.round(ms)} ms${steps ? ` — ${steps}` : ""}${lag}${w.unsaid ? ` (+${w.unsaid} more slow ${g} since the last line)` : ""}`);
  w.at = now;
  w.unsaid = 0;
};

// Express middleware: as early as possible, so the time counts everything.
const middleware = (req, res, next) => {
  const t0 = process.hrtime.bigint();
  const g = groupOf(req);
  const s = statsOf(g);
  s.n++;
  s.inflight++;
  let first = null;
  const writeHead = res.writeHead;
  res.writeHead = function (...args) {
    if (first == null) first = Number(process.hrtime.bigint() - t0) / 1e6;
    return writeHead.apply(this, args);
  };
  let done = false;
  const end = (finished) => {
    if (done) return;
    done = true;
    s.inflight--;
    if (!finished && !res.headersSent) { s.aborted++; return; }
    if (!finished) s.aborted++;
    const ms = first != null ? first : Number(process.hrtime.bigint() - t0) / 1e6;
    observe(s, ms);
    const c = res.statusCode;
    if (c >= 500) s.s5++; else if (c >= 400) s.s4++; else if (c >= 300) s.s3++; else s.s2++;
    if (ms > SLOW_MS) { s.slow++; sayIfSlow(g, req, res, ms); }
  };
  res.once("finish", () => end(true));
  res.once("close", () => end(res.writableFinished));
  next();
};

// ---------- reading ----------
const pct = (s, q) => {
  const total = s.b.reduce((a, c) => a + c, 0);
  if (!total) return null;
  const want = Math.ceil(total * q);
  let seen = 0;
  for (let i = 0; i < BOUNDS.length; i++) { seen += s.b[i]; if (seen >= want) return BOUNDS[i] === Infinity ? Math.round(s.max) : BOUNDS[i]; }
  return null;
};
const requests = () =>
  [...groups.entries()].map(([group, s]) => {
    const done = s.b.reduce((a, c) => a + c, 0);
    return {
      group, n: s.n, inflight: s.inflight, s2: s.s2, s3: s.s3, s4: s.s4, s5: s.s5, aborted: s.aborted, slow: s.slow,
      meanMs: done ? Math.round(s.sum / done) : null, p50Ms: pct(s, 0.5), p95Ms: pct(s, 0.95), p99Ms: pct(s, 0.99), maxMs: Math.round(s.max),
      buckets: BOUNDS.map((le, i) => [le === Infinity ? "+Inf" : le, s.b[i]]),
    };
  }).sort((a, b) => b.n - a.n);

let lastCpu = { at: process.hrtime.bigint(), u: process.cpuUsage() };
const cpuPercent = () => {
  const now = process.hrtime.bigint();
  const u = process.cpuUsage();
  const wall = Number(now - lastCpu.at) / 1e3; // µs
  const used = (u.user - lastCpu.u.user) + (u.system - lastCpu.u.system);
  lastCpu = { at: now, u };
  return wall > 0 ? Math.round((used / wall) * 1000) / 10 : 0;
};

const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };

const snapshot = () => {
  const m = process.memoryUsage();
  const list = requests();
  const streams = list.filter((r) => r.group.startsWith("/stream")).reduce((a, r) => a + r.inflight, 0);
  const torrentClient = safe(() => require("../media/torrent").clientIfLoaded());
  const cpu = safe(() => require("../media/cpuwork").status(), {});
  const heavy = safe(() => require("./admission").heavy.status(), {});
  const up = safe(() => require("./upstream").status(), { hosts: [], cache: {} });
  const imgQueue = safe(() => require("./imgvariant")._internals.queue.length, null);
  const loop = safe(() => require("./looplag").read(), {});
  const watch = safe(() => require("./watchdog").status(), {});
  const total = list.reduce((a, r) => ({ n: a.n + r.n, s5: a.s5 + r.s5, slow: a.slow + r.slow, inflight: a.inflight + r.inflight }), { n: 0, s5: 0, slow: 0, inflight: 0 });
  return {
    at: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    since: new Date(startedAt).toISOString(),
    node: process.version,
    eventLoop: { p50Ms: loop.p50Ms != null ? loop.p50Ms : null, p99Ms: loop.p99Ms != null ? loop.p99Ms : null, maxMs: loop.maxMs != null ? loop.maxMs : null, meanMs: loop.meanMs != null ? loop.meanMs : null, windowMs: loop.windowMs || null },
    cpuPercent: cpuPercent(),
    memory: { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, arrayBuffers: m.arrayBuffers, watchdog: watch.thresholds || null },
    work: {
      requestsInFlight: total.inflight,
      streamsInFlight: streams,
      encoders: (cpu.viewers || []).length,
      backgroundJobs: (cpu.background || []).length,
      cpuWaiting: (cpu.waiting || []).length,
      ffmpeg: watch.now ? watch.now.ffmpeg : null,
      torrents: torrentClient ? torrentClient.torrents.length : 0,
      peers: torrentClient ? torrentClient.torrents.reduce((a, t) => a + (t.numPeers || 0), 0) : 0,
      heavyLane: { waiting: heavy.waiting || 0, refused: heavy.refused || 0, timedOut: heavy.timedOut || 0, maxWaiting: heavy.maxWaiting || 0 },
      imgVariantQueue: imgQueue,
      upstreamQueued: up.hosts.reduce((a, h) => a + h.queued, 0),
      upstreamInFlight: up.hosts.reduce((a, h) => a + h.active, 0),
    },
    totals: total,
    requests: list,
    upstream: up,
    rateLimits: safe(() => require("./ratelimit").status(), null),
    ws: safe(() => require("../realtime").wsStatus(), null),
    http: safe(() => require("./httplimits").settings(require("../config").HTTP), null),
    checks: safe(() => require("./resources").status(), null),
  };
};

// The same numbers as Prometheus text (counters and gauges; one histogram per group).
const prom = () => {
  const s = snapshot();
  const out = [];
  const esc = (v) => String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const line = (name, labels, v) => out.push(`${name}${labels ? `{${labels}}` : ""} ${v == null ? "NaN" : v}`);
  out.push("# TYPE aurora_http_requests_total counter");
  for (const r of s.requests) for (const k of ["s2", "s3", "s4", "s5", "aborted"]) line("aurora_http_requests_total", `group="${esc(r.group)}",result="${k}"`, r[k]);
  out.push("# TYPE aurora_http_first_byte_ms histogram");
  for (const r of s.requests) {
    let cum = 0;
    for (const [le, c] of r.buckets) { cum += c; line("aurora_http_first_byte_ms_bucket", `group="${esc(r.group)}",le="${le}"`, cum); }
    line("aurora_http_first_byte_ms_count", `group="${esc(r.group)}"`, cum);
  }
  out.push("# TYPE aurora_http_in_flight gauge");
  for (const r of s.requests) if (r.inflight) line("aurora_http_in_flight", `group="${esc(r.group)}"`, r.inflight);
  out.push("# TYPE aurora_event_loop_delay_ms gauge");
  for (const k of ["p50Ms", "p99Ms", "maxMs"]) line("aurora_event_loop_delay_ms", `q="${k}"`, s.eventLoop[k]);
  out.push("# TYPE aurora_memory_bytes gauge");
  for (const k of ["rss", "heapUsed", "heapTotal", "external", "arrayBuffers"]) line("aurora_memory_bytes", `kind="${k}"`, s.memory[k]);
  line("aurora_cpu_percent", "", s.cpuPercent);
  out.push("# TYPE aurora_work gauge");
  for (const [k, v] of Object.entries(s.work)) if (typeof v === "number") line("aurora_work", `kind="${k}"`, v);
  out.push("# TYPE aurora_upstream_breaker_open gauge");
  for (const h of s.upstream.hosts) {
    line("aurora_upstream_breaker_open", `host="${esc(h.host)}"`, h.breaker === "closed" ? 0 : 1);
    line("aurora_upstream_calls_total", `host="${esc(h.host)}"`, h.calls);
    line("aurora_upstream_failures_total", `host="${esc(h.host)}"`, h.failed);
  }
  if (s.rateLimits) for (const g of s.rateLimits.groups) {
    line("aurora_ratelimit_refused_total", `group="${esc(g.group)}"`, g.refused);
    line("aurora_ratelimit_would_refuse_total", `group="${esc(g.group)}"`, g.wouldRefuse);
  }
  if (s.ws) line("aurora_ws_open", "", s.ws.open);
  return out.join("\n") + "\n";
};

const _reset = () => { groups.clear(); slowSaid.clear(); startedAt = Date.now(); };

module.exports = { middleware, snapshot, prom, groupOf, SLOW_MS, BOUNDS, _internals: { groups, _reset, slowSaid } };
