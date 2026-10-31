// The password rule (auth-round, 2026-10-31): one rule for every NEW password
// the server accepts — a sign-up (password or Google), a reset, a password set
// for the first time, a change. The clients show the same rule up front
// (public/js/passrules.js, tv-native/src/passRules.ts) and add a strength hint;
// the hint is theirs, the rule is this.
//
// At least 4 characters: the household's rule since the first sign-in build
// (the admin's "Set password", the wall's "Add profile"). Raising it is one
// constant here and its two client copies; existing passwords keep working
// either way (the rule is checked when a password is CHOSEN, never at sign-in).
// At most 128: scrypt would take a megabyte, but nobody types one.
"use strict";
const MIN = 4;
const MAX = 128;

// -> null when it passes, else { error, code, field } for a 400 body.
const check = (pw, field = "password") => {
  const s = typeof pw === "string" ? pw : pw == null ? "" : String(pw);
  if (s.length < MIN) return { error: `Use at least ${MIN} characters.`, code: "short", field };
  if (s.length > MAX) return { error: `Use at most ${MAX} characters.`, code: "long", field };
  return null;
};

module.exports = { MIN, MAX, check };
