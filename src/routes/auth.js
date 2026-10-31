// Sign-in (prompt 10, account = profile). There is no separate accounts
// layer: a profile signs in with its username (or email) and its OWN
// password — one password concept in the whole app. Sessions ride an
// HttpOnly cookie for browsers (Secure auto-added on HTTPS origins) and the
// X-Session header for the TV. The rollout switch lives in the admin panel
// (src/lib/authmode.js) and is read per request.
//
// auth-round (2026-10-31): Google on the phone app (a Custom Tab and a
// one-time hand-off code, /google/app-start + /google/app-finish), a password
// required for every sign-up (Google too), a first password asked of
// Google-only profiles, self-service password reset (/reset/*), and errors
// that name the field they belong to. docs/auth-round.md is the contract.
const express = require("express");
const crypto = require("crypto");
const config = require("../config");
const profiles = require("../profiles");
const sessions = require("../lib/sessions");
const realtime = require("../realtime");
const {
  readCookie, setSessionCookie, clearSessionCookie, sessionFor, appKind, trustedForReset,
} = require("../lib/authz");
const resetgate = require("../lib/resetgate");
const limit = require("../lib/authlimit");
const passrules = require("../lib/passrules");
const google = require("../lib/googleauth");
const pwreset = require("../lib/pwreset");
const authlog = require("../lib/authlog");

const router = express.Router();
// Imports that have to stay inside functions (circular), asked for once
// instead of on every call — lib/lazy.js has the why.
// (/api/ping asks on every app start.)
const lazy = require("../lib/lazy");
const authmodeLib = lazy(require, "../lib/authmode");

const deviceOf = (req) => realtime.parseDevice(req.headers["user-agent"] || "");
// What the auth log calls the device: the apps say what they are (X-Aurora-App);
// a browser is read from its user agent.
const logDevice = (req) => {
  const k = appKind(req);
  if (k === "phone") return "Phone app";
  if (k === "tv" && req.headers["x-aurora-app"]) return "TV app";
  const d = deviceOf(req);
  return `${d.browser} on ${d.os}`;
};
// The admin's name as a sign-in screen may say it: in "closed" mode, before a
// session, the generic words (the same rule as /api/server-info — member data
// is not handed out before sign-in).
const adminNameFor = (req) => (authmodeLib().get() !== "closed" || sessionFor(req) ? config.ADMIN_NAME : "the admin");
// A new sign-in session, remembering what asked and how the person proved it.
const newSession = (req, profileId, via) =>
  sessions.create(profileId, { ip: realtime.clientIp(req), device: deviceOf(req), kind: appKind(req), via });

// Minimal health endpoint for the TV's server resolver: stays 200 in every
// auth mode, carries nothing personal.
// `imgBlur`: this server renders ?blur= art variants (lib/imgvariant.js) — the
// TV asks for its billboard pre-blurred only when the server says so, and
// keeps blurring on the box against an older one.
// `imgFmt`: the formats ?fmt= understands on those blurred variants, and the
// promise that the width ladder reaches 1920 (the TV's title-page backdrop
// through /img/ext?w=) — docs/qa/native-bench/ART-FORMAT-PLAN.md.
// `imgHosts`: hosts /img/ext proxies that older servers did not
// (lib/imghosts.js ADDED_HOSTS) — the TV sends a picture from one of them
// through the proxy only when the server lists it here.
router.get("/api/ping", (req, res) => {
  res.json({
    ok: true,
    name: "aurora",
    authMode: authmodeLib().get(),
    imgBlur: true,
    imgFmt: ["webp"],
    imgHosts: require("../lib/imghosts").ADDED_HOSTS,
  });
});

// ---------- login rate limiting (per-IP and per-identifier) ----------
// lib/authlimit.js (shared with the reset routes below).
const { tooMany, recordFail } = limit;

// ---------- core endpoints ----------

// A profile that owes a new password (lib/resetgate.js) is NOT signed in as
// far as this answer goes — `user` is null, which is what keeps a client that
// predates the rule at its sign-in screen — and the answer says why:
// `passwordResetRequired`, with the little a client needs to draw the "pick
// a new password" screen. Asked with the session (cookie / X-Session) or the
// unlock token (X-Profile-Token) the device holds. `passwordSetup`: the
// password owed is a FIRST one (a Google-only profile, auth-round).
router.get("/api/me", (req, res) => {
  const authMode = authmodeLib().get();
  const rid = resetgate.restrictedProfile(req);
  const rp = rid ? profiles.list().find((x) => x.id === rid) : null;
  if (rp) {
    return res.json({
      authMode,
      user: null,
      passwordResetRequired: true,
      ...(profiles.setupDue(rp.id) ? { passwordSetup: true } : {}),
      resetProfile: { id: rp.id, name: rp.name, avatar: rp.avatar, color: rp.color },
    });
  }
  const s = sessionFor(req);
  res.json({ authMode, user: s ? s.user : null });
});

// Sign in with username OR email + the profile's password. Success hands
// back everything a client needs to walk straight in: the session (cookie +
// body for the TV), the profile card, and a profile unlock TOKEN — login
// verified the very same password, so asking for it again at the wall would
// be theater.
//
// `mustReset` (the admin's People → "Reset password"): every answer that
// hands out a session says whether a new password is due — this one, the
// TV's pairing poll, both Google flows and the wall's unlock
// (/api/profiles/:id/unlock). When it is, what was just handed out is a
// RESTRICTED credential: the server refuses everything made with it except
// saving a new password (lib/resetgate.js has the rule, the list of routes
// and the refusal). `mustReset` is how a client knows to go straight to its
// "pick a new password" screen; a client that ignores it (an older TV build)
// is refused on its next request and lands on its sign-in screen.
router.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  const ip = realtime.clientIp(req);
  const uKey = "u:" + String(username || "").trim().toLowerCase().slice(0, 80);
  if (tooMany("ip:" + ip) || tooMany(uKey)) return limit.refuse(res, ["ip:" + ip, uKey]);
  if (!String(username || "").trim()) return res.status(400).json({ error: "Enter your username or email.", field: "identifier" });
  if (!password) return res.status(400).json({ error: "Enter your password.", field: "password" });
  // (the password check can throw — scrypt fails when the machine is out of
  // memory — and an async handler's throw is never answered under Express 4:
  // the sign-in screen used to wait for ever)
  let result;
  try {
    result = await profiles.login(username, password);
  } catch (e) {
    console.error("[auth] sign-in check failed:", e && e.message ? e.message : e);
    return res.status(500).json({ error: "The server couldn't check that password right now. Try again in a moment." });
  }
  if (!result.ok) {
    recordFail("ip:" + ip);
    recordFail(uKey);
    profiles.recordAccess(profiles.byUsername(username)?.id || profiles.byEmail(username)?.id, {
      ip, device: deviceOf(req), failed: true,
    });
    return res.status(401).json({ error: result.error, ...(result.code ? { code: result.code } : {}) });
  }
  const sid = newSession(req, result.profileId, "password");
  setSessionCookie(req, res, sid);
  profiles.recordAccess(result.profileId, { ip, device: deviceOf(req) });
  res.json({
    ok: true,
    user: result.user,
    profile: result.profile,
    profileToken: profiles.issueToken(result.profileId),
    session: sid, // the TV stores this and sends it as X-Session
    mustReset: !!result.mustReset,
  });
});

router.post("/api/auth/logout", (req, res) => {
  // both: a TV may carry a cookie from an unlock AND its stored header sid
  // "Sign out" on the pick-a-new-password screen: the unlock token of a
  // profile that owes a new password goes too (an unclaimed profile has no
  // session — the token is all the device holds). Before the sessions: the
  // check below reads them.
  const token = req.get("X-Profile-Token");
  const tokenOf = token ? profiles.tokenProfile(token) : null;
  if (tokenOf && profiles.resetDue(tokenOf)) profiles.revokeToken(token);
  for (const sid of [readCookie(req), req.get("X-Session")]) if (sid) sessions.revoke(sid);
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

// ---------- request access (signup = a profile request) ----------
// The login screen's signup files the SAME kind of request the profile wall
// does — one approval queue for the admin — just with sign-in identity
// attached: username and/or email + password, plus (optionally) a
// server-verified Google identity (the pollId a finished Google step left).
// A password is required either way (auth-round; profiles.requestProfile).
const AVATARS = ["🍿", "🎬", "🦊", "🐼", "🚀", "🌵", "🦖", "👾", "🐳", "🌙", "⚡", "🔥"];
const COLORS = ["#e05f2c", "#8b7bff", "#2c9fe0", "#38b26c", "#d94f8a", "#e0b52c", "#7a5cd6", "#4ec3c9"];

router.post("/api/auth/signup", async (req, res) => {
  const { name, username, email, password, note, pollId } = req.body || {};
  const ip = realtime.clientIp(req);
  if (tooMany("signup:" + ip)) return limit.refuse(res, ["signup:" + ip]);
  recordFail("signup:" + ip); // signup attempts count against the window too

  // a completed Google flow (held server-side — the client only ever hands
  // back the opaque pollId, never a sub or email we'd have to trust). The
  // entry is consumed ONLY after the request succeeds: a validation failure
  // (name taken, password too short…) must leave it usable for the retry, or
  // the person is forced to redo the whole Google dance.
  let goog = null;
  if (pollId) {
    const p = gPolls.get(String(pollId));
    if (!p || !p.done || !p.signupSub) {
      return res.status(400).json({ error: "The Google step expired. Start again with Google.", code: "expired" });
    }
    goog = p.signupSub;
  }
  // An app from before this rule (TV 5.8.1, phone 1.0.1) asks with Google and
  // NO password field at all: its screen can only show this sentence, so the
  // sentence says what to do.
  if (goog && (password == null || password === "")) {
    return res.status(400).json({ error: "Choose a password to finish. If there's no password field here, update the Aurora app.", field: "password", code: "short" });
  }
  if (!goog && !String(username || "").trim() && !String(email || "").trim()) {
    return res.status(400).json({ error: "Choose a username, or give an email to sign in with.", field: "username" });
  }
  const result = await profiles.requestProfile({
    name,
    realName: name, // the display name IS who they are — one field, less form
    username,
    email: email || (goog ? goog.email : null),
    password,
    note,
    googleSub: goog ? goog.sub : null,
    googleEmail: goog ? goog.email : null,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    avatar: AVATARS[Math.floor(Math.random() * AVATARS.length)],
    ip,
    device: deviceOf(req),
  });
  if (result.error) {
    return res.status(400).json({ error: result.error, ...(result.field ? { field: result.field } : {}), ...(result.code ? { code: result.code } : {}) });
  }
  if (pollId) gPolls.delete(String(pollId)); // success — now it's spent
  if (goog) authlog.add("google-signup", { ip, device: logDevice(req), outcome: "requested" });
  realtime.broadcastAdmins({ type: "profile_request_new", request: result.request });
  res.json(result);
});

// ---------- claiming (transition-mode onboarding) ----------
// From inside their profile, a person switches sign-in on: pick a username
// (+ optional email). If the profile already has a password it simply stays
// the sign-in password — nothing new to invent; otherwise one is set here.
const profileProof = (req, profileId) => {
  if (!profiles.exists(profileId)) return { error: "no such profile", status: 404 };
  if (profiles.isLocked(profileId)) return { error: "that profile is locked", status: 403 };
  if (profiles.isProtected(profileId) && !profiles.tokenValid(profileId, req.get("X-Profile-Token"))) {
    return { error: "unlock the profile first", status: 401 };
  }
  return { ok: true };
};

// Claiming is TRANSITION machinery. With the wall closed it would be an
// anonymous hole: /api/auth/* is allowlisted through the wall, and an
// unclaimed password-less profile has no proof to demand — so a stranger
// could claim it (and mint a session) with one request. Closed = no claiming.
const claimingOpen = (res) => {
  if (authmodeLib().get() === "closed") {
    res.status(403).json({ error: `sign-in setup is over — ask ${config.ADMIN_NAME} for access` });
    return false;
  }
  return true;
};

router.get("/api/auth/claimable/:profileId", (req, res) => {
  if (!claimingOpen(res)) return;
  const proof = profileProof(req, req.params.profileId);
  if (proof.error) return res.status(proof.status).json({ error: proof.error });
  res.json({ claimable: profiles.claimableFor(req.params.profileId) });
});

router.post("/api/auth/claim", async (req, res) => {
  if (!claimingOpen(res)) return;
  const { profileId, username, email, password } = req.body || {};
  const ip = realtime.clientIp(req);
  if (tooMany("claim:" + ip)) return limit.refuse(res, ["claim:" + ip]);
  const proof = profileProof(req, String(profileId || ""));
  if (proof.error) {
    recordFail("claim:" + ip);
    return res.status(proof.status).json({ error: proof.error });
  }
  const result = await profiles.claimSignin({ profileId, username, email, password });
  if (result.error) {
    recordFail("claim:" + ip);
    return res.status(result.claimed ? 409 : 400).json(result);
  }
  // claiming signs you in on the spot
  const sid = newSession(req, result.profileId, "claim");
  setSessionCookie(req, res, sid);
  res.json({ ok: true, user: result.user, profile: result.profile, session: sid, mustReset: !!result.mustReset });
});

// ---------- signed-in self-service ----------

// Change my password (the profile's one and only password).
//
// The CURRENT password is asked for — a walked-away-from browser shouldn't be
// enough — except (auth-round, "reset from a device where you're still
// signed in") when authz.trustedForReset says this session may: the person
// proved who they are on this device minutes ago, or it is their own phone or
// browser signed in by them within the last 30 days (never a TV, never a kids
// profile). A profile with no password yet (Google-only) has nothing to ask.
// `signOutOthers`: every other session of the profile ends too.
//
// One of the two routes a must-reset session may still call (lib/resetgate.js;
// the other is /api/profiles/:id/password): then the new password must differ
// from the old one, and the answer carries fresh credentials for this device
// ({ token, session, user } — resetgate.finish), every other session of the
// profile being gone. A wrong current password counts against the same
// limiter as a wrong unlock.
router.get("/api/auth/password/options", (req, res) => {
  const s = sessionFor(req);
  if (!s) return res.status(401).json({ error: "Sign in first.", signinRequired: true });
  const hasPassword = !!s.profile.passwordHash;
  const t = trustedForReset(s);
  res.json({ hasPassword, needsCurrent: hasPassword && !t.ok, ...(hasPassword && !t.ok ? { why: t.why } : {}) });
});

router.post("/api/auth/password", async (req, res) => {
  const s = sessionFor(req);
  if (!s) return res.status(401).json({ error: "sign in first" });
  const { currentPassword, newPassword, signOutOthers } = req.body || {};
  const bad = passrules.check(newPassword, "newPassword");
  if (bad) return res.status(400).json(bad);
  const id = s.profile.id;
  const ip = realtime.clientIp(req);
  if (tooMany("unlock:" + ip) || tooMany("unlock:p:" + id)) return limit.refuse(res, ["unlock:" + ip, "unlock:p:" + id]);
  const due = profiles.resetDue(id);
  const hadPassword = !!s.profile.passwordHash;
  // no current password typed: allowed only on a trusted session (above)
  let r;
  let forgot = false;
  if (hadPassword && !currentPassword) {
    const t = trustedForReset(s);
    if (!t.ok) {
      return res.status(401).json({
        error: t.why === "tv"
          ? "Enter your current password. On a TV, a password can't be changed without it."
          : "Enter your current password.",
        field: "currentPassword", code: "current-needed", why: t.why,
      });
    }
    if (due) {
      // a forced reset still wants a DIFFERENT password
      if (await profiles.checkPassword(id, String(newPassword)).catch(() => false)) return res.status(400).json({ error: "That's the old password. Choose a different one.", code: "same", field: "newPassword" });
    }
    forgot = true;
    r = await profiles.resetPassword(id, String(newPassword));
  } else {
    r = await profiles.setPassword(id, String(newPassword), currentPassword || "");
  }
  if (r.error === "wrong password") {
    recordFail("unlock:" + ip);
    recordFail("unlock:p:" + id);
  }
  if (r.error) {
    return res.status(r.code ? 400 : 401).json({
      error: r.error === "wrong password" ? "current password is wrong" : r.error,
      ...(r.error === "wrong password" ? { field: "currentPassword" } : {}),
      ...(r.code ? { code: r.code } : {}),
      ...(r.field ? { field: r.field } : {}),
    });
  }
  pwreset.closeAllFor(id);
  authlog.add(hadPassword ? (forgot ? "password-reset" : "password-changed") : "password-set", {
    profileId: id, via: !hadPassword ? "first password" : forgot ? "signed-in device" : "current password", ip, device: logDevice(req),
  });
  if (due) return res.json({ ok: true, ...resetgate.finish(req, res, id) });
  // (the change ended the profile's unlock tokens: this device gets a new one)
  const others = signOutOthers || forgot ? sessions.revokeAllExcept(id, s.sessionKey) : 0;
  res.json({ ok: true, token: profiles.issueToken(id), ...(others ? { signedOutOthers: others } : {}) });
});

// Exchange my session for a profile unlock token. The session was minted by
// the very password the profile lock checks, so prompting again would be
// theater — this is what lets a signed-in device walk through the wall.
router.post("/api/auth/profile-token", (req, res) => {
  const s = sessionFor(req);
  if (!s) return res.status(401).json({ error: "sign in first" });
  profiles.recordAccess(s.profile.id, {
    ip: realtime.clientIp(req), device: deviceOf(req),
  });
  res.json({ ok: true, profileId: s.profile.id, token: profiles.issueToken(s.profile.id) });
});

// "Sessions on my profile" — list and revoke (the key is the sha256 handle,
// never a usable session id).
router.get("/api/auth/sessions", (req, res) => {
  const s = sessionFor(req);
  if (!s) return res.status(401).json({ error: "sign in first" });
  res.json({
    sessions: sessions.listFor(s.profile.id).map((row) => ({
      ...row,
      current: row.key === s.sessionKey,
    })),
  });
});

router.delete("/api/auth/sessions/:key", (req, res) => {
  const s = sessionFor(req);
  if (!s) return res.status(401).json({ error: "sign in first" });
  const mine = sessions.listFor(s.profile.id).some((r) => r.key === req.params.key);
  if (!mine) return res.status(404).json({ error: "not found" });
  sessions.revoke(req.params.key);
  res.json({ ok: true });
});

// ---------- TV pairing by QR ----------
// The TV starts a pairing and renders /link?code=XXXXXX as a QR; the phone
// scans it, lands on the confirm screen, and approves with ITS session; the
// TV polls with its secret and receives a session + profile of its own.
// See src/lib/devicepair.js for the two-credential design.
const devicepair = require("../lib/devicepair");

router.post("/api/auth/device/start", (req, res) => {
  const ip = realtime.clientIp(req);
  if (tooMany("pair:" + ip)) return res.status(429).json({ error: "slow down" });
  recordFail("pair:" + ip); // starts count against the window — codes are cheap to mint
  const r = devicepair.start({ ip, device: deviceOf(req) });
  if (r.error) return res.status(429).json(r);
  res.json({
    ...r,
    // what the TV should encode in the QR (its own reachable base URL + path)
    linkPath: `/link?code=${r.code}`,
  });
});

// What the phone's confirm screen needs: who is asking (and code validity).
// A code can be TYPED now (the /link page's code field), so a miss is counted
// per address like a failed sign-in: ten in fifteen minutes, then 429. A code
// only ever lets the asker give THEIR OWN session to that TV (devicepair.js),
// so this is not what keeps pairing safe — it keeps the "who is asking"
// answer (the TV's address and model) from being fished for by a script.
router.get("/api/auth/device/describe/:code", (req, res) => {
  const ip = realtime.clientIp(req);
  if (tooMany("pairlook:" + ip)) {
    return res.status(429).json({ error: "too many attempts — try again in a few minutes" });
  }
  const d = devicepair.describe(req.params.code);
  if (!d) {
    recordFail("pairlook:" + ip);
    return res.status(404).json({ error: "that code expired — ask the TV for a fresh one" });
  }
  res.json(d);
});

// The one tap that signs the TV in — requires the phone's OWN session, and
// hands the TV that session's profile (never anything else).
router.post("/api/auth/device/approve", (req, res) => {
  const s = sessionFor(req);
  if (!s) return res.status(401).json({ error: "sign in first", signinRequired: true });
  const r = devicepair.approve((req.body || {}).code, s.profile.id);
  if (r.error) return res.status(410).json(r);
  res.json({ ok: true });
});

// The TV's poll: code + its secret. Single-use — the session is minted once.
router.post("/api/auth/device/poll", (req, res) => {
  const { code, secret } = req.body || {};
  const r = devicepair.consume(code, secret);
  if (r.gone) return res.status(410).json({ error: "that code expired — start again" });
  if (r.pending) return res.json({ pending: true });
  const p = profiles.list().find((x) => x.id === r.profileId);
  if (!p || p.locked) return res.status(410).json({ error: "that profile isn't available" });
  const sid = newSession(req, p.id, "pair");
  res.json({
    ok: true,
    user: profiles.signinPub(p),
    profile: profiles.pub(p),
    profileToken: profiles.issueToken(p.id),
    session: sid, // the TV stores this and sends it as X-Session
    mustReset: profiles.resetDue(p.id),
    ...(profiles.setupDue(p.id) ? { passwordSetup: true } : {}),
  });
});

// ---------- admin ----------
const adminOnly = (req, res, next) => {
  if (!realtime.isAdmin(req)) return res.status(403).json({ error: "Admin access required" });
  next();
};

// The sign-in rollout switch, LIVE — no restart, no config edits. Leaving
// "open" takes a one-time backup of profiles.json (claiming writes into it).
router.post("/api/admin/auth-mode", adminOnly, (req, res) => {
  const authmode = authmodeLib();
  const mode = String((req.body || {}).mode || "");
  const target = mode === "hybrid" ? "transition" : mode === "required" ? "closed" : mode;
  if (!authmode.MODES.includes(target)) return res.status(400).json({ error: "unknown mode" });
  if (target !== "open") {
    try {
      const fs = require("fs");
      const path = require("path");
      const src = path.join(config.DATA_DIR, "profiles.json");
      const dir = path.join(config.DATA_DIR, "backups");
      const dest = path.join(dir, `profiles-pre-auth-${new Date().toISOString().slice(0, 10)}.json`);
      if (fs.existsSync(src) && !fs.existsSync(dest)) {
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(src, dest);
      }
    } catch {}
  }
  authmode.set(target);
  console.log(`[auth] mode -> ${target} (set from the admin panel)`);
  res.json({ ok: true, mode: target });
});

// Per-profile sign-in roster for the admin panel (claimed pills etc.).
router.get("/api/admin/signin", adminOnly, (req, res) => {
  res.json({ profiles: profiles.signinList() });
});

// Hand a profile a fresh password (someone forgot theirs, or a passwordless
// profile needs one). Also the "sign them out everywhere" hammer.
router.post("/api/admin/signin/:profileId/password", adminOnly, async (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 4) {
    return res.status(400).json({ error: "password too short (4+ chars)" });
  }
  const r = await profiles.adminSetPassword(req.params.profileId, newPassword);
  if (r.error) return res.status(404).json(r);
  sessions.revokeAllFor(req.params.profileId); // old sessions die with the old password
  pwreset.closeAllFor(req.params.profileId);
  authlog.add("password-set-by-admin", { profileId: req.params.profileId, by: "admin" });
  res.json(r);
});

// ---------- Google ----------
// lib/googleauth.js holds the two OAuth clients and the calls to Google (and
// answers them itself on a private test instance — lib/googlemock.js).
// Configure GOOGLE_WEB_CLIENT_ID/SECRET and GOOGLE_TV_CLIENT_ID/SECRET in
// .env; without them every Google surface hides itself.
//
// Three ways in, one outcome (googleOutcomeFor):
//   the TV's device-code flow   /google/start + /google/poll
//   the website's popup         /google/web-start → Google → /web-callback → /web-finish
//   the phone app's Custom Tab  /google/app-start → Google → /web-callback →
//                               aurora-phone://auth/google?code=… → /google/app-finish
// Each carries an INTENT: "signin" (also what an unknown account turns into a
// sign-up), "signup", "reset" (a reset token for the linked profile), or "link".
const gPolls = new Map(); // pollId -> {deviceCode, interval, expiresAt, done, error, session, user, linkSub, signupSub, reset, intent}
const INTENTS = new Set(["signin", "login", "signup", "reset"]);
const intentOf = (raw) => {
  const s = String(raw || "signin");
  return s === "login" ? "signin" : INTENTS.has(s) ? s : "signin";
};

// What a VERIFIED Google identity means. Shared by every flow so they can
// never drift apart.
//   intent "reset": the profile linked to that Google account gets a reset
//     token (a kids or locked profile does not); an unlinked account is told so.
//   otherwise: a known profile signs straight in — and a profile with no
//     password yet must set one first (auth-round: `mustReset` + `passwordSetup`,
//     the session is a restricted one until it is saved); an unknown account
//     is held (server-side) for a sign-up request; a locked profile is refused.
const googleOutcomeFor = (info, req, intent = "signin") => {
  const prof = profiles.byGoogleSub(info.sub);
  if (intent === "reset") {
    if (!prof) return { error: "No Aurora profile is linked to that Google account. Try another way to reset your password." };
    if (prof.locked) return { error: `That profile is locked. Talk to ${adminNameFor(req)}.` };
    if (profiles.kidsOf(prof.id)) return { error: "A kids profile's password is changed by a grown-up, in the admin page." };
    authlog.add("reset-verified", { profileId: prof.id, via: "google", ip: realtime.clientIp(req), device: logDevice(req) });
    return { reset: { token: pwreset.issueToken(prof.id, "google"), name: prof.name } };
  }
  if (prof && prof.locked) return { error: `That profile is locked. Talk to ${adminNameFor(req)}.` };
  if (prof) {
    const setup = profiles.requirePasswordSetup(prof.id);
    if (setup) authlog.add("password-setup-asked", { profileId: prof.id, via: "google" });
    return {
      session: newSession(req, prof.id, "google"),
      user: profiles.signinPub(prof),
      profile: profiles.pub(prof),
      profileToken: profiles.issueToken(prof.id),
      mustReset: profiles.resetDue(prof.id),
      ...(setup ? { passwordSetup: true } : {}),
    };
  }
  return { signupSub: { sub: info.sub, email: info.email || null, name: info.name || null } };
};

// The login-shaped answer of a finished Google step (or its other outcomes).
const outcomeBody = (o) => {
  if (o.reset) return { ok: true, reset: o.reset };
  return {
    ok: true, user: o.user, profile: o.profile, profileToken: o.profileToken, session: o.session,
    mustReset: !!o.mustReset, ...(o.passwordSetup ? { passwordSetup: true } : {}),
  };
};
// A verified-but-unknown identity, handed on to /api/auth/signup by a pollId.
const holdSignup = (signupSub) => {
  const pollId = crypto.randomBytes(12).toString("hex");
  gPolls.set(pollId, { done: true, signupSub, expiresAt: Date.now() + 10 * 60 * 1000, interval: 1e9, lastPoll: 0 });
  return { ok: true, signup: { email: signupSub.email, name: signupSub.name }, pollId };
};

router.post("/api/auth/google/start", async (req, res) => {
  if (!google.ids().tv) return res.status(501).json({ error: "Google sign-in isn't set up on this server." });
  for (const [k, v] of gPolls) if (Date.now() > v.expiresAt + 60000) gPolls.delete(k);
  const ip = realtime.clientIp(req);
  if (tooMany("gstart:" + ip, 30)) return limit.refuse(res, [["gstart:" + ip, 30]]);
  recordFail("gstart:" + ip);
  try {
    const d = await google.deviceStart();
    const pollId = crypto.randomBytes(12).toString("hex");
    gPolls.set(pollId, {
      deviceCode: d.device_code,
      interval: (d.interval || 5) * 1000,
      expiresAt: Date.now() + (d.expires_in || 900) * 1000,
      lastPoll: 0,
      done: false,
      intent: intentOf((req.body || {}).intent),
    });
    res.json({
      pollId,
      userCode: d.user_code,
      verificationUrl: d.verification_url || d.verification_uri || "https://google.com/device",
      expiresIn: d.expires_in || 900,
    });
  } catch (err) {
    res.status(502).json({ error: err.google ? err.message : "Couldn't reach Google. Try again." });
  }
});

// Admin: a LIVE check of the Google setup — actually asks Google for a device
// code and reports what happened, so a misconfigured client (wrong type, bad
// id) is diagnosed in the panel instead of failing mysteriously on the login
// screen. The unused device code just expires.
router.get("/api/admin/google-check", adminOnly, async (req, res) => {
  if (!google.ids().tv) return res.json({ status: "missing" });
  try {
    await google.deviceStart();
    res.json({ status: "ok" });
  } catch (err) {
    res.json({
      status: err.google === "invalid_client" ? "wrong_type" : "error",
      detail: err.message,
    });
  }
});

router.post("/api/auth/google/poll", async (req, res) => {
  const pollId = (req.body || {}).pollId;
  const p = gPolls.get(pollId);
  if (!p) return res.status(404).json({ error: "That sign-in attempt expired. Start again." });
  if (p.done) {
    if (p.error) {
      gPolls.delete(pollId);
      return res.status(401).json({ error: p.error });
    }
    // link and signup flows stay in the map until their endpoint consumes them
    if (p.linkSub) return res.json({ ok: true, linkable: true });
    if (p.signupSub) return res.json({ ok: true, signup: { email: p.signupSub.email, name: p.signupSub.name } });
    gPolls.delete(pollId);
    if (p.reset) return res.json({ ok: true, reset: p.reset });
    setSessionCookie(req, res, p.session);
    return res.json(outcomeBody(p));
  }
  if (Date.now() > p.expiresAt) {
    gPolls.delete(pollId);
    return res.status(410).json({ error: "The code expired. Start again." });
  }
  // respect Google's interval: only actually poll upstream when it's due
  if (Date.now() - p.lastPoll >= p.interval) {
    p.lastPoll = Date.now();
    try {
      const d = await google.devicePoll(p.deviceCode);
      if (d.error === "authorization_pending" || d.error === "slow_down") {
        if (d.error === "slow_down") p.interval += 5000;
      } else if (d.error) {
        p.done = true;
        p.error = d.error === "access_denied" ? "You declined the sign-in." : "Google sign-in didn't work. Try again.";
      } else if (d.id_token) {
        const info = await google.tokenInfo(d.id_token);
        if (info.aud !== google.ids().tv || !info.sub) {
          p.done = true;
          p.error = "Google sign-in didn't work. Try again.";
        } else if (p.intent !== "reset" && sessionFor(req)) {
          // already signed in → this flow is a LINK, not a login
          p.done = true;
          p.linkSub = info.sub;
        } else {
          p.done = true;
          Object.assign(p, googleOutcomeFor(info, req, p.intent));
        }
      }
    } catch {} // transient network error: stay pending
  }
  res.json({ pending: true });
});

// ---------- Google WEB flow (the browser's popup, the phone's Custom Tab) ----------
// A standard authorization-code redirect: the popup (or the phone's tab) goes
// to Google, Google returns it to /web-callback (the redirect URI registered
// for the web client), and the result is collected:
//   the website: the popup messages the opener, which calls /web-finish
//     (where the session cookie is set — on the main window's own request);
//   the phone app: /web-callback hands the tab a ONE-TIME CODE through the
//     app's own address, aurora-phone://auth/google?code=…, and the app
//     trades it at /google/app-finish with the verifier only it holds.
// Works on localhost and real domains; a device that reached the server by
// raw IP can't use it (Google forbids IP redirect URIs) and is told to use
// the code flow instead (the private test instance's mock has no such rule).
const gStates = new Map(); // state -> {createdAt, redirectUri, linkProfileId, intent, app: {challenge}, outcome}
const IP_HOST = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?$|^\[/;
const LOCAL_HOST = /^localhost(:\d+)?$/i;
const STATE_TTL = 10 * 60 * 1000;

// Can the phone's Custom Tab flow run for a device that reached us at `host`?
// Only on a real domain (Google allows no IP redirect, and the phone's own
// "localhost" is not this server) — or on a private test instance with the mock.
const googleAppFor = ({ host, mock, webId }) => {
  if (!webId) return false;
  if (mock) return true;
  const h = String(host || "");
  return !!h && !IP_HOST.test(h) && !LOCAL_HOST.test(h);
};

// Shared by /web-start and /app-start: remember the attempt, send the browser on.
const startWebFlow = (req, res, extra) => {
  const host = String(req.headers.host || "");
  for (const [k, v] of gStates) if (Date.now() - v.createdAt > STATE_TTL) gStates.delete(k);
  if (gStates.size > 2000) return res.status(429).json({ error: "Too many sign-ins at once. Try again in a minute." });
  const proto = require("../lib/authz").isHttps(req) ? "https" : "http";
  const redirectUri = `${proto}://${host}/api/auth/google/web-callback`;
  const state = crypto.randomBytes(16).toString("hex");
  gStates.set(state, { createdAt: Date.now(), redirectUri, ...extra });
  res.redirect(google.authUrl({ redirectUri, state, origin: `${proto}://${host}` }));
};

router.get("/api/auth/google/web-start", (req, res) => {
  if (!google.ids().web) return res.status(501).json({ error: "Google sign-in isn't set up on this server." });
  const host = String(req.headers.host || "");
  if (IP_HOST.test(host) && !google.mockActive()) {
    return res.status(409).json({
      error: "Google's web sign-in needs a hostname (localhost or the domain) — from an IP address use the code flow",
      useDevice: !!google.ids().tv,
    });
  }
  const s = sessionFor(req);
  const intent = String(req.query.intent || "signin");
  startWebFlow(req, res, {
    // linking is an EXPLICIT intent from Preferences — never inferred from a
    // cookie the popup happens to carry
    linkProfileId: intent === "link" && s ? s.profile.id : null,
    intent: intent === "link" ? "link" : intentOf(intent),
  });
});

// The phone app's start (opened in a Chrome Custom Tab). `challenge` is the
// base64url SHA-256 of a verifier the app keeps to itself: the hand-off code
// this attempt ends with is good only together with that verifier (PKCE's
// idea), so a code another app catches on its way back is worth nothing.
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const appPage = (status, msg) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aurora</title>` +
  `<body style="background:#0b0c14;color:#c9cfdf;font:16px system-ui;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box"><div style="max-width:340px;line-height:1.5"><p>${msg}</p></div></body>`;
router.get("/api/auth/google/app-start", (req, res) => {
  if (!google.ids().web) return res.status(501).type("html").send(appPage(501, "Google sign-in isn't set up on this server. Go back to the app."));
  const host = String(req.headers.host || "");
  if (!googleAppFor({ host, mock: google.mockActive(), webId: google.ids().web })) {
    return res.status(409).type("html").send(appPage(409, "Google sign-in can't open from this address. Go back to the app and use the code instead."));
  }
  const challenge = String(req.query.challenge || "");
  if (!CHALLENGE.test(challenge)) return res.status(400).type("html").send(appPage(400, "That sign-in link isn't complete. Go back to the app and try again."));
  const ip = realtime.clientIp(req);
  if (tooMany("gapp:" + ip, 30)) return limit.refuse(res, [["gapp:" + ip, 30]]);
  recordFail("gapp:" + ip);
  startWebFlow(req, res, { intent: intentOf(req.query.intent), app: { challenge } });
});

// Hand-off codes for the phone: sha256(code) -> { challenge, outcome, expiresAt }.
// Memory only, 3 minutes, single use (burnt on the first try, right or wrong).
const handoffs = new Map();
const HANDOFF_TTL = () => {
  // (a private test instance may shorten it, to test "expired")
  const t = Number(process.env.AURORA_AUTH_HANDOFF_TTL_MS);
  return google.mockActive() && t > 0 ? t : 3 * 60 * 1000;
};
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const usedHandoffs = new Map(); // sha -> when used (to say "used" rather than "expired")

router.get("/api/auth/google/web-callback", async (req, res) => {
  const stateKey = String(req.query.state || "");
  const st = gStates.get(stateKey);
  const page = (msg) =>
    res.type("html").send(
      `<!doctype html><meta charset="utf-8"><body style="background:#0a0e18;color:#9aa3ba;font:15px system-ui;display:grid;place-items:center;height:100vh;margin:0"><div>${msg}</div>` +
      `<script>try{window.opener&&window.opener.postMessage({auroraGoogle:{state:${JSON.stringify(stateKey)}}},location.origin)}catch(e){}setTimeout(function(){window.close()},800)</script>`,
    );
  if (!st) return page("This sign-in attempt expired. Close this window and try again.");
  if (st.done) return page("This sign-in attempt is already finished. Close this window.");
  st.done = true;
  try {
    if (req.query.error) throw Object.assign(new Error(String(req.query.error)), { declined: req.query.error === "access_denied" });
    const td = await google.exchangeCode(req.query.code, st.redirectUri);
    if (!td.id_token) throw new Error(td.error_description || td.error || "token exchange failed");
    const info = await google.tokenInfo(td.id_token);
    if (info.aud !== google.ids().web || !info.sub) throw new Error("token verification failed");
    if (st.linkProfileId) {
      if (profiles.byGoogleSub(info.sub)) throw new Error("That Google account is already linked to a profile.");
      profiles.linkGoogle(st.linkProfileId, info.sub);
      const prof = profiles.list().find((x) => x.id === st.linkProfileId);
      st.outcome = { linked: true, user: prof ? profiles.signinPub(prof) : null };
    } else {
      st.outcome = googleOutcomeFor(info, req, st.intent);
    }
  } catch (err) {
    st.outcome = {
      error: err.declined ? "You cancelled the Google sign-in."
        : /already linked/.test(err.message || "") ? err.message
          : "Google sign-in didn't work. Try again.",
    };
  }
  if (st.app) {
    // the phone: hand the tab back to the app with a one-time code
    gStates.delete(stateKey);
    const code = crypto.randomBytes(32).toString("base64url");
    for (const [k, v] of handoffs) if (v.expiresAt < Date.now()) handoffs.delete(k);
    handoffs.set(sha(code), { challenge: st.app.challenge, outcome: st.outcome, expiresAt: Date.now() + HANDOFF_TTL() });
    return res.redirect(`aurora-phone://auth/google?code=${encodeURIComponent(code)}`);
  }
  page("Done. You can close this window.");
});

router.post("/api/auth/google/web-finish", (req, res) => {
  const key = String((req.body || {}).state || "");
  const st = gStates.get(key);
  if (!st || !st.outcome || st.app) return res.status(404).json({ error: "nothing finished for that sign-in attempt" });
  const o = st.outcome;
  gStates.delete(key);
  if (o.error) return res.status(401).json({ error: o.error });
  if (o.linked) return res.json({ ok: true, linked: true, user: o.user });
  // hand the verified identity to the signup endpoint via the same pollId
  // channel the device flow uses — one consumption path
  if (o.signupSub) return res.json(holdSignup(o.signupSub));
  if (o.reset) return res.json(outcomeBody(o));
  setSessionCookie(req, res, o.session);
  res.json(outcomeBody(o));
});

// The phone app trades its hand-off code: the code + the verifier whose
// SHA-256 is the challenge app-start was given. Single use, three minutes.
router.post("/api/auth/google/app-finish", (req, res) => {
  const ip = realtime.clientIp(req);
  if (tooMany("gfinish:" + ip, 20)) return limit.refuse(res, [["gfinish:" + ip, 20]]);
  const { code, verifier } = req.body || {};
  const k = sha(String(code || ""));
  const h = handoffs.get(k);
  if (!h) {
    recordFail("gfinish:" + ip);
    const used = usedHandoffs.has(k);
    return res.status(410).json(used
      ? { error: "That sign-in was already used. Start again with Google.", code: "used" }
      : { error: "That sign-in expired. Start again with Google.", code: "expired" });
  }
  handoffs.delete(k); // burnt on the first try, right or wrong
  usedHandoffs.set(k, Date.now());
  for (const [x, at] of usedHandoffs) if (Date.now() - at > 30 * 60 * 1000) usedHandoffs.delete(x);
  if (h.expiresAt < Date.now()) return res.status(410).json({ error: "That sign-in expired. Start again with Google.", code: "expired" });
  const expect = Buffer.from(h.challenge);
  const got = Buffer.from(crypto.createHash("sha256").update(String(verifier || "")).digest("base64url"));
  if (expect.length !== got.length || !crypto.timingSafeEqual(expect, got)) {
    recordFail("gfinish:" + ip);
    authlog.add("google-handoff-refused", { ip, device: logDevice(req), outcome: "wrong device" });
    return res.status(400).json({ error: "This sign-in was started on another device. Start again with Google here.", code: "wrong-device" });
  }
  const o = h.outcome || {};
  if (o.error) return res.status(401).json({ error: o.error });
  if (o.signupSub) return res.json(holdSignup(o.signupSub));
  if (o.reset) return res.json(outcomeBody(o));
  res.json(outcomeBody(o));
});

// Link the signed-in profile to a Google identity (same device flow; the
// verified sub attaches to the CURRENT session's profile).
router.post("/api/auth/google/link", (req, res) => {
  const s = sessionFor(req);
  if (!s) return res.status(401).json({ error: "sign in first" });
  const p = gPolls.get((req.body || {}).pollId);
  if (!p || !p.done || p.error || !p.linkSub) {
    return res.status(400).json({ error: "finish the Google step first" });
  }
  if (profiles.byGoogleSub(p.linkSub)) {
    gPolls.delete((req.body || {}).pollId);
    return res.status(409).json({ error: "that Google account is already linked to a profile" });
  }
  profiles.linkGoogle(s.profile.id, p.linkSub);
  gPolls.delete((req.body || {}).pollId);
  res.json({ ok: true, user: profiles.signinPub(s.profile) });
});

// ---------- password reset (auth-round; lib/pwreset.js has the design) ----------
// NO ENUMERATION: every answer here is the same whether the name exists or
// not. Rate limits: per address and per name, stricter than sign-in.
const RESET_IP = (ip) => ["rs:ip:" + ip, 12, 60 * 60 * 1000];
const RESET_ID = (k) => ["rs:id:" + k, 5, 60 * 60 * 1000];
const CODE_IP = (ip) => ["rc:ip:" + ip, 10, 15 * 60 * 1000];
const idKey = (raw) => String(raw || "").trim().toLowerCase().slice(0, 80);
// The profile a name points at, for a self-service reset — or null (unknown,
// locked, kids: all treated the same, so none can be told apart).
const resetTarget = ({ identifier, profileId }) => {
  let p = null;
  if (profileId) p = profiles.list().find((x) => x.id === String(profileId)) || null;
  else if (identifier) p = profiles.byUsername(identifier) || profiles.byEmail(identifier);
  if (!p || p.locked || profiles.kidsOf(p.id)) return null;
  return p;
};

router.get("/api/auth/reset/options", (req, res) => {
  res.json({
    google: !!(google.ids().web || google.ids().tv),
    email: require("../lib/mailer").ready(),
    admin: true,
    // (closed mode, no session: the generic name — the same rule as /api/server-info)
    adminName: adminNameFor(req),
    codeLength: pwreset.CODE_LEN,
  });
});

// Ask the admin. Answers { ok, ticket } whatever the name; the waiting device
// asks /reset/status with the ticket. The admin is told (People, and an alert
// on the admin's own channels) only about a real profile.
router.post("/api/auth/reset/request", (req, res) => {
  const { identifier, profileId, note } = req.body || {};
  const ip = realtime.clientIp(req);
  const key = idKey(identifier || profileId);
  if (!key) return res.status(400).json({ error: "Enter your username or email.", field: "identifier" });
  if (limit.anyTooMany([RESET_IP(ip), RESET_ID(key)])) return limit.refuse(res, [RESET_IP(ip), RESET_ID(key)]);
  recordFail(RESET_IP(ip)[0]);
  recordFail(RESET_ID(key)[0]);
  const p = resetTarget({ identifier, profileId });
  const { ticket, row } = pwreset.request({ profileId: p ? p.id : null, note, ip, device: logDevice(req) });
  if (p) {
    authlog.add("reset-asked", { profileId: p.id, via: "admin", ip, device: logDevice(req) });
    realtime.broadcastAdmins({ type: "password_reset_request", request: { id: row.id, profileId: p.id, name: p.name } });
    try { require("../lib/notify").send("Aurora: password reset asked", `${p.name} asked for a password reset. Open People in the admin page to approve it.`); } catch {}
  }
  res.json({ ok: true, ticket, expiresIn: Math.round(pwreset.TTL.request / 1000) });
});

router.post("/api/auth/reset/status", (req, res) => {
  const ip = realtime.clientIp(req);
  if (tooMany("rst:" + ip, 400)) return limit.refuse(res, [["rst:" + ip, 400]]);
  recordFail("rst:" + ip);
  const out = pwreset.status(String((req.body || {}).ticket || ""));
  if (out.status === "approved") {
    const t = pwreset.readToken(out.token);
    const p = t ? profiles.list().find((x) => x.id === t.profileId) : null;
    return res.json({ status: "approved", token: out.token, name: p ? p.name : "" });
  }
  res.json(out);
});

// A code the admin read out. Wrong, expired or for nobody: one answer.
router.post("/api/auth/reset/code", (req, res) => {
  const { identifier, profileId, code } = req.body || {};
  const ip = realtime.clientIp(req);
  const key = idKey(identifier || profileId);
  if (!key) return res.status(400).json({ error: "Enter your username or email.", field: "identifier" });
  if (!String(code || "").trim()) return res.status(400).json({ error: "Enter the reset code.", field: "code" });
  if (limit.anyTooMany([CODE_IP(ip), RESET_ID(key)])) return limit.refuse(res, [CODE_IP(ip), RESET_ID(key)]);
  const p = resetTarget({ identifier, profileId });
  const r = p ? pwreset.redeemCode(p.id, code) : "none";
  if (r !== "ok") {
    recordFail(CODE_IP(ip)[0]);
    recordFail(RESET_ID(key)[0]);
    if (p) authlog.add("reset-code-wrong", { profileId: p.id, ip, device: logDevice(req) });
    return res.status(400).json({ error: `That code didn't work. Check it, or ask ${adminNameFor(req)} for a new one.`, field: "code", code: "wrong" });
  }
  authlog.add("reset-verified", { profileId: p.id, via: "code", ip, device: logDevice(req) });
  res.json({ ok: true, token: pwreset.issueToken(p.id, "code", pwreset.TTL.tokenLong), name: p.name });
});

// Email a link — only when the server is set up to send email (lib/mailer.js;
// it is off unless the owner configures it). Always { ok } when on.
router.post("/api/auth/reset/email", (req, res) => {
  const mailer = require("../lib/mailer");
  if (!mailer.ready()) return res.status(501).json({ error: "Email reset isn't set up on this server." });
  const { identifier } = req.body || {};
  const ip = realtime.clientIp(req);
  const key = idKey(identifier);
  if (!key) return res.status(400).json({ error: "Enter your username or email.", field: "identifier" });
  if (limit.anyTooMany([RESET_IP(ip), RESET_ID(key)])) return limit.refuse(res, [RESET_IP(ip), RESET_ID(key)]);
  recordFail(RESET_IP(ip)[0]);
  recordFail(RESET_ID(key)[0]);
  const p = resetTarget({ identifier });
  if (p && p.email) {
    const token = pwreset.issueToken(p.id, "email", pwreset.TTL.tokenLong);
    authlog.add("reset-email-sent", { profileId: p.id, via: "email", ip, device: logDevice(req) });
    mailer.sendReset({ to: p.email, name: p.name, token }).catch((e) => console.warn("[auth] reset email failed:", e && e.message));
  }
  res.json({ ok: true });
});

// Is this reset token still good? (A link that is opened draws the form.)
router.post("/api/auth/reset/check", (req, res) => {
  const ip = realtime.clientIp(req);
  if (tooMany("rck:" + ip, 30)) return limit.refuse(res, [["rck:" + ip, 30]]);
  const t = pwreset.readToken(String((req.body || {}).token || ""));
  const p = t ? profiles.list().find((x) => x.id === t.profileId) : null;
  if (!p || p.locked) {
    recordFail("rck:" + ip);
    return res.status(410).json({ error: "This reset link has expired or was already used. Ask for a new one.", code: "expired" });
  }
  res.json({ ok: true, name: p.name, avatar: p.avatar, color: p.color });
});

// Save the new password with a reset token. Signs this device in (the login
// shape); every other session of the profile ends unless the person unticked
// "Sign out of all other devices".
router.post("/api/auth/reset/complete", async (req, res) => {
  const { token, newPassword, signOutOthers } = req.body || {};
  const ip = realtime.clientIp(req);
  if (tooMany("rck:" + ip, 30)) return limit.refuse(res, [["rck:" + ip, 30]]);
  const bad = passrules.check(newPassword, "newPassword");
  if (bad) return res.status(400).json(bad);
  const t = pwreset.readToken(String(token || ""), { consume: true });
  const p = t ? profiles.list().find((x) => x.id === t.profileId) : null;
  if (!p || p.locked) {
    recordFail("rck:" + ip);
    return res.status(410).json({ error: "This reset has expired or was already used. Start again.", code: "expired" });
  }
  const r = await profiles.resetPassword(p.id, String(newPassword));
  if (r.error) return res.status(400).json({ error: "Couldn't save that password. Try again." });
  pwreset.closeAllFor(p.id);
  let others = 0;
  if (signOutOthers !== false) {
    others = sessions.revokeAllFor(p.id, { remember: true });
    profiles.revokeTokensFor(p.id, { remember: true });
    try {
      const msg = JSON.stringify({ type: "profile_signed_out", profileId: p.id });
      for (const c of realtime.clientsOfProfile(p)) { try { c.ws.send(msg); } catch {} }
    } catch {}
  }
  authlog.add("password-reset", { profileId: p.id, via: t.via, ip, device: logDevice(req), others });
  const sid = newSession(req, p.id, "reset");
  setSessionCookie(req, res, sid);
  profiles.recordAccess(p.id, { ip, device: deviceOf(req) });
  res.json({
    ok: true,
    user: profiles.signinPub(p),
    profile: profiles.pub(p),
    profileToken: profiles.issueToken(p.id),
    session: sid,
    mustReset: false,
    signedOutOthers: others,
  });
});

module.exports = router;
module.exports._internals = {
  tooMany, recordFail, fails: limit.fails, FAIL_MAX: limit.FAIL_MAX, FAIL_WINDOW: limit.FAIL_WINDOW,
  googleOutcomeFor, googleAppFor, gPolls, gStates, handoffs,
};
