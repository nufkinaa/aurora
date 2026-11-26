// Access keys for Clipwave (2026-11-26): the app that cuts short clips out of
// the library reads it through /clipwave/v1 (routes/clipwave.js) with
// `Authorization: Bearer <key>`. elia: "give me option in settings to create
// auth token for that api" — the admin makes and removes them in the admin
// panel (Server → Clipwave access).
//
// A key opens the WHOLE library read-only (every film and episode, their
// subtitles, their files) and nothing else: no profile, no history, no admin
// route, no download queue. So only the admin can make one.
//
// What is kept: the key's sha256, never the key itself — it is shown ONCE,
// when it is made. The list shows a name, the first characters, when it was
// made and when it was last used.
//
// data/clipwave-tokens.json: { v: 1, tokens: [{ id, name, hash, start, createdAt, lastUsedAt }] }
"use strict";
const path = require("path");
const crypto = require("crypto");
const config = require("../config");
const { JsonStore } = require("./jsonstore");

const MAX_TOKENS = 20;
const PREFIX = "cw_";
// "last used" is written at most this often per key (Clipwave makes many
// range requests a minute while it cuts; the date needs no more than this)
const USED_EVERY_MS = 60 * 1000;

let store = null;
const db = () => {
  if (!store) {
    store = new JsonStore(path.join(config.DATA_DIR, "clipwave-tokens.json"), () => ({ v: 1, tokens: [] }), { kind: "state" });
    if (!Array.isArray(store.data.tokens)) store.data.tokens = [];
  }
  return store;
};

const hashOf = (key) => crypto.createHash("sha256").update(String(key)).digest("hex");

const publicOf = (t) => ({
  id: t.id,
  name: t.name,
  start: t.start,
  createdAt: t.createdAt,
  lastUsedAt: t.lastUsedAt || null,
});

const list = () => db().data.tokens.map(publicOf);

const cleanName = (name) => String(name || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 60) || "Clipwave";

// -> { token (the key, shown once), entry } | { error }
const create = (name, now = Date.now()) => {
  const s = db();
  if (s.data.tokens.length >= MAX_TOKENS) return { error: `At most ${MAX_TOKENS} keys — remove one first.` };
  const key = PREFIX + crypto.randomBytes(32).toString("base64url");
  const entry = {
    id: crypto.randomBytes(6).toString("hex"),
    name: cleanName(name),
    hash: hashOf(key),
    start: key.slice(0, PREFIX.length + 4),
    createdAt: new Date(now).toISOString(),
    lastUsedAt: null,
  };
  s.data.tokens.push(entry);
  s.flush(); // a key the admin was just shown is kept at once
  return { token: key, entry: publicOf(entry) };
};

const remove = (id) => {
  const s = db();
  const before = s.data.tokens.length;
  s.data.tokens = s.data.tokens.filter((t) => t.id !== String(id));
  if (s.data.tokens.length === before) return false;
  s.flush(); // a removed key is gone at once, restart or not
  return true;
};

const lastWrite = new Map(); // id -> when "last used" was last saved
// The key a request carries -> its entry, or null. (Compared by digest: the
// lookup never sees the key, and equal-length hex compares in constant time.)
const check = (key, now = Date.now()) => {
  if (!key || typeof key !== "string" || !key.startsWith(PREFIX) || key.length > 200) return null;
  const h = Buffer.from(hashOf(key), "hex");
  let hit = null;
  for (const t of db().data.tokens) {
    const th = Buffer.from(String(t.hash || ""), "hex");
    if (th.length === h.length && crypto.timingSafeEqual(th, h)) hit = t;
  }
  if (!hit) return null;
  const was = lastWrite.get(hit.id) || 0;
  if (now - was >= USED_EVERY_MS) {
    lastWrite.set(hit.id, now);
    hit.lastUsedAt = new Date(now).toISOString();
    db().save();
  }
  return publicOf(hit);
};

// The key in `Authorization: Bearer <key>`, or null.
const bearerOf = (req) => {
  const h = String((req.headers && req.headers.authorization) || "");
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m ? m[1] : null;
};

module.exports = {
  list, create, remove, check, bearerOf, hashOf, MAX_TOKENS, PREFIX,
  _internals: { db, reset: () => { store = null; lastWrite.clear(); } },
};
