// Profiles with per-profile playback progress and watchlist, stored on the
// server so any device resumes where you left off.
const path = require("path");
const crypto = require("crypto");
const { promisify } = require("util");
const config = require("./config");
const scanner = require("./media/scanner");
const { JsonStore } = require("./lib/jsonstore");

const store = new JsonStore(path.join(config.DATA_DIR, "profiles.json"), () => ({
  profiles: [
    { id: "default", name: "Watcher", color: "#e05f2c", avatar: "🍿" },
  ],
  state: {},
}));

// Backfill for stores written before profile approval / access logging existed.
if (!Array.isArray(store.data.pending)) store.data.pending = [];
if (!store.data.access || typeof store.data.access !== "object") store.data.access = {};

const stateFor = (profileId) => {
  const s = store.data.state[profileId] || (store.data.state[profileId] = {});
  // Backfill keys so older profiles.json files gain new fields transparently.
  if (!s.progress) s.progress = {};
  if (!s.watchlist) s.watchlist = [];
  if (!s.ratings) s.ratings = {};          // itemKey (id or imdbId) -> 1..5
  if (!s.likedGenres) s.likedGenres = [];  // ["Action", ...]
  if (!s.streamItems) s.streamItems = {};  // torrent id -> play-item meta (for Continue Watching)
  if (!s.upNextDismissed) s.upNextDismissed = {}; // showId -> dismissed NEXT-episode id
  return s;
};

// A watchlist entry is either a local library id (string) or a stream ref
// object {stream:true, imdbId, type, title, poster, year}. This key identifies
// either for dedupe/removal.
const entryKey = (entry) =>
  typeof entry === "string" ? entry : "disc:" + entry.imdbId;

// Two stored forms can denote ONE title: a library id, and a stream ref of
// the same film added from Discover before (or after) it was downloaded.
// sameIdentity makes membership checks and removal treat them as one; the
// shared identity matcher does the heavy lifting. `deps` is injectable so
// tests never touch the live store or the scanner.
const sameIdentity = (a, b, deps = null) => {
  if (entryKey(a) === entryKey(b)) return true;
  const str = typeof a === "string" ? a : typeof b === "string" ? b : null;
  const ref = a && typeof a === "object" ? a : b && typeof b === "object" ? b : null;
  if (!str || !ref) return false;
  const findLibrary =
    (deps && deps.findLibrary) ||
    ((r) => require("./media/identity").findLibraryFor(r));
  const lib = findLibrary(ref);
  return !!lib && lib.id === str;
};

// Public shape sent to clients — NEVER leaks the password hash/salt, just
// whether a password is set.
const pub = (p) => ({
  id: p.id,
  name: p.name,
  color: p.color,
  avatar: p.avatar,
  theme: p.theme || null, // appearance rides the profile across devices
  accent: p.accent || null,
  // A processed image under /avatars/, or null. Kept SEPARATE from `avatar`
  // (emoji): the TV renders `avatar` as literal text, so it stays the
  // universal fallback and never carries a path.
  avatarImage: p.avatarImage || null,
  rows: p.rows || null, // home-row order/visibility prefs (settings UI reads these)
  hasPassword: !!p.passwordHash,
  locked: !!p.locked,
});

const list = () => store.data.profiles;          // internal (raw)
const publicList = () => store.data.profiles.map(pub);
const getRaw = (id) => store.data.profiles.find((x) => x.id === id) || null;
const exists = (id) => !!getRaw(id);
const isProtected = (id) => !!getRaw(id)?.passwordHash;
const isLocked = (id) => !!getRaw(id)?.locked;

// ---------- password hashing (scrypt) + unlock tokens ----------
// A casual household lock, not hardened auth: passwords are salted+hashed so
// they're never stored in the clear, and access to a protected profile's data
// requires a short-lived token issued on unlock. Tokens live in memory only,
// so a server restart simply requires re-entering the password.
// scrypt is deliberately expensive: measured 78ms per call on this machine.
// scryptSync spends all of that ON THE EVENT LOOP, so every profile unlock or
// creation froze the whole server for ~78ms — every other viewer's stream
// requests, websocket traffic and API calls included. The async form does the
// same work on libuv's threadpool instead, leaving the loop free.
const scrypt = promisify(crypto.scrypt);

const hashPassword = async (password) => {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = (await scrypt(password, salt, 64)).toString("hex");
  return { salt, hash };
};
const verifyHash = async (password, salt, hash) => {
  if (!salt || !hash) return false;
  const test = await scrypt(String(password), salt, 64);
  const b = Buffer.from(hash, "hex");
  // Constant-time compare, as before — never a plain === on secrets.
  return test.length === b.length && crypto.timingSafeEqual(test, b);
};

const tokens = new Map(); // token -> profileId
const issueToken = (id) => {
  const t = crypto.randomBytes(24).toString("hex");
  tokens.set(t, id);
  return t;
};
const tokenValid = (id, token) => !!token && tokens.get(token) === id;

// Verify a password and, on success, hand back an access token. Profiles with
// no password unlock freely. An admin-locked profile never unlocks — not even
// with the right password.
const unlock = async (id, password) => {
  const p = getRaw(id);
  if (!p) return { error: "not found" };
  if (p.locked) return { error: "locked by admin" };
  if (!p.passwordHash) return { ok: true, token: issueToken(id) };
  if (!(await verifyHash(password, p.passwordSalt, p.passwordHash))) {
    return { error: "wrong password" };
  }
  return { ok: true, token: issueToken(id) };
};

// Admin lockdown: a locked profile can't be entered, unlocked, edited, or used
// for any per-profile data until an admin unlocks it. Locking revokes every
// live session token immediately.
const setLocked = (id, locked) => {
  const p = getRaw(id);
  if (!p) return null;
  if (locked) {
    p.locked = true;
    for (const [t, pid] of tokens) if (pid === id) tokens.delete(t);
  } else {
    delete p.locked;
  }
  store.save();
  return pub(p);
};

// Set, change, or remove (empty newPassword) a profile's password. Changing or
// removing an existing password requires the current one.
const setPassword = async (id, newPassword, currentPassword) => {
  const p = getRaw(id);
  if (!p) return { error: "not found" };
  if (p.passwordHash && !(await verifyHash(currentPassword, p.passwordSalt, p.passwordHash))) {
    return { error: "wrong password" };
  }
  if (!newPassword) {
    delete p.passwordHash;
    delete p.passwordSalt;
  } else {
    const { salt, hash } = await hashPassword(String(newPassword));
    p.passwordHash = hash;
    p.passwordSalt = salt;
    for (const [t, pid] of tokens) if (pid === id) tokens.delete(t); // invalidate old sessions
  }
  store.save();
  return { ok: true };
};

// ---------- new-profile requests (admin approval) ----------
// A stranger on the LAN can reach the profile gate, so "add profile" is a
// REQUEST, not a creation: nothing enters `profiles` until an admin approves it.
// The password is hashed here, at request time, so approval never needs — and
// the server never stores — the plaintext.
const MAX_PENDING = 40;

// What the admin is shown. Same rule as pub(): the hash and salt never leave.
const pendingPub = (r) => ({
  id: r.id,
  name: r.name,
  color: r.color,
  avatar: r.avatar,
  realName: r.realName,
  note: r.note,
  requestedAt: r.requestedAt,
  ip: r.ip,
  device: r.device,
});

const nameTaken = (name) => {
  const n = String(name).trim().toLowerCase();
  return (
    store.data.profiles.some((p) => (p.name || "").trim().toLowerCase() === n) ||
    store.data.pending.some((r) => (r.name || "").trim().toLowerCase() === n)
  );
};

const requestProfile = async ({ name, color, avatar, password, realName, note, ip, device }) => {
  const clean = String(name || "").trim().slice(0, 24);
  if (!clean) return { error: "You left the name blank. A nameless profile. Inspired. Try again with letters this time." };
  if (nameTaken(clean)) return { error: "That name is taken. Add a number, or get creative." };
  // Without a cap, anyone who can reach the gate could fill the store with
  // requests. Rejecting rather than rotating keeps the admin's queue honest.
  if (store.data.pending.length >= MAX_PENDING) {
    return { error: `Queue's full. Forty other people had this idea before you. Come back when ${config.ADMIN_NAME} digs out from under it.` };
  }
  const { salt, hash } = await hashPassword(String(password));
  const req = {
    id: crypto.randomBytes(6).toString("hex"),
    name: clean,
    color: color || "#e05f2c",
    avatar: avatar || "🙂",
    realName: String(realName || "").trim().slice(0, 60),
    note: String(note || "").trim().slice(0, 200),
    requestedAt: Date.now(),
    ip: String(ip || "?").slice(0, 60),
    device: device || null,
    passwordHash: hash,
    passwordSalt: salt,
  };
  store.data.pending.push(req);
  store.save();
  return { ok: true, request: pendingPub(req) };
};

const pendingList = () => store.data.pending.map(pendingPub);
const pendingCount = () => store.data.pending.length;

// Promote a request into a real profile, password hash and all. Idempotency
// matters: two clicks on Approve must not create two profiles, so the request is
// spliced out before anything else can see it.
const approveRequest = (reqId) => {
  const i = store.data.pending.findIndex((r) => r.id === reqId);
  if (i === -1) return null;
  const [req] = store.data.pending.splice(i, 1);
  const profile = {
    id: req.id,
    name: req.name,
    color: req.color,
    avatar: req.avatar,
    passwordHash: req.passwordHash,
    passwordSalt: req.passwordSalt,
    // Kept so the admin can still tell who this profile belongs to later.
    realName: req.realName || undefined,
    approvedAt: Date.now(),
  };
  store.data.profiles.push(profile);
  store.save();
  return pub(profile);
};

const rejectRequest = (reqId) => {
  const i = store.data.pending.findIndex((r) => r.id === reqId);
  if (i === -1) return false;
  store.data.pending.splice(i, 1);
  store.save();
  return true;
};

// ---------- per-profile device / IP log ----------
// Who has been getting into each profile, deduped per (IP, device) so the list
// stays a roster rather than a firehose. Rewriting the store on every request
// would be absurd, so an existing row's `last` is only persisted every few
// minutes; a brand-new row or a failed password is saved immediately (those are
// exactly the events an admin wants to see straight away).
const ACCESS_MAX_ROWS = 30;
const ACCESS_TOUCH_MS = 5 * 60 * 1000;

const rowsFor = (profileId) => {
  const a = store.data.access;
  if (!Array.isArray(a[profileId])) a[profileId] = [];
  return a[profileId];
};

const recordAccess = (profileId, { ip, device, failed = false } = {}) => {
  if (!profileId || typeof profileId !== "string") return;
  // A persisted map key must never be a prototype-polluting name.
  if (["__proto__", "constructor", "prototype"].includes(profileId)) return;
  const addr = String(ip || "?").slice(0, 60);
  const key = `${addr}|${device ? `${device.browser}/${device.os}` : "?"}`;
  const rows = rowsFor(profileId);
  const now = Date.now();
  let row = rows.find((r) => r.key === key);
  if (!row) {
    row = { key, ip: addr, device: device || null, first: now, last: now, count: 0, fails: 0 };
    rows.push(row);
    // Oldest-seen rows fall off first so an attacker cycling IPs can't push the
    // legitimate devices out of the list.
    if (rows.length > ACCESS_MAX_ROWS) {
      rows.sort((a, b) => b.last - a.last);
      rows.length = ACCESS_MAX_ROWS;
    }
    if (failed) row.fails++; else row.count++;
    store.save();
    return;
  }
  const stale = now - (row.last || 0) > ACCESS_TOUCH_MS;
  row.last = now;
  if (failed) row.fails++; else row.count++;
  if (failed || stale) store.save();
};

const accessFor = (profileId) =>
  [...rowsFor(profileId)].sort((a, b) => b.last - a.last);

// When this profile was last used from ANY device, before right now. Read-only
// over the same access rows the admin panel shows — call it BEFORE
// recordAccess() or you'll just get the current moment back.
const lastSeenBefore = (profileId) => {
  let last = 0;
  for (const r of rowsFor(profileId)) if ((r.last || 0) > last) last = r.last;
  return last || 0;
};

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const THEMES = ["aurora", "oled", "warm"];

const update = (id, fields) => {
  const p = store.data.profiles.find((x) => x.id === id);
  if (!p) return null;
  if (fields.name) p.name = String(fields.name).slice(0, 24);
  if (typeof fields.color === "string" && HEX_COLOR.test(fields.color)) p.color = fields.color;
  // The avatar stays SHORT text (emoji) — the TV prints it literally at
  // fontSize 48, so a path or long string here would render as text there.
  if (typeof fields.avatar === "string" && fields.avatar.length > 0 && fields.avatar.length <= 8) {
    p.avatar = fields.avatar;
  }
  // Appearance follows the profile to every device (additive fields — old
  // profiles and the TV keep working without them).
  if (typeof fields.theme === "string" && THEMES.includes(fields.theme)) p.theme = fields.theme;
  if (typeof fields.accent === "string" && HEX_COLOR.test(fields.accent)) p.accent = fields.accent;
  if (fields.accent === null) delete p.accent; // back to the default violet
  // Home row composition: {order: [rowIds], hidden: [rowIds]}. Ids are
  // opaque strings (generated rows like liked-<genre> included) — bounded,
  // never interpreted. Empty prefs delete the field (back to defaults).
  if (fields.rows && typeof fields.rows === "object") {
    const clean = (a) =>
      Array.isArray(a)
        ? a.filter((x) => typeof x === "string" && x.length > 0 && x.length <= 40).slice(0, 50)
        : [];
    const rows = { order: clean(fields.rows.order), hidden: clean(fields.rows.hidden) };
    if (rows.order.length || rows.hidden.length) p.rows = rows;
    else delete p.rows;
  }
  store.save();
  return pub(p);
};

// The stored home-row prefs for /api/home's composer (null = defaults).
const rowPrefs = (id) => {
  const p = store.data.profiles.find((x) => x.id === id);
  return (p && p.rows) || null;
};

// Set (or clear) the processed avatar image URL — written only by the upload
// route, which owns validation and the file on disk.
const setAvatarImage = (id, url) => {
  const p = store.data.profiles.find((x) => x.id === id);
  if (!p) return null;
  if (url) p.avatarImage = url;
  else delete p.avatarImage;
  store.save();
  return pub(p);
};

const remove = (id) => {
  const i = store.data.profiles.findIndex((x) => x.id === id);
  if (i === -1) return false;
  store.data.profiles.splice(i, 1);
  delete store.data.state[id];
  delete store.data.access[id]; // no orphan device log for a profile that's gone
  store.save();
  return true;
};

// `meta` (optional) is the play-item for a torrent stream, stored so Continue
// Watching can render + resume it (torrent ids aren't in the scanner).
const setProgress = (profileId, itemId, position, duration, meta) => {
  const state = stateFor(profileId);
  const finished = duration > 0 && position / duration > 0.95;
  state.progress[itemId] = {
    position: Math.floor(position),
    duration: Math.floor(duration),
    finished,
    updatedAt: Date.now(),
  };
  // `torrent|…` is something that was actually played; `stream|…` is a title
  // marked watched by hand without ever playing it here (you saw it elsewhere).
  // Both need their meta kept, because that is what streamEpisodeProgress reads
  // to answer "have I seen this episode?" for a title that isn't in the library.
  if (meta && typeof meta === "object" && /^(torrent|stream)\|/.test(itemId)) {
    state.streamItems[itemId] = meta;
  }
  store.save();
};

const getProgress = (profileId) => stateFor(profileId).progress;

// The stored play-item for a streamed title (used to rebuild a torrent item
// after a page refresh, when the client's in-memory pendingItems is gone).
const getStreamItem = (profileId, itemId) => stateFor(profileId).streamItems[itemId] || null;

// The whole map. Home needs it to turn `torrent|<hash>|<idx>` progress keys back
// into IMDb ids, which is the only way to tell whether a streamed title has been
// watched — the key itself names a torrent, not a title.
const getStreamItems = (profileId) => stateFor(profileId).streamItems;

// Raw watchlist entries (local id strings / stream refs), for callers that need
// the entry rather than the rendered card watchlistItems() returns.
const getWatchlist = (profileId) => stateFor(profileId).watchlist;

// Watch progress for streamed titles, re-filed under a key the browser can
// recognise. The stored key names a FILE (`torrent|<hash>|<idx>`) or a title the
// viewer ticked off by hand (`stream|<imdbId>`), neither of which a card on screen
// knows about — so `keyOf` maps the stored meta onto something it does. Returning
// null skips the entry. Most recent watch per key wins.
const streamProgressBy = (profileId, keyOf) => {
  const s = stateFor(profileId);
  const out = {};
  for (const [id, meta] of Object.entries(s.streamItems)) {
    if (!meta || !meta.imdbId) continue;
    const key = keyOf(meta);
    if (!key) continue;
    const prog = s.progress[id];
    if (!prog) continue;
    if (!out[key] || (out[key].updatedAt || 0) < prog.updatedAt) {
      out[key] = { position: prog.position, duration: prog.duration, finished: prog.finished, updatedAt: prog.updatedAt };
    }
  }
  return out;
};

// Keyed "imdbId:season:episode", so the Discover show page can draw a progress
// bar per episode regardless of which torrent source was used.
const streamEpisodeProgress = (profileId) =>
  streamProgressBy(profileId, (m) => (m.season && m.episode ? `${m.imdbId}:${m.season}:${m.episode}` : null));

// The film counterpart, keyed by IMDb id: what the browser needs to tell whether
// a streamable title has been watched, which no amount of looking at
// `progress[item.id]` can answer (see watchState in public/js/state.js).
const streamTitleProgress = (profileId) =>
  streamProgressBy(profileId, (m) => (m.season ? null : m.imdbId));

// `item` is a local id string or a stream ref object (see entryKey).
const toggleWatchlist = (profileId, item, add) => {
  const state = stateFor(profileId);
  // Adds dedupe on the EXACT stored key only — an identity twin in the OTHER
  // form is welcome, because each form carries keys the other lacks (the
  // stream ref holds imdbId/genres that New Episodes and the genre filter
  // need; the library id survives the stream cache expiring). The read path
  // (materializeWatchlist) collapses twins to one card, and removal is
  // identity-aware so one remove takes every costume of the title with it.
  const exact = state.watchlist.some((e) => entryKey(e) === entryKey(item));
  if (add && !exact) state.watchlist.push(item);
  if (!add) {
    // Build the library maps ONCE for the whole sweep — bare sameIdentity
    // rebuilds them per stream-ref entry (O(watchlist × library) per click).
    const identity = require("./media/identity");
    const maps = identity._internals.libraryMaps();
    const deps = { findLibrary: (r) => identity.findLibraryFor(r, maps) };
    state.watchlist = state.watchlist.filter((e) => !sameIdentity(e, item, deps));
  }
  store.save();
  return state.watchlist;
};

// 1..5 stars; 0/null clears the rating.
const setRating = (profileId, itemId, stars) => {
  const state = stateFor(profileId);
  const n = Math.round(Number(stars) || 0);
  if (n >= 1 && n <= 5) state.ratings[itemId] = n;
  else delete state.ratings[itemId];
  store.save();
  return state.ratings;
};

const getRatings = (profileId) => stateFor(profileId).ratings;

const setLikedGenres = (profileId, genres) => {
  const state = stateFor(profileId);
  state.likedGenres = Array.isArray(genres) ? genres.filter((g) => typeof g === "string").slice(0, 40) : [];
  store.save();
  return state.likedGenres;
};

const getLikedGenres = (profileId) => stateFor(profileId).likedGenres;

// Items for the Continue Watching row: in-progress videos, most recent first.
// Finished episodes advance to the next episode of the show.
const continueWatching = (profileId) => {
  const state = stateFor(profileId);
  const entries = Object.entries(state.progress).sort(
    (a, b) => b[1].updatedAt - a[1].updatedAt
  );

  const items = [];
  const seenShows = new Set();
  const seenStream = new Set(); // dedupe streamed content by title/show

  for (const [itemId, prog] of entries) {
    if (items.length >= 12) break;

    // Torrent streams: resolve from the stored play-item (not in the scanner).
    if (itemId.startsWith("torrent|")) {
      const meta = state.streamItems[itemId];
      if (!meta || prog.finished || prog.position <= 10) continue;
      // One card per show/title — the most recent episode (entries are sorted
      // newest-first). imdbId is the SHOW's id for episodes, so all episodes of
      // one show collapse to its latest; also kills same-episode duplicates
      // from watching it via two different sources.
      const key = meta.imdbId || itemId;
      if (seenStream.has(key)) continue;
      seenStream.add(key);
      items.push({ ...meta, progress: prog });
      continue;
    }

    const item = scanner.findById(itemId);
    if (!item || item.type === "show") continue;

    const isEpisode = !!item.showId;
    if (isEpisode && seenShows.has(item.showId)) continue;

    if (prog.finished) {
      if (!isEpisode) continue; // finished movies drop off
      const next = nextEpisode(item.showId, itemId);
      if (!next) continue;
      seenShows.add(item.showId);
      // Dismissed via the card's ✕. Keyed to the SPECIFIC next episode, so the
      // dismissal expires by itself: watch further and the candidate changes,
      // and the card comes back for the new episode.
      if (state.upNextDismissed[item.showId] === next.id) continue;
      items.push({ ...next, progress: null, upNext: true });
    } else if (prog.position > 10) {
      if (isEpisode) seenShows.add(item.showId);
      items.push({ ...item, progress: prog });
    }
  }
  return items;
};

const nextEpisode = (showId, episodeId) => {
  const show = scanner.findById(showId);
  if (!show || !show.seasons) return null;
  const flat = show.seasons.flatMap((s) => s.episodes);
  const i = flat.findIndex((e) => e.id === episodeId);
  if (i === -1 || i + 1 >= flat.length) return null;
  return { ...flat[i + 1], showId: show.id, showTitle: show.title, cover: show.cover };
};

// "Because you watched X": take the most recently watched title with genres,
// suggest same-genre titles the profile hasn't started.
const recommendations = (profileId) => {
  const state = stateFor(profileId);
  const entries = Object.entries(state.progress).sort(
    (a, b) => b[1].updatedAt - a[1].updatedAt
  );

  let source = null;
  for (const [itemId] of entries) {
    let item = scanner.findById(itemId);
    if (item && item.showId) item = scanner.findById(item.showId);
    if (item && (item.genres || []).length > 0) {
      source = item;
      break;
    }
  }
  if (!source) return null;

  const sourceGenres = new Set(source.genres);
  const touched = new Set();
  for (const [itemId] of entries) {
    touched.add(itemId);
    const it = scanner.findById(itemId);
    if (it && it.showId) touched.add(it.showId);
  }

  const items = scanner
    .allItems()
    .filter(
      (i) =>
        i.id !== source.id &&
        !touched.has(i.id) &&
        (i.genres || []).some((g) => sourceGenres.has(g))
    )
    .sort((a, b) => (b.rating || 0) - (a.rating || 0))
    .slice(0, 14);

  // `genres` lets the caller match streamable titles to the same taste — this
  // module only has the library index to work from.
  return { source: source.title, genres: source.genres || [], items };
};

// Resolve watchlist entries to renderable card items: local ids via the
// scanner, stream refs normalised to a card shape that opens the Discover page.
// Pure materializer (deps injected; tests use fakes): stored entries → cards.
// One title, one card (elia's item 11): a stream ref whose title the library
// now OWNS becomes the LIBRARY card — its own cover — carrying BOTH keys
// (id + imdbId) so both detail pages' membership checks recognize it, plus
// `listKey` (the ORIGINAL stored key). Deliberately NO source:"stream" on a
// library-backed card: that is exactly what makes openItem route it to the
// library page instead of Discover. Read-time only — stored entries are
// never rewritten here.
const materializeWatchlist = (entries, deps) => {
  const out = [];
  const seen = new Set();
  for (const entry of entries) {
    let card = null;
    if (typeof entry === "string") {
      const item = deps.findById(entry);
      if (!item) continue;
      card = { ...item, listKey: entry };
      const imdbId = deps.imdbIdFor(item);
      if (imdbId) card.imdbId = imdbId;
    } else {
      const lib = deps.findLibrary(entry);
      if (lib) {
        card = {
          ...lib,
          // rare gap: a library item scanned without artwork still shows the
          // poster the stream ref stored at add-time
          cover: lib.cover || entry.poster || null,
          imdbId: entry.imdbId,
          listKey: "disc:" + entry.imdbId,
        };
      } else {
        card = {
          id: "disc:" + entry.imdbId,
          imdbId: entry.imdbId,
          type: entry.type || "movie",
          title: entry.title || "",
          cover: entry.poster || null,
          year: entry.year || null,
          genres: entry.genres || [],
          rating: entry.rating || null,
          source: "stream",
          listKey: "disc:" + entry.imdbId,
        };
      }
    }
    // Collapse twins WITHIN the list (both forms stored by design now) — safe
    // because removal is identity-aware and takes both. imdbId joins the seen
    // set only for STREAM-STORED entries: two distinct library items whose
    // cached IMDb lookups ever collide must both stay visible.
    const fromStream = card.listKey.startsWith("disc:");
    if (seen.has(card.id) || (fromStream && card.imdbId && seen.has(card.imdbId)))
      continue;
    seen.add(card.id);
    if (fromStream && card.imdbId) seen.add(card.imdbId);
    out.push(card);
  }
  return out.reverse();
};

const watchlistItems = (profileId) => {
  const identity = require("./media/identity");
  const maps = identity._internals.libraryMaps();
  return materializeWatchlist(stateFor(profileId).watchlist, {
    findById: scanner.findById,
    findLibrary: (ref) => identity.findLibraryFor(ref, maps),
    imdbIdFor: identity.imdbIdFor,
  });
};

const clearProgress = (profileId, itemId) => {
  const state = stateFor(profileId);
  delete state.progress[itemId];
  delete state.streamItems[itemId]; // drop stored stream meta too
  store.save();
};

// Hide the synthesized "up next" card for one show. clearProgress cannot do
// this — the card's id is the NEXT episode's, while the progress row that
// spawns it lives under the PREVIOUS one, so deleting by the card's id was a
// silent no-op and the card came straight back. Stored per (show, episode):
// watching past the dismissed episode changes the candidate and un-hides it.
const dismissUpNext = (profileId, showId, episodeId) => {
  const state = stateFor(profileId);
  state.upNextDismissed[String(showId)] = String(episodeId);
  store.save();
};

module.exports = {
  list,
  publicList,
  exists,
  isProtected,
  isLocked,
  setLocked,
  tokenValid,
  unlock,
  setPassword,
  requestProfile,
  pendingList,
  pendingCount,
  approveRequest,
  rejectRequest,
  recordAccess,
  accessFor,
  lastSeenBefore,
  update,
  setAvatarImage,
  rowPrefs,
  remove,
  setProgress,
  getProgress,
  getStreamItem,
  getStreamItems,
  getWatchlist,
  streamEpisodeProgress,
  streamTitleProgress,
  clearProgress,
  dismissUpNext,
  toggleWatchlist,
  continueWatching,
  watchlistItems,
  nextEpisode,
  recommendations,
  setRating,
  getRatings,
  setLikedGenres,
  getLikedGenres,
  // Test-only: the pure halves of the watchlist identity work.
  _internals: { entryKey, sameIdentity, materializeWatchlist },
};
