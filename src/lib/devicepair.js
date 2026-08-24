// TV pairing by QR (prompt 10 follow-up): the TV asks for a short code and
// shows it as a QR; the PHONE — already signed in — scans it, sees "sign in
// this TV as @you?", and one tap approves. The TV polls and receives its
// session. Same shape as the Google device flow, minus Google.
//
// Two credentials per pairing, on purpose:
//   code    — short and human/scannable (shown on the TV). Knowing it only
//             lets you APPROVE — i.e. donate YOUR OWN session to that TV.
//   secret  — long, held only by the TV that started the pairing. Claiming
//             the minted session requires it, so guessing codes can never
//             STEAL anything.
// Entries live 5 minutes, are single-use, and the whole table is tiny.
const crypto = require("crypto");

// No 0/O/1/I/L — this gets read off a TV screen by a human as a fallback.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const TTL_MS = 5 * 60 * 1000;

const pairs = new Map(); // code -> {secret, createdAt, expiresAt, ip, device, profileId|null, used}

const prune = () => {
  const now = Date.now();
  for (const [code, p] of pairs) {
    if (now > p.expiresAt || p.used) pairs.delete(code);
  }
};

const newCode = () => {
  let code = "";
  const bytes = crypto.randomBytes(6);
  for (const b of bytes) code += ALPHABET[b % ALPHABET.length];
  return code;
};

// Start a pairing (called by the TV). Returns what the TV renders + keeps.
const start = ({ ip = null, device = null } = {}) => {
  prune();
  if (pairs.size >= 50) return { error: "too many pairings in flight — try again in a minute" };
  let code = newCode();
  while (pairs.has(code)) code = newCode();
  const secret = crypto.randomBytes(24).toString("hex");
  pairs.set(code, {
    secret,
    createdAt: Date.now(),
    expiresAt: Date.now() + TTL_MS,
    ip,
    device,
    profileId: null,
    used: false,
  });
  return { code, secret, expiresIn: TTL_MS / 1000 };
};

// What the phone's confirm screen shows about the asking device.
const describe = (code) => {
  prune();
  const p = pairs.get(String(code || "").toUpperCase());
  if (!p) return null;
  return { ip: p.ip, device: p.device, approved: !!p.profileId };
};

// Approve (called by the signed-in phone): attach ITS profile to the code.
const approve = (code, profileId) => {
  prune();
  const p = pairs.get(String(code || "").toUpperCase());
  if (!p) return { error: "that code expired — ask the TV for a fresh one" };
  if (p.profileId) return { error: "already approved" };
  p.profileId = profileId;
  return { ok: true };
};

// Consume (called by the polling TV, code + ITS secret): hand over the
// approved profile exactly once.
const consume = (code, secret) => {
  prune();
  const p = pairs.get(String(code || "").toUpperCase());
  if (!p) return { gone: true };
  if (!secret || secret !== p.secret) return { gone: true }; // wrong holder = as if expired
  if (!p.profileId) return { pending: true };
  p.used = true;
  pairs.delete(String(code).toUpperCase());
  return { profileId: p.profileId };
};

module.exports = { start, describe, approve, consume, _internals: { pairs, ALPHABET, TTL_MS } };
