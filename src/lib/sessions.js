// Server-side sessions (prompt 10). Maps a session to its PROFILE (account = profile). One table, two transports: an HttpOnly
// cookie for browsers and a bearer header (X-Session) for the TV app.
// Design per findings/auth.md:
//   - the session id is 32 random bytes; only its sha256 is STORED, so a
//     leaked sessions.json cannot be replayed;
//   - sliding expiry with cheap persistence (lastSeenAt written at most
//     every few minutes, piggybacking the JsonStore debounce);
//   - survives restarts (the old in-memory token map logged everyone out).
const crypto = require("crypto");
const path = require("path");
const config = require("../config");
const { JsonStore } = require("./jsonstore");

const store = new JsonStore(path.join(config.DATA_DIR, "sessions.json"), {});

const TTL_MS = 90 * 24 * 3600 * 1000; // sliding 90 days — household devices
const TOUCH_EVERY_MS = 5 * 60 * 1000;

const hash = (sid) => crypto.createHash("sha256").update(sid).digest("hex");

const create = (profileId, { device = null, ip = null } = {}) => {
  const sid = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  store.data[hash(sid)] = {
    profileId,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + TTL_MS,
    device,
    ip,
  };
  prune();
  store.save();
  return sid; // the caller hands this to the client; we never see it again
};

// The session row for a presented sid, or null. Slides the expiry.
const get = (sid) => {
  if (!sid || typeof sid !== "string" || sid.length !== 64) return null;
  const key = hash(sid);
  const row = store.data[key];
  if (!row) return null;
  const now = Date.now();
  if (row.expiresAt < now) {
    delete store.data[key];
    store.save();
    return null;
  }
  if (now - row.lastSeenAt > TOUCH_EVERY_MS) {
    row.lastSeenAt = now;
    row.expiresAt = now + TTL_MS;
    store.save();
  }
  return { ...row, key };
};

const revoke = (sidOrKey) => {
  const key = sidOrKey.length === 64 && store.data[sidOrKey] ? sidOrKey : hash(sidOrKey);
  const existed = !!store.data[key];
  delete store.data[key];
  store.save();
  return existed;
};

// Sessions the ADMIN ended (People → Kick, Reset password), remembered for a
// while by their stored key (the sha256 — never a usable id). See
// profiles.tokenEnded for why: outside sign-in mode "closed" a dead session
// is otherwise indistinguishable from no session at all. RAM only.
const ended = new Map(); // key -> when
const ENDED_TTL = 30 * 24 * 3600 * 1000;
const ENDED_MAX = 2000;
const wasEnded = (sid) => {
  if (!sid || typeof sid !== "string" || sid.length !== 64) return false;
  const at = ended.get(hash(sid));
  return !!at && Date.now() - at < ENDED_TTL;
};

const revokeAllFor = (profileId, { remember = false } = {}) => {
  let n = 0;
  for (const [key, row] of Object.entries(store.data)) {
    if (row.profileId === profileId) {
      delete store.data[key];
      if (remember) ended.set(key, Date.now());
      n++;
    }
  }
  if (ended.size > ENDED_MAX) {
    const cutoff = Date.now() - ENDED_TTL;
    for (const [k, at] of ended) {
      if (at < cutoff || ended.size > ENDED_MAX) ended.delete(k);
      else break; // insertion order: the rest are newer
    }
  }
  if (n) store.save();
  return n;
};

// "Sessions on my account": safe rows only — the key is exposed as the
// revocation handle (it's the sha256, not the usable sid).
const listFor = (profileId) =>
  Object.entries(store.data)
    .filter(([, r]) => r.profileId === profileId && r.expiresAt > Date.now())
    .map(([key, r]) => ({
      key,
      createdAt: r.createdAt,
      lastSeenAt: r.lastSeenAt,
      device: r.device,
      ip: r.ip,
    }))
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);

const prune = () => {
  const now = Date.now();
  for (const [key, row] of Object.entries(store.data)) {
    if (row.expiresAt < now) delete store.data[key];
  }
};

module.exports = { create, get, revoke, revokeAllFor, wasEnded, listFor, _internals: { hash, store, TTL_MS, prune, ended } };
