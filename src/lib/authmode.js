// The sign-in rollout switch, LIVE-SWITCHABLE from the admin panel (elia:
// "a state in admin instead of the json"). Three states:
//
//   "open"       — no accounts anywhere; the app behaves as it always did.
//   "transition" — the app STILL behaves as it always did (wall visible,
//                  nothing gated) but accounts exist: everyone gets an
//                  in-app prompt to claim theirs (username + password,
//                  optionally email/Google) from inside their profile.
//   "closed"     — a real login wall, like any site: sessions required for
//                  every data + stream route, each account sees only its
//                  own profiles.
//
// Precedence: data/settings.json (what the admin panel writes) wins; the
// hand-authored config.json "authMode" is the fallback/recovery override for
// a fresh data dir. Legacy names from the first cut ("hybrid", "required")
// still parse. Reads are per-request so a flip needs NO restart.
const settings = require("./settings");
const config = require("../config");

const MODES = ["open", "transition", "closed"];
const norm = (m) =>
  m === "hybrid" ? "transition" : m === "required" ? "closed" : m;

const get = () => {
  const m = norm(settings.data.authMode || config.AUTH_MODE);
  return MODES.includes(m) ? m : "open";
};

const set = (mode) => {
  if (!MODES.includes(norm(mode))) return false;
  settings.data.authMode = norm(mode);
  settings.save();
  return true;
};

module.exports = { get, set, MODES };
