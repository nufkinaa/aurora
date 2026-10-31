// Sign-in rate limiting (per address and per identifier) — moved here from
// routes/auth.js (auth-round) so the reset routes count against the same
// windows. In-memory on purpose (single node); scrypt's own ~78 ms per check
// is a second throttle.
"use strict";
const FAIL_WINDOW = 15 * 60 * 1000;
const FAIL_MAX = 10;
const fails = new Map(); // key -> [timestamps]

// `max`/`windowMs`: a stricter window for a key family (the reset routes).
const tooMany = (key, max = FAIL_MAX, windowMs = FAIL_WINDOW) => {
  const now = Date.now();
  const list = (fails.get(key) || []).filter((t) => now - t < Math.max(windowMs, FAIL_WINDOW));
  fails.set(key, list);
  return list.filter((t) => now - t < windowMs).length >= max;
};
// Seconds until the oldest counted try leaves the window (for Retry-After).
const retryAfter = (key, max = FAIL_MAX, windowMs = FAIL_WINDOW) => {
  const now = Date.now();
  const list = (fails.get(key) || []).filter((t) => now - t < windowMs).sort((a, b) => a - b);
  if (list.length < max) return 0;
  return Math.max(1, Math.ceil((list[list.length - max] + windowMs - now) / 1000));
};
const recordFail = (key) => {
  // the healer reads these as a statistic ("many refusals from one address")
  if (/^(ip|unlock):(?!p:)/.test(key)) { try { require("./signals").hit("auth-fail", key.replace(/^(ip|unlock):/, "")); } catch {} }
  const list = fails.get(key) || [];
  list.push(Date.now());
  fails.set(key, list);
  // a spray of unique identifiers must not grow the map forever
  if (fails.size > 5000) {
    const now = Date.now();
    for (const [k, v] of fails) {
      if (!v.some((t) => now - t < 24 * 3600 * 1000)) fails.delete(k);
    }
  }
};

// The one refusal every limited route answers with: a sentence with the wait,
// the wait in seconds, and the Retry-After header.
const refuse = (res, keys) => {
  let wait = 0;
  for (const k of keys) {
    const [key, max, windowMs] = Array.isArray(k) ? k : [k];
    wait = Math.max(wait, retryAfter(key, max, windowMs));
  }
  wait = wait || 60;
  const m = Math.max(1, Math.ceil(wait / 60));
  res.set("Retry-After", String(wait));
  return res.status(429).json({
    error: `Too many tries. Wait ${m} minute${m === 1 ? "" : "s"}, then try again.`,
    code: "limited",
    retryAfter: wait,
  });
};
// tooMany over several keys; each is "key" or [key, max, windowMs].
const anyTooMany = (keys) => keys.some((k) => (Array.isArray(k) ? tooMany(...k) : tooMany(k)));

module.exports = { FAIL_WINDOW, FAIL_MAX, fails, tooMany, retryAfter, recordFail, refuse, anyTooMany };
