// Children mode (2026-11-11) — the small pieces the routes share.
// docs/children-mode.md has the whole design; the age gate itself is
// lib/kids.js (unchanged rules: children mode is "this account is limited
// to maxAge", read through profiles.kidsOf like a kids profile always was).
//
//  - the passcode limiter: two windows, so a child at the pad runs out of
//    tries fast on one device, and slowly across all of them (a 4-digit
//    passcode is 10 000 guesses; 30 a day is most of a year on average);
//  - the one-time "forgot the passcode" tokens a verified Google sign-in of
//    the ACCOUNT hands out (intent "childmode", routes/auth.js);
//  - the word to every device signed in to the account: "child_mode".
"use strict";
const crypto = require("crypto");

// ---------- the passcode limiter ----------
const keysFor = (ip, profileId) => [
  ["childpass:" + ip + ":" + profileId, 5, 15 * 60 * 1000],
  ["childpass:p:" + profileId, 30, 24 * 3600 * 1000],
];
// One guess. deps: { verify(profileId, code) -> Promise<bool> } (tests stub it).
// -> { ok: true } | { status: 429, ... } | { status: 401, wrongPasscode: true }
const attempt = async (ip, profileId, code, verify) => {
  const limit = require("./authlimit");
  const keys = keysFor(ip, profileId);
  if (limit.anyTooMany(keys)) {
    let wait = 0;
    for (const [k, max, win] of keys) wait = Math.max(wait, limit.retryAfter(k, max, win));
    const m = Math.max(1, Math.ceil((wait || 60) / 60));
    return { status: 429, error: `Too many tries. Wait ${m} minute${m === 1 ? "" : "s"}, then try again.`, code: "limited", retryAfter: wait || 60 };
  }
  // (no passcode typed, or not 4-6 digits: a question, not a guess — it
  // can't be right, and it costs no try)
  if (typeof code !== "string" || !/^\d{4,6}$/.test(code)) return { status: 401, error: "Enter the passcode.", passcodeRequired: true };
  if (await verify(profileId, code)) return { ok: true };
  for (const [k] of keys) limit.recordFail(k);
  return { status: 401, error: "That's not the passcode.", wrongPasscode: true, wrongPin: true };
};

// ---------- "Forgot the passcode?" with Google ----------
// token -> { profileId, expiresAt }. Memory only, ten minutes, single use.
const resetTokens = new Map();
const RESET_TTL = 10 * 60 * 1000;
const issueResetToken = (profileId) => {
  const now = Date.now();
  for (const [t, v] of resetTokens) if (v.expiresAt < now) resetTokens.delete(t);
  const token = "cm." + crypto.randomBytes(24).toString("hex");
  resetTokens.set(token, { profileId, expiresAt: now + RESET_TTL });
  return token;
};
// Burnt on the first try, right or wrong account.
const takeResetToken = (token, profileId) => {
  const v = resetTokens.get(String(token || ""));
  if (!v) return false;
  resetTokens.delete(String(token));
  return v.profileId === profileId && v.expiresAt >= Date.now();
};

// ---------- every device of the account, told at once ----------
// The message: { type: "child_mode", profileId, childMode: { maxAge } | null }.
// A device that misses it (asleep, offline) is filtered on its very next
// request anyway — the gate reads the account, not the device — and the
// X-Aurora-Kids header on that answer tells the app to put its look on.
const tell = (profileId) => {
  try {
    const profiles = require("../profiles");
    const realtime = require("../realtime");
    const p = profiles.list().find((x) => x.id === profileId);
    if (!p) return 0;
    const k = profiles.kidsOf(profileId);
    const msg = { type: "child_mode", profileId, childMode: k ? { maxAge: k.maxAge } : null };
    let n = 0;
    for (const c of realtime.clientsOfProfile(p)) {
      try { realtime.sendTo(c.id, msg); n++; } catch {}
    }
    return n;
  } catch { return 0; }
};

module.exports = { keysFor, attempt, issueResetToken, takeResetToken, tell, _internals: { resetTokens } };
