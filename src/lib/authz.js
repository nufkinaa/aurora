// Shared session plumbing (prompt 10) — one place that answers "who is making
// this request?", used by the auth routes AND by every route that gates on it.
// Kept out of routes/auth.js so data routes never import a router.
const sessions = require("./sessions");
const profiles = require("../profiles");
// Imports that have to stay inside functions (circular), asked for once
// instead of on every call — lib/lazy.js has the why.
const lazy = require("./lazy");
const authmodeLib = lazy(require, "./authmode");

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
  return {
    profile: p, user: profiles.signinPub(p), sessionKey: row.key,
    // (auth-round) how and where this session began — trustedForReset reads them
    kind: row.kind || null, via: row.via || null, createdAt: row.createdAt || 0, device: row.device || null,
  };
};

// What asked (auth-round): the apps say so in X-Aurora-App; a browser is a
// browser by its user agent; anything else (an app build from before this
// round, a script) counts as a TV — the most careful answer.
const appKind = (req) => {
  const h = String((req.headers && req.headers["x-aurora-app"]) || "").toLowerCase();
  if (h === "phone" || h === "tv") return h;
  return /mozilla\//i.test(String((req.headers && req.headers["user-agent"]) || "")) ? "web" : "tv";
};

// May this signed-in session set a new password WITHOUT the current one?
// (elia's "reset from a device where you're still signed in"). Yes when:
//   - the person proved who they are on THIS device a moment ago (a sign-in
//     with a password, Google, a claim or a reset, under RECENT_PROOF_MS) —
//     any device, the TV included: they are standing at it; or
//   - it is their own phone app or browser (never a TV: a shared screen in a
//     living room), signed in by them (not a TV pairing) within the last
//     TRUSTED_DAYS days.
// Never a kids profile (a child may not change the profile's password).
// -> { ok, why } — `why` names the reason it is refused, for the client's words.
const RECENT_PROOF_MS = 10 * 60 * 1000;
const TRUSTED_DAYS = 30;
const PROOFS = new Set(["password", "google", "claim", "reset", "unlock"]);
const trustedForReset = (s, now = Date.now()) => {
  if (!s) return { ok: false, why: "signed-out" };
  if (profiles.kidsOf && profiles.kidsOf(s.profile.id)) return { ok: false, why: "kids" };
  const age = now - (s.createdAt || 0);
  if (PROOFS.has(s.via) && age < RECENT_PROOF_MS) return { ok: true, why: "recent" };
  // sessions from before this round carry no kind: a real browser's user
  // agent (device.browser) is the one sign they were a browser's
  const kind = s.kind || (s.device && s.device.browser && s.device.browser !== "Other" ? "web" : "tv");
  if (kind === "tv") return { ok: false, why: "tv" };
  if (s.via === "pair") return { ok: false, why: "paired" };
  if (age > TRUSTED_DAYS * 24 * 3600 * 1000) return { ok: false, why: "old" };
  return { ok: true, why: "trusted" };
};

// May this request touch this profile's data? Only "closed" mode adds the
// session check — open and transition keep today's behavior exactly, so
// nothing changes for anyone until the admin closes the wall.
const profileAllowed = (req, profileId) => {
  if (authmodeLib().get() !== "closed") return true;
  const s = sessionFor(req);
  return !!s && s.profile.id === profileId;
};

module.exports = {
  appKind, trustedForReset, RECENT_PROOF_MS, TRUSTED_DAYS,
  COOKIE,
  isHttps,
  readCookie,
  setSessionCookie,
  clearSessionCookie,
  sessionFor,
  profileAllowed,
};
