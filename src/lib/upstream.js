// Every call this server makes to the outside world goes through here.
//
// TMDB, Cinemeta, TVmaze, the subtitle providers, Apple, Wikidata, Google,
// ntfy… each one can be down, slow, or answering errors. Before this module
// each call site had its own timeout (6-20 s) and nothing else, so a dead
// provider made every page that needed it wait the full timeout, again and
// again, and a slow one piled up sockets without limit. Now every call gets:
//
//   A TIMEOUT that covers the whole answer, body included (a host that drips
//   one byte a second is cut off like one that never answers), and a cap on
//   the body's size.
//
//   A DEADLINE for the caller (`deadlineMs`, page-facing calls only): how
//   long a waiting page waits. When it passes the caller gets its answer
//   from the cache, or a quick failure, and the call carries on in the
//   background up to its timeout. What it brings back is kept, so the next
//   ask is answered at once ("late fill", counted as `lateFills`).
//
//   A FAIR SHARE PER HOST: at most `concurrency` calls in flight to one host,
//   then a short queue, then "busy" at once. No host can tie up an unbounded
//   number of sockets.
//
//   A CIRCUIT BREAKER PER HOST: after `failThreshold` failures in a row
//   (network error, timeout, 5xx, 429) the host is not called for a
//   cooldown (30 s, doubling to 5 min while it stays down). Callers fail in
//   microseconds instead of waiting, or get the cached answer. After the
//   cooldown ONE call is let through to try; its result closes the breaker
//   or opens it again.
//
//   RETRIES only where they are safe and cheap: GET/HEAD, on a network error
//   or a 502/503/504/429, at most `retries` times, after a random wait
//   ("full jitter", so many callers do not come back together), and only
//   while the deadline and the breaker allow.
//
//   A CACHE for JSON answers (`json(url, { ttlMs })`): fresh answers come
//   from memory; a stale one is answered at once and refreshed behind it
//   (stale-while-revalidate); a failure is covered by the stale answer when
//   there is one (stale-if-error); a 404 is remembered for `negativeMs` so a
//   title a provider does not know is not asked about on every page view.
//   Bounded by bytes, least recently used out first.
//
// `fetch(url, opts)` answers a real Response (its body already read, inside
// the timeout and the host's slot), so a call site keeps its own `res.ok`,
// `res.json()`, `res.headers.get()`. globalThis.fetch is looked up on every
// call, so tests that stub it keep working.
//
// status() feeds the admin's /api/admin/metrics and Server → Health card:
// per host, calls, failures, timeouts, breaker state, in flight, queued,
// cache hits and latency.
"use strict";

let config = null;
const cfgUser = () => {
  try {
    if (!config) config = require("../config");
    return (config.UPSTREAM && config.UPSTREAM.hosts) || {};
  } catch {
    return {};
  }
};

const DEFAULTS = {
  timeoutMs: 10000, // the whole call, body included
  concurrency: 6, // in flight per host
  queue: 48, // waiting per host, past that "busy" at once
  queueWaitMs: 5000, // longest wait for a slot (never past the caller's deadline)
  failThreshold: 5, // failures in a row that open the breaker
  cooldownMs: 30 * 1000,
  cooldownMaxMs: 5 * 60 * 1000,
  maxBytes: 16 * 1024 * 1024,
  retries: 1, // GET/HEAD only
  retryBaseMs: 250,
  retryMaxMs: 2000,
};
// Hosts with their own needs. Anything else gets DEFAULTS.
const HOSTS = {
  // ~40 requests / s allowed; a "More like this" row is ~45 calls at once, so
  // the queue is deep (each waits its turn, none is refused)
  "api.themoviedb.org": { concurrency: 8, queue: 256 },
  // picture hosts (/img/ext): a cold Home asks for ~300 posters at once —
  // they wait their turn (deep queue), they are not refused
  "image.tmdb.org": { concurrency: 12, queue: 1024, queueWaitMs: 15000, retries: 0 },
  "images.metahub.space": { concurrency: 12, queue: 1024, queueWaitMs: 15000, retries: 0 },
  "episodes.metahub.space": { concurrency: 8, queue: 1024, queueWaitMs: 15000, retries: 0 },
  "live.metahub.space": { concurrency: 8, queue: 1024, queueWaitMs: 15000, retries: 0 },
  "static.tvmaze.com": { concurrency: 8, queue: 1024, queueWaitMs: 15000, retries: 0 },
  "upload.wikimedia.org": { concurrency: 6, queue: 512, queueWaitMs: 15000, retries: 0 },
  "v3-cinemeta.strem.io": { concurrency: 6 },
  "api.tvmaze.com": { concurrency: 4 }, // 20 calls / 10 s per address
  "openrouter.ai": { concurrency: 2, timeoutMs: 60000, retries: 0 },
  "oauth2.googleapis.com": { concurrency: 4, retries: 0 },
  "www.googleapis.com": { concurrency: 4, retries: 0 },
  "ntfy.sh": { concurrency: 2, retries: 0 },
  "api.telegram.org": { concurrency: 2, retries: 0 },
};
const settingsFor = (host) => ({ ...DEFAULTS, ...(HOSTS[host] || {}), ...((cfgUser()[host] && typeof cfgUser()[host] === "object") ? cfgUser()[host] : {}) });

class UpstreamError extends Error {
  // code: "open" (breaker), "busy" (host queue full), "timeout", "deadline"
  // (the caller's wait ran out; the call goes on), "status" (an answer that is
  // not ok), "network", "too-large", "aborted" (the caller gave up)
  constructor(code, host, message, status) {
    super(message || `${host}: ${code}`);
    this.name = "UpstreamError";
    this.code = code;
    this.host = host;
    if (status != null) this.status = status;
  }
}

// ---------- the clock (tests replace it) ----------
const clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clearTimeout: (t) => clearTimeout(t),
  random: () => Math.random(),
};

// ---------- per-host state ----------
const MAX_HOSTS = 200;
const LAT_BOUNDS = [50, 100, 250, 500, 1000, 2500, 5000, 10000, Infinity];
const hosts = new Map(); // host -> state
const hostOf = (url) => {
  try { return new URL(String(url)).host.toLowerCase(); } catch { return "invalid"; }
};
const stateOf = (host) => {
  let h = hosts.get(host);
  if (h) return h;
  if (hosts.size >= MAX_HOSTS) {
    // forget the quietest closed one (push endpoints come and go)
    let victim = null;
    for (const [k, v] of hosts) if (v.breaker === "closed" && !v.active && !v.waiting.length && (!victim || v.lastAt < hosts.get(victim).lastAt)) victim = k;
    if (victim) hosts.delete(victim);
  }
  h = {
    host,
    active: 0,
    waiting: [],
    breaker: "closed", // closed | open | half-open
    fails: 0, // in a row
    level: 0, // how many times it opened in a row (the cooldown doubles)
    openUntil: 0,
    probing: false,
    openedAt: 0,
    lastAt: 0,
    lastError: null,
    lastErrorAt: 0,
    n: { calls: 0, ok: 0, failed: 0, timeouts: 0, refusedOpen: 0, busy: 0, retries: 0, notFound: 0, deadlines: 0, lateFills: 0, cacheFresh: 0, cacheStale: 0, cacheNegative: 0, staleOnError: 0, opened: 0 },
    lat: LAT_BOUNDS.map(() => 0),
    latSum: 0,
    latN: 0,
  };
  hosts.set(host, h);
  return h;
};

const say = (line) => { try { console.warn(`[upstream] ${line}`); } catch {} };

// May this call go out? Throws UpstreamError("open") when not.
const admitBreaker = (h, s) => {
  if (h.breaker === "closed") return false;
  const now = clock.now();
  if (h.breaker === "open" && now >= h.openUntil) h.breaker = "half-open";
  if (h.breaker === "half-open" && !h.probing) {
    h.probing = true;
    return true; // this one is the trial
  }
  h.n.refusedOpen++;
  throw new UpstreamError("open", h.host, `${h.host} is not answering — not asked again for ${Math.max(1, Math.round((h.openUntil - now) / 1000))} s`, 503);
};
const noteSuccess = (h, probe) => {
  if (probe) h.probing = false;
  if (h.breaker !== "closed") say(`${h.host} answers again — breaker closed after ${Math.round((clock.now() - h.openedAt) / 1000)} s`);
  h.breaker = "closed";
  h.fails = 0;
  h.level = 0;
};
const noteFailure = (h, s, why, probe, noBreaker) => {
  if (probe) h.probing = false;
  h.fails++;
  h.lastError = String(why || "failed").slice(0, 120);
  h.lastErrorAt = clock.now();
  if (noBreaker) return;
  if (h.breaker === "half-open" || (h.breaker === "closed" && h.fails >= s.failThreshold)) {
    const cooldown = Math.min(s.cooldownMaxMs, s.cooldownMs * Math.pow(2, h.level));
    if (h.breaker === "closed") { h.openedAt = clock.now(); h.n.opened++; say(`${h.host}: ${h.fails} failures in a row (${h.lastError}) — breaker open, not asked for ${Math.round(cooldown / 1000)} s`); }
    h.level++;
    h.breaker = "open";
    h.openUntil = clock.now() + cooldown;
  }
};

// A slot among the host's `concurrency`. Resolves to release().
const acquire = (h, s, waitMs) => {
  const grant = () => {
    h.active++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      h.active--;
      const next = h.waiting.shift();
      if (next) next();
    };
  };
  if (h.active < s.concurrency) return Promise.resolve(grant());
  if (h.waiting.length >= s.queue || waitMs <= 0) {
    h.n.busy++;
    return Promise.reject(new UpstreamError("busy", h.host, `${h.host}: too many calls waiting`, 503));
  }
  return new Promise((resolve, reject) => {
    let timer = null;
    const go = () => { if (timer) clock.clearTimeout(timer); resolve(grant()); };
    h.waiting.push(go);
    timer = clock.setTimeout(() => {
      const i = h.waiting.indexOf(go);
      if (i >= 0) h.waiting.splice(i, 1);
      h.n.busy++;
      reject(new UpstreamError("busy", h.host, `${h.host}: no free slot in ${waitMs} ms`, 503));
    }, waitMs);
  });
};

const noteLatency = (h, ms) => {
  h.latSum += ms;
  h.latN++;
  for (let i = 0; i < LAT_BOUNDS.length; i++) if (ms <= LAT_BOUNDS[i]) { h.lat[i]++; break; }
};

const anySignal = (signals) => {
  const list = signals.filter(Boolean);
  if (list.length <= 1) return list[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(list);
  const ctrl = new AbortController();
  for (const s of list) {
    if (s.aborted) { ctrl.abort(s.reason); break; }
    s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
};

// Read the whole body, at most maxBytes. Inside the call's timeout (the
// signal also aborts the body stream).
const readBody = async (res, maxBytes, host) => {
  if (!res.body || typeof res.body.getReader !== "function") return Buffer.from(await res.arrayBuffer());
  const reader = res.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw new UpstreamError("too-large", host, `${host}: answer larger than ${maxBytes} bytes`);
    }
    parts.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(parts, size);
};

const RETRY_STATUS = new Set([429, 502, 503, 504]);
const isFailureStatus = (st) => st >= 500 || st === 429;
const retryAfterMs = (res) => {
  const v = res && res.headers && typeof res.headers.get === "function" ? res.headers.get("retry-after") : null;
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n)) return n * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : null;
};
const sleep = (ms) => new Promise((r) => clock.setTimeout(r, ms));

let signalsLib = null;
const tellSignals = (url, status) => {
  try {
    if (!signalsLib) signalsLib = require("./signals");
    signalsLib.provider(url, status);
  } catch {}
};

// One attempt: slot, call, body. Resolves a Response (or the stub's own
// object, when a test hands one back that is not a Response).
const attempt = async (h, s, url, opts, startedAt, deadlineAt) => {
  const release = await acquire(h, s, Math.max(0, Math.min(s.queueWaitMs, deadlineAt - clock.now())));
  try {
    const timeoutMs = Math.max(1, opts.timeoutMs || s.timeoutMs); // the call site knows its own need
    const { timeoutMs: _t, deadlineMs: _d, retries: _r, maxBytes: _m, site: _s, breaker: _b, ...init } = opts;
    const tSignal = AbortSignal.timeout(timeoutMs);
    init.signal = anySignal([tSignal, opts.signal]);
    let res;
    try {
      res = await globalThis.fetch(url, init);
      if (res && typeof Response === "function" && res instanceof Response) {
        const cap = opts.maxBytes || s.maxBytes;
        // a body that says it is too big is not read at all
        if (Number(res.headers.get("content-length") || 0) > cap) {
          try { await res.body?.cancel(); } catch {}
          throw new UpstreamError("too-large", h.host, `${h.host}: answer larger than ${cap} bytes`);
        }
        const buf = await readBody(res, cap, h.host);
        const headers = new Headers(res.headers);
        headers.delete("content-encoding"); // already undone by fetch
        headers.set("content-length", String(buf.length));
        const nullBody = res.status === 204 || res.status === 304 || res.status < 200;
        const out = new Response(nullBody ? null : buf, { status: res.status, statusText: res.statusText, headers });
        try { Object.defineProperty(out, "url", { value: res.url || String(url) }); } catch {}
        res = out;
      }
    } catch (e) {
      if (e instanceof UpstreamError) throw e;
      if (opts.signal && opts.signal.aborted && !tSignal.aborted) throw new UpstreamError("aborted", h.host, `${h.host}: the caller gave up`);
      if (tSignal.aborted || (e && (e.name === "TimeoutError" || e.name === "AbortError"))) {
        throw new UpstreamError("timeout", h.host, `${h.host}: no full answer in ${timeoutMs} ms`, 504);
      }
      const code = (e && e.cause && (e.cause.code || e.cause.name)) || (e && e.code) || (e && e.message) || "error";
      throw new UpstreamError("network", h.host, `${h.host}: ${code}`, 502);
    }
    return res;
  } finally {
    release();
  }
};

// The call itself: breaker, slot, retries. Rejects with UpstreamError; an
// answer that is not ok is RESOLVED (the caller reads res.status), except
// that it counts against the breaker when it is a 5xx/429.
const run = async (url, opts = {}) => {
  const host = hostOf(url);
  const h = stateOf(host);
  const s = settingsFor(host);
  const method = String(opts.method || "GET").toUpperCase();
  const idempotent = method === "GET" || method === "HEAD";
  const retries = idempotent ? Math.max(0, opts.retries != null ? opts.retries : s.retries) : 0;
  const startedAt = clock.now();
  // the call's own budget (slot wait + attempts + waits between them)
  const budgetAt = startedAt + Math.max(s.timeoutMs, opts.timeoutMs || 0) + 1000;
  h.lastAt = startedAt;
  h.n.calls++;
  const noBreaker = opts.breaker === false;
  for (let i = 0; ; i++) {
    const probe = noBreaker ? false : admitBreaker(h, s);
    let res = null;
    let err = null;
    const t0 = clock.now();
    try {
      res = await attempt(h, s, url, opts, startedAt, budgetAt);
    } catch (e) {
      err = e;
    }
    const ms = clock.now() - t0;
    if (err) {
      if (err.code === "busy" || err.code === "aborted" || err.code === "too-large") { if (probe) h.probing = false; throw err; }
      if (err.code === "timeout") h.n.timeouts++;
      noteFailure(h, s, err.message, probe, noBreaker);
      noteLatency(h, ms);
      if (i < retries && err.code === "network" && h.breaker === "closed" && clock.now() + s.retryBaseMs < budgetAt) {
        h.n.retries++;
        await sleep(Math.round(clock.random() * Math.min(s.retryMaxMs, s.retryBaseMs * Math.pow(2, i))));
        continue;
      }
      h.n.failed++;
      throw err;
    }
    noteLatency(h, ms);
    const st = Number(res.status) || 0;
    tellSignals(url, st);
    if (isFailureStatus(st)) {
      noteFailure(h, s, `answered ${st}`, probe, noBreaker);
      const ra = retryAfterMs(res);
      if (i < retries && RETRY_STATUS.has(st) && h.breaker === "closed" && (ra == null || ra <= s.retryMaxMs)) {
        const wait = ra != null ? ra : Math.round(clock.random() * Math.min(s.retryMaxMs, s.retryBaseMs * Math.pow(2, i)));
        if (clock.now() + wait < budgetAt) {
          h.n.retries++;
          await sleep(wait);
          continue;
        }
      }
      h.n.failed++;
      return res;
    }
    noteSuccess(h, probe);
    h.n.ok++;
    if (st === 404) h.n.notFound++;
    return res;
  }
};

// fetch(url, opts): a Response, like global fetch. Extra options:
//   timeoutMs  the whole call (default per host, 10 s)
//   deadlineMs how long THIS caller waits; past it, UpstreamError("deadline")
//              and the call is abandoned (use json() for a call that should
//              finish and be kept)
//   retries    GET/HEAD only (default 1)
//   maxBytes   body cap (default 16 MB)
//   breaker    false: always try (alerts — a message that may be the only
//              word of an outage is never dropped by a breaker)
const upFetch = (url, opts = {}) => {
  const p = run(url, opts);
  if (!opts.deadlineMs) return p;
  return withDeadline(p, opts.deadlineMs, hostOf(url));
};

const withDeadline = (p, ms, host, onLate) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const t = clock.setTimeout(() => {
      if (settled) return;
      settled = true;
      stateOf(host).n.deadlines++;
      if (onLate) onLate();
      reject(new UpstreamError("deadline", host, `${host}: no answer within ${ms} ms (still being fetched)`, 504));
    }, ms);
    p.then(
      (v) => { if (settled) return; settled = true; clock.clearTimeout(t); resolve(v); },
      (e) => { if (settled) return; settled = true; clock.clearTimeout(t); reject(e); },
    );
  });

// ---------- the JSON cache ----------
const CACHE_MAX_BYTES = 24 * 1024 * 1024;
const ENTRY_MAX_BYTES = 2 * 1024 * 1024;
const cache = new Map(); // key -> { at, ttl, stale, neg, text, bytes, status }
let cacheBytes = 0;
const inflight = new Map(); // key -> promise of { value, status }
const cacheKey = (url) => String(url);
const cacheGet = (key) => {
  const e = cache.get(key);
  if (!e) return null;
  if (clock.now() - e.at > e.ttl + e.stale) { cacheDrop(key); return null; }
  cache.delete(key); // LRU: to the newest end
  cache.set(key, e);
  return e;
};
const cacheDrop = (key) => {
  const e = cache.get(key);
  if (!e) return;
  cacheBytes -= e.bytes;
  cache.delete(key);
};
const cachePut = (key, entry) => {
  if (entry.bytes > ENTRY_MAX_BYTES) return;
  cacheDrop(key);
  cache.set(key, entry);
  cacheBytes += entry.bytes;
  while (cacheBytes > CACHE_MAX_BYTES && cache.size) cacheDrop(cache.keys().next().value);
};

const statusError = (host, status, url) => {
  const e = new UpstreamError("status", host, `${status} ${String(url).replace(/api_key=[^&]+/, "api_key=…").slice(0, 160)}`, status);
  return e;
};

// json(url, opts): the parsed answer of a GET. Throws UpstreamError — with
// .status for an answer that is not ok (a 404 is .status 404, code "status").
//   ttlMs       keep a good answer this long (0 = no cache, the default)
//   staleMs     …and after that, answer it while a fresh one is fetched, and
//               when the host fails (default 6 h)
//   negativeMs  remember a 404 this long (default 10 min; 0 = never)
//   deadlineMs  how long the caller waits (late fill: the call finishes and
//               is kept)
//   + every fetch() option
const json = (url, opts = {}) => {
  const host = hostOf(url);
  const h = stateOf(host);
  const key = opts.cacheKey || cacheKey(url);
  const ttl = opts.ttlMs || 0;
  const stale = opts.staleMs != null ? opts.staleMs : 6 * 3600 * 1000;
  const negMs = opts.negativeMs != null ? opts.negativeMs : 10 * 60 * 1000;
  const cached = ttl || negMs ? cacheGet(key) : null;
  const now = clock.now();
  if (cached) {
    const age = now - cached.at;
    if (cached.neg) {
      if (age <= cached.ttl) { h.n.cacheNegative++; return Promise.reject(statusError(host, cached.status, url)); }
    } else if (age <= cached.ttl) {
      h.n.cacheFresh++;
      return Promise.resolve(JSON.parse(cached.text));
    }
  }
  // One call per key at a time (a row of cards asking for the same title
  // makes one call). It resolves the answer's TEXT: every caller parses its
  // own copy, so no caller can change what another one (or the cache) holds.
  let rec = inflight.get(key);
  if (!rec) {
    rec = { late: false, q: null };
    const r = rec;
    r.q = (async () => {
      const { ttlMs: _a, staleMs: _b, negativeMs: _c, cacheKey: _k, deadlineMs: _d, ...fo } = opts;
      const res = await run(url, { ...fo, method: "GET" });
      if (res.status === 404 || res.status === 410) {
        if (negMs) cachePut(key, { at: clock.now(), ttl: negMs, stale: 0, neg: true, status: res.status, text: null, bytes: 64 });
        throw statusError(host, res.status, url);
      }
      if (!res.ok) throw statusError(host, res.status, url);
      const text = await res.text();
      try { JSON.parse(text); } catch { throw new UpstreamError("status", host, `${host}: answer is not JSON`, 502); }
      if (ttl) cachePut(key, { at: clock.now(), ttl, stale, neg: false, status: res.status, text, bytes: text.length + 64 });
      if (r.late) h.n.lateFills++;
      return text;
    })();
    inflight.set(key, r);
    const done = () => { if (inflight.get(key) === r) inflight.delete(key); };
    r.q.then(done, done);
  }
  const p = rec.q;
  // a stale answer is answered now; the fresh one lands in the cache
  if (cached && !cached.neg) {
    h.n.cacheStale++;
    p.catch(() => {});
    return Promise.resolve(JSON.parse(cached.text));
  }
  const covered = p.then((text) => JSON.parse(text), (e) => {
    // the host failed: an answer kept from before covers it
    if (e && e.status !== 404 && e.status !== 410) {
      const old = ttl ? cache.get(key) : null;
      if (old && !old.neg) { h.n.staleOnError++; return JSON.parse(old.text); }
    }
    throw e;
  });
  if (!opts.deadlineMs) return covered;
  p.catch(() => {}); // a late failure is nobody's to hear
  covered.catch(() => {});
  return withDeadline(covered, opts.deadlineMs, host, () => { rec.late = true; });
};

// ---------- reading ----------
const status = () => {
  const out = [];
  const now = clock.now();
  for (const h of hosts.values()) {
    const s = settingsFor(h.host);
    let breaker = h.breaker;
    if (breaker === "open" && now >= h.openUntil) breaker = "half-open";
    const p = (q) => {
      if (!h.latN) return null;
      const want = Math.ceil(h.latN * q);
      let seen = 0;
      for (let i = 0; i < LAT_BOUNDS.length; i++) { seen += h.lat[i]; if (seen >= want) return LAT_BOUNDS[i] === Infinity ? s.timeoutMs : LAT_BOUNDS[i]; }
      return null;
    };
    out.push({
      host: h.host, breaker, failsInARow: h.fails,
      reopensInMs: h.breaker === "open" ? Math.max(0, h.openUntil - now) : 0,
      active: h.active, queued: h.waiting.length, limit: s.concurrency,
      ...h.n,
      meanMs: h.latN ? Math.round(h.latSum / h.latN) : null, p50Ms: p(0.5), p95Ms: p(0.95),
      lastError: h.lastError, lastErrorAgoMs: h.lastErrorAt ? now - h.lastErrorAt : null,
    });
  }
  out.sort((a, b) => (b.breaker !== "closed") - (a.breaker !== "closed") || b.calls - a.calls);
  return { hosts: out, cache: { entries: cache.size, bytes: cacheBytes, maxBytes: CACHE_MAX_BYTES, inflight: inflight.size } };
};
const openBreakers = () => [...hosts.values()].filter((h) => h.breaker !== "closed").map((h) => h.host);

const _reset = () => { hosts.clear(); cache.clear(); cacheBytes = 0; inflight.clear(); };

module.exports = {
  fetch: upFetch, json, status, openBreakers, UpstreamError, hostOf,
  DEFAULTS, HOSTS,
  _internals: { clock, hosts, cache, inflight, settingsFor, stateOf, _reset },
};
