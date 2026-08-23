// Accounts (prompt 10): an account is a PERSON who signs in; profiles are
// the watch identities nested under it. The account layer sits ON TOP of
// profiles — nothing about profiles.js's storage changes, and in
// authMode:"open" this module is completely dormant.
//
// Signup stays a REQUEST an admin approves (elia's model, same as profile
// requests): passwords are scrypt-hashed at request time so approval never
// sees — and the server never stores — the plaintext.
const path = require("path");
const crypto = require("crypto");
const { promisify } = require("util");
const config = require("./config");
const { JsonStore } = require("./lib/jsonstore");
const profiles = require("./profiles");

const store = new JsonStore(path.join(config.DATA_DIR, "users.json"), {
  users: [], // {id, username, name, passwordHash, passwordSalt, profileIds, googleSub, createdAt}
  pending: [], // signup requests, same shape + note/ip/device/requestedAt
});

const scrypt = promisify(crypto.scrypt);
const MAX_PENDING = 40;

const normUsername = (u) =>
  String(u || "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 24);

const hashPassword = async (password) => {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = (await scrypt(String(password), salt, 64)).toString("hex");
  return { salt, hash };
};
const verifyHash = async (password, salt, hash) => {
  if (!salt || !hash) return false;
  const test = await scrypt(String(password), salt, 64);
  const b = Buffer.from(hash, "hex");
  return test.length === b.length && crypto.timingSafeEqual(test, b);
};

// What clients may see of a user. Hash and salt never leave, same as pub().
const pub = (u) => ({
  id: u.id,
  username: u.username,
  name: u.name,
  profileIds: u.profileIds || [],
  hasGoogle: !!u.googleSub,
});

const byId = (id) => store.data.users.find((u) => u.id === id) || null;
const byUsername = (username) =>
  store.data.users.find((u) => u.username === normUsername(username)) || null;
const byGoogleSub = (sub) => store.data.users.find((u) => u.googleSub === sub) || null;

const usernameTaken = (username) =>
  !!byUsername(username) ||
  store.data.pending.some((r) => r.username === normUsername(username));

// ---------- signup requests (admin-approved, like profile requests) ----------
const requestSignup = async ({ username, name, password, note, ip, device }) => {
  const u = normUsername(username);
  if (u.length < 2) return { error: "pick a username (letters/numbers, 2+ chars)" };
  if (!password || String(password).length < 4) return { error: "password too short (4+ chars)" };
  if (usernameTaken(u)) return { error: "that username is taken" };
  if (store.data.pending.length >= MAX_PENDING) return { error: "too many pending requests — ask the admin" };
  const { salt, hash } = await hashPassword(password);
  const req = {
    id: crypto.randomBytes(6).toString("hex"),
    username: u,
    name: String(name || u).slice(0, 40),
    note: String(note || "").slice(0, 200),
    passwordHash: hash,
    passwordSalt: salt,
    requestedAt: Date.now(),
    ip,
    device,
  };
  store.data.pending.push(req);
  store.save();
  return { ok: true, request: { id: req.id, username: req.username, name: req.name } };
};

const pendingList = () =>
  store.data.pending.map(({ passwordHash, passwordSalt, ...safe }) => safe);

const approveSignup = (requestId) => {
  const i = store.data.pending.findIndex((r) => r.id === requestId);
  if (i === -1) return { error: "not found" };
  // the name may have been claimed while the request sat in the queue (the
  // profile migration generates usernames too) — approving would otherwise
  // mint a duplicate that can never log in
  if (byUsername(store.data.pending[i].username)) {
    return { error: `@${store.data.pending[i].username} got taken while this request waited — reject it and have them re-request` };
  }
  const r = store.data.pending.splice(i, 1)[0];
  const user = {
    id: crypto.randomBytes(6).toString("hex"),
    username: r.username,
    name: r.name,
    passwordHash: r.passwordHash,
    passwordSalt: r.passwordSalt,
    profileIds: [],
    createdAt: Date.now(),
  };
  store.data.users.push(user);
  store.save();
  return { ok: true, user: pub(user) };
};

const rejectSignup = (requestId) => {
  const i = store.data.pending.findIndex((r) => r.id === requestId);
  if (i === -1) return { error: "not found" };
  store.data.pending.splice(i, 1);
  store.save();
  return { ok: true };
};

// ---------- login ----------
const login = async (username, password) => {
  const u = byUsername(username);
  // scrypt against a dummy even on unknown users, so timing doesn't reveal
  // which usernames exist
  const ok = u
    ? await verifyHash(password, u.passwordSalt, u.passwordHash)
    : (await hashPassword(String(password || "x")), false);
  if (!ok) return { error: "wrong username or password" };
  return { ok: true, user: pub(u), userId: u.id };
};

// ---------- migration: existing profiles → accounts, 1:1 ----------
// Idempotent, additive, and preceded by a BACKUP of profiles.json. A profile
// password (same scrypt format) carries over as the account password; a
// password-less profile gets a passwordless account that CANNOT log in until
// the admin (or migration owner) sets one — logged loudly.
const migrateFromProfiles = ({ backup = true } = {}) => {
  const fs = require("fs");
  const migrated = [];
  const src = path.join(config.DATA_DIR, "profiles.json");
  if (backup && fs.existsSync(src)) {
    const dir = path.join(config.DATA_DIR, "backups");
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `profiles-pre-auth-${new Date().toISOString().slice(0, 10)}.json`);
    if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
  }
  for (const p of profiles.list()) {
    const username = normUsername(p.name) || `user${p.id.slice(0, 4)}`;
    if (store.data.users.some((u) => u.profileIds.includes(p.id))) continue;
    if (byUsername(username)) {
      byUsername(username).profileIds.push(p.id);
      migrated.push(`${p.name} → existing @${username}`);
      continue;
    }
    store.data.users.push({
      id: crypto.randomBytes(6).toString("hex"),
      username,
      name: p.name,
      passwordHash: p.passwordHash || null, // same scrypt format — carries over
      passwordSalt: p.passwordSalt || null,
      profileIds: [p.id],
      createdAt: Date.now(),
      migrated: true,
    });
    migrated.push(`${p.name} → @${username}${p.passwordHash ? "" : " (NO PASSWORD — set one before required mode)"}`);
  }
  if (migrated.length) store.save();
  return migrated;
};

const ownsProfile = (userId, profileId) => {
  const u = byId(userId);
  return !!u && (u.profileIds || []).includes(profileId);
};

const setPassword = async (userId, newPassword) => {
  const u = byId(userId);
  if (!u) return { error: "not found" };
  const { salt, hash } = await hashPassword(newPassword);
  u.passwordHash = hash;
  u.passwordSalt = salt;
  store.save();
  return { ok: true };
};

// Admin views/knobs. adminList carries a bit more than pub() (created, which
// profiles, whether a password exists) — hashes still never leave.
const adminList = () =>
  store.data.users.map((u) => ({
    ...pub(u),
    createdAt: u.createdAt,
    migrated: !!u.migrated,
    hasPassword: !!u.passwordHash,
  }));

const setProfiles = (userId, profileIds) => {
  const u = byId(userId);
  if (!u) return { error: "not found" };
  u.profileIds = Array.isArray(profileIds)
    ? profileIds.filter((id) => profiles.exists(id)).slice(0, 20)
    : [];
  store.save();
  return { ok: true, user: pub(u) };
};

const removeUser = (userId) => {
  const i = store.data.users.findIndex((u) => u.id === userId);
  if (i === -1) return { error: "not found" };
  store.data.users.splice(i, 1);
  store.save();
  return { ok: true };
};

const linkGoogle = (userId, sub) => {
  const u = byId(userId);
  if (!u) return { error: "not found" };
  u.googleSub = sub;
  store.save();
  return { ok: true };
};

module.exports = {
  pub, byId, byUsername, byGoogleSub, usernameTaken,
  requestSignup, pendingList, approveSignup, rejectSignup,
  login, migrateFromProfiles, ownsProfile, setPassword, linkGoogle,
  adminList, setProfiles, removeUser,
  _internals: { normUsername, store, hashPassword, verifyHash },
};
