// A forced password reset, enforced on the server (2026-10-10).
//
// THE RULE. When the admin asks a profile for a new password (People →
// "Reset password": routes/admin.js) every session and unlock token of that
// profile is ended on the spot. The current password still signs in — that is
// how the person proves who they are — but until a new password is saved,
// every credential of that profile is a RESTRICTED one. A request made with
// one may call, as that profile,
//
//     GET  /api/ping, /api/me, /api/server-info     (what a client needs to draw the screen)
//     POST /api/auth/logout                         (sign out)
//     POST /api/auth/password                       (save the new password — by session)
//     POST /api/profiles/<that profile>/password    (the same — by session or unlock token)
//
// and nothing else: every other /api, /stream, /img, /avatars, /offline and
// /proxy request that carries such a credential is refused with
//
//     401 { error, signinRequired: true, passwordResetRequired: true, profileId }
//
// `passwordResetRequired` is the machine-readable part: a client that knows
// it shows a blocking "pick a new password" screen. `signinRequired` with a
// 401 is for the clients that do not (a released TV build, a tab running last
// week's code): it is the refusal they already understand — "this sign-in is
// no good, go to the sign-in screen" — so they stop, rather than run on as a
// half-working app. Read `passwordResetRequired` FIRST.
//
// This replaces the earlier rule ("the flag is a note to the client"), under
// which the person could close the sheet and carry on with the old password.
//
// SIGNING IN AGAIN is not something done "as that profile", and it has to
// stay possible: a device must be able to become somebody else (or the same
// person, once more). So the routes a device with NO sign-in may call — sign
// in, pair, the profile wall's list and its unlock, the kids lock — are let
// through with the restricted credential TAKEN OFF the request (SIGN_IN_AGAIN
// below): they run exactly as they do for a stranger, and nothing in them
// sees the restricted sign-in. A must-reset session that arrives there as a
// cookie is ended as well — a device back at its sign-in screen or profile
// wall has walked away from it, and the cookie would otherwise ride along on
// every picture the next profile asks for.
//
// WHICH CREDENTIAL SPEAKS. A request can carry three: the session cookie, an
// X-Session header and an X-Profile-Token header. The TV app sends headers,
// and its HTTP stack ALSO keeps whatever cookie an earlier sign-in set — so a
// TV that has moved on to another profile can still be dragging a must-reset
// profile's cookie along. The headers are what a client attached on purpose:
//   - a live header credential of a must-reset profile → restricted;
//   - live header credentials, none of them restricted → that is who is
//     asking; a must-reset profile's COOKIE beside them is taken off the
//     request (it must not hold the other profile up, and it must not let the
//     request through as the must-reset one either) and the session it names
//     is ended: the device has moved on;
//   - no live header credential → the cookie decides. A browser's <img> and
//     <video> requests carry only the cookie, so a browser that signed in as
//     a must-reset profile is that person's until they finish or sign out.
//
// WHAT IT CANNOT DO. In sign-in modes "open" and "transition" the library,
// the pictures and the streams are served to anyone who can reach the server,
// with no credential at all — that is what those modes mean. A must-reset
// profile is locked there too (its history, My List, settings and every
// request made with its credentials), but a person who presents NO credential
// is a visitor like any other. Only "closed" makes "nothing" mean nothing.
//
// SIGNED OUT BY THE ADMIN. The same middleware answers for credentials the
// admin ended (Kick, Reset password): a request that still presents one in a
// header (X-Session, X-Profile-Token — what the TV app and the website attach
// themselves) and holds no live credential is told
//
//     401 { error, signinRequired: true, signedOut: true }
//
// so the device goes to its sign-in / profile screen on its next request
// instead of carrying on as a visitor. Cookies are left out on purpose: a
// dead cookie stays in a browser until something replaces it, and the profile
// wall must keep working around it.
const sessions = require("./sessions");
const profiles = require("../profiles");
const authz = require("./authz");

// Everything that serves data — the sign-in wall's list (server.js), plus
// /offline/ (the prepared copy a phone saves: video, served by routes/stream.js).
const GATED = (p) => /^\/(api|stream|avatars|img|offline)\//.test(p) || p === "/proxy";

// What the request carries, and whose it is while it is LIVE.
const read = (req) => {
  const h = req.headers || {};
  const cookieSid = authz.readCookie(req);
  const headerSid = h["x-session"] ? String(h["x-session"]) : null;
  const token = h["x-profile-token"] ? String(h["x-profile-token"]) : null;
  const rowOf = (sid) => (sid ? sessions.get(sid) : null);
  const cookieRow = rowOf(cookieSid);
  const headerRow = rowOf(headerSid);
  return {
    headerSid, token,
    cookie: cookieRow ? cookieRow.profileId : null,
    header: [headerRow ? headerRow.profileId : null, token ? profiles.tokenProfile(token) : null].filter(Boolean),
  };
};

// Take the sign-in credentials off a request (the session cookie alone, or
// the headers too): what runs next sees a request that never had them.
// `end`: the cookie's session is a must-reset one the device has left behind
// — it is ended on the server too, and the browser is told to forget it.
const dropCookie = (req, res = null, { end = false } = {}) => {
  const raw = req.headers && req.headers.cookie;
  if (!raw) return;
  if (end) {
    const sid = authz.readCookie(req);
    if (sid) sessions.revoke(sid);
    // (a route that sets a cookie of its own — a sign-in — replaces this)
    if (res && !res.headersSent) { try { authz.clearSessionCookie(req, res); } catch {} }
  }
  const kept = String(raw).split(";").filter((part) => part.trim().split("=")[0] !== authz.COOKIE);
  if (kept.length) req.headers.cookie = kept.join(";");
  else delete req.headers.cookie;
};
const dropAll = (req, res = null, { end = false } = {}) => {
  dropCookie(req, res, { end });
  if (req.headers) {
    delete req.headers["x-session"];
    delete req.headers["x-profile-token"];
  }
};

// The must-reset profile this request is made as, or null — by the rule
// above ("which credential speaks"). Works on a bare http.IncomingMessage too
// (the WebSocket upgrade). NOTE it may take a stale must-reset cookie off the
// request (and end its session): call it before reading the session.
const restrictedProfile = (req, res = null) => {
  // (a household with no reset pending pays one array scan and no more)
  if (!profiles.list().some((p) => p.mustReset)) return null;
  const c = read(req);
  for (const id of c.header) if (profiles.resetDue(id)) return id;
  const cookieDue = !!c.cookie && profiles.resetDue(c.cookie);
  if (c.header.length) {
    if (cookieDue) dropCookie(req, res, { end: true });
    return null;
  }
  return cookieDue ? c.cookie : null;
};

// As that profile: the way to a new password, and out.
const allowedWhileRestricted = (req, id) => {
  const p = req.path;
  if (req.method === "GET") return /^\/api\/(ping|me|server-info)$/.test(p);
  if (req.method !== "POST") return false;
  if (p === "/api/auth/logout" || p === "/api/auth/password") return true;
  const m = /^\/api\/profiles\/([^/]+)\/password$/.exec(p);
  if (!m) return false;
  try { return decodeURIComponent(m[1]) === id; } catch { return false; }
};

// As nobody: what a device with no sign-in may ask, to get one — sign in
// (password, Google), pair a TV (start / poll / describe — NOT approve, which
// acts with a session), ask for a profile, the wall's list and its unlock
// with the faces on it, and the kids lock.
const SIGN_IN_AGAIN = [
  ["POST", /^\/api\/auth\/(login|signup|google\/(start|poll|web-finish)|device\/(start|poll))$/],
  ["GET", /^\/api\/auth\/(google\/(web-start|web-callback)|device\/describe\/[^/]+)$/],
  ["GET", /^\/api\/(profiles|kids\/status)$/],
  ["POST", /^\/api\/(profiles\/[^/]+\/unlock|kids\/(enter|exit))$/],
  ["GET", /^\/avatars\//],
];
const signingInAgain = (req) => SIGN_IN_AGAIN.some(([method, re]) => req.method === method && re.test(req.path));

// A header credential the admin ended, and nothing live beside it.
const signedOut = (req) => {
  const c = read(req);
  const ended =
    (c.headerSid && sessions.wasEnded(c.headerSid)) || (c.token && profiles.tokenEnded(c.token));
  return !!ended && !c.cookie && c.header.length === 0;
};
// What a signed-out device may still ask: everything it needs to sign in
// again or to pick a profile at the wall.
const OPEN_WHEN_SIGNED_OUT =
  /^\/api\/(ping|me|server-info|profiles|kids\/(status|enter|exit))$|^\/api\/auth\/|^\/api\/profiles\/[^/]+\/unlock$/;

const RESET_REFUSAL = "A new password is needed before this profile can be used again.";
const refusal = (profileId) => ({
  error: RESET_REFUSAL,
  signinRequired: true,
  passwordResetRequired: true,
  profileId,
});

const middleware = (req, res, next) => {
  if (!GATED(req.path)) return next();
  const rid = restrictedProfile(req, res);
  const out = rid ? false : signedOut(req);
  if (!rid && !out) return next();
  // The admin page may be open in the very browser that is being asked (its
  // own calls carry the admin password), and the server reads its own /img.
  if (require("../realtime").isAdmin(req)) return next();
  if (require("./internalpass").ok(req)) return next();
  if (rid) {
    if (allowedWhileRestricted(req, rid)) return next();
    if (signingInAgain(req)) {
      // (only a session that came as the COOKIE is ended: a header was put
      // there by a client that may be sitting on its "new password" screen —
      // and not for a face on the wall: a picture is not a decision to leave)
      const c = read(req);
      dropAll(req, res, { end: !!c.cookie && profiles.resetDue(c.cookie) && !req.path.startsWith("/avatars/") });
      return next();
    }
    return res.status(401).json(refusal(rid));
  }
  if (OPEN_WHEN_SIGNED_OUT.test(req.path)) return next();
  res.status(401).json({ error: "You were signed out — sign in again.", signinRequired: true, signedOut: true });
};

// The new password is saved (profiles.setPassword cleared the flag and ended
// every unlock token). What is left: every session of the profile goes — the
// restricted ones minted since the reset was asked, on this device and any
// other — and THIS device, which has just proved the old password and chosen
// the new one, is handed fresh credentials so it carries on without meeting
// the wall again: an unlock token always, and a sign-in session when the
// profile signs in (the unlock route's own rule). The profile's other open
// sockets are told, as "sign out everywhere else" tells them.
const finish = (req, res, id) => {
  const realtime = require("../realtime");
  sessions.revokeAllFor(id);
  const raw = profiles.list().find((x) => x.id === id);
  const out = { token: profiles.issueToken(id), passwordReset: "done" };
  if (raw && profiles.isClaimed(raw)) {
    const sid = sessions.create(id, {
      ip: realtime.clientIp(req),
      device: realtime.parseDevice(req.headers["user-agent"] || ""),
    });
    authz.setSessionCookie(req, res, sid);
    out.session = sid; // the TV stores this and sends it as X-Session
    out.user = profiles.signinPub(raw);
  }
  try {
    const except = String((req.body || {}).clientId || "");
    const msg = JSON.stringify({ type: "profile_signed_out", profileId: id });
    for (const c of realtime.clientsOfProfile(raw || { id })) {
      if (except && c.id === except) continue;
      try { c.ws.send(msg); } catch {}
    }
  } catch {}
  return out;
};

module.exports = {
  middleware, restrictedProfile, signedOut, allowedWhileRestricted, signingInAgain, refusal, finish,
  RESET_REFUSAL,
};
