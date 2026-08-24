// Profile management + per-profile playback state.
const express = require("express");
const config = require("../config");
const profiles = require("../profiles");
const scanner = require("../media/scanner");
const realtime = require("../realtime");
const telemetry = require("../telemetry");
const authz = require("../lib/authz");

const router = express.Router();

// Who is on the other end of this request — used for the per-profile device log
// and for stamping a new-profile request with where it came from.
const whoIs = (req) => ({
  ip: realtime.clientIp(req),
  device: realtime.parseDevice(req.headers["user-agent"] || ""),
});

// Gate for a protected profile's data: password-set profiles require a valid
// unlock token (X-Profile-Token). Password-free profiles pass through.
// Admin-locked profiles are refused outright — even with a stale token.
const gate = (req, res, next) => {
  const id = req.params.id;
  // An id that isn't a profile used to sail straight through: isProtected() is
  // false for a non-existent profile, so the handler ran and stateFor() CREATED
  // a state entry for whatever string was in the URL. That made a pending
  // (unapproved) profile's state readable, and let anyone grow profiles.json one
  // junk key at a time. No profile, no access.
  if (!profiles.exists(id)) return res.status(404).json({ error: "Not found" });
  // authMode "required": the request must carry a session that OWNS this
  // profile (open/hybrid: profileAllowed is always true — legacy flows intact).
  // The profile password below stays as an optional second layer.
  if (!authz.profileAllowed(req, id)) {
    return res.status(401).json({ error: "sign in first", signinRequired: true });
  }
  if (profiles.isLocked(id)) return res.status(403).json({ error: "locked by admin" });
  // A session FOR this profile is stronger proof than an unlock token — it
  // was minted by the very same password (account = profile). Without this,
  // a signed-in device still got 401s on its own protected profile until it
  // exchanged the session for a token.
  const s = authz.sessionFor(req);
  if (s && s.profile.id === id) return next();
  if (!profiles.isProtected(id)) return next();
  if (profiles.tokenValid(id, req.get("X-Profile-Token"))) return next();
  return res.status(401).json({ error: "locked" });
};

router.get("/api/profiles", (req, res) => {
  // The profile wall, mode-aware (prompt 10):
  //   open / transition — everyone sees every profile (today's behavior;
  //                       transition is the claim period, nothing is gated)
  //   closed            — no session: 401 (clients show the login screen);
  //                       with a session: only the account's own profiles.
  if (require("../lib/authmode").get() !== "closed") {
    return res.json(profiles.publicList());
  }
  const s = authz.sessionFor(req);
  if (!s) return res.status(401).json({ error: "sign in first", signinRequired: true });
  // account = profile: signed in, you ARE your profile — the wall is just you
  res.json(profiles.publicList().filter((p) => p.id === s.profile.id));
});

// Verify a password and get an access token (no-op token for open profiles).
router.post("/api/profiles/:id/unlock", async (req, res) => {
  // required mode: unlocking someone else's profile needs their session, not
  // just their profile password
  if (!authz.profileAllowed(req, req.params.id)) {
    return res.status(401).json({ error: "sign in first", signinRequired: true });
  }
  const result = await profiles.unlock(req.params.id, (req.body || {}).password);
  if (result.error) {
    const status =
      result.error === "not found" ? 404 : result.error === "locked by admin" ? 403 : 401;
    // A wrong password is the single most useful signal for spotting someone
    // poking at a profile, so it goes in the device log even though it failed.
    // "not found" isn't logged: there's no profile to log it against.
    if (result.error !== "not found") {
      profiles.recordAccess(req.params.id, { ...whoIs(req), failed: true });
    }
    return res.status(status).json(result);
  }
  // How long this profile sat unused before right now — read BEFORE recording,
  // or it just reads back this moment. Purely cosmetic: the client uses it to
  // greet a returning viewer. Never let it affect whether the unlock succeeds.
  let awayDays = 0;
  try {
    const prev = profiles.lastSeenBefore(req.params.id);
    if (prev) awayDays = Math.floor((Date.now() - prev) / 86400000);
  } catch {}
  profiles.recordAccess(req.params.id, whoIs(req));
  // ACCOUNT = PROFILE: unlocking a CLAIMED profile just verified its sign-in
  // password, so the device gets a session too — silently. This is what makes
  // the transition seamless: by the time the admin closes the wall, every
  // device that kept using the app is already signed in. (Claimed implies a
  // password exists, so this never fires for open profiles; the extra fields
  // are additive — old clients and the TV ignore them.)
  let signin = {};
  try {
    const raw = profiles.list().find((x) => x.id === req.params.id);
    if (raw && profiles.isClaimed(raw) && raw.passwordHash) {
      const sid = require("../lib/sessions").create(raw.id, whoIs(req));
      require("../lib/authz").setSessionCookie(req, res, sid);
      signin = { session: sid, user: profiles.signinPub(raw) };
    }
  } catch {}
  res.json({ ...result, awayDays, ...signin });
});

// Shortest password accepted anywhere (mirrored client-side in
// public/js/screens/profiles.js — keep the two in step).
const MIN_PASSWORD = 4;

// Set / change / remove a profile's password (not while admin-locked).
// An empty newPassword removes the password; a non-empty one obeys the same
// minimum as profile creation.
router.post("/api/profiles/:id/password", async (req, res) => {
  if (profiles.isLocked(req.params.id)) {
    return res.status(403).json({ error: "locked by admin" });
  }
  const { newPassword, currentPassword } = req.body || {};
  if (newPassword && String(newPassword).length < MIN_PASSWORD) {
    return res.status(400).json({ error: `Passwords need at least ${MIN_PASSWORD} characters.` });
  }
  const result = await profiles.setPassword(req.params.id, newPassword || "", currentPassword || "");
  if (result.error) return res.status(result.error === "not found" ? 404 : 401).json(result);
  res.json(result);
});

// Asking for a profile does NOT create one — anyone who can reach the gate can
// post here, so it files a request an admin has to approve. The password is
// still mandatory and is hashed at request time, so the profile is protected
// from the moment it goes live and the plaintext is never stored.
// A real name is required: it's the only thing that lets the admin tell who is
// actually asking. (Profiles that predate this flow keep working as they are.)
router.post("/api/profiles", async (req, res) => {
  // closed mode: new watch profiles are requested by signed-in people
  // (account signup is the separate /api/auth/signup flow)
  if (require("../lib/authmode").get() === "closed" && !authz.sessionFor(req)) {
    return res.status(401).json({ error: "sign in first", signinRequired: true });
  }
  const body = req.body || {};
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < MIN_PASSWORD) {
    return res.status(400).json({
      error: `${MIN_PASSWORD} characters. That is the entire requirement, and somehow you are still here reading this.`,
    });
  }
  const realName = typeof body.realName === "string" ? body.realName.trim() : "";
  if (realName.length < 2) {
    return res.status(400).json({ error: `${config.ADMIN_NAME} needs your real name — mysteries don't get approved.` });
  }
  const result = await profiles.requestProfile({
    name: body.name,
    color: body.color,
    avatar: body.avatar,
    password,
    realName,
    note: body.note,
    ...whoIs(req),
  });
  if (result.error) return res.status(400).json({ error: result.error });
  // `pending: true` is what tells the client to show "waiting for approval"
  // instead of dropping the new profile into the picker.
  res.json({ pending: true, request: result.request });
});

router.put("/api/profiles/:id", gate, (req, res) => {
  const p = profiles.update(req.params.id, req.body || {});
  if (!p) return res.status(404).json({ error: "Not found" });
  res.json(p);
});

router.delete("/api/profiles/:id", gate, (req, res) => {
  if (profiles.list().length <= 1) {
    return res.status(400).json({ error: "That's the last profile standing — someone has to watch things." });
  }
  if (!profiles.remove(req.params.id)) {
    return res.status(404).json({ error: "Not found" });
  }
  res.json({ ok: true });
});

// Seconds this profile has watched today, from the sessions telemetry already
// records. Read-only, gated like the rest of a profile's data. Only the
// "you've been at this a while" nudge uses it.
router.get("/api/profiles/:id/today", gate, (req, res) => {
  const p = profiles.list().find((x) => x.id === req.params.id);
  res.json({ watchSec: p ? telemetry.todayWatchSec(p.name) : 0 });
});

router.get("/api/profiles/:id/state", gate, (req, res) => {
  res.json({
    progress: profiles.getProgress(req.params.id),
    ratings: profiles.getRatings(req.params.id),
    likedGenres: profiles.getLikedGenres(req.params.id),
    episodeProgress: profiles.streamEpisodeProgress(req.params.id),
    streamProgress: profiles.streamTitleProgress(req.params.id),
  });
});

// itemId must be a real string (a number crashes itemId.startsWith downstream),
// bounded (it becomes a persisted map key), and not a prototype-polluting key.
const badItemId = (itemId) =>
  typeof itemId !== "string" || !itemId || itemId.length > 300 ||
  ["__proto__", "constructor", "prototype"].includes(itemId);

// 1..5 stars (0/null clears). itemId is a library id or an IMDb id.
router.post("/api/profiles/:id/rating", gate, (req, res) => {
  const { itemId, stars } = req.body || {};
  if (badItemId(itemId)) return res.status(400).json({ error: "itemId required" });
  const ratings = profiles.setRating(req.params.id, itemId, stars);
  res.json({ ratings });
});

// Liked genres for recommendations.
router.post("/api/profiles/:id/preferences", gate, (req, res) => {
  const { likedGenres } = req.body || {};
  const saved = profiles.setLikedGenres(req.params.id, likedGenres || []);
  res.json({ likedGenres: saved });
});

router.post("/api/profiles/:id/progress", gate, (req, res) => {
  const { itemId, position, duration, item } = req.body || {};
  if (badItemId(itemId) || typeof position !== "number" || typeof duration !== "number") {
    return res.status(400).json({ error: "itemId, position, duration required" });
  }
  profiles.setProgress(req.params.id, itemId, position, duration, item);
  res.json({ ok: true });
});

router.delete("/api/profiles/:id/progress/:itemId", gate, (req, res) => {
  profiles.clearProgress(req.params.id, req.params.itemId);
  res.json({ ok: true });
});

router.post("/api/profiles/:id/watchlist", gate, (req, res) => {
  const { itemId, stream, add } = req.body || {};
  // Local library item (validated) OR a stream ref {imdbId, type, title, poster,
  // year, genres, rating}. Genres and rating ride along because a stream ref is
  // all My List ever knows about the title — without them its genre filter and
  // rating sort silently skipped every streamable entry.
  let item = null;
  if (stream && stream.imdbId) {
    item = {
      stream: true,
      imdbId: String(stream.imdbId),
      type: stream.type === "show" ? "show" : "movie",
      title: String(stream.title || "").slice(0, 200),
      poster: stream.poster || null,
      year: stream.year || null,
      genres: Array.isArray(stream.genres)
        ? stream.genres
            .filter((g) => typeof g === "string" && g)
            .slice(0, 12)
            .map((g) => g.slice(0, 40))
        : [],
      rating: Number.isFinite(Number(stream.rating)) && Number(stream.rating) > 0
        ? Number(stream.rating)
        : null,
    };
  } else if (itemId && scanner.findById(itemId)) {
    item = itemId;
  }
  if (!item) return res.status(400).json({ error: "valid itemId or stream ref required" });
  const watchlist = profiles.toggleWatchlist(req.params.id, item, add !== false);
  res.json({ watchlist });
});

// Hide one show's synthesized "up next" card. Deleting the card's id from
// progress never worked (the row lives under the PREVIOUS episode's id), so
// the ✕ on those cards was a silent lie until this existed.
router.post("/api/profiles/:id/upnext-dismiss", gate, (req, res) => {
  const { showId, episodeId } = req.body || {};
  if (badItemId(showId) || badItemId(episodeId)) {
    return res.status(400).json({ error: "showId and episodeId required" });
  }
  profiles.dismissUpNext(req.params.id, showId, episodeId);
  res.json({ ok: true });
});

router.get("/api/profiles/:id/watchlist", gate, (req, res) => {
  res.json({ items: profiles.watchlistItems(req.params.id) });
});

// ---------- custom avatar image ----------
// The app's first user file upload — treated as hostile input end to end:
// size-capped raw body, magic-byte sniff (the claimed content-type is
// ignored), re-encoded through ffmpeg to a fresh 256px JPEG (the ORIGINAL
// bytes are never stored or served), deterministic server-chosen filename
// (nothing from the client touches the path).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const rawImage = express.raw({
  limit: "2mb",
  type: ["image/jpeg", "image/png", "image/webp", "application/octet-stream"],
});
const AVATAR_DIR = path.join(config.DATA_DIR, "avatars");
const SAFE_ID = /^[\w-]{1,40}$/; // profile ids are server-generated, but the id is used in a filename — belt anyway

router.post("/api/profiles/:id/avatar-image", gate, rawImage, (req, res) => {
  if (!config.ffmpegAvailable) {
    return res.status(503).json({ error: "image processing isn't available on this server (ffmpeg missing)" });
  }
  if (!SAFE_ID.test(req.params.id)) return res.status(400).json({ error: "bad id" });
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length < 100) {
    return res.status(400).json({ error: "no image received (2MB max)" });
  }
  if (!require("../lib/imgcheck").magicOk(buf)) {
    return res.status(400).json({ error: "that file isn't a JPEG, PNG or WebP" });
  }
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
  // unique suffixes so two simultaneous uploads to one profile can't write
  // through each other; the rename at the end is the atomic publish
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpIn = path.join(os.tmpdir(), `aurora-avatar-${req.params.id}-${nonce}`);
  const out = path.join(AVATAR_DIR, `${req.params.id}.jpg`);
  const tmpOut = `${out}.${nonce}.tmp`;
  try {
    fs.writeFileSync(tmpIn, buf);
  } catch {
    return res.status(500).json({ error: "couldn't stage the upload" });
  }
  execFile(
    config.FFMPEG,
    ["-y", "-i", tmpIn,
      // center-crop square, then 256px — every avatar comes out identical
      "-vf", "crop='min(iw,ih)':'min(iw,ih)',scale=256:256",
      "-frames:v", "1", "-q:v", "4", tmpOut],
    { timeout: 20000 },
    (err) => {
      try { fs.unlinkSync(tmpIn); } catch {}
      if (err) {
        try { fs.unlinkSync(tmpOut); } catch {}
        return res.status(400).json({ error: "couldn't process that image — try another file" });
      }
      try { fs.renameSync(tmpOut, out); } catch {
        try { fs.unlinkSync(tmpOut); } catch {} // never strand a servable .tmp
        return res.status(500).json({ error: "couldn't save the avatar" });
      }
      // ?v busts the long-cache on re-upload (the static mount is immutable)
      const url = `/avatars/${req.params.id}.jpg?v=${Date.now()}`;
      res.json({ ok: true, profile: profiles.setAvatarImage(req.params.id, url) });
    },
  );
});

router.delete("/api/profiles/:id/avatar-image", gate, (req, res) => {
  if (SAFE_ID.test(req.params.id)) {
    try { fs.unlinkSync(path.join(AVATAR_DIR, `${req.params.id}.jpg`)); } catch {}
  }
  res.json({ ok: true, profile: profiles.setAvatarImage(req.params.id, null) });
});

// Taste onboarding: the titles this profile SAID they love. Read by the
// picker (to show current picks) and by prompt 9's recommender.
router.get("/api/profiles/:id/taste", gate, (req, res) => {
  res.json({ liked: profiles.getLikedTitles(req.params.id) });
});
router.post("/api/profiles/:id/taste", gate, (req, res) => {
  res.json({ liked: profiles.setLikedTitles(req.params.id, (req.body || {}).liked) });
});

// Aurora Wrapped: this profile's viewing, aggregated from the telemetry
// sessions (ring buffer — the payload carries `since` so the UI never
// pretends it's a full year), plus started/finished counts from progress
// and best-effort genre attribution through the library.
router.get("/api/profiles/:id/wrapped", gate, (req, res) => {
  const p = profiles.list().find((x) => x.id === req.params.id);
  const w = telemetry.wrappedFor(p.name);
  if (w.empty) return res.json({ empty: true });

  // genres: match the watched titles against the library, weight by seconds
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const genreOf = new Map();
  for (const item of scanner.allItems()) genreOf.set(norm(item.title), item.genres || []);
  const genreSec = new Map();
  for (const t of w.titlesFull || []) {
    for (const g of genreOf.get(norm(t.name)) || []) {
      genreSec.set(g, (genreSec.get(g) || 0) + t.sec);
    }
  }
  w.topGenres = [...genreSec.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([name, sec]) => ({ name, sec }));
  delete w.titlesFull;

  // commitment issues: how many shows were started vs actually finished
  const progress = profiles.getProgress(req.params.id);
  let started = 0;
  let finished = 0;
  for (const row of Object.values(progress)) {
    if (row.finished) finished++;
    else if (row.position > 0) started++;
  }
  w.started = started;
  w.finished = finished;
  res.json(w);
});

module.exports = router;
