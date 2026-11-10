// The finished answer of an expensive request, kept for a short while.
//
// GET /api/home is the heaviest thing a device asks for: 20–50 ms of the one
// event-loop thread to compose, serialise and compress, for an answer that is
// the same for everyone asking as the same profile until something changes.
// A library change used to make every device ask at once (a 4–8 s freeze at
// 100 devices, measured); one device asking on 64 connections held everybody
// else up for 6.4 s.
//
// This keeps the FINAL bytes — after the kids filter and the blur-up
// placeholders have been applied, exactly what went out — together with their
// compressed forms and a strong validator (a hash of those bytes):
//
//   begin(req, res, { key, stamp })
//     key    who is asking, as far as the answer depends on it (the profile,
//            the TV's slim shape, the kids limit, placeholders or not)
//     stamp  everything the answer was built FROM, as version numbers (the
//            library, that profile's own writes, the recommender, the
//            catalogue caches, kids limits, settings, the day) — a string,
//            or a function that works it out (asked again by recheck())
//   A kept answer with the same key AND the same stamp, no older than
//   MAX_AGE_MS, is sent from memory: 304 with no body when the client already
//   has it (If-None-Match), otherwise the stored bytes — and begin() returns
//   true. Otherwise it returns false, the route composes as before, and what
//   it sends is captured on the way out.
//
//   recheck(req, res)
//     For a request that had to wait its turn (lib/admission.js) after
//     begin() found nothing: somebody asking for the same thing may have had
//     it composed meanwhile. Looks again, with the stamp as it is NOW — which
//     is also the stamp the answer is kept under if this request composes it.
//
// MAX_AGE_MS bounds what a stamp cannot see (a background fetch landing, the
// clock crossing a release date): nothing kept here is ever older than that.
// A different key never shares an entry — a kids profile's answer is its own.
//
// POOLS (perf-server 2026-11-10). pool({ name, maxEntries, maxAgeMs }) makes
// another, separate set of kept answers with the same rules, so a route with
// a key per profile never pushes Home's answers out. The module itself is the
// first pool (Home and the library), exactly as it always was.
//
// COMPRESSION OFF THE LOOP (perf-server 2026-11-10). A kept answer's brotli or
// gzip form is made once per answer, but it was made synchronously, on the
// event loop: 20–30 ms for a Home and ~50 ms for a 1.5 MB library at quality
// 6, for every profile's answer after each library change, just when every
// device asks at once. Answers over SYNC_MAX are now compressed on libuv's
// thread pool (the same zlib with the same parameters: the same bytes); the
// requests that arrive meanwhile wait for that one compression. Small ones
// are still compressed in place.
"use strict";
const zlib = require("zlib");
const crypto = require("crypto");

const MAX_AGE_MS = 30 * 1000;
const MAX_ENTRIES = 64;
const BR_QUALITY = 6; // the figure server.js measured for /api/home
const SYNC_MAX = 64 * 1024; // up to this size, compressing in place costs well under a millisecond

// What the client accepts, best first. (q=0 means "not this one".)
const pickEncoding = (header) => {
  const h = String(header || "").toLowerCase();
  const ok = (name) => new RegExp(`(^|,)\\s*${name}\\s*(;\\s*q=(0\\.\\d*[1-9]\\d*|1(\\.0*)?))?\\s*(,|$)`).test(h);
  if (ok("br")) return "br";
  if (ok("gzip")) return "gzip";
  return null;
};

// Does If-None-Match name this entry? Any of its forms counts (the plain
// bytes, or a compressed form: "<hash>", "<hash>-br", "<hash>-gz"), weak or
// strong, alone or in a list.
const matches = (header, hash) => {
  if (!header) return false;
  if (String(header).trim() === "*") return true;
  for (const part of String(header).split(",")) {
    const t = part.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
    if (t === hash || t === `${hash}-br` || t === `${hash}-gz`) return true;
  }
  return false;
};

const brOpts = (raw) => ({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: BR_QUALITY, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });

// An entry's compressed form: a Buffer when it is ready (or small enough to
// make now), otherwise the one Promise every waiting request shares.
const compressed = (e, enc) => {
  const k = enc === "br" ? "br" : "gzip";
  if (e[k]) return e[k];
  if (e.raw.length <= SYNC_MAX) return (e[k] = k === "br" ? zlib.brotliCompressSync(e.raw, brOpts(e.raw)) : zlib.gzipSync(e.raw));
  const wait = `${k}Wait`;
  if (!e[wait]) {
    e[wait] = new Promise((resolve, reject) => {
      const done = (err, out) => (err ? reject(err) : resolve((e[k] = out)));
      if (k === "br") zlib.brotliCompress(e.raw, brOpts(e.raw), done);
      else zlib.gzip(e.raw, done);
    });
    e[wait].catch(() => { e[wait] = null; }); // a failure is not remembered: the next request tries again
  }
  return e[wait];
};

const deliver = (req, res, e, stats) => {
  const enc = e.raw.length >= 1024 ? pickEncoding(req.headers["accept-encoding"]) : null;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // personal, and to be checked every time — the check is the cheap part
  res.setHeader("Cache-Control", "private, no-cache");
  res.setHeader("Vary", "Accept-Encoding");
  // a strong validator over the bytes that are sent (each encoding its own)
  const tag = (as) => `"${e.hash}${as === "br" ? "-br" : as === "gzip" ? "-gz" : ""}"`;
  res.setHeader("ETag", tag(enc));
  if ((req.method === "GET" || req.method === "HEAD") && matches(req.headers["if-none-match"], e.hash)) {
    stats.notModified++;
    res.statusCode = 304;
    res.end();
    return;
  }
  const finish = (body, as) => {
    if (res.writableEnded || res.destroyed) return;
    if (as) res.setHeader("Content-Encoding", as);
    else if (res.getHeader("Content-Encoding")) res.removeHeader("Content-Encoding");
    res.setHeader("ETag", tag(as));
    res.setHeader("Content-Length", body.length);
    res.statusCode = 200;
    if (req.method === "HEAD") return void res.end();
    res.end(body);
  };
  if (!enc) return finish(e.raw, null);
  let out;
  try { out = compressed(e, enc); } catch { return finish(e.raw, null); }
  if (Buffer.isBuffer(out)) return finish(out, enc);
  // (a compression that fails sends the plain bytes, under their own validator)
  out.then((b) => finish(b, enc), () => finish(e.raw, null));
};

const pools = new Set();

// A set of kept answers. See the note at the top.
const pool = ({ name = "answers", maxEntries = MAX_ENTRIES, maxAgeMs = MAX_AGE_MS } = {}) => {
  const entries = new Map(); // key -> { stamp, at, raw: Buffer, hash, br, gzip }
  const stats = { hits: 0, misses: 0, notModified: 0, stored: 0 };

  const get = (key, stamp, now = Date.now()) => {
    const e = entries.get(key);
    if (!e) return null;
    if (e.stamp !== stamp || now - e.at > maxAgeMs) {
      entries.delete(key);
      return null;
    }
    return e;
  };

  const put = (key, stamp, body, now = Date.now()) => {
    const raw = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
    const e = { stamp, at: now, raw, hash: crypto.createHash("sha1").update(raw).digest("base64url").slice(0, 22), br: null, gzip: null };
    entries.delete(key);
    entries.set(key, e);
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    stats.stored++;
    return e;
  };

  const self = { name, stats, MAX_AGE_MS: maxAgeMs, MAX_ENTRIES: maxEntries };

  // See the note at the top. Returns true when the request has been answered.
  self.begin = (req, res, { key, stamp }) => {
    const stampNow = typeof stamp === "function" ? stamp : () => stamp;
    const ctx = { key, stampNow, stamp: stampNow(), send: res.send, pool: self };
    const hit = get(key, ctx.stamp);
    if (hit) {
      stats.hits++;
      deliver(req, res, hit, stats);
      return true;
    }
    stats.misses++;
    res._kept = ctx;
    // Capture what the route sends: Express's res.json ends in res.send(string),
    // after every res.json wrapper in front of the route (the kids filter, the
    // blur-up placeholders) has had its turn.
    res.send = function (body) {
      res.send = ctx.send;
      if (res.statusCode === 200 && (typeof body === "string" || Buffer.isBuffer(body)) && !res.headersSent) {
        try {
          return void deliver(req, res, put(key, ctx.stamp, body), stats);
        } catch {}
      }
      return ctx.send.call(this, body);
    };
    return false;
  };

  // See the note at the top. Returns true when the request has been answered.
  self.recheck = (req, res) => {
    const ctx = res._kept;
    if (!ctx || ctx.pool !== self) return false;
    ctx.stamp = ctx.stampNow(); // what the answer about to be composed is built from
    const hit = get(ctx.key, ctx.stamp);
    if (!hit) return false;
    stats.hits++;
    stats.misses--; // it was counted as a miss on arrival; it was answered from memory after all
    res.send = ctx.send;
    deliver(req, res, hit, stats);
    return true;
  };

  self.clear = () => {
    const n = entries.size;
    entries.clear();
    return n;
  };
  self._internals = { entries, get, put };
  pools.add(self);
  return self;
};

const main = pool({ name: "home and library" });

// under memory pressure these go first: they are rebuilt on the next request
try {
  require("./watchdog").onSoftHeal(() => {
    let n = 0;
    for (const p of pools) n += p.clear();
    return n ? `${n} kept answers dropped` : null;
  });
} catch {}

module.exports = {
  begin: main.begin, recheck: main.recheck, clear: main.clear, stats: main.stats, MAX_AGE_MS, MAX_ENTRIES, pool, pools,
  _internals: {
    entries: main._internals.entries, get: main._internals.get, put: main._internals.put,
    deliver: (req, res, e) => deliver(req, res, e, main.stats), pickEncoding, matches, compressed, SYNC_MAX,
  },
};
