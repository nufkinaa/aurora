// Sign-in (prompt 10). Session transport: an HttpOnly cookie for browsers
// (Secure auto-added on HTTPS origins — nufurora.com gets hardened cookies,
// the LAN IP gets what HTTP can carry) and the X-Session header for the TV.
// Everything here is mode-aware: in authMode:"open" the endpoints exist but
// nothing else in the app depends on them.
const express = require("express");
const config = require("../config");
const users = require("../users");
const sessions = require("../lib/sessions");
const realtime = require("../realtime");
const {
  readCookie, setSessionCookie, clearSessionCookie, sessionFor,
} = require("../lib/authz");

const router = express.Router();

// Minimal health endpoint for the TV's server resolver: stays 200 in every
// auth mode, carries nothing personal. The TV switches to this from its old
// "ping /api/home" habit before "required" mode can ever be flipped.
router.get("/api/ping", (req, res) => {
  res.json({ ok: true, name: "aurora", authMode: require("../lib/authmode").get() });
});

// ---------- login rate limiting (per-IP and per-username) ----------
// In-memory on purpose (single node); scrypt's own ~78ms/verify is a second
// throttle. Counters are visible failures, mirroring the device log.
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
  // a spray of unique usernames must not grow the map forever — when it gets
  // big, drop every key whose window has fully expired
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
    user: s ? users.pub(s.user) : null,
  });
});

router.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  const ip = realtime.clientIp(req);
  // the identifier may be a username OR an email — key the per-account
  // counter on the raw lowercased input so both forms rate-limit
  const uKey = "u:" + String(username || "").trim().toLowerCase().slice(0, 80);
  if (tooMany("ip:" + ip) || tooMany(uKey)) {
    return res.status(429).json({ error: "too many attempts — try again in a few minutes" });
  }
  const result = await users.login(username, password);
  if (!result.ok) {
    recordFail("ip:" + ip);
    recordFail(uKey);
    return res.status(401).json({ error: result.error });
  }
  const sid = sessions.create(result.userId, {
    ip,
    device: realtime.parseDevice(req.headers["user-agent"] || ""),
  });
  setSessionCookie(req, res, sid);
  // the TV stores this and sends it as X-Session on every request
  res.json({ ok: true, user: result.user, session: sid });
});

router.post("/api/auth/logout", (req, res) => {
  const sid = readCookie(req) || req.get("X-Session");
  if (sid) sessions.revoke(sid);
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

// Signup stays a request the admin approves — nobody self-creates access.
router.post("/api/auth/signup", async (req, res) => {
  const { username, name, email, password, note } = req.body || {};
  const ip = realtime.clientIp(req);
  if (tooMany("signup:" + ip)) return res.status(429).json({ error: "slow down" });
  recordFail("signup:" + ip); // signup attempts count against the window too
  const result = await users.requestSignup({
    username, name, email, password, note,
    ip,
    device: realtime.parseDevice(req.headers["user-agent"] || ""),
  });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

// ---------- claiming (transition-mode onboarding) ----------
// From inside a profile, the person makes the migrated account theirs:
// confirm username, set a password, optionally add an email. A protected
// profile requires its unlock token — the same proof the rest of the app
// accepts for acting as that profile. Claiming signs them in on the spot.
const profileProof = (req, profileId) => {
  const profiles = require("../profiles");
  if (!profiles.exists(profileId)) return { error: "no such profile", status: 404 };
  if (profiles.isLocked(profileId)) return { error: "that profile is locked", status: 403 };
  if (profiles.isProtected(profileId) && !profiles.tokenValid(profileId, req.get("X-Profile-Token"))) {
    return { error: "unlock the profile first", status: 401 };
  }
  return { ok: true };
};

// Is there an unclaimed account waiting behind this profile? (Seeds the
// claim card: suggested username, and whether to show the prompt at all.)
router.get("/api/auth/claimable/:profileId", (req, res) => {
  const proof = profileProof(req, req.params.profileId);
  if (proof.error) return res.status(proof.status).json({ error: proof.error });
  res.json({ account: users.unclaimedFor(req.params.profileId) });
});

router.post("/api/auth/claim", async (req, res) => {
  const { profileId, username, password, email } = req.body || {};
  const ip = realtime.clientIp(req);
  if (tooMany("claim:" + ip)) return res.status(429).json({ error: "slow down" });
  const proof = profileProof(req, String(profileId || ""));
  if (proof.error) {
    recordFail("claim:" + ip);
    return res.status(proof.status).json({ error: proof.error });
  }
  const result = await users.claimAccount({ profileId, username, password, email });
  if (result.error) {
    recordFail("claim:" + ip);
    return res.status(result.claimed ? 409 : 400).json(result);
  }
  const sid = sessions.create(result.userId, {
    ip,
    device: realtime.parseDevice(req.headers["user-agent"] || ""),
  });
  setSessionCookie(req, res, sid);
  res.json({ ok: true, user: result.user, session: sid });
});

// Change my password (needs the current one — a walked-away-from browser
// shouldn't be enough to take the account over).
router.post("/api/auth/password", async (req, res) => {
  const s = sessionFor(req);
  if (!s) return res.status(401).json({ error: "sign in first" });
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 4) {
    return res.status(400).json({ error: "new password too short (4+ chars)" });
  }
  const u = users.byId(s.user.id);
  // migrated accounts may be passwordless — then there's nothing to verify
  if (u.passwordHash) {
    const ok = await users._internals.verifyHash(currentPassword, u.passwordSalt, u.passwordHash);
    if (!ok) return res.status(401).json({ error: "current password is wrong" });
  }
  await users.setPassword(s.user.id, newPassword);
  res.json({ ok: true });
});

// "Sessions on my account" — list and revoke (the key is the sha256 handle,
// never a usable session id).
router.get("/api/auth/sessions", (req, res) => {
  const s = sessionFor(req);
  if (!s) return res.status(401).json({ error: "sign in first" });
  res.json({
    sessions: sessions.listFor(s.user.id).map((row) => ({
      ...row,
      current: row.key === s.sessionKey,
    })),
  });
});

router.delete("/api/auth/sessions/:key", (req, res) => {
  const s = sessionFor(req);
  if (!s) return res.status(401).json({ error: "sign in first" });
  // only your own sessions
  const mine = sessions.listFor(s.user.id).some((r) => r.key === req.params.key);
  if (!mine) return res.status(404).json({ error: "not found" });
  sessions.revoke(req.params.key);
  res.json({ ok: true });
});

// ---------- admin: approve/reject signup requests ----------
const adminOnly = (req, res, next) => {
  if (!realtime.isAdmin(req)) return res.status(403).json({ error: "Admin access required" });
  next();
};
router.get("/api/admin/signups", adminOnly, (req, res) => {
  res.json({ pending: users.pendingList() });
});
router.post("/api/admin/signups/:id/approve", adminOnly, (req, res) => {
  const r = users.approveSignup(req.params.id);
  if (r.error) return res.status(404).json(r);
  res.json(r);
});
router.post("/api/admin/signups/:id/reject", adminOnly, (req, res) => {
  const r = users.rejectSignup(req.params.id);
  if (r.error) return res.status(404).json(r);
  res.json(r);
});
// Admin: run the profiles→accounts migration explicitly (idempotent; backs
// up profiles.json first — see users.migrateFromProfiles).
router.post("/api/admin/auth-migrate", adminOnly, (req, res) => {
  res.json({ migrated: users.migrateFromProfiles() });
});
// Admin: the sign-in rollout switch, LIVE — no restart, no config edits.
// Leaving "open" runs the migration first so every profile has an account
// waiting to be claimed before anything changes for anyone.
router.post("/api/admin/auth-mode", adminOnly, (req, res) => {
  const authmode = require("../lib/authmode");
  const mode = String((req.body || {}).mode || "");
  const target = mode === "hybrid" ? "transition" : mode === "required" ? "closed" : mode;
  if (!authmode.MODES.includes(target)) return res.status(400).json({ error: "unknown mode" });
  let migrated = [];
  if (target !== "open") migrated = users.migrateFromProfiles();
  authmode.set(target);
  console.log(`[auth] mode -> ${target} (set from the admin panel)` +
    (migrated.length ? ` — migrated: ${migrated.join("; ")}` : ""));
  res.json({ ok: true, mode: target, migrated });
});
// Admin: list accounts and (re)assign which profiles each one owns — the knob
// that makes a freshly approved account actually see something.
router.get("/api/admin/users", adminOnly, (req, res) => {
  res.json({ users: users.adminList() });
});
router.post("/api/admin/users/:id/profiles", adminOnly, (req, res) => {
  const r = users.setProfiles(req.params.id, (req.body || {}).profileIds);
  if (r.error) return res.status(404).json(r);
  res.json(r);
});
// Admin: set an account's password directly. Exists for one reason — migrated
// accounts inherit their profile's password, and a password-LESS profile
// yields an account that cannot log in until someone gives it a password.
router.post("/api/admin/users/:id/password", adminOnly, async (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 4) {
    return res.status(400).json({ error: "password too short (4+ chars)" });
  }
  const r = await users.setPassword(req.params.id, newPassword);
  if (r.error) return res.status(404).json(r);
  res.json(r);
});
router.delete("/api/admin/users/:id", adminOnly, (req, res) => {
  const r = users.removeUser(req.params.id);
  if (r.error) return res.status(404).json(r);
  sessions.revokeAllFor(req.params.id);
  res.json(r);
});

// ---------- Google sign-in (device-code flow — findings/auth.md §1b) ----------
// The browser/phone talks to Google over HTTPS directly; Aurora never needs
// a redirect URI, so this works from the LAN and the TV identically.
// Configure GOOGLE_CLIENT_ID (+ GOOGLE_CLIENT_SECRET) in .env; without them
// the button simply doesn't exist client-side.
const G_ID = process.env.GOOGLE_CLIENT_ID || null;
const G_SECRET = process.env.GOOGLE_CLIENT_SECRET || null;
const gPolls = new Map(); // pollId -> {deviceCode, interval, expiresAt, done, error, session, user}

router.post("/api/auth/google/start", async (req, res) => {
  if (!G_ID) return res.status(501).json({ error: "Google sign-in isn't configured on this server" });
  // sweep attempts that expired without ever being polled to completion
  for (const [k, v] of gPolls) if (Date.now() > v.expiresAt + 60000) gPolls.delete(k);
  try {
    const r = await fetch("https://oauth2.googleapis.com/device/code", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: G_ID, scope: "openid email profile" }),
      signal: AbortSignal.timeout(8000),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "device_code failed");
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
    res.status(502).json({ error: "couldn't reach Google — try again" });
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
    // link flows stay in the map until /api/auth/google/link consumes them
    if (p.linkSub) return res.json({ ok: true, linkable: true });
    gPolls.delete((req.body || {}).pollId);
    setSessionCookie(req, res, p.session);
    return res.json({ ok: true, user: p.user, session: p.session });
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
          // already signed in → this flow is a LINK, not a login: hold the
          // verified sub for /api/auth/google/link to attach
          p.done = true;
          p.linkSub = info.sub;
        } else {
          const user = users.byGoogleSub(info.sub);
          if (!user) {
            p.done = true;
            p.error = `no Aurora account is linked to ${info.email || "that Google account"} — sign in with your password once and link it in Preferences`;
          } else {
            p.done = true;
            p.session = sessions.create(user.id, {
              ip: realtime.clientIp(req),
              device: realtime.parseDevice(req.headers["user-agent"] || ""),
            });
            p.user = users.pub(user);
          }
        }
      }
    } catch {} // transient network error: stay pending
  }
  res.json({ pending: true });
});

// Link the signed-in account to a Google identity (same device flow, but the
// result attaches `sub` to the CURRENT user instead of logging in).
router.post("/api/auth/google/link", async (req, res) => {
  const s = sessionFor(req);
  if (!s) return res.status(401).json({ error: "sign in first" });
  const p = gPolls.get((req.body || {}).pollId);
  if (!p || !p.done || p.error || !p.linkSub) {
    // reuse the poll endpoint until it reports linkable
    return res.status(400).json({ error: "finish the Google step first" });
  }
  users.linkGoogle(s.user.id, p.linkSub);
  gPolls.delete((req.body || {}).pollId);
  res.json({ ok: true });
});

module.exports = router;
module.exports._internals = { tooMany, recordFail, fails, FAIL_MAX, FAIL_WINDOW };
