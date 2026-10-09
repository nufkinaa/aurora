// Shared session plumbing (prompt 10) — one place that answers "who is making
// this request?", used by the auth routes AND by every route that gates on it.
// Kept out of routes/auth.js so data routes never import a router.
const sessions = require("./sessions");
const profiles = require("../profiles");

const COOKIE = "aurora_session";

const isHttps = (req) =>
  req.secure || String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https";

const readCookie = (req) => {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) {
      // a hand-mangled cookie value ("%zz") must read as "no session",
      // not throw 500s out of every route that resolves sessions
      try { return decodeURIComponent(v.join("=")); } catch { return null; }
    }
  }
  return null;
};

// Secure is added automatically on HTTPS origins (nufurora.com behind a valid
// cert); on the LAN's plain HTTP it can't be — that's the honest ceiling of
// this deployment, per findings/auth.md §4.
const setSessionCookie = (req, res, sid) => {
  const attrs = [
    `${COOKIE}=${sid}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${90 * 24 * 3600}`,
  ];
  if (isHttps(req)) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
};
const clearSessionCookie = (req, res) => {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
};

// Cookie first (browsers), X-Session header second (the TV app — RN cookies
// are unreliable across restarts, so it stores the sid in AsyncStorage).
// Works on plain http.IncomingMessage too (the WS upgrade request has no
// Express req.get), so realtime can stamp ws.authed at connection time.
// ACCOUNT = PROFILE: a session resolves straight to its profile.
// A DEAD cookie must not shadow a live header: the TV app stores its sid and
// sends it as X-Session, but RN's HTTP stack also keeps whatever cookie a
// login or profile unlock set, and that one goes stale when the session it
// named is revoked (admin kick, a later unlock replacing it) while the TV
// pairs afresh and holds a newer sid. With "cookie first, full stop" every
// request of such a TV answered 401 — no pictures anywhere (2026-10-09).
const liveRow = (sid) => (sid ? sessions.get(String(sid)) : null);
const sessionFor = (req) => {
  const row = liveRow(readCookie(req)) || liveRow(req.headers["x-session"]);
  if (!row) return null;
  const p = profiles.list().find((x) => x.id === row.profileId);
  if (!p || p.locked) return null; // a locked profile's sessions are dead air
  return { profile: p, user: profiles.signinPub(p), sessionKey: row.key };
};

// May this request touch this profile's data? Only "closed" mode adds the
// session check — open and transition keep today's behavior exactly, so
// nothing changes for anyone until the admin closes the wall.
const profileAllowed = (req, profileId) => {
  if (require("./authmode").get() !== "closed") return true;
  const s = sessionFor(req);
  return !!s && s.profile.id === profileId;
};

module.exports = {
  COOKIE,
  isHttps,
  readCookie,
  setSessionCookie,
  clearSessionCookie,
  sessionFor,
  profileAllowed,
};
