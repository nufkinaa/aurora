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
"use strict";
const zlib = require("zlib");
const crypto = require("crypto");

const MAX_AGE_MS = 30 * 1000;
const MAX_ENTRIES = 64;
const BR_QUALITY = 6; // the figure server.js measured for /api/home

const entries = new Map(); // key -> { stamp, at, raw: Buffer, hash, br, gzip }
const stats = { hits: 0, misses: 0, notModified: 0, stored: 0 };

const get = (key, stamp, now = Date.now()) => {
  const e = entries.get(key);
  if (!e) return null;
  if (e.stamp !== stamp || now - e.at > MAX_AGE_MS) {
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
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
  stats.stored++;
  return e;
};

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

const deliver = (req, res, e) => {
  const enc = e.raw.length >= 1024 ? pickEncoding(req.headers["accept-encoding"]) : null;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // personal, and to be checked every time — the check is the cheap part
  res.setHeader("Cache-Control", "private, no-cache");
  res.setHeader("Vary", "Accept-Encoding");
  // a strong validator over the bytes that are sent (each encoding its own)
  res.setHeader("ETag", `"${e.hash}${enc === "br" ? "-br" : enc === "gzip" ? "-gz" : ""}"`);
  if ((req.method === "GET" || req.method === "HEAD") && matches(req.headers["if-none-match"], e.hash)) {
    stats.notModified++;
    res.statusCode = 304;
    res.end();
    return;
  }
  let body = e.raw;
  if (enc === "br") {
    body = e.br || (e.br = zlib.brotliCompressSync(e.raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: BR_QUALITY, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: e.raw.length } }));
    res.setHeader("Content-Encoding", "br");
  } else if (enc === "gzip") {
    body = e.gzip || (e.gzip = zlib.gzipSync(e.raw));
    res.setHeader("Content-Encoding", "gzip");
  }
  res.setHeader("Content-Length", body.length);
  res.statusCode = 200;
  if (req.method === "HEAD") return void res.end();
  res.end(body);
};

// See the note at the top. Returns true when the request has been answered.
const begin = (req, res, { key, stamp }) => {
  const stampNow = typeof stamp === "function" ? stamp : () => stamp;
  const ctx = { key, stampNow, stamp: stampNow(), send: res.send };
  const hit = get(key, ctx.stamp);
  if (hit) {
    stats.hits++;
    deliver(req, res, hit);
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
        return void deliver(req, res, put(key, ctx.stamp, body));
      } catch {}
    }
    return ctx.send.call(this, body);
  };
  return false;
};

// See the note at the top. Returns true when the request has been answered.
const recheck = (req, res) => {
  const ctx = res._kept;
  if (!ctx) return false;
  ctx.stamp = ctx.stampNow(); // what the answer about to be composed is built from
  const hit = get(ctx.key, ctx.stamp);
  if (!hit) return false;
  stats.hits++;
  stats.misses--; // it was counted as a miss on arrival; it was answered from memory after all
  res.send = ctx.send;
  deliver(req, res, hit);
  return true;
};

const clear = () => {
  const n = entries.size;
  entries.clear();
  return n;
};

// under memory pressure these go first: they are rebuilt on the next request
try {
  require("./watchdog").onSoftHeal(() => { const n = clear(); return n ? `${n} kept answers dropped` : null; });
} catch {}

module.exports = { begin, recheck, clear, stats, MAX_AGE_MS, MAX_ENTRIES, _internals: { entries, get, put, deliver, pickEncoding, matches } };
