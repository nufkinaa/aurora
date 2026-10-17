// AirPlay links (2026-10-17): a signed, expiring, ONE-TITLE address for the
// device a film is handed to.
//
// WHY. When Safari sends a film to an Apple TV (AirPlay video), the Apple TV
// fetches the stream ITSELF — the playlist, every segment, or the file. It
// has none of the sender's credentials: no session cookie, no X-Session
// header, nothing Aurora's sign-in wall would let through. On a server in
// sign-in mode "closed" every /stream request it made was a 401 and the TV
// showed an error (Matan's "Airplay do not work", 2026-10-17). So the player
// asks for an address that carries its own, narrow permission:
//
//     /air/<token>/stream/transcode/<id>/jit/index.m3u8?seg=fmp4
//
// THE TOKEN rides in the PATH, not in the query, because every address a
// playlist names is RELATIVE (index.m3u8?v=…, seg00012.m4s?v=…, init.mp4,
// sub/0.m3u8): resolved against /air/<token>/stream/…/ they keep the token
// with no rewriting of any playlist. A query would be dropped by the first
// relative URI.
//
// WHAT IT IS. base64url(JSON payload) "." base64url(HMAC-SHA256), the key
// random per process and never written anywhere (lib/internalpass.js does
// the same): a server restart ends every link (the player asks for a new one
// when the receiver reports an error — public/js/airplay.js). The payload:
//   v  1
//   t  the title: "l:<library id>" or "t:<infoHash>:<fileIdx>"
//   p  the profile that asked ("" when nobody did: sign-in modes open/transition)
//   s  a digest of the sign-in session that asked ("" without one)
//   k  the kids age limit in force for the asker when it asked (-1: none)
//   e  expiry, seconds since the epoch
//   n  a nonce (two links are never the same string)
//
// WHAT IT OPENS — and nothing else (pathScope / allowed below):
//   GET/HEAD of the stream routes of THAT ONE title: the file itself, the
//   remux, the jit playlists and segments, the offset transcode, and the
//   AirPlay master + subtitle playlists (routes/stream.js "airplay"). No /api,
//   no /img, no other title, no POST (not even the jit goodbye beacon), no
//   download route (a link is for watching, not for taking the file away —
//   /stream/download is not on the list).
//
// WHEN IT STOPS: at its expiry; when the session that asked is ended (sign
// out, the admin's Kick or Reset password); when the profile is locked,
// deleted or owes a new password; when the wall is closed and the link was
// asked for without a session. The kids gate judges every request made with
// it as the asker (routes/api.js kidsFor: the stricter of the limit carried
// here and the profile's limit now).
//
// The middleware runs BEFORE the sign-in wall (server.js): it checks the
// token, takes every credential off the request (a link is exactly its own
// permission — a stray cookie must not widen or narrow it), rewrites req.url
// to the stream path and marks the request (req.air). The wall lets a marked
// request through; the reset gate and the kids gate still see it.
const crypto = require("crypto");

const KEY = crypto.randomBytes(32);
const PREFIX = "/air/";
// How long a link lives. A film is watched in one go (a pause or two): long
// enough for the longest film plus a break, short enough that a link copied
// out of a receiver's log is dead by the evening. The player asks for a new
// one when the receiver reports an error, so an expiry mid-film costs a
// moment, not the film.
const MIN_TTL_MS = 3 * 3600 * 1000;
const MAX_TTL_MS = 8 * 3600 * 1000;
const EXTRA_MS = 2 * 3600 * 1000;
const ttlFor = (durationSec) => {
  const d = Number(durationSec) > 0 ? Number(durationSec) * 1000 : 0;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, d + EXTRA_MS));
};

const b64 = (buf) => Buffer.from(buf).toString("base64url");
const sign = (body) => crypto.createHmac("sha256", KEY).update(body).digest("base64url");
// A session named by digest only (the stored key is the sha256 of the id;
// this is a hash of THAT, cut short) — the receiver never holds anything a
// session can be found or ended with.
const sessionDigest = (sessionKey) =>
  sessionKey ? crypto.createHash("sha256").update(`air|${sessionKey}`).digest("hex").slice(0, 24) : "";

// ---------- which paths belong to which title ----------
const ID = "[A-Za-z0-9_-]{1,64}";
const HASH = "[a-fA-F0-9]{40}";
const SEG = "(?:index\\.m3u8|master\\.m3u8|init\\.mp4|seg\\d{5}\\.(?:ts|m4s))";
const LIB_RULES = [
  new RegExp(`^/stream/video/(${ID})$`),
  new RegExp(`^/stream/hls/(${ID})/(?:index\\.m3u8|seg\\d{5}\\.ts)$`),
  new RegExp(`^/stream/transcode/(${ID})/jit/${SEG}$`),
  new RegExp(`^/stream/transcode/(${ID})/\\d{1,6}/${SEG}$`),
  new RegExp(`^/stream/airplay/(${ID})/(?:master\\.m3u8|sub/\\d{1,2}\\.(?:m3u8|vtt))$`),
];
const TOR_RULES = [
  new RegExp(`^/stream/torrent/(${HASH})/(\\d{1,5})$`),
  new RegExp(`^/stream/torrent/hls/(${HASH})/(\\d{1,5})/jit/${SEG}$`),
  new RegExp(`^/stream/torrent/hls/(${HASH})/(\\d{1,5})/\\d{1,6}/${SEG}$`),
];
// The title a stream path belongs to, as the token names it — or null for a
// path no link may open.
const pathScope = (p) => {
  if (typeof p !== "string" || p.length > 400 || p.includes("..") || p.includes("//")) return null;
  for (const re of LIB_RULES) {
    const m = re.exec(p);
    if (m) return `l:${m[1]}`;
  }
  for (const re of TOR_RULES) {
    const m = re.exec(p);
    if (m) return `t:${m[1].toLowerCase()}:${Number(m[2])}`;
  }
  return null;
};

const mint = ({ title, profileId = "", sessionKey = null, maxAge = null, ttlMs = MIN_TTL_MS, now = Date.now() }) => {
  if (typeof title !== "string" || !/^(l:[A-Za-z0-9_-]{1,64}|t:[a-f0-9]{40}:\d{1,5})$/.test(title)) throw new Error("bad title");
  const payload = {
    v: 1,
    t: title,
    p: profileId ? String(profileId) : "",
    s: sessionDigest(sessionKey),
    k: typeof maxAge === "number" && Number.isFinite(maxAge) ? maxAge : -1,
    e: Math.floor((now + Math.max(60 * 1000, Math.min(MAX_TTL_MS, ttlMs))) / 1000),
    n: crypto.randomBytes(6).toString("hex"),
  };
  const body = b64(JSON.stringify(payload));
  return { token: `${body}.${sign(body)}`, expiresAt: payload.e * 1000 };
};

// The payload of a good, unexpired token — else null. Constant-time compare.
const verify = (token, now = Date.now()) => {
  if (typeof token !== "string" || token.length > 600) return null;
  const dot = token.indexOf(".");
  if (dot < 1 || dot !== token.lastIndexOf(".")) return null;
  const body = token.slice(0, dot);
  const got = Buffer.from(token.slice(dot + 1));
  const want = Buffer.from(sign(body));
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  let p = null;
  try { p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
  if (!p || p.v !== 1 || typeof p.t !== "string" || typeof p.e !== "number") return null;
  if (p.e * 1000 <= now) return null;
  return p;
};

// May a request with this payload read this path?
const allowed = (payload, method, p) =>
  !!payload && (method === "GET" || method === "HEAD") && pathScope(p) === payload.t;

// ---------- the request side ----------
// deps (injectable for tests): closed() -> bool, profile(id) -> raw profile
// | null, resetDue(id) -> bool, sessionLive(digest) -> bool
const defaultDeps = () => ({
  closed: () => require("./authmode").get() === "closed",
  profile: (id) => require("../profiles").list().find((x) => x.id === id) || null,
  resetDue: (id) => require("../profiles").resetDue(id),
  sessionLive: (digest) => {
    const { store } = require("./sessions")._internals;
    const now = Date.now();
    for (const [key, row] of Object.entries(store.data)) {
      if (row && row.expiresAt > now && sessionDigest(key) === digest) return true;
    }
    return false;
  },
});

const refuse = (res, status, error) => {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json({ error, airplay: true });
};

// Why a payload no longer opens anything right now (null = it does).
const stale = (p, deps) => {
  if (p.p) {
    const prof = deps.profile(p.p);
    if (!prof || prof.locked) return "That profile can't be used right now.";
    if (deps.resetDue(p.p)) return "A new password is needed before this profile can be used again.";
  }
  if (p.s && !deps.sessionLive(p.s)) return "That sign-in has ended — start AirPlay again from the player.";
  // a link asked for while the doors were open does not open them once closed
  if (deps.closed() && !p.s) return "Sign in first.";
  return null;
};

const makeMiddleware = (depsIn = null) => {
  let deps = depsIn;
  return (req, res, next) => {
    const url = req.url || "";
    if (!url.startsWith(PREFIX)) return next();
    if (!deps) deps = defaultDeps();
    const rest = url.slice(PREFIX.length);
    const slash = rest.indexOf("/");
    if (slash < 1) return refuse(res, 404, "Not found");
    const token = rest.slice(0, slash);
    const inner = rest.slice(slash); // "/stream/…?query"
    const q = inner.indexOf("?");
    let innerPath = q < 0 ? inner : inner.slice(0, q);
    try { innerPath = decodeURIComponent(innerPath); } catch { return refuse(res, 400, "Bad address"); }
    const p = verify(token);
    if (!p) return refuse(res, 401, "This AirPlay link has expired — start AirPlay again from the player.");
    if (!allowed(p, req.method, innerPath)) return refuse(res, 403, "This AirPlay link is for one film's stream only.");
    const why = stale(p, deps);
    if (why) return refuse(res, 401, why);
    // exactly the link's own permission from here on
    const h = req.headers || {};
    delete h.cookie;
    delete h["x-session"];
    delete h["x-profile-token"];
    delete h["x-profile"];
    delete h["x-admin-password"];
    delete h["x-aurora-internal"];
    req.url = inner;
    req.air = { profile: p.p || null, maxAge: p.k >= 0 ? p.k : null, title: p.t, expiresAt: p.e * 1000 };
    // nothing a receiver is handed is for any cache along the way
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  };
};
const middleware = makeMiddleware();

module.exports = {
  PREFIX, mint, verify, allowed, pathScope, ttlFor, sessionDigest, makeMiddleware, middleware,
  _internals: { MIN_TTL_MS, MAX_TTL_MS, stale },
};
