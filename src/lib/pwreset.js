// Self-service password reset (auth-round, 2026-10-31) — elia: "a lot of
// users forget their password so let's make it easy and clear to reset it by
// themselves". Aurora sends no email by default, so a person proves who they
// are another way, and every way ends in the same place: a RESET TOKEN that
// sets a new password once (routes/auth.js /api/auth/reset/complete).
//
//   Google      verified with Google, for a profile linked to that account;
//   the admin   the person asks, the admin approves in People: the waiting
//               device continues by itself (its ticket turns into a token),
//               and the admin is shown a one-time CODE to read out as well;
//   a code      the admin can also make a code without being asked;
//   email       a link by email, when the server is set up to send one
//               (lib/mailer.js — off unless configured).
//
// THE SECRETS. Tokens, tickets and codes are random, short-lived and single
// use, and only their sha256 is kept (data/password-resets.json): a copy of
// the file opens nothing. A code is 8 characters from an alphabet without
// look-alikes, hashed with the profile id; five wrong tries burn it.
//
// NO ENUMERATION. Asking for a reset answers the same whether the username
// exists or not: a request for nobody is kept like any other (so its ticket
// answers "pending" until it lapses) but never shown to the admin.
//
// Kids profiles are left out of every self-service way (a child may not
// change the profile's password — lib/kids.js): their requests are treated as
// requests for nobody; a grown-up uses the admin's "Set password".
"use strict";
const path = require("path");
const crypto = require("crypto");
const config = require("../config");
const { JsonStore } = require("./jsonstore");

const MIN = 60 * 1000;
const TTL = {
  token: 15 * MIN, // Google, an approved request
  tokenLong: 30 * MIN, // a code, an email link
  code: 30 * MIN,
  request: 24 * 60 * MIN,
};
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
const CODE_LEN = 8;
const CODE_TRIES = 5;
const MAX_REQUESTS = 300;

const store = new JsonStore(path.join(config.DATA_DIR, "password-resets.json"),
  () => ({ tokens: {}, codes: {}, requests: [] }), { kind: "state" });
const data = () => {
  const d = store.data;
  if (!d.tokens || typeof d.tokens !== "object") d.tokens = {};
  if (!d.codes || typeof d.codes !== "object") d.codes = {};
  if (!Array.isArray(d.requests)) d.requests = [];
  return d;
};

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const secret = () => crypto.randomBytes(32).toString("base64url");
const newCode = () => Array.from(crypto.randomBytes(CODE_LEN), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
// What a person typed as a code → its canonical form (spaces, dashes, case).
const normCode = (raw) => String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const codeHash = (profileId, code) => sha(`${profileId}:${normCode(code)}`);

const prune = (now = Date.now()) => {
  const d = data();
  let changed = false;
  for (const [k, t] of Object.entries(d.tokens)) if (t.expiresAt < now) { delete d.tokens[k]; changed = true; }
  for (const [k, c] of Object.entries(d.codes)) if (c.expiresAt < now) { delete d.codes[k]; changed = true; }
  const keep = d.requests.filter((r) => r.expiresAt > now);
  if (keep.length !== d.requests.length) { d.requests = keep; changed = true; }
  while (d.requests.length > MAX_REQUESTS) { d.requests.shift(); changed = true; }
  if (changed) store.save();
};

// ---------- reset tokens ----------
// -> the token (shown to the device once), stored as its sha256.
const issueToken = (profileId, via, ttl = TTL.token) => {
  prune();
  const t = secret();
  data().tokens[sha(t)] = { profileId, via, createdAt: Date.now(), expiresAt: Date.now() + ttl };
  store.save();
  return t;
};
// -> { profileId, via } or null. `consume`: it is spent now.
const readToken = (token, { consume = false } = {}) => {
  if (!token || typeof token !== "string" || token.length > 200) return null;
  const k = sha(token);
  const row = data().tokens[k];
  if (!row) return null;
  if (row.expiresAt < Date.now()) { delete data().tokens[k]; store.save(); return null; }
  if (consume) { delete data().tokens[k]; store.save(); }
  return { profileId: row.profileId, via: row.via, expiresAt: row.expiresAt };
};

// A finished reset (or any new password): every other way that was open for
// that profile closes — its tokens, its code, its approved requests.
const closeAllFor = (profileId) => {
  const d = data();
  for (const [k, t] of Object.entries(d.tokens)) if (t.profileId === profileId) delete d.tokens[k];
  delete d.codes[profileId];
  for (const r of d.requests) if (r.profileId === profileId && (r.status === "pending" || r.status === "approved")) r.status = "done";
  store.save();
};

// ---------- codes the admin gives out ----------
const issueCode = (profileId) => {
  prune();
  const code = newCode();
  const expiresAt = Date.now() + TTL.code;
  data().codes[profileId] = { hash: codeHash(profileId, code), expiresAt, tries: 0, createdAt: Date.now() };
  store.save();
  return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt };
};
// -> "ok" (spent now) | "wrong" | "none"
const redeemCode = (profileId, code) => {
  prune();
  const c = profileId ? data().codes[profileId] : null;
  if (!c) return "none";
  if (c.hash === codeHash(profileId, code)) {
    delete data().codes[profileId];
    store.save();
    return "ok";
  }
  c.tries = (c.tries || 0) + 1;
  if (c.tries >= CODE_TRIES) delete data().codes[profileId];
  store.save();
  return "wrong";
};

// ---------- asking the admin ----------
// profileId null = a request for nobody (unknown name, a kids or locked
// profile): kept so its ticket answers like any other, never shown.
const request = ({ profileId, note, ip, device }) => {
  prune();
  const ticket = secret();
  const d = data();
  // one live request per profile: a second ask replaces the first (its ticket stops)
  if (profileId) {
    for (const r of d.requests) if (r.profileId === profileId && r.status === "pending") r.status = "replaced";
  }
  const row = {
    id: crypto.randomBytes(6).toString("hex"),
    ticket: sha(ticket),
    profileId: profileId || null,
    note: String(note || "").trim().slice(0, 200),
    requestedAt: Date.now(),
    expiresAt: Date.now() + TTL.request,
    ip: String(ip || "?").slice(0, 60),
    device: device || null,
    status: "pending",
  };
  d.requests.push(row);
  store.save();
  return { ticket, row };
};
const byTicket = (ticket) => {
  if (!ticket || typeof ticket !== "string" || ticket.length > 200) return null;
  const k = sha(ticket);
  return data().requests.find((r) => r.ticket === k) || null;
};
// What the waiting device is told. An approved request hands over a token
// ONCE ("approved" + token); after that it says "used".
const status = (ticket) => {
  prune();
  const r = byTicket(ticket);
  if (!r || r.expiresAt < Date.now() || r.status === "replaced") return { status: "expired" };
  if (r.status === "pending") return { status: "pending" };
  if (r.status === "declined") return { status: "declined" };
  if (r.status === "approved") {
    r.status = "handed";
    store.save();
    return { status: "approved", token: issueToken(r.profileId, "admin") };
  }
  return { status: "used" };
};
const pendingForAdmin = () => {
  prune();
  return data().requests.filter((r) => r.profileId && r.status === "pending");
};
const decide = (id, approve) => {
  const r = data().requests.find((x) => x.id === id);
  if (!r || !r.profileId || r.status !== "pending" || r.expiresAt < Date.now()) return null;
  r.status = approve ? "approved" : "declined";
  r.decidedAt = Date.now();
  // the waiting screen may have gone: an approval stays good for a little while
  if (approve) r.expiresAt = Date.now() + TTL.code;
  store.save();
  return r;
};

module.exports = {
  TTL, CODE_LEN, CODE_TRIES,
  issueToken, readToken, closeAllFor,
  issueCode, redeemCode, normCode,
  request, status, pendingForAdmin, decide,
  _internals: { store, sha, prune, data },
};
