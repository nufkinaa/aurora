// The PLAYER OPTIONS that follow the person, on the website: night mode,
// dialogue boost (audiofx.js) and the look of subtitles (subStyle.js). PURE —
// only those two pure tables are imported (test/player-options.test.js runs
// it as it is); state.js does the storage and the request around it, as it
// does for personprefs.js. The TV's side of the same rules is
// tv-native/src/personPrefs.ts.
import { SUB_STYLE_DEFAULTS, SUB_STYLE_CHOICES, SUB_STYLE_KEYS, styleFromDevice } from "./subStyle.js";
import { AUDIO_FX_DEFAULTS, AUDIO_FX_KEYS } from "./audiofx.js";

export const OPTION_DEFAULTS = { ...AUDIO_FX_DEFAULTS, ...SUB_STYLE_DEFAULTS };
export const OPTION_KEYS = [...AUDIO_FX_KEYS, ...SUB_STYLE_KEYS];
const valid = (k, v) => (AUDIO_FX_KEYS.includes(k) ? typeof v === "boolean" : SUB_STYLE_CHOICES[k].includes(v));

// What this browser's player settings ("aurora-player") should hold for a
// profile, and what (if anything) the profile is owed.
//   prefs   the profile's prefs
//   local   the browser's player settings now
//   moved   has the one-time move of this browser's OLD subtitle look
//           (cueSize / cueBackground, device-only until 2026-10-19) already
//           been offered to this profile?
// Per key: the profile's value when it has one; else, the first time this
// person is seen after the update, this browser's old look where it was a
// real choice — and that is offered to the profile; else the default (never
// the last person's value left in the browser).
// → { local, owed, changed }
export const playerOptionsFor = ({ prefs, local, moved }) => {
  const p = prefs && typeof prefs === "object" ? prefs : {};
  const was = local && typeof local === "object" ? local : {};
  const next = { ...was };
  const owed = {};
  const old = moved ? {} : styleFromDevice(was, "web");
  for (const k of OPTION_KEYS) {
    if (valid(k, p[k])) next[k] = p[k];
    else if (Object.hasOwn(old, k)) {
      next[k] = old[k];
      owed[k] = old[k];
    } else next[k] = OPTION_DEFAULTS[k];
  }
  const changed = OPTION_KEYS.some((k) => next[k] !== was[k]);
  return { local: next, owed, changed };
};
