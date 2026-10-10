// Settings that follow the person, on the website. PURE — no imports
// (test/personprefs-web.test.js runs it as it is; state.js does the storage
// and the request around it). tv-native/src/personPrefs.ts is the TV's side
// of the same table; src/profiles.js `update` says what the profile stores.
//
// Two switches used to live in this browser only (localStorage
// "aurora-player"): "Play the next episode" and "Subtitles on by themselves".
// They are the person's now — on the profile, the same on every device —
// like the subtitle language, the download switches and usage stats already
// were. Subtitle size and background, and trailers on the home page, stay
// with the device.
export const PERSON_SWITCHES = ["autoplayNext", "subsDefault"]; // both default ON
export const SUB_LANGS = ["any", "he", "en", "ru"];

// What this browser's player settings should hold for `profile`, and what (if
// anything) the profile is owed.
//   local   the browser's player settings now ("aurora-player")
//   box     what the browser held BEFORE these followed the person — kept
//           once, so the one-time move below reads the browser's own old
//           choice and never the last person's
//   moved   has the one-time move already been done for this profile here?
// Per switch: the profile's value when it has one; else, the first time this
// person is seen in this browser, the browser's old choice when it was a real
// one (off) — and that is offered to the profile; else the default (on).
// → { local, owed, changed }
export const personPrefsFor = ({ prefs, local, box, moved }) => {
  const p = prefs && typeof prefs === "object" ? prefs : {};
  const next = { ...(local || {}) };
  const owed = {};
  for (const k of PERSON_SWITCHES) {
    let v = true;
    if (typeof p[k] === "boolean") v = p[k];
    else if (!moved && box && box[k] === false) {
      v = false;
      owed[k] = false;
    }
    next[k] = v;
  }
  if (SUB_LANGS.includes(p.subLang)) next.subLang = p.subLang;
  const changed = [...PERSON_SWITCHES, "subLang"].some((k) => next[k] !== (local || {})[k]);
  return { local: next, owed, changed };
};

// The browser's old choices, read once off its player settings.
export const boxFrom = (local) => {
  const box = {};
  for (const k of PERSON_SWITCHES) if (local && typeof local[k] === "boolean") box[k] = local[k];
  return box;
};
