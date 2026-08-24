// Sign-in (prompt 10, account = profile). There is no separate accounts
// layer: a profile signs in with its username (or email) and its OWN
// password — one password concept in the whole app. Sessions ride an
// HttpOnly cookie for browsers (Secure auto-added on HTTPS origins) and the
// X-Session header for the TV. The rollout switch lives in the admin panel
// (src/lib/authmode.js) and is read per request.
const express = require("express");
const config = require("../config");
const profiles = require("../profiles");
const sessions = require("../lib/sessions");
const realtime = require("../realtime");
const {
  readCookie, setSessionCookie, clearSessionCookie, sessionFor,
} = require("../lib/authz");

const router = express.Router();

const deviceOf = (req) => realtime.parseDevice(req.headers["user-agent"] || "");

// Minimal health endpoint for the TV's server resolver: stays 200 in every
// auth mode, carries nothing personal.
router.get("/api/ping", (req, res) => {
  res.json({ ok: true, name: "aurora", authMode: require("../lib/authmode").get() });
});

// ---------- login rate limiting (per-IP and per-identifier) ----------
// In-memory on purpose (single node); scrypt's own ~78ms/verify is a second
// throttle.
const FAIL_WINDOW = 15 * 60 * 1000;
const FAIL_MAX = 10;
const fails = new Map(); // key -> [timestamps]
const tooMany = (key) => {
  const now = Date.now();
  const list = (fails.get(key) || []).filter((t) => now - t < FAIL_WINDOW);
  fails.set(key, list);
  return list.length >= FAIL_MAX;
};
const recordFail = (key) => {
  const list = fails.get(key) || [];
  list.push(Date.now());
  fails.set(key, list);
  // a spray of unique identifiers must not grow the map forever
  if (fails.size > 5000) {
    const now = Date.now();
    for (const [k, v] of fails) {
      if (!v.some((t) => now - t < FAIL_WINDOW)) fails.delete(k);
    }
  }
};

// ---------- core endpoints ----------

router.get("/api/me", (req, res) => {
  const s = sessionFor(req);
  res.json({
    authMode: require("../lib/authmode").get(),
    user: s ? s.user : null,
  });
});

// Sign in with username OR email + the profile's password. Success hands
// back everything a client needs to walk straight in: the session (cookie +
// body for the TV), the profile card, and a profile unlock TOKEN — login
// verified the very same password, so asking for it again at the wall would
// be theater.
router.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  const ip = realtime.clientIp(req);
  const uKey = "u:" + String(username || "").trim().toLowerCase().slice(0, 80);
  if (tooMany("ip:" + ip) || tooMany(uKey)) {
    return res.status(429).json({ error: "too many attempts — try again in a few minutes" });
  }
  const result = await profiles.login(username, password);
  if (!result.ok) {
    recordFail("ip:" + ip);
    recordFail(uKey);
    profiles.recordAccess(profiles.byUsername(username)?.id || profiles.byEmail(username)?.id, {
      ip, device: deviceOf(req), failed: true,
    });
    return res.status(401).json({ error: result.error });
  }
  const sid = sessions.create(result.profileId, { ip, device: deviceOf(req) });
  setSessionCookie(req, res, sid);
  profiles.recordAccess(result.profileId, { ip, device: deviceOf(req) });
  res.json({
    ok: true,
    user: result.user,
    profile: result.profile,
    profileToken: profiles.issueToken(result.profileId),
    session: sid, // the TV stores this and sends it as X-Session
  });
});

router.post("/api/auth/logout", (req, res) => {
  const sid = readCookie(req) || req.get("X-Session");
  if (sid) sessions.revoke(sid);
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

// ---------- request access (signup = a profile request) ----------
// The login screen's signup files the SAME kind of request the profile wall
// does — one approval queue for the admin — just with sign-in identity
// attached: username and/or email + password, or a server-verified Google
// identity (pollId from the device flow below).
const AVATARS = ["🍿", "🎬", "🦊", "🐼", "🚀", "🌵", "🦖", "👾", "🐳", "🌙", "⚡", "🔥"];
const COLORS = ["#e05f2c", "#8b7bff", "#2c9fe0", "#38b26c", "#d94f8a", "#e0b52c", "#7a5cd6", "#4ec3c9"];

router.post("/api/auth/signup", async (req, res) => {
  const { name, username, email, password, note, pollId } = req.body || {};
  const ip = realtime.clientIp(req);
  if (tooMany("signup:" + ip)) return res.status(429).json({ error: "slow down" });
  recordFail("signup:" + ip); // signup attempts count against the window too

  // a completed Google device flow (held server-side — the client only ever
  // hands back the opaque pollId, never a sub or email we'd have to trust)
  let google = null;
  if (pollId) {
    const p = gPolls.get(String(pollId));
    if (!p || !p.done || !p.signupSub) {
      return res.status(400).json({ error: "finish the Google step first" });
    }
    google = p.signupSub;
    gPolls.delete(String(pollId));
  }
  if (!google && !String(username || "").trim() && !String(email || "").trim()) {
    return res.status(400).json({ error: "pick a username or an email to sign in with" });
  }
  const result = await profiles.requestProfile({
    name,
    realName: name, // the display name IS who they are — one field, less form
    username,
    email: email || (google ? google.email : null),
    password,
    note,
    googleSub: google ? google.sub : null,
    googleEmail: google ? google.email : null,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    avatar: AVATARS[Math.floor(Math.random() * AVATARS.length)],
    ip,
    device: deviceOf(req),
  });
  if (result.error) return res.status(400).json({ error: result.error });
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

router.get("/api/auth/claimable/:profileId", (req, res) => {
  const proof = profileProof(req, req.params.profileId);
  if (proof.error) return res.status(proof.status).json({ error: proof.error });
  res.json({ claimable: profiles.claimableFor(req.params.profileId) });
});

router.post("/api/auth/claim", async (req, res) => {
  const { profileId, username, email, password } = req.body || {};
  const ip = realtime.clientIp(req);
  if (tooMany("claim:" + ip)) return res.status(429).json({ error: "slow down" });
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
  const sid = sessions.create(result.profileId, { ip, device: deviceOf(req) });
  setSessionCookie(req, res, sid);
  res.json({ ok: true, user: result.user, profile: result.profile, session: sid });
});

// ---------- signed-in self-service ----------

// Change my password (the profile's one and only password). Requires the
// current one — a walked-away-from browser shouldn't be enough.
router.post("/api/auth/password", async (req, res) => {
  const s = sessionFor(req);
  if (!s) return res.status(401).json({ error: "sign in first" });
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 4) {
    return res.status(400).json({ error: "new password too short (4+ chars)" });
  }
  const r = await profiles.setPassword(s.profile.id, String(newPassword), currentPassword || "");
  if (r.error) return res.status(401).json({ error: r.error === "wrong password" ? "current password is wrong" : r.error });
  res.json({ ok: true });
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

// ---------- admin ----------
const adminOnly = (req, res, next) => {
  if (!realtime.isAdmin(req)) return res.status(403).json({ error: "Admin access required" });
  next();
};

// The sign-in rollout switch, LIVE — no restart, no config edits. Leaving
// "open" takes a one-time backup of profiles.json (claiming writes into it).
router.post("/api/admin/auth-mode", adminOnly, (req, res) => {
  const authmode = require("../lib/authmode");
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
  res.json(r);
});

// ---------- Google sign-in (device-code flow — findings/auth.md §1b) ----------
// The person's phone talks to Google over HTTPS directly; Aurora never needs
// a redirect URI, so this works from the LAN and the TV identically.
// Configure GOOGLE_CLIENT_ID (+ GOOGLE_CLIENT_SECRET) in .env; without them
// every Google surface hides itself.
const G_ID = process.env.GOOGLE_CLIENT_ID || null;
const G_SECRET = process.env.GOOGLE_CLIENT_SECRET || null;
// The WEB (redirect/popup) flow — the "normal" Google button for browsers.
// Defaults to the same keys: a standard "Web application" OAuth client works
// here directly (it's the device flow that needs the TV-type client), so
// elia's existing client id serves the website as-is once its redirect URIs
// are registered. A separate TV-type client can override for the device flow.
const G_WEB_ID = process.env.GOOGLE_WEB_CLIENT_ID || G_ID;
const G_WEB_SECRET = process.env.GOOGLE_WEB_CLIENT_SECRET || G_SECRET;
const gPolls = new Map(); // pollId -> {deviceCode, interval, expiresAt, done, error, session, user, linkSub, signupSub}

// What a VERIFIED-but-unlinked-to-this-flow Google identity means: a known
// profile signs straight in; an unknown one is held (server-side) for a
// signup request; a locked profile is refused. Shared by the device poll and
// the web callback so the two flows can never drift apart.
const googleOutcomeFor = (info, req) => {
  const prof = profiles.byGoogleSub(info.sub);
  if (prof && prof.locked) return { error: `that profile is locked — talk to ${config.ADMIN_NAME}` };
  if (prof) {
    return {
      session: sessions.create(prof.id, { ip: realtime.clientIp(req), device: deviceOf(req) }),
      user: profiles.signinPub(prof),
      profile: profiles.pub(prof),
      profileToken: profiles.issueToken(prof.id),
    };
  }
  return { signupSub: { sub: info.sub, email: info.email || null, name: info.name || null } };
};

// Ask Google for a device code. Exported logic so the admin panel's config
// check can run the same call and report the REAL failure (the #1 setup trap:
// an OAuth client of the wrong TYPE — Google only allows this flow for
// clients created as "TVs and Limited Input devices").
const googleDeviceStart = async () => {
  const r = await fetch("https://oauth2.googleapis.com/device/code", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: G_ID, scope: "openid email profile" }),
    signal: AbortSignal.timeout(8000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const wrongType = d.error === "invalid_client";
    const err = new Error(
      wrongType
        ? "the Google OAuth client is the wrong TYPE — it must be created as “TVs and Limited Input devices” (see the admin panel)"
        : `Google refused: ${d.error_description || d.error || r.status}`,
    );
    err.google = d.error || String(r.status);
    throw err;
  }
  return d;
};

router.post("/api/auth/google/start", async (req, res) => {
  if (!G_ID) return res.status(501).json({ error: "Google sign-in isn't configured on this server" });
  for (const [k, v] of gPolls) if (Date.now() > v.expiresAt + 60000) gPolls.delete(k);
  try {
    const d = await googleDeviceStart();
    const pollId = require("crypto").randomBytes(12).toString("hex");
    gPolls.set(pollId, {
      deviceCode: d.device_code,
      interval: (d.interval || 5) * 1000,
      expiresAt: Date.now() + (d.expires_in || 900) * 1000,
      lastPoll: 0,
      done: false,
    });
    res.json({
      pollId,
      userCode: d.user_code,
      verificationUrl: d.verification_url || d.verification_uri || "https://google.com/device",
      expiresIn: d.expires_in || 900,
    });
  } catch (err) {
    res.status(502).json({ error: err.google ? err.message : "couldn't reach Google — try again" });
  }
});

// Admin: a LIVE check of the Google setup — actually asks Google for a device
// code and reports what happened, so a misconfigured client (wrong type, bad
// id) is diagnosed in the panel instead of failing mysteriously on the login
// screen. The unused device code just expires.
router.get("/api/admin/google-check", adminOnly, async (req, res) => {
  if (!G_ID) return res.json({ status: "missing" });
  try {
    await googleDeviceStart();
    res.json({ status: "ok" });
  } catch (err) {
    res.json({
      status: err.google === "invalid_client" ? "wrong_type" : "error",
      detail: err.message,
    });
  }
});

router.post("/api/auth/google/poll", async (req, res) => {
  const p = gPolls.get((req.body || {}).pollId);
  if (!p) return res.status(404).json({ error: "unknown or expired sign-in attempt" });
  if (p.done) {
    if (p.error) {
      gPolls.delete((req.body || {}).pollId);
      return res.status(401).json({ error: p.error });
    }
    // link and signup flows stay in the map until their endpoint consumes them
    if (p.linkSub) return res.json({ ok: true, linkable: true });
    if (p.signupSub) return res.json({ ok: true, signup: { email: p.signupSub.email, name: p.signupSub.name } });
    gPolls.delete((req.body || {}).pollId);
    setSessionCookie(req, res, p.session);
    return res.json({ ok: true, user: p.user, profile: p.profile, profileToken: p.profileToken, session: p.session });
  }
  if (Date.now() > p.expiresAt) {
    gPolls.delete((req.body || {}).pollId);
    return res.status(410).json({ error: "the code expired — start again" });
  }
  // respect Google's interval: only actually poll upstream when it's due
  if (Date.now() - p.lastPoll >= p.interval) {
    p.lastPoll = Date.now();
    try {
      const r = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: G_ID,
          ...(G_SECRET ? { client_secret: G_SECRET } : {}),
          device_code: p.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
        signal: AbortSignal.timeout(8000),
      });
      const d = await r.json();
      if (d.error === "authorization_pending" || d.error === "slow_down") {
        if (d.error === "slow_down") p.interval += 5000;
      } else if (d.error) {
        p.done = true;
        p.error = d.error === "access_denied" ? "you declined the sign-in" : "Google sign-in failed";
      } else if (d.id_token) {
        // let Google validate its own token over HTTPS (household scale —
        // no local JWKS machinery to rot)
        const info = await fetch(
          "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(d.id_token),
          { signal: AbortSignal.timeout(8000) },
        ).then((x) => x.json());
        if (info.aud !== G_ID || !info.sub) {
          p.done = true;
          p.error = "Google sign-in failed";
        } else if (sessionFor(req)) {
          // already signed in → this flow is a LINK, not a login
          p.done = true;
          p.linkSub = info.sub;
        } else {
          p.done = true;
          Object.assign(p, googleOutcomeFor(info, req));
        }
      }
    } catch {} // transient network error: stay pending
  }
  res.json({ pending: true });
});

// ---------- Google WEB flow (the "normal" browser sign-in) ----------
// A standard authorization-code redirect in a POPUP: /web-start sends the
// popup to Google, Google returns it to /web-callback (registered redirect
// URI), the popup messages the opener, and the opener collects the result
// with /web-finish (which is also where the session cookie is set — on the
// main window's own request). Works on localhost and real domains; a device
// that reached the server by raw IP can't use it (Google forbids IP redirect
// URIs) and is told to use the code flow instead.
const gStates = new Map(); // state -> {createdAt, redirectUri, linkProfileId, outcome}
const IP_HOST = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?$|^\[/;

router.get("/api/auth/google/web-start", (req, res) => {
  if (!G_WEB_ID) return res.status(501).json({ error: "Google sign-in isn't configured on this server" });
  const host = String(req.headers.host || "");
  if (IP_HOST.test(host)) {
    return res.status(409).json({
      error: "Google's web sign-in needs a hostname (localhost or the domain) — from an IP address use the code flow",
      useDevice: !!G_ID,
    });
  }
  for (const [k, v] of gStates) if (Date.now() - v.createdAt > 10 * 60 * 1000) gStates.delete(k);
  const proto = require("../lib/authz").isHttps(req) ? "https" : "http";
  const redirectUri = `${proto}://${host}/api/auth/google/web-callback`;
  const state = require("crypto").randomBytes(16).toString("hex");
  const s = sessionFor(req);
  gStates.set(state, {
    createdAt: Date.now(),
    redirectUri,
    // linking is an EXPLICIT intent from Preferences — never inferred from a
    // cookie the popup happens to carry
    linkProfileId: req.query.intent === "link" && s ? s.profile.id : null,
  });
  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.searchParams.set("client_id", G_WEB_ID);
  auth.searchParams.set("redirect_uri", redirectUri);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("scope", "openid email profile");
  auth.searchParams.set("state", state);
  auth.searchParams.set("prompt", "select_account");
  res.redirect(auth.toString());
});

router.get("/api/auth/google/web-callback", async (req, res) => {
  const stateKey = String(req.query.state || "");
  const st = gStates.get(stateKey);
  const page = (msg) =>
    res.type("html").send(
      `<!doctype html><meta charset="utf-8"><body style="background:#0a0e18;color:#9aa3ba;font:15px system-ui;display:grid;place-items:center;height:100vh;margin:0"><div>${msg}</div>` +
      `<script>try{window.opener&&window.opener.postMessage({auroraGoogle:{state:${JSON.stringify(stateKey)}}},location.origin)}catch(e){}setTimeout(function(){window.close()},800)</script>`,
    );
  if (!st) return page("This sign-in attempt expired — close this window and try again.");
  try {
    if (req.query.error) throw new Error(String(req.query.error));
    const tr = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: G_WEB_ID,
        client_secret: G_WEB_SECRET || "",
        code: String(req.query.code || ""),
        grant_type: "authorization_code",
        redirect_uri: st.redirectUri,
      }),
      signal: AbortSignal.timeout(8000),
    });
    const td = await tr.json();
    if (!td.id_token) throw new Error(td.error_description || td.error || "token exchange failed");
    const info = await fetch(
      "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(td.id_token),
      { signal: AbortSignal.timeout(8000) },
    ).then((x) => x.json());
    if (info.aud !== G_WEB_ID || !info.sub) throw new Error("token verification failed");
    if (st.linkProfileId) {
      if (profiles.byGoogleSub(info.sub)) throw new Error("that Google account is already linked to a profile");
      profiles.linkGoogle(st.linkProfileId, info.sub);
      const prof = profiles.list().find((x) => x.id === st.linkProfileId);
      st.outcome = { linked: true, user: prof ? profiles.signinPub(prof) : null };
    } else {
      st.outcome = googleOutcomeFor(info, req);
    }
  } catch (err) {
    st.outcome = { error: err.message || "Google sign-in failed" };
  }
  page("Done — you can close this window.");
});

router.post("/api/auth/google/web-finish", (req, res) => {
  const key = String((req.body || {}).state || "");
  const st = gStates.get(key);
  if (!st || !st.outcome) return res.status(404).json({ error: "nothing finished for that sign-in attempt" });
  const o = st.outcome;
  gStates.delete(key);
  if (o.error) return res.status(401).json({ error: o.error });
  if (o.linked) return res.json({ ok: true, linked: true, user: o.user });
  if (o.signupSub) {
    // hand the verified identity to the signup endpoint via the same pollId
    // channel the device flow uses — one consumption path
    const pollId = require("crypto").randomBytes(12).toString("hex");
    gPolls.set(pollId, { done: true, signupSub: o.signupSub, expiresAt: Date.now() + 10 * 60 * 1000, interval: 1e9, lastPoll: 0 });
    return res.json({ ok: true, signup: { email: o.signupSub.email, name: o.signupSub.name }, pollId });
  }
  setSessionCookie(req, res, o.session);
  res.json({ ok: true, user: o.user, profile: o.profile, profileToken: o.profileToken, session: o.session });
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

module.exports = router;
module.exports._internals = { tooMany, recordFail, fails, FAIL_MAX, FAIL_WINDOW };
