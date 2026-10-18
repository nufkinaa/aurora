// Per-client rate limits on the PUBLIC endpoints that cost something: the
// ones that ask an outside provider (search, catalogue, title pages, people,
// X-Ray, trailers, pictures fetched from a picture host, the web proxy) or
// burn CPU (subtitle Resync). Never on admin authentication, never on video.
//
// One token bucket per client per group: `burst` requests at once, refilled
// at `rate` per second. Generous on purpose — a person typing a search on a
// TV, scrolling Browse or opening title after title never gets near them;
// a script hammering the server does.
//
// WHO is a client: a signed-in device by its session (so a household behind
// one address is many clients), anyone else by address. The address is the
// socket's own, or X-Forwarded-For's first hop ONLY when the socket is the
// reverse proxy on this machine (a LAN device cannot pick its own address
// by sending the header). Loopback / private-LAN addresses get LAN_FACTOR
// times the allowance (a household on its own network).
//
// MODES (config.json "rateLimits"): "log" (the default — nothing is refused;
// what WOULD have been is counted per group, shown on the admin Health card
// and said in the log, rate-limited), "enforce" (429 with Retry-After, which
// the clients already handle for the admission lane), "off". Per group:
//   "rateLimits": { "mode": "enforce", "groups": { "search": { "rate": 8, "burst": 40, "mode": "log" } } }
//
// The admission lane (lib/admission.js) is a different thing: it orders the
// heavy requests already admitted so they take turns with everything else.
// This decides whether a client gets to make that many in the first place.
"use strict";

const GROUPS = {
  // per second, at once
  search: { rate: 10, burst: 30, label: "Search" },
  suggest: { rate: 20, burst: 60, label: "Search suggestions" },
  catalogue: { rate: 10, burst: 60, label: "Catalogue and discover" },
  title: { rate: 10, burst: 40, label: "Title pages (catalogue)" },
  person: { rate: 4, burst: 20, label: "People" },
  xray: { rate: 4, burst: 20, label: "X-Ray and trailers" },
  "img-fetch": { rate: 30, burst: 400, label: "Pictures fetched from a picture host" },
  resync: { rate: 0.2, burst: 6, label: "Subtitle Resync" },
  proxy: { rate: 5, burst: 30, label: "Web proxy" },
};
const LAN_FACTOR = 4;
const MAX_KEYS = 20000;
const LOG_EVERY_MS = 60 * 1000;

// Which group a request belongs to (null: not limited). Method + path only.
const groupOf = (method, p) => {
  if (method === "GET") {
    if (p === "/api/search/suggest") return "suggest";
    if (p === "/api/search" || p === "/api/discover/search") return "search";
    if (p.startsWith("/api/discover/meta/")) return "title";
    if (p === "/api/catalog" || p === "/api/catalog/genres" || p === "/api/discover" || p.startsWith("/api/discover/")) return "catalogue";
    if (p.startsWith("/api/person/")) return "person";
    if (p === "/api/xray" || p === "/api/trailer") return "xray";
    if (p === "/proxy") return "proxy";
  } else if (method === "POST") {
    if (p === "/api/subtitles/resync") return "resync";
  }
  return null;
};

let settingsCache = null;
let settingsAt = 0;
const readSettings = () => {
  const now = Date.now();
  if (settingsCache && now - settingsAt < 5000) return settingsCache;
  let raw;
  try { raw = require("../config").RATE_LIMITS; } catch { raw = undefined; }
  const mode = typeof raw === "string" ? raw : raw && typeof raw === "object" && raw.mode ? raw.mode : "log";
  const over = (raw && typeof raw === "object" && raw.groups && typeof raw.groups === "object") ? raw.groups : {};
  const groups = {};
  for (const [name, g] of Object.entries(GROUPS)) {
    const o = over[name] && typeof over[name] === "object" ? over[name] : {};
    groups[name] = {
      ...g,
      rate: Number(o.rate) > 0 ? Number(o.rate) : g.rate,
      burst: Number(o.burst) > 0 ? Number(o.burst) : g.burst,
      mode: ["log", "enforce", "off"].includes(o.mode) ? o.mode : ["log", "enforce", "off"].includes(mode) ? mode : "log",
    };
  }
  settingsCache = { mode: ["log", "enforce", "off"].includes(mode) ? mode : "log", groups };
  settingsAt = now;
  return settingsCache;
};

const isLoopback = (a) => a === "127.0.0.1" || a === "::1" || a === "localhost";
const isPrivate = (a) => isLoopback(a) || a.startsWith("10.") || a.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(a) || /^f[cd]/i.test(a) || /^fe80:/i.test(a);
// The client's address. X-Forwarded-For is believed only from a TRUSTED
// proxy — this machine itself by default (nginx / Caddy on the same box, the
// nufurora.com layout); a proxy elsewhere (a Docker bridge, another host) is
// named in config.json: "trustProxy": ["172.17.0.1"] (exact addresses, or
// "10.0.0.0/8"-style IPv4 ranges). The header is read from the right: hops
// added by trusted proxies are skipped, the first one that is not is the
// client — so a client cannot pick its own address by sending the header.
const ipv4 = (a) => { const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a); return m ? ((+m[1] << 24) >>> 0) + (+m[2] << 16) + (+m[3] << 8) + +m[4] : null; };
let trustCache = { raw: undefined, list: null };
const trusted = () => {
  let raw;
  try { raw = require("../config").TRUST_PROXY; } catch { raw = undefined; }
  if (trustCache.raw === raw && trustCache.list) return trustCache.list;
  const list = [];
  for (const t of Array.isArray(raw) ? raw : []) {
    const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(String(t).trim());
    if (m && ipv4(m[1]) != null) { const bits = Number(m[2]); const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0; list.push({ net: (ipv4(m[1]) & mask) >>> 0, mask }); }
    else list.push({ exact: String(t).trim().replace("::ffff:", "") });
  }
  trustCache = { raw, list };
  return list;
};
const isTrustedProxy = (a) => {
  if (isLoopback(a)) return true;
  const n = ipv4(a);
  for (const t of trusted()) {
    if (t.exact != null ? t.exact === a : n != null && ((n & t.mask) >>> 0) === t.net) return true;
  }
  return false;
};
const addressOf = (req) => {
  const sock = String((req.socket && req.socket.remoteAddress) || "").replace("::ffff:", "");
  if (!isTrustedProxy(sock)) return sock || "?";
  const hops = String(req.headers["x-forwarded-for"] || "").split(",").map((x) => x.trim().replace("::ffff:", "")).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) if (!isTrustedProxy(hops[i]) || i === 0) return hops[i];
  return sock || "?";
};
let authzLib = null;
const clientOf = (req) => {
  try {
    if (!authzLib) authzLib = require("./authz");
    const s = authzLib.sessionFor(req); // a LIVE session only: a made-up one is an address
    if (s && s.sessionKey) return { key: `s:${String(s.sessionKey).slice(0, 16)}`, lan: false, kind: "session" };
    if (s && s.profile) return { key: `p:${s.profile.id}`, lan: false, kind: "session" };
  } catch {}
  const a = addressOf(req);
  return { key: `a:${a}`, lan: isPrivate(a), kind: "address" };
};

const buckets = new Map(); // `${group}|${key}` -> { tokens, at }
const counts = {}; // group -> { allowed, refused, wouldRefuse, lastAt }
const said = new Map(); // group -> last log time
const countOf = (g) => counts[g] || (counts[g] = { allowed: 0, refused: 0, wouldRefuse: 0, lastRefusedAt: 0, clients: new Set() });

let clock = () => Date.now();

// Take one token. { ok, retryAfterSec, mode }
const take = (group, req) => {
  const st = readSettings();
  const g = st.groups[group];
  if (!g || g.mode === "off") return { ok: true, mode: "off" };
  const who = clientOf(req);
  const factor = who.lan ? LAN_FACTOR : 1;
  const rate = g.rate * factor;
  const burst = g.burst * factor;
  const k = `${group}|${who.key}`;
  const now = clock();
  let b = buckets.get(k);
  if (!b) {
    if (buckets.size >= MAX_KEYS) sweep(now, true);
    b = { tokens: burst, at: now };
    buckets.set(k, b);
  } else {
    b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * rate);
    b.at = now;
  }
  const c = countOf(group);
  if (b.tokens >= 1) {
    b.tokens -= 1;
    c.allowed++;
    return { ok: true, mode: g.mode };
  }
  const retryAfterSec = Math.max(1, Math.ceil((1 - b.tokens) / rate));
  c.lastRefusedAt = now;
  if (c.clients.size < 1000) c.clients.add(who.key);
  if (g.mode === "enforce") c.refused++;
  else c.wouldRefuse++;
  // one line per group per minute, whatever the flood
  if (now - (said.get(group) || 0) > LOG_EVERY_MS) {
    said.set(group, now);
    console.warn(`[ratelimit] ${g.mode === "enforce" ? "refused" : "would refuse (log mode)"} ${group}: a ${who.kind === "session" ? "signed-in device" : who.lan ? "LAN address" : "address"} over ${g.burst * factor} at once / ${g.rate * factor} a second (refused so far: ${c.refused}, would have: ${c.wouldRefuse})`);
  }
  return { ok: g.mode !== "enforce", mode: g.mode, retryAfterSec, over: true };
};

const refuse = (res, group, retryAfterSec) => {
  if (res.headersSent) return;
  res.setHeader("Retry-After", String(retryAfterSec));
  res.status(429).json({ error: `Too many requests — try again in ${retryAfterSec} s.`, retryAfter: retryAfterSec, limit: group });
};

// Express middleware: every limited group, by path.
const middleware = (req, res, next) => {
  const group = groupOf(req.method, req.path);
  if (!group) return next();
  const r = take(group, req);
  if (r.ok) return next();
  refuse(res, group, r.retryAfterSec);
};

// A full bucket is the same as no bucket: forget it.
const sweep = (now = clock(), hard = false) => {
  const st = readSettings();
  for (const [k, b] of buckets) {
    const g = st.groups[k.slice(0, k.indexOf("|"))];
    const idleSec = (now - b.at) / 1000;
    if (!g || idleSec * g.rate + b.tokens >= g.burst || (hard && idleSec > 10)) buckets.delete(k);
  }
  if (hard && buckets.size >= MAX_KEYS) buckets.clear();
};
const timer = setInterval(() => sweep(), 60 * 1000);
timer.unref?.();

const status = () => {
  const st = readSettings();
  const groups = Object.entries(st.groups).map(([name, g]) => {
    const c = counts[name] || { allowed: 0, refused: 0, wouldRefuse: 0, lastRefusedAt: 0, clients: new Set() };
    return { group: name, label: g.label, mode: g.mode, rate: g.rate, burst: g.burst, allowed: c.allowed, refused: c.refused, wouldRefuse: c.wouldRefuse, clientsOver: c.clients.size, lastRefusedAgoMs: c.lastRefusedAt ? clock() - c.lastRefusedAt : null };
  });
  return { mode: st.mode, lanFactor: LAN_FACTOR, buckets: buckets.size, groups };
};

const _reset = () => { buckets.clear(); for (const k of Object.keys(counts)) delete counts[k]; said.clear(); settingsCache = null; };

module.exports = {
  middleware, take, refuse, groupOf, status, GROUPS,
  _internals: { buckets, addressOf, isTrustedProxy, clientOf, sweep, readSettings, _reset, setClock: (fn) => { clock = fn || (() => Date.now()); } },
};
