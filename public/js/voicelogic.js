// Voice search: the rules, and nothing else. PURE — no imports, no DOM.
// tv-native/src/voiceLogic.ts is this file with types; test/voice-logic.test.js
// runs both through the same assertions. Change one, change both.
//
// The microphone (the browser's Web Speech API on the website, Android's
// speech recognition on the TV) hears; what it heard goes to the same
// server search as typing (/api/search?v=2&voice=1 — media/spoken.js tidies
// the sentence). This file says, for both apps:
//   - which language to listen in: the person's choice (profile prefs
//     `voiceLang`: auto | he | en, the same on every device), else the
//     device's own language;
//   - what each moment of a voice search is (voiceReduce), from the events a
//     recogniser sends, whichever recogniser it is;
//   - what to tell the person (voiceMessage), in the same words on both.

export const VOICE_PREFS = ["auto", "he", "en"];
export const LANG_NAME = { he: "Hebrew", en: "English" };
// how a language is named on its own switch (in its own script)
export const LANG_SELF = { he: "עברית", en: "English" };

// The language to listen in. `pref`: the profile's voiceLang; `device`: the
// device's language tag ("he-IL", "iw", "en-US").
export const voiceLangFor = (pref, device) => {
  if (pref === "he" || pref === "en") return pref;
  const tag = String(device || "").toLowerCase();
  return /^(he|iw)([-_]|$)/.test(tag) ? "he" : "en";
};
// the tag a recogniser is asked for
export const bcp47 = (lang) => (lang === "he" ? "he-IL" : "en-US");
export const otherLang = (lang) => (lang === "he" ? "en" : "he");

// What went wrong, from any recogniser's own word for it:
//   the Web Speech API's error codes, the TV module's (AuroraVoice.kt), and
//   Android's SpeechRecognizer error numbers.
const ERRORS = {
  // web
  "not-allowed": "denied",
  "service-not-allowed": "blocked",
  "no-speech": "no-speech",
  "audio-capture": "audio",
  network: "network",
  "language-not-supported": "language",
  aborted: "cancelled",
  "bad-grammar": "failed",
  // the TV module
  denied: "denied",
  blocked: "blocked",
  unavailable: "unavailable",
  "no-match": "no-match",
  busy: "busy",
  audio: "audio",
  language: "language",
  client: "failed",
  server: "network",
  failed: "failed",
  cancelled: "cancelled",
  // android.speech.SpeechRecognizer.ERROR_*
  1: "network", 2: "network", 3: "audio", 4: "network", 5: "failed", 6: "no-speech", 7: "no-match",
  8: "busy", 9: "denied", 10: "busy", 11: "network", 12: "language", 13: "language",
};
export const voiceError = (code) =>
  Object.prototype.hasOwnProperty.call(ERRORS, String(code)) ? ERRORS[String(code)] : "failed";

// ---- the moments of one voice search ----
//   idle        nothing is listening
//   starting    asked for the microphone (and, the first time, the person's
//               permission); not hearing yet
//   listening   hearing: `interim` is what it has so far (shown as it comes)
//   heard       done: `text` is what to search for
//   error       `error` says what (voiceMessage says it in words)
export const VOICE_IDLE = { phase: "idle", lang: "en", interim: "", text: "", error: null };

const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
const heardOrError = (state, error) =>
  state.interim ? { ...state, phase: "heard", text: state.interim, error: null } : { ...state, phase: "error", error };

export const voiceReduce = (state, ev) => {
  const s = state || VOICE_IDLE;
  const open = s.phase === "starting" || s.phase === "listening";
  switch (ev && ev.type) {
    case "start":
      return { phase: "starting", lang: ev.lang === "he" ? "he" : "en", interim: "", text: "", error: null };
    case "permission":
      if (!open || ev.granted) return s;
      return { ...s, phase: "error", error: ev.never ? "blocked" : "denied", interim: "" };
    case "unavailable":
      return { ...s, phase: "error", error: "unavailable", interim: "" };
    case "ready":
      return open ? { ...s, phase: "listening" } : s;
    case "partial": {
      if (!open) return s;
      const t = clean(ev.text);
      return { ...s, phase: "listening", interim: t || s.interim };
    }
    case "final": {
      if (!open) return s;
      const t = clean(ev.text);
      if (t) return { ...s, phase: "heard", text: t, interim: t, error: null };
      return heardOrError(s, "no-match");
    }
    case "error": {
      if (!open) return s;
      const e = voiceError(ev.code);
      if (e === "cancelled") return { ...VOICE_IDLE, lang: s.lang };
      // the recogniser gave up after showing words: those words are the answer
      if (e === "no-speech" || e === "no-match") return heardOrError(s, e);
      return { ...s, phase: "error", error: e, interim: "" };
    }
    case "end":
      // the recogniser stopped without a final result
      if (!open) return s;
      return heardOrError(s, "no-speech");
    case "cancel":
      return { ...VOICE_IDLE, lang: s.lang };
    case "done":
      return { ...VOICE_IDLE, lang: s.lang };
    default:
      return s;
  }
};

// Is the microphone on (the button lit, the panel open)?
export const voiceActive = (state) => !!state && (state.phase === "starting" || state.phase === "listening");

// ---- the words ----
// `platform`: "web" | "tv" — only where a fix is the device's own (its
// settings) do the two say different things.
export const voiceMessage = (state, platform = "web") => {
  const s = state || VOICE_IDLE;
  const name = LANG_NAME[s.lang] || "English";
  const tv = platform === "tv";
  switch (s.phase) {
    case "starting":
      return "Starting the microphone…";
    case "listening":
      return s.interim ? "" : `Listening in ${name}… say a title`;
    case "heard":
      return "";
    case "error":
      switch (s.error) {
        case "denied":
          return "Aurora isn't allowed to use the microphone. Press the mic again and choose Allow.";
        case "blocked":
          return tv
            ? "The microphone is off for Aurora. Turn it on in the TV's Settings → Apps → Aurora → Permissions."
            : "The microphone is blocked for this site. Allow it in the browser's site settings.";
        case "unavailable":
          return tv
            ? "This TV has no speech recognition. Install or update the Google app to search by voice."
            : "This browser can't search by voice.";
        case "no-speech":
          return "Didn't hear anything. Press the mic and say a title.";
        case "no-match":
          return "Didn't catch that. Press the mic and try again.";
        case "network":
          return "Voice search needs the internet: the speech service didn't answer.";
        case "busy":
          return "The microphone is busy. Try again in a moment.";
        case "audio":
          return tv ? "The remote's microphone didn't answer." : "No microphone was found.";
        case "language":
          return `Listening in ${name} isn't available here. Switch to ${LANG_NAME[otherLang(s.lang)]}.`;
        default:
          return "Voice search stopped. Press the mic to try again.";
      }
    default:
      return "";
  }
};
